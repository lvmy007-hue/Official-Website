import type { FbaInventoryRecord, FbaProduct, InventoryAgeSnapshot, InventoryPlanningSnapshot } from '@prisma/client'
import type { InventoryAssessment, InventoryDemand, InventoryPolicy, InventoryRow } from '@nova/api-contracts'
import { ageFeeBands, ageView, type AgeColumns, type AgeFeeColumns } from './inventory-aging'
import { ourAction } from './inventory-advice'
import { agingRisk, assess, computeDemand, countedInbound, type OrderWindows } from './inventory-rules'

// 把库存记录、规划报告、库龄快照、订单汇总组装成库存健康表的一行。纯函数（不读数据库），便于单测。

type Dec = { toString(): string } | null | undefined
export const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const dateText = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null)
const YES = new Set(['yes', 'y', 'true', '是'])

export interface StrandedInfo {
  qty: number | null
  reason: string | null
}

export interface RowSources {
  record: FbaInventoryRecord & { sellerAccount: { displayName: string } }
  product: Pick<FbaProduct, 'title' | 'brand'> | null
  planning: InventoryPlanningSnapshot | null
  age: InventoryAgeSnapshot | null
  stranded: StrandedInfo | null
  orders: OrderWindows | null
  policy: InventoryPolicy | null
  today: string
}

export interface BuiltRow {
  row: InventoryRow
  /** 详情页要用的原始分段与费用列。 */
  ageColumns: AgeColumns | null
  feeColumns: AgeFeeColumns | null
  agedQty: number | null
}

export function ageColumnsOf(age: InventoryAgeSnapshot | null): AgeColumns | null {
  return age
    ? {
        age0to90: age.age0to90,
        age91to180: age.age91to180,
        age181to270: age.age181to270,
        age271to365: age.age271to365,
        age365plus: age.age365plus,
        age0to30: age.age0to30,
        age31to60: age.age31to60,
        age61to90: age.age61to90,
        age366to455: age.age366to455,
        age456plus: age.age456plus,
      }
    : null
}

export function feeColumnsOf(planning: InventoryPlanningSnapshot | null): AgeFeeColumns | null {
  return planning
    ? {
        aisEst181To210: num(planning.aisEst181To210),
        aisEst211To240: num(planning.aisEst211To240),
        aisEst241To270: num(planning.aisEst241To270),
        aisEst271To300: num(planning.aisEst271To300),
        aisEst301To330: num(planning.aisEst301To330),
        aisEst331To365: num(planning.aisEst331To365),
        aisEst365Plus: num(planning.aisEst365Plus),
      }
    : null
}

export function agedQtyOf(age: AgeColumns | null, fromDays: number): number | null {
  if (!age) return null
  const parts = fromDays <= 181 ? [age.age181to270, age.age271to365, age.age365plus] : fromDays <= 271 ? [age.age271to365, age.age365plus] : [age.age365plus]
  return parts.every(part => part === null) ? null : parts.reduce<number>((total, part) => total + (part ?? 0), 0)
}

export function reportSalesOf(planning: InventoryPlanningSnapshot | null) {
  return planning ? { t7: planning.unitsShippedT7, t30: planning.unitsShippedT30, t60: planning.unitsShippedT60, t90: planning.unitsShippedT90 } : null
}

export function buildRow(src: RowSources): BuiltRow {
  const { record, planning, age, policy, today } = src
  const demand: InventoryDemand = computeDemand(src.orders, reportSalesOf(planning), today)
  const inbound = { working: record.inboundWorkingQuantity, shipped: record.inboundShippedQuantity, receiving: record.inboundReceivingQuantity }
  const inboundCounted = policy ? countedInbound(policy.inboundCounted, inbound) : 0
  const assessment: InventoryAssessment = assess({ policy, sellable: record.fulfillableQuantity, inboundCounted, demandMid: demand.mid, awdQty: null, today })

  const ageCols = ageColumnsOf(age)
  const feeCols = feeColumnsOf(planning)
  const view = ageView(ageCols)
  const surcharge = num(age?.ageSurchargeEstimate)
  const fromDays = policy?.agingFromDays ?? 271
  const atRisk = agingRisk(age ? { age181to270: age.age181to270, age271to365: age.age271to365, age365plus: age.age365plus, surcharge } : null, fromDays)
  const strandedReason = record.strandedReason ?? src.stranded?.reason ?? null
  const lowFee = planning ? num(planning.lowInventoryLevelFee) : null
  const lowApplied = planning?.lowInventoryLevelFeeApplied ?? null
  const lowFeeAtRisk = planning ? (lowApplied !== null && YES.has(lowApplied.trim().toLowerCase())) || (lowFee ?? 0) > 0 : null

  const row: InventoryRow = {
    id: record.id,
    sellerAccountId: record.sellerAccountId,
    storeName: record.sellerAccount.displayName,
    asin: record.asin,
    sku: record.sellerSku,
    fnsku: record.fnsku,
    title: src.product?.title ?? planning?.productName ?? null,
    brand: src.product?.brand ?? null,
    quantity: {
      sellable: record.fulfillableQuantity,
      reserved: record.reservedQuantity,
      reservedCustomerOrder: planning?.reservedCustomerOrder ?? null,
      reservedProcessing: planning?.reservedFcProcessing ?? null,
      reservedTransfer: planning?.reservedFcTransfer ?? null,
      inboundWorking: inbound.working,
      inboundShipped: inbound.shipped,
      inboundReceiving: inbound.receiving,
      inboundTotal: inbound.working + inbound.shipped + inbound.receiving,
      inboundCounted,
      unsellable: record.unfulfillableQuantity,
      researching: record.researchQuantity,
      strandedQty: src.stranded?.qty ?? null,
    },
    demand,
    assessment,
    cover: {
      amazonDaysOfSupply: num(planning?.daysOfSupply) ?? num(record.daysOfSupply),
      amazonShortTermDays: num(planning?.shortTermHistoricalDaysOfSupply),
      amazonLongTermDays: num(planning?.longTermHistoricalDaysOfSupply),
      weeksOfCover: { t7: num(planning?.weeksOfCoverT7), t30: num(planning?.weeksOfCoverT30), t60: num(planning?.weeksOfCoverT60), t90: num(planning?.weeksOfCoverT90) },
      sellThrough: num(planning?.sellThrough),
    },
    age: { granularity: view.granularity, buckets: view.buckets, snapshotDate: dateText(age?.snapshotDate), surchargeEstimate: surcharge, atRisk },
    fees: {
      nextMonthStorage: num(planning?.estimatedStorageCostNextMonth),
      ageSurchargeBands: ageFeeBands(feeCols),
      longTerm6Month: num(planning?.ltsfProjected6Mo),
      longTerm12Month: num(planning?.ltsfProjected12Mo),
      lowInventoryLevelApplied: lowApplied,
      lowInventoryLevelFee: lowFee,
      amazonMinimumLevel: planning?.fbaMinimumInventoryLevel ?? null,
      lowFeeAtRisk,
    },
    seasonality: planning?.seasonality ?? null,
    status: { amazonHealth: planning?.amazonHealthStatus ?? null, strandedReason },
    advice: {
      ourAction: ourAction({
        risk: assessment.risk,
        strandedQty: src.stranded?.qty ?? null,
        strandedReason,
        agingAtRisk: atRisk,
        unsellable: record.unfulfillableQuantity,
        researching: record.researchQuantity,
      }),
      amazonAction: planning?.recommendedAction ?? null,
      amazonSalePrice: num(planning?.recommendedSalesPrice),
      amazonSaleDays: planning?.recommendedSaleDurationDays ?? null,
      amazonRemovalQty: planning?.recommendedRemovalQty ?? null,
      amazonSavings: num(planning?.estimatedCostSavings),
      amazonShipInQty: planning?.recommendedShipInQty ?? null,
      amazonShipInDate: dateText(planning?.recommendedShipInDate),
    },
    dates: { quantityUpdatedAt: record.sourceUpdatedAt.toISOString(), planningDate: dateText(planning?.snapshotDate) },
  }
  return { row, ageColumns: ageCols, feeColumns: feeCols, agedQty: agedQtyOf(ageCols, fromDays) }
}
