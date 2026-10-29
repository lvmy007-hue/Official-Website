import { Injectable } from '@nestjs/common'
import {
  BATCH_INBOUND_PERMISSION,
  BATCH_INBOUND_READ,
  INBOUND_DRAFT_SOURCE_TYPE,
  INBOUND_DRAFT_TARGET,
  INBOUND_WRITE,
  InboundIntentQuerySchema,
  ToInboundDraftsBodySchema,
  US_MARKETPLACE_ID,
  toInboundSourceAddress,
  type CreatedInboundDraft,
  type InboundIntentListResponse,
  type InboundIntentRow,
  type ToInboundDraftsResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { batchStatusOf } from '../replenishment'
import { ShipFromService } from '../ship-from'
import { buildInboundDrafts } from './batch-inbound-build'

type Tx = Prisma.TransactionClient

// 补货批次一键转入仓计划草稿（P6-08，16 章第 5.2 节）。
//   - 要同时有 replenishment.plan.create 与 inbound.plan.write，并且建议在数据范围内（范围外按“不存在”处理）；
//   - dryRun 缺省为 true：只预览分组、数量、地址与不能确认的原因；确认时用与预览相同的计算，预览什么就生成什么；
//   - 一组 = 一个店铺 + 一个发货地址 = 一份真实的入仓计划草稿（FbaInboundPlan，来源为补货批次，记批次编号与发货地址）；不调用亚马逊；
//   - 每条建议记一条已完成的“入仓计划草稿”动作（指向草稿），已转过的建议不能重复转（先锁批次行再检查，并发确认不会生成两份）；
//   - 草稿被取消后，其中的建议可以重新转；以前只登记了意向的记录（PENDING_TARGET）由 `intents` 列出，补建后自动算已解决。
@Injectable()
export class BatchInboundService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly shipFrom: ShipFromService,
  ) {}

  async toDrafts(req: RequestWithContext, batchId: string, rawBody: unknown): Promise<ToInboundDraftsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, BATCH_INBOUND_PERMISSION, {})
    await this.context.authorize(req, INBOUND_WRITE)
    const body = ToInboundDraftsBodySchema.parse(rawBody)
    if (body.dryRun) {
      const built = await buildInboundDrafts(this.prisma, this.shipFrom, { tenantId: context.tenantId, scope, batchId, body })
      return built.preview
    }
    return this.prisma.$transaction(async tx => {
      // 先“摸”一下批次行取得行锁：另一个确认请求要等这个提交后才继续，之后读到的已转记录是最新的
      const locked = await tx.replenishmentBatch.findFirst({ where: { id: batchId, tenantId: context.tenantId }, select: { status: true } })
      if (!locked) throw appError('RESOURCE_NOT_FOUND', '补货批次不存在')
      await tx.replenishmentBatch.update({ where: { id: batchId }, data: { status: locked.status } })
      const built = await buildInboundDrafts(tx, this.shipFrom, { tenantId: context.tenantId, scope, batchId, body })
      if (!built.preview.canConfirm) {
        throw appError(built.conflict ? 'CONFLICT' : 'VALIDATION_FAILED', built.preview.blockers.join('；'), {
          details: { blockers: built.preview.blockers.length, converted: built.preview.converted.length },
        })
      }
      const created: CreatedInboundDraft[] = []
      for (const group of built.groups) {
        const address = group.address
        if (!address) continue
        const plan = await tx.fbaInboundPlan.create({
          data: {
            tenantId: context.tenantId,
            sellerAccountId: group.preview.sellerAccountId,
            marketplaceId: US_MARKETPLACE_ID,
            name: group.preview.planName,
            status: 'DRAFT',
            stage: 'DRAFT',
            sourceAddress: JSON.stringify(toInboundSourceAddress(address)),
            sourceType: INBOUND_DRAFT_SOURCE_TYPE,
            sourceRefId: batchId,
            shipFromAddressId: address.id,
            totalUnits: group.preview.totalUnits,
            createdBy: context.userId,
          },
        })
        await tx.inboundPlanItem.createMany({
          data: group.items.map(item => ({ tenantId: context.tenantId, planId: plan.id, sku: item.rec.sku, quantity: item.quantity, asin: item.asin, fnsku: item.fnsku, productName: item.title })),
        })
        await tx.replenishmentAction.createMany({
          data: group.items.map(item => ({
            tenantId: context.tenantId,
            batchId,
            recommendationId: item.rec.id,
            action: 'INBOUND_DRAFT',
            finalQty: item.quantity,
            targetDocType: INBOUND_DRAFT_TARGET,
            targetDocId: plan.id,
            actorId: context.userId,
          })),
        })
        await this.audit.record(
          req,
          {
            action: 'FBA_INBOUND_PLAN_CREATED',
            resourceType: 'FbaInboundPlan',
            resourceId: plan.id,
            after: { name: plan.name, stage: plan.stage, units: plan.totalUnits, source: INBOUND_DRAFT_SOURCE_TYPE, shipFromAddress: address.name },
            detail: { batchId, batchNo: built.batch.batchNo, skuCount: group.items.length },
          },
          { client: tx },
        )
        created.push({
          planId: plan.id,
          name: plan.name,
          sellerAccountId: group.preview.sellerAccountId,
          storeName: group.preview.storeName,
          skuCount: group.items.length,
          totalUnits: group.preview.totalUnits,
          shipFromAddressId: address.id,
          shipFromAddressName: address.name,
        })
      }
      const actions = built.groups.reduce((sum, group) => sum + group.items.length, 0)
      await this.refresh(tx, context.tenantId, batchId)
      await this.audit.record(
        req,
        { action: 'REPLENISHMENT_INBOUND_DRAFTED', resourceType: 'ReplenishmentBatch', resourceId: batchId, detail: { plans: created.length, items: actions } },
        { client: tx },
      )
      return { dryRun: false as const, batchId, batchNo: built.batch.batchNo, plans: created, actions }
    })
  }

  private async refresh(tx: Tx, tenantId: string, batchId: string) {
    const [recs, actions] = await Promise.all([
      tx.replenishmentRecommendation.findMany({ where: { tenantId, batchId }, select: { id: true }, take: 6000 }),
      tx.replenishmentAction.findMany({ where: { tenantId, batchId }, select: { recommendationId: true, action: true }, take: 20_000 }),
    ])
    await tx.replenishmentBatch.update({
      where: { id: batchId },
      data: {
        status: batchStatusOf(
          recs.map(rec => rec.id),
          actions,
        ),
      },
    })
  }

  /** 以前只登记了“要生成入仓计划”、没有生成单据的意向：同一条建议后来补建了草稿，就不再出现在这里。 */
  async intents(req: RequestWithContext, rawQuery: Record<string, string>): Promise<InboundIntentListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, BATCH_INBOUND_READ, rawQuery)
    const query = InboundIntentQuerySchema.parse(rawQuery)
    const where: Prisma.ReplenishmentActionWhereInput = {
      tenantId: context.tenantId,
      action: 'INBOUND_DRAFT',
      status: 'PENDING_TARGET',
      ...(query.batchId ? { batchId: query.batchId } : {}),
      recommendation: { ...storeWhere(scope), actions: { none: { action: 'INBOUND_DRAFT', status: 'DONE' } } },
    }
    const [total, rows] = await Promise.all([
      this.prisma.replenishmentAction.count({ where }),
      this.prisma.replenishmentAction.findMany({
        where,
        orderBy: [{ createdAt: query.sort.dir }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { batch: { select: { batchNo: true } }, recommendation: { select: { sku: true, asin: true, sellerAccountId: true } } },
      }),
    ])
    const storeIds = [...new Set(rows.map(row => row.recommendation.sellerAccountId))]
    const [stores, products] = rows.length
      ? await Promise.all([
          this.prisma.sellerAccount.findMany({ where: { tenantId: context.tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 500 }),
          this.prisma.fbaProduct.findMany({
            where: { tenantId: context.tenantId, sellerAccountId: { in: storeIds }, sellerSku: { in: rows.map(row => row.recommendation.sku) } },
            select: { sellerAccountId: true, sellerSku: true, title: true },
            take: 1000,
          }),
        ])
      : [[], []]
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const titles = new Map(products.map(item => [`${item.sellerAccountId}|${item.sellerSku}`, item.title]))
    const items: InboundIntentRow[] = rows.map(row => ({
      actionId: row.id,
      batchId: row.batchId,
      batchNo: row.batch.batchNo,
      recommendationId: row.recommendationId,
      sellerAccountId: row.recommendation.sellerAccountId,
      storeName: names.get(row.recommendation.sellerAccountId) ?? row.recommendation.sellerAccountId,
      sku: row.recommendation.sku,
      asin: row.recommendation.asin,
      title: titles.get(`${row.recommendation.sellerAccountId}|${row.recommendation.sku}`) ?? null,
      qty: row.finalQty,
      registeredAt: row.createdAt.toISOString(),
    }))
    return { items, page: query.page, pageSize: query.pageSize, total }
  }
}
