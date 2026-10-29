import type { AppliedOverride, BatchStatus, BatchSummary, BatchSnapshot, CalcStep, InventoryRiskLevel, RecommendationRow, ReplenishAction, Shipment } from '@nova/api-contracts'
import type { ReplenishmentAction, ReplenishmentBatch, ReplenishmentRecommendation } from '@prisma/client'
import { nameOrFormer } from '../../platform/people'
import { effectiveActions } from './replenishment-status'

// 数据库行 → 接口行（纯函数）。

const dateText = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)
const dec = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

export function batchSummaryOf(batch: ReplenishmentBatch, names: ReadonlyMap<string, string>): BatchSummary {
  return {
    id: batch.id,
    batchNo: batch.batchNo,
    status: batch.status as BatchStatus,
    today: batch.today.toISOString().slice(0, 10),
    computedAt: batch.computedAt.toISOString(),
    computedBy: nameOrFormer(names, batch.computedBy),
    skuTotal: batch.skuTotal,
    recommendedCount: batch.recommendedCount,
    policyVersions: (batch.policyVersionsJson as BatchSummary['policyVersions'] | null) ?? [],
  }
}

export const snapshotOf = (batch: ReplenishmentBatch) => batch.snapshotJson as unknown as BatchSnapshot

/** 冻结的计算结果：计算链 8 步、第 1 步的日销数值与当时的目标覆盖天数（结果回看用）。 */
export interface Frozen {
  dailyDemand: number | null
  coverageDays: number | null
  steps: CalcStep[]
  // P6-09 才有的记录：旧批次没有这些键，读出来是 undefined（页面显示“旧批次没有记录”，不当 0）
  supplyInLeadTime?: number | null
  supplyBeyondLeadTime?: number | null
  unavoidableShortage?: number | null
  unavoidableIncluded?: boolean | null
  appliedOverride?: AppliedOverride[]
}
export const frozenOf = (rec: { calcStepsJson: unknown }) => rec.calcStepsJson as unknown as Frozen

const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000
/** 建议发货日距今天数：负数表示已逾期。 */
export const daysFrom = (today: string, date: string) => Math.round(dayNumber(date) - dayNumber(today))

export type RecommendationWithActions = ReplenishmentRecommendation & { actions: ReplenishmentAction[] }

export function recommendationRowOf(rec: RecommendationWithActions, ctx: { storeName: string; title: string | null; restockSnapshotDate: string | null; today: string }): RecommendationRow {
  const frozen = frozenOf(rec)
  const orderDate = dateText(rec.dueDate) as string
  const suggestedShipDate = dateText(rec.shipDate) ?? orderDate
  return {
    id: rec.id,
    batchId: rec.batchId,
    sellerAccountId: rec.sellerAccountId,
    storeName: ctx.storeName,
    sku: rec.sku,
    asin: rec.asin,
    title: ctx.title,
    risk: rec.riskLevel as InventoryRiskLevel | null,
    recommendedQty: rec.recommendedQty,
    purchaseQty: rec.purchaseQty,
    orderDate,
    shipDate: dateText(rec.shipDate),
    arriveDate: dateText(rec.arriveDate),
    stockoutDate: dateText(rec.stockoutDate),
    suggestedShipDate,
    shipInDays: daysFrom(ctx.today, suggestedShipDate),
    confidence: dec(rec.confidence) as number,
    shipments: rec.shipmentsJson as unknown as Shipment[],
    supplyInLeadTime: frozen.supplyInLeadTime ?? null,
    supplyBeyondLeadTime: frozen.supplyBeyondLeadTime ?? null,
    unavoidableShortage: frozen.unavoidableShortage ?? null,
    unavoidableIncluded: frozen.unavoidableIncluded ?? null,
    appliedOverride: frozen.appliedOverride ?? [],
    // 商品成本版本由 P2a-10 交付；之前不估算占用资金，也不显示 0
    capital: rec.capitalAmount === null ? { state: 'NOT_CONNECTED', amount: null, note: '商品成本尚未接入，占用资金暂无法计算' } : { state: 'OK', amount: dec(rec.capitalAmount), note: null },
    amazon: {
      qty: rec.amazonRestockQty,
      shipDate: dateText(rec.amazonShipDate),
      diffQty: rec.amazonRestockQty === null ? null : rec.recommendedQty - rec.amazonRestockQty,
      diffReason: rec.diffReason,
      snapshotDate: ctx.restockSnapshotDate,
    },
    steps: frozen.steps,
    actions: effectiveActions(rec.actions)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map(action => ({
        action: action.action as ReplenishAction,
        finalQty: action.finalQty,
        status: action.status as 'DONE' | 'PENDING_TARGET',
        targetDocType: action.targetDocType,
        targetDocId: action.targetDocId,
        createdAt: action.createdAt.toISOString(),
      })),
  }
}
