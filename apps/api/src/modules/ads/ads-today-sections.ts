import {
  ADS_TODAY_ANOMALY_RULES,
  ADS_TODAY_ESTIMATE_NOTE,
  ADS_TODAY_HISTORY_DAYS,
  ADS_TODAY_LIST_LIMIT,
  ADS_TODAY_OUT_OF_BUDGET_NOTE,
  ADS_TODAY_STOCKOUT_LOOKBACK_DAYS,
  addTotals,
  adsCpc,
  cpcSurge,
  exhaustProjection,
  hourBand,
  spendWithoutConversion,
  type AdsTodayAnomaly,
  type AdsTodayAnomalies,
  type AdsTodayBudget,
  type AdsTodayBudgetRow,
  type AdsTodayHour,
  type AdsTodayOutOfBudget,
  type AdsTodayStockout,
  type AdsTodayStockoutItem,
  type AdsTodayStreamState,
  type AdsTodayTotals,
  type AdsTotals,
  type DashState,
} from '@nova/api-contracts'
import { campaignKeyOf, type AdvertisedDay, type BudgetCampaignRow, type OutOfBudgetRow, type SnapshotRow } from './ads-today-load'

// 今日广告各区块的装配（P3-06）：全是纯函数，输入是已经读好的数据，不碰数据库，便于单测。
// 没有数据的区块写明状态与原因（尚无记录、尚未接入），不用 0 顶替。

const HOUR_MS = 3_600_000
const stateOfStream = (stream: AdsTodayStreamState): DashState => (stream === 'LIVE' ? 'OK' : stream)
export const STREAM_NOTE: Record<Exclude<AdsTodayStreamState, 'LIVE'>, string> = {
  NOT_CONNECTED: '营销数据流的接收端尚未配置（部署专项），没有今日小时指标',
  NO_DATA: '营销数据流已配置，但今天还没有收到小时指标',
}

export const totalsView = (totals: AdsTotals): AdsTodayTotals => ({ ...totals, cpc: adsCpc(totals.spend, totals.clicks) })

/** 今日 24 个小时：已过去的小时给指标与历史同时段区间带，未到的小时只留空位；没有小时指标行的小时是 null，不当 0。 */
export function buildHours(input: { byHour: ReadonlyMap<string, AdsTotals>; dayStart: Date; dayEndExclusive: Date; now: Date }): AdsTodayHour[] {
  const hours: AdsTodayHour[] = []
  for (let at = input.dayStart.getTime(); at < input.dayEndExclusive.getTime(); at += HOUR_MS) {
    const elapsed = at <= input.now.getTime()
    const row = elapsed ? input.byHour.get(new Date(at).toISOString()) : undefined
    const samples = []
    for (let day = 1; day <= ADS_TODAY_HISTORY_DAYS; day += 1) {
      const before = input.byHour.get(new Date(at - day * 24 * HOUR_MS).toISOString())
      if (before) samples.push({ spend: before.spend, clicks: before.clicks })
    }
    hours.push({
      hourStart: new Date(at).toISOString(),
      elapsed,
      spend: row ? row.spend : null,
      clicks: row ? row.clicks : null,
      sales: row ? row.sales : null,
      orders: row ? row.orders : null,
      band: hourBand(samples),
    })
  }
  return hours
}

/** 对比：昨天截至同一时刻的合计；那段时间没有任何小时指标为 null。 */
export function yesterdaySameHour(byHour: ReadonlyMap<string, AdsTotals>, dayStart: Date, now: Date): AdsTodayTotals | null {
  const until = Math.floor(now.getTime() / HOUR_MS) * HOUR_MS + HOUR_MS - 24 * HOUR_MS
  const picked: AdsTotals[] = []
  for (let at = dayStart.getTime() - 24 * HOUR_MS; at < until; at += HOUR_MS) {
    const row = byHour.get(new Date(at).toISOString())
    if (row) picked.push(row)
  }
  return picked.length > 0 ? totalsView(addTotals(picked)) : null
}

/** 今日合计：只加今天这些小时（byHour 里还带着历史）。 */
export function todayTotals(byHour: ReadonlyMap<string, AdsTotals>, dayStart: Date, dayEndExclusive: Date): AdsTotals | null {
  const picked = [...byHour.entries()].filter(([key]) => key >= dayStart.toISOString() && key < dayEndExclusive.toISOString()).map(([, value]) => value)
  return picked.length > 0 ? addTotals(picked) : null
}

export function buildBudget(input: {
  stream: AdsTodayStreamState
  campaigns: readonly BudgetCampaignRow[]
  truncated: boolean
  spend: ReadonlyMap<string, AdsTotals>
  sumsTruncated: boolean
  now: Date
  dayStart: Date
  dayEndExclusive: Date
}): AdsTodayBudget {
  const empty = { dailyBudgetTotal: null, spentToday: null, progress: null, budgetedCampaigns: 0, ambiguous: 0, rows: [], truncated: false }
  if (input.campaigns.length === 0) return { ...empty, state: 'NO_DATA', note: '没有启用中的日预算活动记录（活动管理接口的预算尚未同步，或预算类型没有同步）' }
  // 小时指标的对象编号只有活动编号、没有广告产品：同一档案里编号重复的活动没法确认花费归谁，只算预算、不算花费
  const counts = new Map<string, number>()
  for (const campaign of input.campaigns) counts.set(campaignKeyOf(campaign.adsProfileId, campaign.campaignId), (counts.get(campaignKeyOf(campaign.adsProfileId, campaign.campaignId)) ?? 0) + 1)
  const unique = input.campaigns.filter(campaign => counts.get(campaignKeyOf(campaign.adsProfileId, campaign.campaignId)) === 1)
  const ambiguous = input.campaigns.length - unique.length
  const dailyBudgetTotal = unique.reduce((total, campaign) => total + campaign.dailyBudget, 0)
  const base = { ...empty, dailyBudgetTotal: unique.length > 0 ? dailyBudgetTotal : null, budgetedCampaigns: input.campaigns.length, ambiguous, truncated: input.truncated }
  if (input.stream !== 'LIVE') return { ...base, state: stateOfStream(input.stream), note: `${STREAM_NOTE[input.stream]}，今日花费与预算进度算不出` }

  const rows: AdsTodayBudgetRow[] = unique.map(campaign => {
    const key = campaignKeyOf(campaign.adsProfileId, campaign.campaignId)
    const spend = input.spend.get(key)?.spend ?? null
    const projection = exhaustProjection({ dailyBudget: campaign.dailyBudget, spend, now: input.now, dayStart: input.dayStart, dayEndExclusive: input.dayEndExclusive })
    return {
      key,
      adsProfileId: campaign.adsProfileId,
      campaignId: campaign.campaignId,
      name: campaign.name,
      dailyBudget: campaign.dailyBudget,
      spend,
      progress: spend === null || campaign.dailyBudget <= 0 ? null : spend / campaign.dailyBudget,
      exhaust: projection.state,
      exhaustAt: projection.at ? projection.at.toISOString() : null,
    }
  })
  const spent = rows.filter(row => row.spend !== null)
  const spentToday = spent.length > 0 ? spent.reduce((total, row) => total + (row.spend ?? 0), 0) : null
  rows.sort((a, b) => (b.progress ?? -1) - (a.progress ?? -1) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const notes = [
    ADS_TODAY_ESTIMATE_NOTE,
    ambiguous > 0 ? `${ambiguous} 个活动的编号在同一广告档案里重复，没法确认花费归属，已从预算与花费合计里排除` : null,
    input.truncated || input.sumsTruncated ? '活动数量很多，只处理了一部分活动' : null,
  ].filter(Boolean)
  return {
    ...base,
    state: 'OK',
    note: notes.join('；'),
    spentToday,
    progress: spentToday === null || dailyBudgetTotal <= 0 ? null : spentToday / dailyBudgetTotal,
    rows: rows.slice(0, ADS_TODAY_LIST_LIMIT),
  }
}

export function buildOutOfBudget(input: { rows: readonly OutOfBudgetRow[]; total: number; withStatus: number }): AdsTodayOutOfBudget {
  if (input.withStatus === 0) {
    return { state: 'NO_DATA', note: `没有活动同步过投放状态，判断不了是否超预算。${ADS_TODAY_OUT_OF_BUDGET_NOTE}`, count: 0, rows: [] }
  }
  return {
    state: 'OK',
    note: ADS_TODAY_OUT_OF_BUDGET_NOTE,
    count: input.total,
    rows: input.rows.map(row => ({ key: campaignKeyOf(row.adsProfileId, row.campaignId), ...row })),
  }
}

/** 单次点击成本突增、花费无转化：都是今天的活动级合计对比规则（花费无转化的订单可能只是还没回传）。 */
export function buildAnomalies(input: { stream: AdsTodayStreamState; today: ReadonlyMap<string, AdsTotals>; baseline: ReadonlyMap<string, AdsTotals>; truncated: boolean }): AdsTodayAnomalies {
  const shell = { rules: ADS_TODAY_ANOMALY_RULES, count: 0, items: [] }
  if (input.stream !== 'LIVE') return { ...shell, state: stateOfStream(input.stream), note: STREAM_NOTE[input.stream] }
  const items: AdsTodayAnomaly[] = []
  for (const [key, today] of input.today) {
    const separator = key.indexOf('|')
    const common = {
      key,
      adsProfileId: key.slice(0, separator),
      campaignId: key.slice(separator + 1),
      name: key.slice(separator + 1),
      spend: today.spend ?? 0,
      clicks: today.clicks,
      orders: today.orders,
      cpc: adsCpc(today.spend, today.clicks),
    }
    const surge = cpcSurge(today, input.baseline.get(key) ?? { spend: null, clicks: 0 })
    if (surge) items.push({ ...common, kind: 'CPC_SURGE', baselineCpc: surge.baselineCpc, ratio: surge.ratio })
    if (spendWithoutConversion(today)) items.push({ ...common, kind: 'SPEND_NO_CONVERSION', baselineCpc: null, ratio: null })
  }
  items.sort((a, b) => b.spend - a.spend || (a.key < b.key ? -1 : a.key > b.key ? 1 : a.kind < b.kind ? -1 : 1))
  const note = input.truncated ? '活动数量很多，只统计了花费最高的一部分活动' : null
  return { ...shell, state: 'OK', note, count: items.length, items: items.slice(0, ADS_TODAY_LIST_LIMIT) }
}

export function buildStockout(input: {
  ever: boolean
  advertised: readonly AdvertisedDay[]
  truncated: boolean
  storeOfProfile: ReadonlyMap<string, string | null>
  snapshots: readonly SnapshotRow[]
  storeNames: ReadonlyMap<string, string>
}): AdsTodayStockout {
  const lookbackDays = ADS_TODAY_STOCKOUT_LOOKBACK_DAYS
  const shell = { lookbackDays, items: [] as AdsTodayStockoutItem[] }
  if (!input.ever) return { ...shell, state: 'NOT_CONNECTED', note: '被推广商品日报表还没有同步器写入（需要广告报告接口的落库同步器），断货商品是否仍在投放判断不了' }
  if (input.advertised.length === 0) return { ...shell, state: 'NO_DATA', note: `近 ${lookbackDays} 天没有被推广商品的花费记录` }

  const groups = new Map<string, { storeId: string; asin: string; spend: number; days: Set<string> }>()
  let unbound = 0
  for (const row of input.advertised) {
    const storeId = input.storeOfProfile.get(row.adsProfileId) ?? null
    if (!storeId || !row.asin) {
      unbound += 1
      continue
    }
    const key = `${storeId}|${row.asin}`
    const group = groups.get(key) ?? { storeId, asin: row.asin, spend: 0, days: new Set<string>() }
    group.spend += row.spend
    group.days.add(row.date)
    groups.set(key, group)
  }
  const stock = new Map<string, { sellable: number; date: string }>()
  for (const row of input.snapshots) {
    if (row.sellable === null) continue
    const key = `${row.sellerAccountId}|${row.asin}`
    const before = stock.get(key)
    stock.set(key, { sellable: (before?.sellable ?? 0) + row.sellable, date: row.snapshotDate })
  }
  const items: AdsTodayStockoutItem[] = []
  let compared = 0
  for (const [key, group] of groups) {
    const level = stock.get(key)
    if (!level) continue
    compared += 1
    if (level.sellable > 0) continue
    items.push({
      key,
      asin: group.asin,
      sellerAccountId: group.storeId,
      storeName: input.storeNames.get(group.storeId) ?? null,
      sellable: level.sellable,
      snapshotDate: level.date,
      spend: group.spend,
      days: group.days.size,
      dailyWaste: group.spend / group.days.size,
    })
  }
  items.sort((a, b) => b.dailyWaste - a.dailyWaste || (a.key < b.key ? -1 : 1))
  const notes = [
    unbound > 0 ? `${unbound} 行花费所在的广告账户没有绑定店铺或没有 ASIN，无法对照库存` : null,
    input.truncated ? '被推广商品记录很多，只读了一部分' : null,
    compared > 0 ? '库存取各店铺最近一次快照（接口来源），不是实时库存；花费来自日报表，今天的花费可能还没回传' : null,
  ].filter(Boolean)
  if (compared === 0) {
    const note = `近 ${lookbackDays} 天有花费的商品没有库存快照可对照（接口来源的库存快照没有这些 ASIN，或可售数量没给）${notes.length > 0 ? `；${notes.join('；')}` : ''}`
    return { ...shell, state: 'NO_DATA', note }
  }
  return { ...shell, state: 'OK', note: notes.length > 0 ? notes.join('；') : null, items: items.slice(0, ADS_TODAY_LIST_LIMIT) }
}
