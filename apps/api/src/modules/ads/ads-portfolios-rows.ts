import {
  ADS_CONSOLE_CURRENCY,
  ADS_PORTFOLIO_CAMPAIGN_LIMIT,
  ADS_PORTFOLIO_PACE_RULES,
  ADS_PRODUCT_LABEL,
  addNullable,
  addTotals,
  addDaysToText,
  budgetWindowOf,
  paceOf,
  ratiosOf,
  weekdayWeights,
  type AdsPortfolioCampaignShare,
  type AdsPortfolioDetailResponse,
  type AdsPortfolioRow,
  type AdsPortfolioWindow,
  type AdsProductKey,
  type AdsTotals,
} from '@nova/api-contracts'
import { num } from './ads-campaigns-common'
import { campaignKey } from './ads-overview-load'
import { portfolioKeyOf, type DailySpend, type PortfolioCampaign, type PortfolioRecord } from './ads-portfolios-load'

// 广告组合行的装配（P3-11）：纯函数，输入全部加载好的数据，不碰数据库，单测直接喂数据。

const day = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null)
const isEnabled = (state: string) => state.toUpperCase() === 'ENABLED'

export const windowOfRecord = (record: PortfolioRecord, today: string): AdsPortfolioWindow =>
  budgetWindowOf({ budgetPeriod: record.budgetPeriod, budgetStart: day(record.budgetStart), budgetEnd: day(record.budgetEnd) }, today)

/** 窗口的读取键：同一个窗口的组合共用一次查询。 */
export const windowKey = (window: AdsPortfolioWindow) => `${window.from}|${window.to}`

/** 把活动按所属组合分组。 */
export function groupCampaigns(campaigns: readonly PortfolioCampaign[]): Map<string, PortfolioCampaign[]> {
  const groups = new Map<string, PortfolioCampaign[]>()
  for (const campaign of campaigns) {
    const key = portfolioKeyOf(campaign.adsProfileId, campaign.portfolioId)
    groups.set(key, [...(groups.get(key) ?? []), campaign])
  }
  return groups
}

/** 一组活动在某个键表里的合计；没有任何活动有行为 null（不是 0）。 */
export function sumCampaignTotals(campaigns: readonly PortfolioCampaign[], byCampaign: ReadonlyMap<string, AdsTotals>): AdsTotals | null {
  const found = campaigns.flatMap(item => {
    const totals = byCampaign.get(campaignKey(item.adsProfileId, item.adProduct, item.externalCampaignId))
    return totals ? [totals] : []
  })
  return found.length === 0 ? null : addTotals(found)
}

/** 一组活动的逐日花费合计（日期 → 花费）。 */
export function dailyOfCampaigns(campaigns: readonly PortfolioCampaign[], rows: readonly DailySpend[]): Map<string, number> {
  const wanted = new Set(campaigns.map(item => campaignKey(item.adsProfileId, item.adProduct, item.externalCampaignId)))
  const daily = new Map<string, number>()
  for (const row of rows) {
    if (wanted.has(campaignKey(row.adsProfileId, row.adProduct, row.campaignId))) daily.set(row.date, (daily.get(row.date) ?? 0) + row.spend)
  }
  return daily
}

/** 日花费表在含首尾的日期区间内的合计；区间内没有任何一天有行为 null。 */
export function spendBetween(daily: ReadonlyMap<string, number>, from: string, to: string): number | null {
  return addNullable([...daily.entries()].filter(([date]) => date >= from && date <= to).map(([, spend]) => spend))
}

/** 历史节奏的星期权重：只用最近 historyDays 天（到昨天）的逐日花费。 */
export function weightsOf(daily: ReadonlyMap<string, number>) {
  return weekdayWeights([...daily.entries()].map(([date, spend]) => ({ date, spend })))
}

/** 最近 recentDays 天（到昨天）的日均花费：这几天一行都没有为 null，缺的天按 0 平均。 */
export function recentDailyOf(daily: ReadonlyMap<string, number>, today: string): number | null {
  const from = addDaysToText(today, -ADS_PORTFOLIO_PACE_RULES.recentDays)
  const to = addDaysToText(today, -1)
  const total = spendBetween(daily, from, to)
  return total === null ? null : total / ADS_PORTFOLIO_PACE_RULES.recentDays
}

/** 启用中、美元、按日预算的活动的日预算合计；没有可算的活动为 null。 */
export function currentDailyBudgetOf(campaigns: readonly PortfolioCampaign[]): number | null {
  return addNullable(
    campaigns.flatMap(item => {
      const budget = num(item.budget)
      return isEnabled(item.state) && item.budgetType === 'DAILY' && item.currency === ADS_CONSOLE_CURRENCY && budget !== null && budget > 0 ? [budget] : []
    }),
  )
}

/** 逐日花费行按活动合计（键同 campaignKey）；不是这些活动的行忽略。 */
export function campaignSpendOf(campaigns: readonly PortfolioCampaign[], rows: readonly DailySpend[]): Map<string, number> {
  const wanted = new Set(campaigns.map(item => campaignKey(item.adsProfileId, item.adProduct, item.externalCampaignId)))
  const sums = new Map<string, number>()
  for (const row of rows) {
    const key = campaignKey(row.adsProfileId, row.adProduct, row.campaignId)
    if (wanted.has(key)) sums.set(key, (sums.get(key) ?? 0) + row.spend)
  }
  return sums
}

/**
 * 各活动的预算分配：日预算占比（只算启用中、美元、按日预算的活动）与指定区间内的花费占比。
 * 花费只认美元活动；没有汇总行的活动花费为 null（不是 0）。按花费从高到低、空值在后、再按名称与编号排序，最多 ADS_PORTFOLIO_CAMPAIGN_LIMIT 个。
 */
export function allocationOf(
  campaigns: readonly PortfolioCampaign[],
  spendByKey: ReadonlyMap<string, number>,
  period: { from: string; to: string; basis: 'BUDGET_PERIOD' | 'SELECTED_RANGE' },
  portfolioIsUsd: boolean,
): AdsPortfolioDetailResponse['allocation'] {
  if (campaigns.length === 0) return { state: 'NO_DATA', note: '这个组合下还没有同步到活动（活动的所属组合来自活动管理接口）', items: [], truncated: false, period: null }
  const spendOf = (item: PortfolioCampaign): number | null =>
    portfolioIsUsd && item.currency === ADS_CONSOLE_CURRENCY ? (spendByKey.get(campaignKey(item.adsProfileId, item.adProduct, item.externalCampaignId)) ?? null) : null
  const totalSpend = campaigns.reduce((sum, item) => sum + (spendOf(item) ?? 0), 0)
  const dailyTotal = currentDailyBudgetOf(campaigns)
  const items = campaigns
    .map<AdsPortfolioCampaignShare>(item => {
      const spend = spendOf(item)
      const budget = num(item.budget)
      const counted = isEnabled(item.state) && item.budgetType === 'DAILY' && item.currency === ADS_CONSOLE_CURRENCY && budget !== null && budget > 0
      return {
        id: item.id,
        name: item.name,
        adProduct: item.adProduct,
        productLabel: ADS_PRODUCT_LABEL[item.adProduct as AdsProductKey] ?? item.adProduct,
        state: item.state,
        servingStatus: item.servingStatus,
        budget,
        budgetType: item.budgetType,
        currency: item.currency,
        spend,
        spendShare: spend !== null && totalSpend > 0 ? spend / totalSpend : null,
        budgetShare: counted && dailyTotal !== null && dailyTotal > 0 && budget !== null ? budget / dailyTotal : null,
      }
    })
    .sort(compareShares)
  return { state: 'OK', note: null, items: items.slice(0, ADS_PORTFOLIO_CAMPAIGN_LIMIT), truncated: items.length > ADS_PORTFOLIO_CAMPAIGN_LIMIT, period }
}

function compareShares(a: AdsPortfolioCampaignShare, b: AdsPortfolioCampaignShare): number {
  if (a.spend === null && b.spend !== null) return 1
  if (a.spend !== null && b.spend === null) return -1
  if (a.spend !== null && b.spend !== null && a.spend !== b.spend) return b.spend - a.spend
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export interface RowParts {
  today: string
  window: AdsPortfolioWindow
  /** 预算周期内截至昨天的花费（广告日汇总）；没有汇总行为 null。 */
  reportSpend: number | null
  weights: readonly number[] | null
  campaigns: readonly PortfolioCampaign[]
  /** 所选日期范围内组合下活动的合计；没有汇总行为 null。 */
  totals: AdsTotals | null
}

export function rowOf(record: PortfolioRecord, parts: RowParts): AdsPortfolioRow {
  const { window } = parts
  const cap = num(record.budgetCap)
  const reportedSpent = num(record.spent) ?? 0
  const usd = record.currency === ADS_CONSOLE_CURRENCY
  // 日汇总只含美元：非美元组合不用日汇总的花费，退回亚马逊同步来的已用金额
  const fromReports = usd && parts.reportSpend !== null
  const spent = fromReports ? parts.reportSpend : reportedSpent
  const pace = paceOf({ window, cap, currency: record.currency, spent, today: parts.today, weights: parts.weights })
  return {
    id: record.id,
    portfolioId: record.portfolioId,
    name: record.name,
    status: record.status,
    adsProfileId: record.adsProfileId,
    accountName: record.adsProfile.displayName ?? record.adsProfile.profileId,
    storeName: record.adsProfile.sellerAccount?.displayName ?? null,
    currency: record.currency,
    budget: { cap, kind: window.kind, from: window.from, to: window.to, issue: window.issue },
    spent,
    spentSource: fromReports ? 'REPORTS' : 'PORTFOLIO',
    reportedSpent,
    pace,
    campaigns: { total: parts.campaigns.length, enabled: parts.campaigns.filter(item => isEnabled(item.state)).length },
    totals: usd ? parts.totals : null,
    ratios: usd ? ratiosOf(parts.totals) : null,
    syncedAt: record.syncedAt.toISOString(),
  }
}
