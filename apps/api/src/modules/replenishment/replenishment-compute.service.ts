import { Injectable } from '@nestjs/common'
import {
  CALC_STATE_LABEL,
  RecomputeBodySchema,
  REPLENISH_METHOD,
  type AmazonReplenishment,
  type BatchSnapshot,
  type CalcState,
  type RecomputeResponse,
  type ReplenishCalc,
  type ReplenishPolicy,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { assertStoreInScope, ContextService, type ResolvedScope } from '../auth'
import { diffReasons, InventoryPolicyService, plusDays } from '../inventory'
import { computeReplenishment } from './replenishment-engine'
import { ReplenishmentLoaderService, type SkuInput } from './replenishment-loader.service'
import { ReplenishmentPolicyService } from './replenishment-policy.service'
import { asInventoryPolicy, indexPolicies, pickPolicy } from './replenishment-resolve'
import { batchSummaryOf } from './replenishment-rows'

const PERMISSION = 'replenishment.plan.create'
const CHUNK = 500
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)

/** 一个库存行的计算：策略三级解析 → 计算链；没有接入的供给来源一律 null；上游仓储取 AWD 可用量 + 在途入库量（补往亚马逊物流的在途 outboundToFbaInTransit 已经计入亚马逊物流在途，不重复加）。 */
export function calculate(item: SkuInput, policy: ReplenishPolicy | null, today: string): ReplenishCalc {
  return computeReplenishment({
    today,
    policy,
    quantity: {
      sellable: item.row.quantity.sellable,
      inboundWorking: item.row.quantity.inboundWorking,
      inboundShipped: item.row.quantity.inboundShipped,
      inboundReceiving: item.row.quantity.inboundReceiving,
    },
    demand: item.row.demand,
    subscribe: item.subscribe,
    supply: { awd: item.awdQty, domestic: null, purchaseInTransit: null },
    overrides: item.overrides,
  })
}

export function amazonViewOf(item: SkuInput): AmazonReplenishment | null {
  const restock = item.restock
  if (!restock) return null
  return {
    state: 'OK',
    note: null,
    recommendedQty: restock.recommendedQty,
    recommendedShipDate: restock.recommendedShipDate ? restock.recommendedShipDate.toISOString().slice(0, 10) : null,
    alertReason: restock.alertReason,
    recommendedAction: restock.recommendedAction,
    source: 'RESTOCK_REPORT',
    snapshotDate: restock.snapshotDate.toISOString().slice(0, 10),
  }
}

/** 双源核对：我方建议量与亚马逊官方建议量的差异原因；亚马逊没有建议时写明。 */
export function diffOf(item: SkuInput, calc: ReplenishCalc, policy: ReplenishPolicy | null): string | null {
  const amazon = amazonViewOf(item)
  if (!amazon) return '亚马逊补货建议报告里没有这个 SKU，无法对比'
  const q = item.row.quantity
  const reasons = diffReasons({
    oursQty: calc.recommendedQty,
    amazon,
    amazonUnits30: item.restock?.unitsSold30d ?? null,
    demand: item.row.demand,
    policy: policy ? asInventoryPolicy(policy) : null,
    inbound: { working: q.inboundWorking, shipped: q.inboundShipped, receiving: q.inboundReceiving },
  })
  return reasons.length ? reasons.join('；') : null
}

function nextBatchNo(today: string, existing: number) {
  return `RB-${today.replaceAll('-', '')}-${String(existing + 1).padStart(3, '0')}`
}

// 重算：对范围内每个店铺 SKU 跑一遍计算链，产出一个批次（冻结当时的输入与策略版本）；只保存建议量大于 0 的行，其余按原因计数写进批次快照。
@Injectable()
export class ReplenishmentComputeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly loader: ReplenishmentLoaderService,
    private readonly policies: ReplenishmentPolicyService,
    private readonly inventoryPolicies: InventoryPolicyService,
  ) {}

  async recompute(req: RequestWithContext, rawBody: unknown): Promise<RecomputeResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const body = RecomputeBodySchema.parse(rawBody ?? {})
    const narrowed = narrow(scope, body.storeIds)
    const today = await this.inventoryPolicies.todayOf(context.tenantId)
    const index = indexPolicies(await this.policies.effectiveOf(context.tenantId, today))
    const loaded = await this.loader.load({ tenantId: context.tenantId, scope: narrowed, today })

    const skipped: Record<string, number> = {}
    const used = new Map<string, { level: ReplenishPolicy['level']; levelRef: string; versionNo: number }>()
    const rows: Array<{ item: SkuInput; calc: ReplenishCalc; policy: ReplenishPolicy | null }> = []
    let subscribeUsed = 0
    let overrideUsed = 0
    let unavoidableSkus = 0
    let unavoidableIncludedSkus = 0
    for (const item of loaded.items) {
      const policy = pickPolicy(index, item.row.sku, item.category)
      const calc = calculate(item, policy, today)
      if (policy && calc.state !== 'NO_POLICY') used.set(`${policy.level}|${policy.levelRef}`, { level: policy.level, levelRef: policy.levelRef, versionNo: policy.versionNo })
      if (calc.subscribeUsed) subscribeUsed += 1
      if (calc.appliedOverride.some(rule => rule.applied)) overrideUsed += 1
      if ((calc.unavoidableShortage ?? 0) > 0) {
        unavoidableSkus += 1
        if (calc.unavoidableIncluded) unavoidableIncludedSkus += 1
      }
      if (calc.state === 'OK') rows.push({ item, calc, policy })
      else skipped[CALC_STATE_LABEL[calc.state as CalcState]] = (skipped[CALC_STATE_LABEL[calc.state as CalcState]] ?? 0) + 1
    }
    const storeIds = [...new Set(loaded.items.map(item => item.row.sellerAccountId))].sort()
    const quantityTimes = loaded.items
      .map(item => item.row.dates.quantityUpdatedAt)
      .filter((value): value is string => Boolean(value))
      .sort()
    const snapshot: BatchSnapshot = {
      method: REPLENISH_METHOD,
      today,
      storeIds,
      skipped,
      truncated: loaded.truncated,
      subscribeSaveUsed: subscribeUsed,
      overrideUsed,
      unavoidableSkus,
      unavoidableIncludedSkus,
      // 库存更新时间取范围内最旧的一条（最保守地反映数据新鲜度）
      dataTimes: { inventoryUpdatedAt: quantityTimes[0] ?? null, ordersThrough: plusDays(today, -1), restockSnapshotDate: loaded.restockSnapshotDate },
    }

    const batch = await this.prisma
      .$transaction(
        async tx => {
          const sameDay = await tx.replenishmentBatch.count({ where: { tenantId: context.tenantId, today: asDate(today) } })
          const created = await tx.replenishmentBatch.create({
            data: {
              tenantId: context.tenantId,
              batchNo: nextBatchNo(today, sameDay),
              today: asDate(today),
              storeIdsJson: storeIds,
              policyVersionsJson: [...used.values()] as unknown as Prisma.InputJsonValue,
              snapshotJson: snapshot as unknown as Prisma.InputJsonValue,
              skuTotal: loaded.items.length,
              recommendedCount: rows.length,
              computedBy: context.userId,
            },
          })
          for (let start = 0; start < rows.length; start += CHUNK) {
            await tx.replenishmentRecommendation.createMany({
              data: rows.slice(start, start + CHUNK).map(({ item, calc, policy }) => ({
                tenantId: context.tenantId,
                batchId: created.id,
                sellerAccountId: item.row.sellerAccountId,
                sku: item.row.sku,
                asin: item.row.asin,
                fnsku: item.row.fnsku,
                riskLevel: calc.risk,
                recommendedQty: calc.recommendedQty,
                purchaseQty: calc.purchaseQty,
                dueDate: asDate(calc.orderDate as string),
                shipDate: calc.shipDate ? asDate(calc.shipDate) : null,
                arriveDate: calc.arriveDate ? asDate(calc.arriveDate) : null,
                stockoutDate: calc.stockoutDate ? asDate(calc.stockoutDate) : null,
                confidence: calc.confidence.toFixed(4),
                calcStepsJson: {
                  dailyDemand: calc.dailyDemand,
                  coverageDays: policy?.coverageDays ?? null,
                  // P6-09 冻结在这条建议里：之后改规则、改策略都不会改变已生成的批次
                  supplyInLeadTime: calc.supplyInLeadTime,
                  supplyBeyondLeadTime: calc.supplyBeyondLeadTime,
                  unavoidableShortage: calc.unavoidableShortage,
                  unavoidableIncluded: calc.unavoidableIncluded,
                  appliedOverride: calc.appliedOverride,
                  steps: calc.steps,
                } as unknown as Prisma.InputJsonValue,
                shipmentsJson: calc.shipments as unknown as Prisma.InputJsonValue,
                amazonRestockQty: item.restock?.recommendedQty ?? null,
                amazonShipDate: item.restock?.recommendedShipDate ?? null,
                diffReason: diffOf(item, calc, policy),
              })),
            })
          }
          await this.audit.record(
            req,
            {
              action: 'REPLENISHMENT_RECOMPUTED',
              resourceType: 'ReplenishmentBatch',
              resourceId: created.id,
              before: null,
              after: { batchNo: created.batchNo, skuTotal: created.skuTotal, recommendedCount: created.recommendedCount, storeCount: storeIds.length },
              detail: { skipped },
            },
            { client: tx },
          )
          return created
        },
        { timeout: 60_000 },
      )
      .catch((error: unknown) => {
        if ((error as { code?: string } | null)?.code === 'P2002') throw appError('CONFLICT', '刚有另一次重算产生了同一个批次号，请稍后重试')
        throw error
      })
    const names = await memberNames(this.prisma, context.tenantId, [context.userId])
    return { batch: batchSummaryOf(batch, names), snapshot }
  }
}

/** 把用户选择的店铺收窄在其数据范围内（范围外的店铺返回 403）。 */
function narrow(scope: ResolvedScope, storeIds: string[] | undefined): ResolvedScope {
  if (!storeIds || storeIds.length === 0) return scope
  for (const id of storeIds) assertStoreInScope(scope, id)
  return { unrestricted: false, sellerAccountIds: [...new Set(storeIds)] }
}
