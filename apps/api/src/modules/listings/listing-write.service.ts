import { Injectable } from '@nestjs/common'
import {
  LISTING_BATCH_SWITCH,
  LISTING_MARKETPLACE_ID,
  LISTING_QUALITY_READ,
  LISTING_QUALITY_WRITE,
  LISTING_SUBMITTED_ACTIONS,
  LISTING_UPDATE_SWITCH,
  LISTING_WRITE_LIMITS,
  ListingBatchBodySchema,
  ListingPatchBodySchema,
  ListingRestrictionsBodySchema,
  ListingRunListQuerySchema,
  ListingValidateBodySchema,
  PRICE_RUN_KINDS,
  type ListingRunKind,
  type ListingRunListResponse,
  type ListingRunSubmitResponse,
  type ListingRunView,
} from '@nova/api-contracts'
import type { ListingWriteRun, Prisma } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService, AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService, storeWhere } from '../auth'
import { ListingJobService } from './listing-jobs.service'
import { patchHash, runViewOf } from './listing-write-common'

const json = (value: unknown) => value as Prisma.InputJsonValue

// 刊登修复的写入入口（P4-10）。顺序：权限（先于参数）→ 参数（422）→ 店铺在范围内（403）→ 动作守卫（权限、卖家连接、写入开关，409/403）
//   → 业务条件（预览令牌、商品类型、同一商品没有未完成的修改，409/422）→ 事务内建记录、任务并写审计 → 提交后登记流程并入队。
// 亚马逊的调用都在后台任务里：校验预览与刊登限制查询只读，不需要写入开关；修改刊登与批量任务各有自己的开关。
// 修改刊登必须带上一步“校验通过”的预览编号，且修改内容与校验过的完全一致、预览未过期（30 分钟）。批量任务不要求逐个预览（文件由亚马逊逐条校验，结果写回记录）。
@Injectable()
export class ListingWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
    private readonly jobs: ListingJobService,
  ) {}

  private async storeOf(tenantId: string, id: string) {
    const store = await this.prisma.sellerAccount.findFirst({ where: { id, tenantId }, select: { id: true, displayName: true } })
    if (!store) throw appError('RESOURCE_NOT_FOUND', '店铺不存在')
    return store
  }

  /** 商品类型：请求里带了就用，否则取最近一次同步到的当前状态；都没有就让用户填。 */
  private async productTypeOf(storeId: string, sku: string, given: string | undefined): Promise<string> {
    if (given) return given
    const snapshot = await this.prisma.listingSnapshot.findUnique({
      where: { sellerAccountId_marketplaceId_sellerSku: { sellerAccountId: storeId, marketplaceId: LISTING_MARKETPLACE_ID, sellerSku: sku } },
      select: { productType: true },
    })
    if (!snapshot?.productType) throw appError('VALIDATION_FAILED', `SKU「${sku}」还没有同步到商品类型，请填写商品类型`, { fieldErrors: { productType: ['请填写商品类型'] } })
    return snapshot.productType
  }

  private async view(tenantId: string, runId: string): Promise<ListingRunView> {
    const run = await this.prisma.listingWriteRun.findFirstOrThrow({ where: { id: runId, tenantId } })
    return (await this.views(tenantId, [run]))[0]!
  }

  private async views(tenantId: string, runs: ListingWriteRun[]): Promise<ListingRunView[]> {
    const stores = new Map(
      (await this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(runs.map(run => run.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 500 })).map(
        store => [store.id, store.displayName],
      ),
    )
    const users = await memberNames(
      this.prisma,
      tenantId,
      runs.map(run => run.requestedBy),
    )
    const now = new Date()
    return runs.map(run => runViewOf(run, { stores, users }, now))
  }

  /** 建记录与任务（同一事务，含审计），提交后入队。 */
  private async submit(
    req: RequestWithContext,
    context: ApiContext,
    input: {
      kind: ListingRunKind
      storeId: string
      connectionId: string
      sku?: string
      productType?: string
      requestJson: unknown
      requestHash?: string
      previewRunId?: string
      itemCount?: number
      writesAmazon: boolean
    },
  ): Promise<ListingRunSubmitResponse> {
    const { run, job } = await this.prisma.$transaction(async tx => {
      const created = await tx.listingWriteRun.create({
        data: {
          tenantId: context.tenantId,
          sellerAccountId: input.storeId,
          kind: input.kind,
          sellerSku: input.sku ?? null,
          productType: input.productType ?? null,
          requestJson: json(input.requestJson),
          requestHash: input.requestHash ?? '',
          previewRunId: input.previewRunId ?? null,
          itemCount: input.itemCount ?? 0,
          status: 'PENDING',
          requestedBy: context.userId,
          requestId: req.requestId,
        },
      })
      const queued = await this.jobs.createJob(tx, { tenantId: context.tenantId, connectionId: input.connectionId, requestId: req.requestId, runId: created.id })
      await tx.listingWriteRun.update({ where: { id: created.id }, data: { syncJobId: queued.id } })
      await this.audit.record(
        req,
        {
          action: LISTING_SUBMITTED_ACTIONS[input.kind],
          resourceType: 'ListingWriteRun',
          resourceId: created.id,
          after: { kind: input.kind, storeId: input.storeId, sku: input.sku ?? null, items: input.itemCount ?? 0 },
        },
        { client: tx },
      )
      return { run: created, job: queued }
    })
    const queued = await this.jobs.dispatch(req, job, { tenantId: context.tenantId, connectionId: input.connectionId, runId: run.id, writesAmazon: input.writesAmazon })
    return { run: await this.view(context.tenantId, run.id), state: queued ? 'QUEUED' : 'FAILED' }
  }

  async validate(req: RequestWithContext, rawBody: unknown): Promise<ListingRunSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_WRITE, {})
    const body = ListingValidateBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.storeOf(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: LISTING_QUALITY_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId } })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const productType = await this.productTypeOf(body.storeId, body.sku, body.productType)
    return this.submit(req, context, {
      kind: 'VALIDATE',
      storeId: body.storeId,
      connectionId: connection.id,
      sku: body.sku,
      productType,
      requestJson: { sku: body.sku, productType, patches: body.patches },
      requestHash: patchHash(body.sku, productType, body.patches),
      itemCount: 1,
      writesAmazon: false,
    })
  }

  async patch(req: RequestWithContext, rawBody: unknown): Promise<ListingRunSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_WRITE, {})
    const body = ListingPatchBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.storeOf(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: LISTING_QUALITY_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId }, switchKey: LISTING_UPDATE_SWITCH })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const productType = await this.productTypeOf(body.storeId, body.sku, body.productType)
    const preview = await this.prisma.listingWriteRun.findFirst({ where: { id: body.previewRunId, tenantId: context.tenantId, sellerAccountId: body.storeId, kind: 'VALIDATE' } })
    if (!preview || preview.validation !== 'VALID') throw appError('CONFLICT', '提交修改前需要先做校验预览并通过', { details: { code: 'PREVIEW_REQUIRED' } })
    if (!preview.expiresAt || preview.expiresAt <= new Date()) throw appError('CONFLICT', '校验预览已过期（30 分钟内有效），请重新校验', { details: { code: 'PREVIEW_EXPIRED' } })
    const hash = patchHash(body.sku, productType, body.patches)
    if (preview.requestHash !== hash) throw appError('CONFLICT', '提交的修改与校验过的内容不一致，请重新校验', { details: { code: 'PREVIEW_MISMATCH' } })
    const busy = await this.prisma.listingWriteRun.count({
      where: { tenantId: context.tenantId, sellerAccountId: body.storeId, kind: 'PATCH', sellerSku: body.sku, status: { in: ['PENDING', 'RUNNING'] } },
    })
    if (busy > 0) throw appError('CONFLICT', '这个商品已有未完成的修改，请等它完成后再提交', { details: { code: 'LISTING_RUN_STALE' } })
    return this.submit(req, context, {
      kind: 'PATCH',
      storeId: body.storeId,
      connectionId: connection.id,
      sku: body.sku,
      productType,
      requestJson: { sku: body.sku, productType, patches: body.patches },
      requestHash: hash,
      previewRunId: preview.id,
      itemCount: 1,
      writesAmazon: true,
    })
  }

  async batch(req: RequestWithContext, rawBody: unknown): Promise<ListingRunSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_WRITE, {})
    const body = ListingBatchBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.storeOf(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: LISTING_QUALITY_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId }, switchKey: LISTING_BATCH_SWITCH })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const snapshots = await this.prisma.listingSnapshot.findMany({
      where: { sellerAccountId: body.storeId, marketplaceId: LISTING_MARKETPLACE_ID, sellerSku: { in: body.items.map(item => item.sku) } },
      select: { sellerSku: true, productType: true },
      take: LISTING_WRITE_LIMITS.batchItemsMax,
    })
    const types = new Map(snapshots.map(row => [row.sellerSku, row.productType]))
    const missing = body.items.filter(item => !types.get(item.sku)).map(item => item.sku)
    if (missing.length > 0) {
      const text = `这些 SKU 还没有同步到刊登或商品类型，不能批量修改：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ` 等 ${missing.length} 个` : ''}`
      throw appError('VALIDATION_FAILED', text, { fieldErrors: { items: [text] } })
    }
    const items = body.items.map(item => ({ sku: item.sku, productType: types.get(item.sku)!, patches: item.patches }))
    return this.submit(req, context, { kind: 'BATCH', storeId: body.storeId, connectionId: connection.id, requestJson: { items }, itemCount: items.length, writesAmazon: true })
  }

  async restrictions(req: RequestWithContext, rawBody: unknown): Promise<ListingRunSubmitResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_READ, {})
    const body = ListingRestrictionsBodySchema.parse(rawBody)
    assertStoreInScope(scope, body.storeId)
    await this.storeOf(context.tenantId, body.storeId)
    await this.guard.assert(context, { permission: LISTING_QUALITY_READ, connection: { provider: 'AMAZON_SP_API', sellerAccountId: body.storeId } })
    const connection = await this.jobs.connectionOf(context.tenantId, body.storeId)
    const asins = [...new Set(body.asins)]
    return this.submit(req, context, {
      kind: 'RESTRICTIONS',
      storeId: body.storeId,
      connectionId: connection.id,
      requestJson: { asins, conditionType: body.conditionType },
      itemCount: asins.length,
      writesAmazon: false,
    })
  }

  async runs(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ListingRunListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_READ, {})
    const query = ListingRunListQuerySchema.parse(rawQuery.kind ? { kind: rawQuery.kind } : {})
    const rows = await this.prisma.listingWriteRun.findMany({
      where: { tenantId: context.tenantId, ...storeWhere(scope), kind: query.kind ?? { notIn: [...PRICE_RUN_KINDS] } },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: LISTING_WRITE_LIMITS.runListMax + 1,
    })
    return { items: await this.views(context.tenantId, rows.slice(0, LISTING_WRITE_LIMITS.runListMax)), truncated: rows.length > LISTING_WRITE_LIMITS.runListMax }
  }

  async run(req: RequestWithContext, id: string): Promise<ListingRunView> {
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_QUALITY_READ, {})
    const run = await this.prisma.listingWriteRun.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!run) throw appError('RESOURCE_NOT_FOUND', '记录不存在')
    return (await this.views(context.tenantId, [run]))[0]!
  }
}
