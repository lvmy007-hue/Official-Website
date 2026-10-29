import { ADS_ANOMALY_RULES, type AdsAnomalyKind, type AdsAttributionTree, type AdsQuadrant } from './ads-overview'
import type { DashGranularity } from './dashboard'

// 广告控制台的纯函数（P3-05）：比率、分桶、预算利用率、异常与四象限判断、指标树因子。
// API 与前端共用；全部可空：来源没给的金额是 null，分母为 0 时比率是 null（不编造“无穷大”）。

export interface AdsTotals {
  impressions: number
  clicks: number
  spend: number | null
  sales: number | null
  orders: number
}
export const EMPTY_ADS_TOTALS: AdsTotals = { impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 }

const divide = (numerator: number | null, denominator: number | null): number | null => (numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator)

/** 可空求和：全部为空返回 null。 */
export function addNullable(values: ReadonlyArray<number | null | undefined>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null && value !== undefined) total = (total ?? 0) + value
  return total
}

export const addTotals = (items: readonly AdsTotals[]): AdsTotals => ({
  impressions: items.reduce((total, item) => total + item.impressions, 0),
  clicks: items.reduce((total, item) => total + item.clicks, 0),
  spend: addNullable(items.map(item => item.spend)),
  sales: addNullable(items.map(item => item.sales)),
  orders: items.reduce((total, item) => total + item.orders, 0),
})

export interface AdsRatios {
  /** 花费 ÷ 广告销售额 */
  acos: number | null
  /** 广告销售额 ÷ 花费 */
  roas: number | null
  /** 点击 ÷ 曝光 */
  ctr: number | null
  /** 花费 ÷ 点击 */
  cpc: number | null
  /** 订单 ÷ 点击 */
  cvr: number | null
}

export function adsRatios(totals: AdsTotals): AdsRatios {
  return {
    acos: divide(totals.spend, totals.sales),
    roas: divide(totals.sales, totals.spend),
    ctr: divide(totals.clicks, totals.impressions),
    cpc: divide(totals.spend, totals.clicks),
    cvr: divide(totals.orders, totals.clicks),
  }
}

/** 变化比率；对比期为 0 或缺失返回 null。 */
export function ratioChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null
  return (current - previous) / Math.abs(previous)
}
export const pointChange = (current: number | null, previous: number | null): number | null => (current === null || previous === null ? null : current - previous)

// ---- 分桶（日、周一、月初） ----
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dateOf = (value: number) => new Date(value).toISOString().slice(0, 10)

export function bucketKeyOf(date: string, granularity: DashGranularity): string {
  if (granularity === 'month') return `${date.slice(0, 7)}-01`
  if (granularity === 'week') {
    const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7
    return dateOf(dayMs(date) - weekday * 86_400_000)
  }
  return date
}

/** 把逐日值合并成桶（按桶起始日升序）；桶内全是空则桶的值是空。 */
export function bucketValues(days: ReadonlyArray<{ date: string; value: number | null }>, granularity: DashGranularity): Array<{ key: string; value: number | null }> {
  const sums = new Map<string, number | null>()
  for (const day of days) {
    const key = bucketKeyOf(day.date, granularity)
    const before = sums.get(key) ?? null
    sums.set(key, day.value === null ? before : (before ?? 0) + day.value)
  }
  return [...sums.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, value]) => ({ key, value }))
}

// ---- 预算利用率 ----
/** 两个含首尾的日期区间重叠的天数；结束日为空表示不设结束。 */
export function overlapDays(from: string, to: string, start: string | null, end: string | null): number {
  const low = start && start > from ? start : from
  const high = end && end < to ? end : to
  return high < low ? 0 : Math.round((dayMs(high) - dayMs(low)) / 86_400_000) + 1
}

export interface BudgetedCampaign {
  dailyBudget: number
  spend: number
  startDate: string | null
  endDate: string | null
}
/** 预算利用率：Σ花费 ÷ Σ（日预算 × 重叠天数）；没有可算的活动为 null。 */
export function budgetUtilizationOf(campaigns: readonly BudgetedCampaign[], from: string, to: string): { utilization: number | null; spent: number; budgeted: number } {
  let spent = 0
  let budgeted = 0
  for (const campaign of campaigns) {
    const days = overlapDays(from, to, campaign.startDate, campaign.endDate)
    if (days === 0) continue
    spent += campaign.spend
    budgeted += campaign.dailyBudget * days
  }
  return { utilization: budgeted > 0 ? spent / budgeted : null, spent, budgeted }
}

// ---- 异常与四象限 ----
export interface CampaignTotals {
  spend: number | null
  sales: number | null
  clicks: number
  orders: number
}

/** 异常规则见 ADS_ANOMALY_RULES；一个活动同时命中两条时取“花费无转化”（更严重）。 */
export function campaignAnomaly(campaign: CampaignTotals): AdsAnomalyKind | null {
  const spend = campaign.spend ?? 0
  if (spend < ADS_ANOMALY_RULES.MIN_SPEND) return null
  if (campaign.orders === 0 && campaign.clicks >= ADS_ANOMALY_RULES.MIN_CLICKS) return 'NO_CONVERSION'
  if (campaign.sales !== null && spend > campaign.sales * ADS_ANOMALY_RULES.ACOS_LIMIT) return 'ACOS_OVER_SALES'
  return null
}

/** 四象限：横轴花费（以平均花费为界），纵轴 ACoS（以整体 ACoS 为界）。 */
export function quadrantOf(spend: number, acos: number, spendLine: number, acosLine: number): AdsQuadrant {
  const highSpend = spend >= spendLine
  const highAcos = acos > acosLine
  if (highSpend) return highAcos ? 'WASTE' : 'STAR'
  return highAcos ? 'LOW' : 'POTENTIAL'
}

// ---- 指标树因子 ----
const positive = (value: number | null): value is number => value !== null && value > 0

export interface AttributionResult {
  spend: AdsAttributionTree | null
  sales: AdsAttributionTree | null
  note: string | null
}

/**
 * 花费变化 = 点击 × 单次点击成本；广告销售额变化 = 点击 × 转化率 × 订单均价。
 * 任一因子在任一期不是正数就没法做乘积分解，返回 null 并说明原因（不补 0）。
 */
export function adsAttribution(current: AdsTotals, previous: AdsTotals): AttributionResult {
  const now = adsRatios(current)
  const before = adsRatios(previous)
  const clicks = { key: 'clicks', label: '点击数', before: previous.clicks, after: current.clicks }
  const cpc = { key: 'cpc', label: '单次点击成本', before: before.cpc, after: now.cpc }
  const cvr = { key: 'cvr', label: '转化率（订单 ÷ 点击）', before: before.cvr, after: now.cvr }
  const aov = { key: 'aov', label: '订单均价（广告销售额 ÷ 订单）', before: divide(previous.sales, previous.orders), after: divide(current.sales, current.orders) }
  const complete = (factors: Array<{ key: string; label: string; before: number | null; after: number | null }>) =>
    factors.every(factor => positive(factor.before) && positive(factor.after)) ? (factors as Array<{ key: string; label: string; before: number; after: number }>) : null
  const spendFactors = complete([clicks, cpc])
  const salesFactors = complete([clicks, cvr, aov])
  const spend = spendFactors && positive(previous.spend) && positive(current.spend) ? { title: '花费', before: previous.spend, after: current.spend, factors: spendFactors } : null
  const sales = salesFactors && positive(previous.sales) && positive(current.sales) ? { title: '广告销售额', before: previous.sales, after: current.sales, factors: salesFactors } : null
  const note = spend && sales ? null : '两个期间都要有点击、花费、订单与广告销售额，才能做乘积拆解；缺少的一项不补 0'
  return { spend, sales, note }
}
