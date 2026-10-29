import { Injectable } from '@nestjs/common'
import { DecisionBodySchema, ToDraftBodySchema, type BatchStatus, type DecisionResponse, type DraftResponse, type ReplenishAction } from '@nova/api-contracts'
import type { Prisma, ReplenishmentRecommendation } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { AwdDraftService } from '../awd'
import { batchStatusOf } from './replenishment-status'

const PERMISSION = 'replenishment.plan.create'

type Tx = Prisma.TransactionClient

// 补货动作：采纳 / 调整 / 忽略，以及三类草稿。动作只增不改，同一条建议以最后一次决策为准；批次状态由动作推出。
@Injectable()
export class ReplenishmentActionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly awdDrafts: AwdDraftService,
  ) {}

  /** 取批次内范围可见的建议；任何一条找不到（不存在、不在批次里或不在数据范围内）都按 404，不泄露是否存在。 */
  private async targets(tx: Tx, tenantId: string, scope: ResolvedScope, batchId: string, ids: string[]): Promise<Map<string, ReplenishmentRecommendation>> {
    const batch = await tx.replenishmentBatch.findFirst({ where: { id: batchId, tenantId }, select: { id: true } })
    if (!batch) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
    const unique = [...new Set(ids)]
    const rows = await tx.replenishmentRecommendation.findMany({ where: { tenantId, batchId, id: { in: unique }, ...storeWhere(scope) } })
    if (rows.length !== unique.length) throw appError('RESOURCE_NOT_FOUND', '有补货建议不存在或不在当前数据范围内')
    return new Map(rows.map(row => [row.id, row]))
  }

  private async refresh(tx: Tx, tenantId: string, batchId: string): Promise<BatchStatus> {
    const [recs, actions] = await Promise.all([
      tx.replenishmentRecommendation.findMany({ where: { tenantId, batchId }, select: { id: true }, take: 6000 }),
      tx.replenishmentAction.findMany({ where: { tenantId, batchId }, select: { recommendationId: true, action: true }, take: 20_000 }),
    ])
    const status = batchStatusOf(
      recs.map(rec => rec.id),
      actions,
    )
    await tx.replenishmentBatch.update({ where: { id: batchId }, data: { status } })
    return status
  }

  async decide(req: RequestWithContext, batchId: string, rawBody: unknown): Promise<DecisionResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const body = DecisionBodySchema.parse(rawBody)
    return this.prisma.$transaction(async tx => {
      const recs = await this.targets(
        tx,
        context.tenantId,
        scope,
        batchId,
        body.items.map(item => item.recommendationId),
      )
      await tx.replenishmentAction.createMany({
        data: body.items.map(item => ({
          tenantId: context.tenantId,
          batchId,
          recommendationId: item.recommendationId,
          action: item.action,
          finalQty: item.action === 'IGNORE' ? null : item.action === 'ADJUST' ? (item.qty as number) : (recs.get(item.recommendationId) as ReplenishmentRecommendation).recommendedQty,
          reason: item.reason ?? null,
          actorId: context.userId,
        })),
      })
      const batchStatus = await this.refresh(tx, context.tenantId, batchId)
      await this.audit.record(
        req,
        {
          action: 'REPLENISHMENT_DECIDED',
          resourceType: 'ReplenishmentBatch',
          resourceId: batchId,
          detail: { count: body.items.length, actions: countBy(body.items.map(item => item.action)), batchStatus },
        },
        { client: tx },
      )
      return { updated: body.items.length, batchStatus }
    })
  }

  /** 采购单草稿：真实创建 DRAFT 状态的采购单（商品成本尚未接入，单价与总额留空）。 */
  async toPurchaseDraft(req: RequestWithContext, rawBody: unknown): Promise<DraftResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    await this.context.authorize(req, 'purchase.order.write')
    const body = ToDraftBodySchema.parse(rawBody)
    if (!body.supplierId) throw appError('VALIDATION_FAILED', '生成采购单草稿必须选择供应商', { fieldErrors: { supplierId: ['请选择供应商'] } })
    const supplierId = body.supplierId
    return this.prisma.$transaction(async tx => {
      const supplier = await tx.supplier.findFirst({ where: { id: supplierId, tenantId: context.tenantId, status: 'ACTIVE' } })
      if (!supplier) throw appError('RESOURCE_NOT_FOUND', '供应商不存在或已停用')
      const recs = await this.targets(
        tx,
        context.tenantId,
        scope,
        body.batchId,
        body.items.map(item => item.recommendationId),
      )
      const done = await tx.replenishmentAction.findMany({
        where: { tenantId: context.tenantId, batchId: body.batchId, action: 'PURCHASE_DRAFT', status: 'DONE', recommendationId: { in: [...recs.keys()] } },
        select: { recommendationId: true },
      })
      if (done.length) throw appError('CONFLICT', `有 ${done.length} 条建议已经生成过采购单草稿，不能重复生成`, { details: { recommendationIds: done.map(item => item.recommendationId).join(',') } })
      const lines = body.items.map(item => {
        const rec = recs.get(item.recommendationId) as ReplenishmentRecommendation
        const quantity = item.qty ?? rec.purchaseQty
        if (quantity <= 0) throw appError('VALIDATION_FAILED', `SKU ${rec.sku} 的建议采购量为 0，请填写数量或先排除`, { fieldErrors: { items: [`${rec.sku} 采购量为 0`] } })
        return { rec, quantity }
      })
      const batch = await tx.replenishmentBatch.findFirstOrThrow({ where: { id: body.batchId, tenantId: context.tenantId }, select: { batchNo: true } })
      const prefix = `PO-${batch.batchNo}-`
      const sequence = (await tx.purchaseOrder.count({ where: { tenantId: context.tenantId, number: { startsWith: prefix } } })) + 1
      const order = await tx.purchaseOrder.create({
        data: {
          tenantId: context.tenantId,
          supplierId: supplier.id,
          number: `${prefix}${String(sequence).padStart(2, '0')}`,
          status: 'DRAFT',
          currency: supplier.currency,
          notes: `由补货批次 ${batch.batchNo} 生成的草稿；商品成本尚未接入，单价与总额为空`,
          createdById: context.userId,
          lines: { create: lines.map(({ rec, quantity }) => ({ sellerSku: rec.sku, asin: rec.asin || null, quantity, currency: supplier.currency })) },
        },
      })
      await tx.replenishmentAction.createMany({
        data: lines.map(({ rec, quantity }) => ({
          tenantId: context.tenantId,
          batchId: body.batchId,
          recommendationId: rec.id,
          action: 'PURCHASE_DRAFT',
          finalQty: quantity,
          targetDocType: 'PURCHASE_ORDER',
          targetDocId: order.id,
          actorId: context.userId,
        })),
      })
      await this.refresh(tx, context.tenantId, body.batchId)
      await this.audit.record(
        req,
        { action: 'REPLENISHMENT_PURCHASE_DRAFTED', resourceType: 'PurchaseOrder', resourceId: order.id, after: { number: order.number, lineCount: lines.length }, detail: { batchId: body.batchId } },
        { client: tx },
      )
      return {
        state: 'DONE' as const,
        note: '已生成采购单草稿，请到采购模块核对价格后提交',
        documents: [{ type: 'PURCHASE_ORDER' as const, id: order.id, number: order.number, lineCount: lines.length }],
        actions: lines.length,
      }
    })
  }

  /**
   * 上游仓储入库订单草稿：真实创建“本地草稿”（不调用亚马逊），同一店铺的建议合成一张订单；草稿只带 SKU 与数量，包装与地址要到上游仓储页补全后才能提交。
   * 之前只登记过（PENDING_TARGET）的建议不算已生成，可以重新生成。
   */
  async toAwdDraft(req: RequestWithContext, rawBody: unknown): Promise<DraftResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    await this.context.authorize(req, 'awd.order.write')
    const body = ToDraftBodySchema.parse(rawBody)
    return this.prisma.$transaction(async tx => {
      const recs = await this.targets(
        tx,
        context.tenantId,
        scope,
        body.batchId,
        body.items.map(item => item.recommendationId),
      )
      const done = await tx.replenishmentAction.findMany({
        where: { tenantId: context.tenantId, batchId: body.batchId, action: 'AWD_DRAFT', status: 'DONE', recommendationId: { in: [...recs.keys()] } },
        select: { recommendationId: true },
      })
      if (done.length)
        throw appError('CONFLICT', `有 ${done.length} 条建议已经生成过上游仓储入库订单草稿，不能重复生成`, { details: { recommendationIds: done.map(item => item.recommendationId).join(',') } })
      const batch = await tx.replenishmentBatch.findFirstOrThrow({ where: { id: body.batchId, tenantId: context.tenantId }, select: { batchNo: true } })
      const byStore = new Map<string, Array<{ recommendationId: string; sku: string; qty: number }>>()
      for (const item of body.items) {
        const rec = recs.get(item.recommendationId) as ReplenishmentRecommendation
        const qty = item.qty ?? rec.recommendedQty
        if (qty <= 0) throw appError('VALIDATION_FAILED', `SKU ${rec.sku} 的建议补货量为 0，请填写数量或先排除`, { fieldErrors: { items: [`${rec.sku} 补货量为 0`] } })
        byStore.set(rec.sellerAccountId, [...(byStore.get(rec.sellerAccountId) ?? []), { recommendationId: rec.id, sku: rec.sku, qty }])
      }
      const refs = await this.awdDrafts.createFromReplenishment(tx, {
        tenantId: context.tenantId,
        userId: context.userId,
        batchId: body.batchId,
        batchNo: batch.batchNo,
        stores: [...byStore.entries()].map(([sellerAccountId, items]) => ({ sellerAccountId, items })),
      })
      const qtyOf = new Map([...byStore.values()].flat().map(item => [item.recommendationId, item.qty]))
      await tx.replenishmentAction.createMany({
        data: refs.flatMap(ref =>
          ref.recommendationIds.map(recommendationId => ({
            tenantId: context.tenantId,
            batchId: body.batchId,
            recommendationId,
            action: 'AWD_DRAFT',
            finalQty: qtyOf.get(recommendationId) ?? null,
            targetDocType: 'AWD_ORDER',
            targetDocId: ref.id,
            actorId: context.userId,
          })),
        ),
      })
      await this.refresh(tx, context.tenantId, body.batchId)
      for (const ref of refs) {
        await this.audit.record(
          req,
          {
            action: 'AWD_ORDER_CREATED',
            resourceType: 'AwdInboundOrder',
            resourceId: ref.id,
            after: { status: 'LOCAL_DRAFT', source: 'REPLENISHMENT', lineCount: ref.lineCount },
            detail: { batchId: body.batchId },
          },
          { client: tx },
        )
      }
      return {
        state: 'DONE' as const,
        note: '已生成上游仓储入库订单草稿（只在本地保存，没有调用亚马逊）；请到上游仓储页补全包装与发货地址后再提交',
        documents: refs.map(ref => ({ type: 'AWD_ORDER' as const, id: ref.id, number: ref.reference, lineCount: ref.lineCount })),
        actions: refs.reduce((sum, ref) => sum + ref.recommendationIds.length, 0),
      }
    })
  }
}

function countBy(values: readonly ReplenishAction[] | readonly string[]) {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}
