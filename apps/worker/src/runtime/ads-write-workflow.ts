import { adsWriteChangeField, adsWriteEventOf, adsWriteSwitches, ADS_WRITE_KIND_INFO, type AdsWriteKind, type AdsWriteSource } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError, WORKFLOW_KINDS, type WorkflowDefinition, type WriteRunIntent } from '@nova/workflow'
import { Prisma, type AdsWriteRun } from '@prisma/client'
import { AmazonAdsApiClient } from '../connectors/amazon-ads-api'
import { AdsV1Api } from '../connectors/ads-v1-api'
import { adsWriteRejection, buildAdsWriteCall, createdIdOf, type AdsWriteInput } from '../connectors/ads-v1-write'
import type { WriteWorkflowDeps } from './workflows'

// 广告写入流程（P3-17，08 章开头）：先记录意图 → 调用亚马逊 → 回写本地对象、变更记录与操作事件；崩溃或超时后先向亚马逊对账，查到就沿用，查不到才重新调用。
// 十种写入（手动、自动规则、分时策略共用）一个流程，具体动作取自写入记录（AdsWriteRun）。
// 对账能力：
//   - 修改类（状态、预算、竞价、竞价策略、广告位调整）：亚马逊的更新是把字段设成给定值，重复调用结果相同，不需要对账；
//   - 新增类（否定投放、关键词）：按“广告组或活动下已有相同的词与匹配方式”判断是否已经创建，已经有就沿用，没有才重新创建。

export const ADS_WRITE_FLOW = WORKFLOW_KINDS.ADS_WRITE
type Intent = WriteRunIntent

const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})
const str = (value: unknown) => (typeof value === 'string' ? value : undefined)
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** 写入记录里的 requestJson → 构造亚马逊请求所需的输入。 */
export function inputOfRun(run: Pick<AdsWriteRun, 'kind' | 'externalId' | 'requestJson'>): AdsWriteInput {
  const body = record(run.requestJson)
  return {
    kind: run.kind as AdsWriteKind,
    externalId: run.externalId,
    campaignExternalId: str(body.campaignExternalId) ?? null,
    state: str(body.state),
    amount: num(body.amount),
    strategy: str(body.strategy),
    placement: str(body.placement),
    text: str(body.text),
    matchType: str(body.matchType),
    level: str(body.level),
  }
}

const isCreate = (kind: string) => kind === 'NEGATIVE_ADD' || kind === 'KEYWORD_ADD'

export function createAdsWriteWorkflow(deps: WriteWorkflowDeps): WorkflowDefinition<Intent> {
  const inTenant = <T>(tenantId: string, fn: () => Promise<T>) => runWithTenant(tenantId, fn)

  const loadRun = async (tenantId: string, id: string | undefined) => {
    const row = id ? await inTenant(tenantId, () => deps.prisma.adsWriteRun.findFirst({ where: { id, tenantId } })) : null
    if (!row) throw new NonRetryableError('ADS_WRITE_RUN_NOT_FOUND', '写入记录不存在')
    return row
  }

  /** 调用亚马逊前再确认一次开关（受理之后开关可能已被关闭或自动关闭）：动作自己的开关，加上规则或分时策略的来源开关，缺一不可。 */
  const assertSwitchesOn = async (tenantId: string, run: AdsWriteRun) => {
    const keys = adsWriteSwitches(run.kind as AdsWriteKind, run.source as AdsWriteSource)
    const on = await inTenant(tenantId, () =>
      deps.prisma.integrationSwitch.findMany({ where: { tenantId, switchKey: { in: keys }, sellerAccountId: null, enabled: true }, select: { switchKey: true }, take: keys.length }),
    )
    if (new Set(on.map(row => row.switchKey)).size < keys.length) throw new NonRetryableError('SWITCH_DISABLED', '广告写入开关已关闭，未向亚马逊发出请求')
  }

  const apiFor = async (intent: Intent, run: AdsWriteRun) =>
    inTenant(intent.tenantId, async () => {
      const [connection, profile] = await Promise.all([
        deps.prisma.platformConnection.findFirst({ where: { id: intent.connectionId } }),
        deps.prisma.adsProfile.findFirst({ where: { id: run.adsProfileId, tenantId: intent.tenantId }, select: { adsAccountId: true } }),
      ])
      if (!connection) throw new NonRetryableError('CONNECTION_NOT_FOUND', '广告授权不存在，无法调用亚马逊')
      if (!profile?.adsAccountId) throw new NonRetryableError('ADS_ACCOUNT_MISSING', '广告档案还没有统一接口的广告账户编号')
      return new AdsV1Api(new AmazonAdsApiClient(connection, deps.secrets, deps.guardFor(intent.tenantId, intent.connectionId)), profile.adsAccountId)
    })

  /** 修改类写入成功后，把本地的对象改成新值（下一次同步会以亚马逊为准校正）。找不到对象不算错（可能刚被同步删除）。 */
  async function applyLocal(tx: Prisma.TransactionClient, run: AdsWriteRun): Promise<void> {
    const body = record(run.requestJson)
    const where = { id: run.entityId, tenantId: run.tenantId }
    const amount = num(body.amount)
    switch (run.kind as AdsWriteKind) {
      case 'CAMPAIGN_STATE':
        await tx.adsCampaign.updateMany({ where, data: { state: str(body.state) ?? undefined } })
        return
      case 'CAMPAIGN_BUDGET':
        await tx.adsCampaign.updateMany({ where, data: { budget: amount === undefined ? undefined : new Prisma.Decimal(amount) } })
        return
      case 'CAMPAIGN_BID_STRATEGY':
        await tx.adsCampaign.updateMany({ where, data: { bidStrategy: str(body.strategy) ?? undefined } })
        return
      case 'AD_GROUP_STATE':
        await tx.adsAdGroup.updateMany({ where, data: { state: str(body.state) ?? undefined } })
        return
      case 'AD_GROUP_BID':
        await tx.adsAdGroup.updateMany({ where, data: { defaultBid: amount === undefined ? undefined : new Prisma.Decimal(amount) } })
        return
      case 'TARGET_STATE':
        if (body.table === 'AdsKeyword') await tx.adsKeyword.updateMany({ where, data: { state: str(body.state) ?? undefined } })
        else await tx.adsTarget.updateMany({ where, data: { state: str(body.state) ?? undefined } })
        return
      case 'TARGET_BID': {
        const data = { bid: amount === undefined ? undefined : new Prisma.Decimal(amount) }
        if (body.table === 'AdsKeyword') await tx.adsKeyword.updateMany({ where, data })
        else await tx.adsTarget.updateMany({ where, data })
        return
      }
      default:
        return // 广告位调整没有本地列；新增类等下一次同步带回
    }
  }

  async function recordSuccess(run: AdsWriteRun, now: Date): Promise<void> {
    const body = record(run.requestJson)
    const kind = run.kind as AdsWriteKind
    const field = adsWriteChangeField(kind)
    const event = adsWriteEventOf(kind)
    const manual = run.source === 'MANUAL'
    const profile = await deps.prisma.adsProfile.findFirst({ where: { id: run.adsProfileId, tenantId: run.tenantId }, select: { sellerAccountId: true } })
    await deps.prisma.$transaction(async tx => {
      const claimed = await tx.adsWriteRun.updateMany({
        where: { id: run.id, tenantId: run.tenantId, status: { not: 'SUCCEEDED' } },
        data: { status: 'SUCCEEDED', failureCode: null, finishedAt: now },
      })
      if (claimed.count === 0) return // 已经回写过（流程重放）：不重复写变更记录与事件
      await applyLocal(tx, run)
      // 自动规则与分时策略的执行记录：提交时是“已提交”，确认后改为“已执行”
      const applied = { executed: true, outcome: 'APPLIED', message: null }
      await tx.adsAutomationRun.updateMany({ where: { tenantId: run.tenantId, writeRunId: run.id, outcome: 'QUEUED' }, data: applied })
      await tx.daypartingRun.updateMany({ where: { tenantId: run.tenantId, writeRunId: run.id, outcome: 'QUEUED' }, data: applied })
      await tx.adsChangeLog.createMany({
        data: [
          {
            tenantId: run.tenantId,
            adsProfileId: run.adsProfileId,
            entityType: body.table === 'AdsKeyword' ? 'KEYWORD' : field.entityType,
            entityId: run.entityId,
            entityLabel: run.entityLabel,
            changedField: field.field,
            beforeValue: run.beforeValue,
            afterValue: run.afterValue,
            actorKind: run.source,
            actorId: manual ? run.requestedBy : null,
            occurredAt: now,
            writeRunId: run.id,
          },
        ],
        skipDuplicates: true,
      })
      await tx.entityEvent.createMany({
        data: [
          {
            tenantId: run.tenantId,
            sellerAccountId: profile?.sellerAccountId ?? null,
            entityType: event.entityType,
            entityId: run.entityId,
            kind: event.kind,
            occurredAt: now,
            title: `${ADS_WRITE_KIND_INFO[kind].label}：${run.beforeValue ?? '（未同步）'} → ${run.afterValue}`.slice(0, 300),
            detailJson: { before: { [event.key]: run.beforeValue }, after: { [event.key]: run.afterValue } } as Prisma.InputJsonValue,
            actorKind: manual ? 'USER' : 'SYSTEM',
            actorId: manual ? run.requestedBy : null,
            sourceRef: `ads-write:${run.id}`,
          },
        ],
        skipDuplicates: true,
      })
    })
  }

  async function callAmazon(intent: Intent, run: AdsWriteRun): Promise<Record<string, unknown>> {
    if (run.status === 'SUCCEEDED') return { externalId: run.externalId, done: true } // 已经成功：不再调用
    await assertSwitchesOn(intent.tenantId, run)
    const api = await apiFor(intent, run)
    await inTenant(intent.tenantId, () =>
      deps.prisma.adsWriteRun.updateMany({ where: { id: run.id, tenantId: run.tenantId, status: { in: ['PENDING', 'FAILED'] } }, data: { status: 'RUNNING', failureCode: null, finishedAt: null } }),
    )
    let call
    try {
      call = buildAdsWriteCall(inputOfRun(run))
    } catch (error) {
      throw new NonRetryableError('ADS_WRITE_REQUEST_INVALID', error instanceof Error ? error.message : '写入请求不完整')
    }
    const response = await api.mutate(call.operation, call.resource, call.item)
    const rejection = adsWriteRejection(response)
    if (rejection) throw new NonRetryableError(rejection, '亚马逊拒绝了这次修改')
    return { externalId: run.externalId, createdId: createdIdOf(response) }
  }

  return {
    kind: ADS_WRITE_FLOW,
    steps: [
      {
        name: '向亚马逊执行广告写入',
        // 意图只记写入记录编号与动作，不含词与取值之外的内容
        buildRequest: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.adsWriteRunId)
          return { adsWriteRunId: run.id, kind: run.kind, externalId: run.externalId, requestedAt: new Date().toISOString() }
        },
        run: async ctx => callAmazon(ctx.intent, await loadRun(ctx.tenantId, ctx.intent.adsWriteRunId)),
        reconcile: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.adsWriteRunId)
          if (run.status === 'SUCCEEDED') return { found: true, response: { externalId: run.externalId, done: true } }
          if (!isCreate(run.kind)) return { found: false }
          const input = inputOfRun(run)
          const api = await apiFor(ctx.intent, run)
          const filters = input.level === 'CAMPAIGN' ? { campaignIdFilter: { include: [run.externalId] } } : { adGroupIdFilter: { include: [run.externalId] } }
          const page = await api.queryPage('targets', { filters })
          const wanted = (input.text ?? '').trim().toLowerCase()
          const hit = page.items.find(item => {
            const keyword = record(record(item.targetDetails).keywordTarget)
            return String(keyword.keyword ?? '').toLowerCase() === wanted && String(keyword.matchType ?? '') === input.matchType && Boolean(item.negative) === (run.kind === 'NEGATIVE_ADD')
          })
          return hit ? { found: true, response: { externalId: run.externalId, createdId: str(hit.targetId) ?? null } } : { found: false }
        },
      },
      {
        name: '回写广告对象与变更记录',
        run: async ctx => {
          const run = await loadRun(ctx.tenantId, ctx.intent.adsWriteRunId)
          await inTenant(ctx.tenantId, () => recordSuccess(run, new Date()))
          return { adsWriteRunId: run.id }
        },
      },
    ],
  }
}
