import { APLUS_LIMITS, APLUS_SWITCH_KEY } from '@nova/api-contracts'
import { StorageError, TenantObjectStore } from '@nova/storage'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import type { AplusContent, AplusWriteRun, Prisma, PrismaClient } from '@prisma/client'
import { AmazonSpApiClient } from '../connectors/amazon-sp-api'
import { AplusApi } from '../connectors/aplus-api'
import { parseContentList, parseWriteAck } from '../importers/aplus/parse'
import { parseAplusRequest, type AplusRequest } from './aplus-request'
import type { WriteWorkflowDeps } from './workflows'

// A+ 写入流程（P4-14，importers.md I-18）：一条 AplusWriteRun 一个流程，按记录的类型（创建、保存修改、关联 ASIN、提交审核、上传图片）调用亚马逊。
// 两个步骤：
//   1. 向亚马逊发请求：先确认写入开关仍然打开（接口受理之后开关可能已被关闭或自动关闭），再调用；响应（内容引用键、警告、上传编号、调用时间）持久化在步骤记录里；
//   2. 回写本地：在一个事务里把写入记录置为成功并更新内容 / 关联 ASIN / 审核事件。回写是幂等的（写入记录已经成功就不再重复），崩溃后只会重放这一步，不会重复调用亚马逊。
// 崩溃或超时后的对账：创建会在亚马逊产生新内容，所以先按“名称 + 本次请求发出之后更新、且本地还没有使用的引用键”去内容列表里找，找到就沿用，找不到才重新创建；
// 保存修改、关联 ASIN、提交审核重复调用结果相同（是“设置成这样”），上传图片重复调用只多一个无人使用的上传编号，都直接重试。
// 已知缺口：创建成功之后、进程崩溃之前恰好同名的内容不在列表前 3 页，对账会漏掉，重试会多建一份同名草稿（亚马逊允许同名）。
// 失败原因只留“来源 + 状态码”或 APL_* 失败码，亚马逊返回的原文不入库。

export const APLUS_WRITE = WORKFLOW_KINDS.APLUS_WRITE
type Intent = WriteRunIntent
const CLOCK_SKEW_MS = 60_000
const RECONCILE_PAGES = 3

/** 一次亚马逊调用的结果（持久化到步骤记录）。 */
interface Outcome {
  contentReferenceKey: string | null
  warnings: string[]
  uploadDestinationId: string | null
  /** 调用完成的时间：提交审核的事件用它做发生时间，流程重放时不会写出第二条。 */
  at: string
}

/** 写入开关是否打开（企业级开关，不分店铺）。 */
export const aplusSwitchOn = async (db: Pick<PrismaClient, 'integrationSwitch'>, tenantId: string) =>
  Boolean(await db.integrationSwitch.findFirst({ where: { tenantId, switchKey: APLUS_SWITCH_KEY, sellerAccountId: null, enabled: true }, select: { id: true } }))

export function createAplusWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)

  const loadRun = async (tenantId: string, id: string | undefined) => {
    const row = id ? await inTenant(tenantId, () => deps.prisma.aplusWriteRun.findFirst({ where: { id, tenantId } })) : null
    if (!row) throw new NonRetryableError('APL_RUN_NOT_FOUND', 'A+ 写入记录不存在')
    return row
  }
  const loadContent = async (run: AplusWriteRun) => {
    const row = run.contentId ? await inTenant(run.tenantId, () => deps.prisma.aplusContent.findFirst({ where: { id: run.contentId!, tenantId: run.tenantId } })) : null
    if (!row) throw new NonRetryableError('APL_CONTENT_NOT_FOUND', 'A+ 内容不存在')
    return row
  }
  const needKey = (content: AplusContent) => {
    if (!content.contentReferenceKey) throw new NonRetryableError('APL_KEY_MISSING', '这份内容在亚马逊还没有创建成功，不能做这个操作')
    return content.contentReferenceKey
  }
  const apiOf = (intent: Intent) =>
    inTenant(intent.tenantId, async () => {
      const connection = await deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } })
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '店铺授权不存在，无法调用亚马逊')
      return new AplusApi(new AmazonSpApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)))
    })

  /** 从对象存储读出图片字节：文件不在（或不属于本企业）记 APL_FILE_MISSING。 */
  async function readImage(tenantId: string, objectKey: string): Promise<Buffer> {
    if (!deps.storage) throw new NonRetryableError('STORAGE_NOT_CONFIGURED', '没有配置对象存储，无法读取要上传的图片')
    const store = new TenantObjectStore(deps.storage, tenantId)
    const missing = () => new NonRetryableError('APL_FILE_MISSING', '图片文件已不在存储里')
    const meta = await store.stat(objectKey)
    if (!meta) throw missing()
    if (meta.sizeBytes <= 0 || meta.sizeBytes > APLUS_LIMITS.imageMaxBytes) throw new NonRetryableError('APL_REQUEST_INVALID', '图片文件为空或超过大小上限')
    const chunks: Buffer[] = []
    try {
      for await (const chunk of await store.read(objectKey)) chunks.push(Buffer.from(chunk))
    } catch (error) {
      if (error instanceof StorageError && error.code === 'OBJECT_NOT_FOUND') throw missing()
      throw error
    }
    return Buffer.concat(chunks)
  }

  async function callAmazon(intent: Intent, run: AplusWriteRun): Promise<Outcome> {
    const req = parseAplusRequest(run.kind, run.requestJson)
    // 受理之后开关可能已被关闭：再确认一次，关了就不向亚马逊发请求
    if (!(await inTenant(intent.tenantId, () => aplusSwitchOn(deps.prisma, intent.tenantId)))) throw new NonRetryableError('APL_SWITCH_OFF', 'A+ 内容的写入开关已关闭，未向亚马逊发出请求')
    const done = (extra: Partial<Outcome> = {}): Outcome => ({ contentReferenceKey: null, warnings: [], uploadDestinationId: null, at: new Date().toISOString(), ...extra })
    if (req.kind === 'UPLOAD') {
      const bytes = await readImage(intent.tenantId, req.objectKey)
      return done({ uploadDestinationId: (await (await apiOf(intent)).uploadImage(bytes, req.contentType)).uploadDestinationId })
    }
    const content = await loadContent(run)
    if (req.kind === 'CREATE' && content.contentReferenceKey) return done({ contentReferenceKey: content.contentReferenceKey }) // 已经创建过：不再调用
    const api = await apiOf(intent)
    if (req.kind === 'CREATE') {
      const ack = parseWriteAck(await api.createContent({ name: req.name, contentType: req.contentType, locale: req.locale, contentModuleList: req.contentModuleList }), true)
      return done({ contentReferenceKey: ack.contentReferenceKey, warnings: ack.warnings })
    }
    const key = needKey(content)
    const body =
      req.kind === 'UPDATE'
        ? await api.updateContent(key, { name: req.name, contentType: content.contentType, locale: content.locale, contentModuleList: req.contentModuleList })
        : req.kind === 'ASSOCIATE'
          ? await api.associateAsins(key, req.asins)
          : await api.submitForApproval(key)
    return done({ contentReferenceKey: key, warnings: parseWriteAck(body).warnings })
  }

  /** 创建的对账：本地行已经有引用键就沿用；否则去内容列表里找“同名、本次请求之后更新、本地还没有使用”的内容。 */
  async function reconcileCreate(intent: Intent, run: AplusWriteRun, req: Extract<AplusRequest, { kind: 'CREATE' }>, requestedAt: string) {
    const content = await loadContent(run)
    if (content.contentReferenceKey) return { found: true as const, response: { contentReferenceKey: content.contentReferenceKey, warnings: [], uploadDestinationId: null, at: requestedAt } }
    const api = await apiOf(intent)
    const since = Date.parse(requestedAt) - CLOCK_SKEW_MS
    const candidates: string[] = []
    let token: string | undefined
    for (let page = 0; page < RECONCILE_PAGES; page += 1) {
      const parsed = parseContentList(await api.listContents(token))
      for (const item of parsed.items) if (item.name === req.name && item.updatedAt && item.updatedAt.getTime() >= since) candidates.push(item.key)
      if (!parsed.nextToken || parsed.nextToken === token) break
      token = parsed.nextToken
    }
    if (candidates.length === 0) return { found: false as const }
    const used = await inTenant(intent.tenantId, () =>
      deps.prisma.aplusContent.findMany({ where: { tenantId: intent.tenantId, sellerAccountId: run.sellerAccountId, contentReferenceKey: { in: candidates } }, select: { contentReferenceKey: true } }),
    )
    const taken = new Set(used.map(row => row.contentReferenceKey))
    const key = candidates.find(item => !taken.has(item))
    return key ? { found: true as const, response: { contentReferenceKey: key, warnings: [], uploadDestinationId: null, at: requestedAt } } : { found: false as const }
  }

  /** 回写本地（幂等）：先把写入记录从“未成功”改为成功，改不到说明已经回写过（流程重放），其余不再重复。 */
  async function writeBack(tx: Prisma.TransactionClient, run: AplusWriteRun, req: AplusRequest, out: Outcome): Promise<void> {
    const now = new Date()
    const result: Record<string, unknown> =
      req.kind === 'UPLOAD'
        ? { uploadDestinationId: out.uploadDestinationId }
        : req.kind === 'ASSOCIATE'
          ? { contentReferenceKey: out.contentReferenceKey, associated: req.asins.length }
          : { contentReferenceKey: out.contentReferenceKey }
    const claimed = await tx.aplusWriteRun.updateMany({
      where: { id: run.id, tenantId: run.tenantId, status: { not: 'SUCCEEDED' } },
      data: { status: 'SUCCEEDED', failureCode: null, finishedAt: now, resultJson: result as Prisma.InputJsonValue, warningsJson: out.warnings },
    })
    if (claimed.count === 0 || !run.contentId) return
    const where = { id: run.contentId, tenantId: run.tenantId }
    if (req.kind === 'CREATE') await tx.aplusContent.updateMany({ where, data: { contentReferenceKey: out.contentReferenceKey } })
    if (req.kind === 'UPDATE') await tx.aplusContent.updateMany({ where, data: { lastSyncedAt: now } })
    if (req.kind === 'ASSOCIATE') {
      await tx.aplusAsinRelation.updateMany({ where: { tenantId: run.tenantId, contentId: run.contentId, asin: { in: req.asins } }, data: { lastSeenAt: now } })
      await tx.aplusAsinRelation.createMany({
        data: req.asins.map(asin => ({ tenantId: run.tenantId, contentId: run.contentId!, sellerAccountId: run.sellerAccountId, asin, lastSeenAt: now })),
        skipDuplicates: true,
      })
      const asinCount = await tx.aplusAsinRelation.count({ where: { tenantId: run.tenantId, contentId: run.contentId } })
      await tx.aplusContent.updateMany({ where, data: { asinCount } })
    }
    if (req.kind === 'SUBMIT') {
      await tx.aplusContent.updateMany({ where, data: { status: 'SUBMITTED' } })
      await tx.aplusReviewEvent.createMany({
        data: [{ tenantId: run.tenantId, contentId: run.contentId, status: 'SUBMITTED', message: null, source: 'LOCAL', occurredAt: new Date(out.at) }],
        skipDuplicates: true,
      })
    }
  }

  return {
    kind: APLUS_WRITE,
    steps: [
      {
        name: '向亚马逊提交 A+ 写入',
        buildRequest: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.aplusRunId)
          return { aplusRunId: run.id, kind: run.kind, requestedAt: new Date().toISOString() }
        },
        run: async ctx => callAmazon(ctx.intent, await loadRun(ctx.tenantId, ctx.intent.aplusRunId)),
        reconcile: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.aplusRunId)
          if (run.kind !== 'CREATE') return { found: false } // 其余操作重复调用结果相同，直接重试
          const req = parseAplusRequest(run.kind, run.requestJson)
          return req.kind === 'CREATE' ? reconcileCreate(ctx.intent, run, req, String((ctx.request as { requestedAt?: unknown } | null)?.requestedAt ?? new Date().toISOString())) : { found: false }
        },
      },
      {
        name: '回写 A+ 写入结果',
        run: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.aplusRunId)
          const req = parseAplusRequest(run.kind, run.requestJson)
          await inTenant(ctx.tenantId, () => deps.prisma.$transaction(tx => writeBack(tx, run, req, ctx.responseOf(0) as Outcome)))
          return { aplusRunId: run.id, kind: run.kind, ...(req.kind === 'UPLOAD' ? { uploadDestinationId: (ctx.responseOf(0) as Outcome).uploadDestinationId } : {}) }
        },
      },
    ],
  }
}
