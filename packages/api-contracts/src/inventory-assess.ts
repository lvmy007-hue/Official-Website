import { DEMAND_METHOD, type InboundKind, type InventoryAssessment, type InventoryDemand, type InventoryPolicy, type InventoryRiskLevel } from './inventory.js'

// 库存健康规则引擎（06 章 6.1“健康规则”；freeze/metrics.md M-210）。纯函数，不读数据库。
// 接口侧的库存健康页与后台任务的预警评估（P2a-15）共用这一份，保证“页面上显示高风险”与“系统发出断货预警”是同一个判断。
// 1. 可售天数 =（可售 + 计入的在途）÷ 预测日销；
// 2. 预计断货日 = 今天 + 可售天数；
// 3. 高：断货日早于最快补货到仓日（取“采购链提前期”与“上游仓储调拨时效”中更快的一个）；
//    中：断货日仍在安全库存覆盖范围内（早于最快到仓日 + 安全库存天数）；
//    冗余：覆盖天数超过目标覆盖天数 × 冗余倍数；
// 4. 参数全部来自补货策略的生效版本，不使用固定阈值；没有策略时不判定。

const DAY = 86_400_000
const ms = (date: string) => Date.parse(`${date}T00:00:00Z`)
export const isoPlusDays = (date: string, days: number) => new Date(ms(date) + days * DAY).toISOString().slice(0, 10)
export const isoDaysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / DAY)
const round1 = (value: number) => Math.round(value * 10) / 10
const round3 = (value: number) => Math.round(value * 1000) / 1000

/** 订单汇总（AsinDailySummary）在 [今天-90, 昨天] 内的聚合结果；没有任何行时整体为 null。 */
export interface OrderWindows {
  units7: number
  units30: number
  units60: number
  units90: number
  /** 90 天窗口内最早出现销量记录的日期（用于新品缩短窗口）。 */
  firstSeen: string
  /** 近 30 天内已知库存为 0 的日子数，及这些日子里卖出的件数。 */
  stockoutDays30: number
  stockoutUnits30: number
}

/** 亚马逊库存规划报告里的近 7/30/60/90 天销量（官方口径，不做断货剔除）。 */
export interface ReportSales {
  t7: number | null
  t30: number | null
  t60: number | null
  t90: number | null
}

const none = (): InventoryDemand => ({
  source: null,
  low: null,
  mid: null,
  high: null,
  units7: null,
  units30: null,
  units60: null,
  units90: null,
  stockoutDaysExcluded: 0,
  historyDays: null,
  method: DEMAND_METHOD,
})

/** 预测日销（低、中、高）。优先用我方订单汇总，没有订单记录时退回亚马逊报告销量；两者都没有则不预测。 */
export function computeInventoryDemand(orders: OrderWindows | null, report: ReportSales | null, today: string): InventoryDemand {
  if (orders) {
    const yesterday = isoPlusDays(today, -1)
    const span = Math.max(1, isoDaysBetween(orders.firstSeen, yesterday) + 1)
    const eff = (window: number) => Math.min(window, span)
    const rate7 = orders.units7 / eff(7)
    const rate90 = orders.units90 / eff(90)
    const usable = eff(30) - orders.stockoutDays30
    const excluded = usable >= 1 && orders.stockoutDays30 > 0
    const rate30 = excluded ? Math.max(0, orders.units30 - orders.stockoutUnits30) / usable : orders.units30 / eff(30)
    const rates = [rate7, rate30, rate90]
    return {
      source: 'ORDERS',
      low: round3(Math.min(...rates)),
      mid: round3(rate30),
      high: round3(Math.max(...rates)),
      units7: orders.units7,
      units30: orders.units30,
      units60: orders.units60,
      units90: orders.units90,
      stockoutDaysExcluded: excluded ? orders.stockoutDays30 : 0,
      historyDays: span,
      method: DEMAND_METHOD,
    }
  }
  if (report && report.t30 !== null) {
    const rate30 = report.t30 / 30
    const rates = [rate30, ...(report.t7 !== null ? [report.t7 / 7] : []), ...(report.t90 !== null ? [report.t90 / 90] : [])]
    return {
      source: 'AMAZON_REPORT',
      low: round3(Math.min(...rates)),
      mid: round3(rate30),
      high: round3(Math.max(...rates)),
      units7: report.t7,
      units30: report.t30,
      units60: report.t60,
      units90: report.t90,
      stockoutDaysExcluded: 0,
      historyDays: null,
      method: DEMAND_METHOD,
    }
  }
  return none()
}

export function countedInboundQty(kinds: readonly InboundKind[], quantities: { working: number; shipped: number; receiving: number }): number {
  return (kinds.includes('WORKING') ? quantities.working : 0) + (kinds.includes('SHIPPED') ? quantities.shipped : 0) + (kinds.includes('RECEIVING') ? quantities.receiving : 0)
}

export interface AssessInput {
  policy: InventoryPolicy | null
  sellable: number | null
  inboundCounted: number
  demandMid: number | null
  /** 上游仓储可调拨数量；仓储分销同步器（P2a-08）交付前为 null，不计入“更快的补货路径”。 */
  awdQty: number | null
  today: string
}

const empty = (reason: InventoryAssessment['reason'], state: InventoryAssessment['state'], policy: InventoryPolicy | null): InventoryAssessment => ({
  state,
  reason,
  risk: null,
  daysOfCover: null,
  noDemand: false,
  stockoutDate: null,
  fastestLeadDays: null,
  fastestReplenishDate: null,
  targetDays: policy?.coverageDays ?? null,
  policyVersion: policy?.versionNo ?? null,
})

export function assessInventory(input: AssessInput): InventoryAssessment {
  const { policy } = input
  if (!policy) return empty('NO_POLICY', 'NOT_CONNECTED', null)
  if (input.sellable === null) return empty('NO_QUANTITY', 'NO_DATA', policy)
  if (input.demandMid === null) return empty('NO_DEMAND_DATA', 'NO_DATA', policy)

  const onHand = input.sellable + input.inboundCounted
  const awdFaster = policy.awdLeadTimeDays !== null && (input.awdQty ?? 0) > 0
  const fastest = awdFaster ? Math.min(policy.leadTimeDays, policy.awdLeadTimeDays as number) : policy.leadTimeDays
  const base = {
    state: 'OK' as const,
    reason: null,
    targetDays: policy.coverageDays,
    policyVersion: policy.versionNo,
    fastestLeadDays: fastest,
    fastestReplenishDate: isoPlusDays(input.today, fastest),
  }

  if (input.demandMid <= 0) {
    // 有记录但近期没有销量：覆盖天数无穷大，有库存即视为冗余
    return { ...base, risk: onHand > 0 ? 'EXCESS' : 'NORMAL', daysOfCover: null, noDemand: true, stockoutDate: null }
  }
  const cover = onHand / input.demandMid
  let risk: InventoryRiskLevel = 'NORMAL'
  if (cover < fastest) risk = 'HIGH'
  else if (cover < fastest + policy.safetyDays) risk = 'MEDIUM'
  else if (cover > policy.coverageDays * policy.redundancyMultiplier) risk = 'EXCESS'
  return { ...base, risk, daysOfCover: round1(cover), noDemand: false, stockoutDate: isoPlusDays(input.today, Math.floor(cover)) }
}

const RISK_RANK: Record<InventoryRiskLevel, number> = { HIGH: 0, MEDIUM: 1, NORMAL: 2, EXCESS: 3 }
export const inventoryRiskRank = (risk: InventoryRiskLevel | null) => (risk === null ? 4 : RISK_RANK[risk])

/** 库龄风险：处于“起算天数”及以上库龄的数量大于 0，或报告给出了库龄附加费预估大于 0。 */
export function agingRiskOf(age: { age181to270: number | null; age271to365: number | null; age365plus: number | null; surcharge: number | null } | null, fromDays: number): boolean | null {
  if (!age) return null
  const parts = fromDays <= 181 ? [age.age181to270, age.age271to365, age.age365plus] : fromDays <= 271 ? [age.age271to365, age.age365plus] : [age.age365plus]
  if (parts.every(part => part === null) && age.surcharge === null) return null
  return parts.some(part => (part ?? 0) > 0) || (age.surcharge ?? 0) > 0
}
