import {
  assessInventory,
  computeInventoryDemand,
  countedInboundQty,
  inventoryAgeCrossings,
  type AgeCrossing,
  type InventoryAgeColumns,
  type InventoryAgeFeeColumns,
  type InventoryAssessment,
  type InventoryPolicy,
  type OrderWindows,
} from '@nova/api-contracts'
import type { FbaInventoryRecord, InventoryAgeSnapshot, InventoryPlanningSnapshot } from '@prisma/client'

// 库存预警的事实行（P2a-15）：把一条库存记录与它的规划报告、库龄快照、滞留快照、订单汇总合成预警评估要用的字段。纯函数，不读数据库。
// 判断全部走 @nova/api-contracts 里与库存健康页共用的规则引擎，所以“页面上是高风险”与“系统发出断货预警”不会各算各的。

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const YES = new Set(['yes', 'y', 'true', '是'])

export interface InventoryFact {
  recordId: string
  sellerAccountId: string
  storeName: string
  sku: string
  asin: string
  title: string | null
  sellable: number
  inboundCounted: number
  demandMid: number | null
  assessment: InventoryAssessment
  planningDate: string | null
  /** 收费档的跨档窗口（只含收取库龄附加费的档、且在库存规则的“库龄起算天数”及以上） */
  agingTiers: AgeCrossing[]
  agingSnapshotDate: string | null
  lowFee: { atRisk: boolean | null; fee: number | null; applied: string | null; currency: string | null }
  stranded: { qty: number | null; reason: string | null }
  nextMonthStorage: number | null
}

export interface InventoryFactSource {
  store: { id: string; name: string }
  record: FbaInventoryRecord
  title: string | null
  planning: InventoryPlanningSnapshot | null
  age: InventoryAgeSnapshot | null
  stranded: { qty: number | null; reason: string | null } | null
  orders: OrderWindows | null
  policy: InventoryPolicy | null
  today: string
}

const dateText = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null)

function ageColumns(age: InventoryAgeSnapshot | null): InventoryAgeColumns | null {
  if (!age) return null
  return {
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
}

function feeColumns(planning: InventoryPlanningSnapshot | null): InventoryAgeFeeColumns | null {
  if (!planning) return null
  return {
    aisEst181To210: num(planning.aisEst181To210),
    aisEst211To240: num(planning.aisEst211To240),
    aisEst241To270: num(planning.aisEst241To270),
    aisEst271To300: num(planning.aisEst271To300),
    aisEst301To330: num(planning.aisEst301To330),
    aisEst331To365: num(planning.aisEst331To365),
    aisEst365Plus: num(planning.aisEst365Plus),
  }
}

export function buildInventoryFact(src: InventoryFactSource): InventoryFact {
  const { record, planning, age, policy, today } = src
  const demand = computeInventoryDemand(
    src.orders,
    planning ? { t7: planning.unitsShippedT7, t30: planning.unitsShippedT30, t60: planning.unitsShippedT60, t90: planning.unitsShippedT90 } : null,
    today,
  )
  const inboundCounted = policy
    ? countedInboundQty(policy.inboundCounted, { working: record.inboundWorkingQuantity, shipped: record.inboundShippedQuantity, receiving: record.inboundReceivingQuantity })
    : 0
  const assessment = assessInventory({ policy, sellable: record.fulfillableQuantity, inboundCounted, demandMid: demand.mid, awdQty: null, today })

  const agingSnapshotDate = dateText(age?.snapshotDate)
  const fromDays = policy?.agingFromDays ?? 271 // 与库存健康页一致：没有库存规则时按 271 天起算
  const agingTiers = agingSnapshotDate ? inventoryAgeCrossings(ageColumns(age), feeColumns(planning), agingSnapshotDate, today).filter(item => item.feeTier && item.boundaryDays >= fromDays) : []

  const fee = planning ? num(planning.lowInventoryLevelFee) : null
  const applied = planning?.lowInventoryLevelFeeApplied ?? null
  const atRisk = planning ? (applied !== null && YES.has(applied.trim().toLowerCase())) || (fee ?? 0) > 0 : null

  return {
    recordId: record.id,
    sellerAccountId: record.sellerAccountId,
    storeName: src.store.name,
    sku: record.sellerSku,
    asin: record.asin,
    title: src.title ?? planning?.productName ?? null,
    sellable: record.fulfillableQuantity,
    inboundCounted,
    demandMid: demand.mid,
    assessment,
    planningDate: dateText(planning?.snapshotDate),
    agingTiers,
    agingSnapshotDate,
    lowFee: { atRisk, fee, applied, currency: planning?.currency ?? null },
    stranded: { qty: src.stranded?.qty ?? null, reason: record.strandedReason ?? src.stranded?.reason ?? null },
    nextMonthStorage: num(planning?.estimatedStorageCostNextMonth),
  }
}
