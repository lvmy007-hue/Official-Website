import {
  SNS_CANCEL_NOTE,
  SNS_CARD_LABEL,
  SNS_FORECAST_MAX_AGE_DAYS,
  SNS_BLOCKED_ELIGIBILITY,
  snsDayDiff,
  snsEligibilityLabel,
  snsReplenishmentGate,
  type SnsAsinRow,
  type SnsCard,
  type SnsCardKey,
  type SnsMoney,
  type SnsMonthPoint,
  type SnsOfferRow,
  type SnsTrendPoint,
} from '@nova/api-contracts'
import { eachDay } from '../overview'

// 订阅省的纯计算（P4-06）：指标合计、趋势、月度、预计出货汇总、指标卡、ASIN 与报价明细行。不读数据库，输入都是已经取好的行。
// 原则：亚马逊没给的值保持 null，不补 0；不同币种不相加；多个店铺时某天有的店铺没有记录，合计只含有记录的店铺（页面口径里写明）。

/** 卖家指标的一行（SubscribeSaveMetric）：日期已是 YYYY-MM-DD，金额已是数字。 */
export interface MetricRow {
  sellerAccountId: string
  granularity: string
  metricDate: string
  activeSubscribers: number | null
  shippedUnits: number | null
  revenue: number | null
  currency: string | null
}

/** 报价快照的一行（SubscribeSaveOffer）。 */
export interface OfferRecord {
  id: string
  sellerAccountId: string
  storeName: string | null
  snapshotDate: string
  sku: string
  asin: string
  eligibility: string | null
  fulfillment: string | null
  sellerFundedBasePct: number | null
  price: number | null
  currency: string | null
  inventory: number | null
  stockRisk: string | null
  subscriptions: number | null
  forecastNext30: number | null
  forecastNext60: number | null
  forecastNext90: number | null
  shippedUnitsPrevMonth: number | null
  prevMonthDays: number | null
}

const money2 = (value: number) => Math.round(value * 100) / 100
const sumOrNull = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((total, value) => total + value, 0)
}

// ---- 卖家指标 ----

export interface WindowTotals {
  shippedUnits: number | null
  revenue: SnsMoney[]
  /** 有销售额但亚马逊没给币种的行数（不计入任何币种）。 */
  unknownCurrencyRows: number
  /** 范围内有日级记录的不同日期数。 */
  dataDays: number
}

const dailyIn = (rows: readonly MetricRow[], from: string, to: string) => rows.filter(row => row.granularity === 'DAY' && row.metricDate >= from && row.metricDate <= to)

/** 日级指标在 [from, to] 内的合计：件数相加、金额按币种分别相加。 */
export function windowTotals(rows: readonly MetricRow[], from: string, to: string): WindowTotals {
  const inside = dailyIn(rows, from, to)
  const byCurrency = new Map<string, number>()
  let unknownCurrencyRows = 0
  for (const row of inside) {
    if (row.revenue === null) continue
    if (row.currency === null) unknownCurrencyRows += 1
    else byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? 0) + row.revenue)
  }
  return {
    shippedUnits: sumOrNull(inside.map(row => row.shippedUnits)),
    revenue: [...byCurrency.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([currency, amount]) => ({ currency, amount: money2(amount) })),
    unknownCurrencyRows,
    dataDays: new Set(inside.map(row => row.metricDate)).size,
  }
}

/** 金额最大的币种（并列取代码靠前的）；没有金额为 null。 */
export function mainCurrency(money: readonly SnsMoney[]): string | null {
  const sorted = [...money].sort((a, b) => b.amount - a.amount || (a.currency < b.currency ? -1 : 1))
  return sorted[0]?.currency ?? null
}

/** 活跃订阅数：每个店铺取 [.., to] 内最近一个有值的日级行，店铺之间相加；asOf 是其中最早的一天（最差情况）。 */
export function latestActive(rows: readonly MetricRow[], to: string): { value: number; asOf: string } | null {
  const latest = new Map<string, MetricRow>()
  for (const row of rows) {
    if (row.granularity !== 'DAY' || row.metricDate > to || row.activeSubscribers === null) continue
    const current = latest.get(row.sellerAccountId)
    if (!current || row.metricDate > current.metricDate) latest.set(row.sellerAccountId, row)
  }
  if (latest.size === 0) return null
  const picked = [...latest.values()]
  return { value: picked.reduce((total, row) => total + (row.activeSubscribers ?? 0), 0), asOf: picked.map(row => row.metricDate).sort()[0] as string }
}

/** 逐日点：同一天各店铺相加，没有记录的日期为 null（图上断开，不画成 0）；金额只取趋势币种。 */
export function trendOf(rows: readonly MetricRow[], from: string, to: string, currency: string | null): SnsTrendPoint[] {
  const byDate = new Map<string, MetricRow[]>()
  for (const row of dailyIn(rows, from, to)) byDate.set(row.metricDate, [...(byDate.get(row.metricDate) ?? []), row])
  return eachDay(from, to).map(date => {
    const day = byDate.get(date) ?? []
    return {
      date,
      activeSubscribers: sumOrNull(day.map(row => row.activeSubscribers)),
      shippedUnits: sumOrNull(day.map(row => row.shippedUnits)),
      revenue: moneyOf(day, currency),
    }
  })
}

const moneyOf = (rows: readonly MetricRow[], currency: string | null): number | null => {
  if (currency === null) return null
  const total = sumOrNull(rows.map(row => (row.currency === currency ? row.revenue : null)))
  return total === null ? null : money2(total)
}

/** 最近几个自然月（月度指标，各店铺相加），按月份从早到晚。 */
export function monthsOf(rows: readonly MetricRow[], currency: string | null, limit: number): SnsMonthPoint[] {
  const byMonth = new Map<string, MetricRow[]>()
  for (const row of rows) if (row.granularity === 'MONTH') byMonth.set(row.metricDate.slice(0, 7), [...(byMonth.get(row.metricDate.slice(0, 7)) ?? []), row])
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(-limit)
    .map(([month, group]) => ({
      month,
      activeSubscribers: sumOrNull(group.map(row => row.activeSubscribers)),
      shippedUnits: sumOrNull(group.map(row => row.shippedUnits)),
      revenue: moneyOf(group, currency),
    }))
}

// ---- 报价快照 ----

export interface ForecastTotals {
  /** 各店铺最近快照日期里最新的一个。 */
  snapshotDate: string | null
  offers: number
  offersWithForecast: number
  /** 快照已过期的店铺名（去重，按名称排序）。 */
  staleStores: string[]
  freshOffers: number
  forecast30: number | null
  forecast60: number | null
  forecast90: number | null
  usedInReplenishment: number
  eligible: number
  blocked: number
  unknownEligibility: number
}

const isStale = (offer: OfferRecord, today: string) => snsDayDiff(offer.snapshotDate, today) > SNS_FORECAST_MAX_AGE_DAYS

/** 报价汇总：未来 30、60、90 天预计订阅出货只加快照在 7 天内的店铺，过期的店铺不计入并列出店名。 */
export function forecastTotals(offers: readonly OfferRecord[], today: string): ForecastTotals {
  const fresh = offers.filter(offer => !isStale(offer, today))
  const stale = offers.filter(offer => isStale(offer, today))
  const dates = offers.map(offer => offer.snapshotDate).sort()
  return {
    snapshotDate: dates[dates.length - 1] ?? null,
    offers: offers.length,
    offersWithForecast: offers.filter(offer => offer.forecastNext30 !== null).length,
    staleStores: [...new Set(stale.map(offer => offer.storeName ?? offer.sellerAccountId))].sort(),
    freshOffers: fresh.length,
    forecast30: sumOrNull(fresh.map(offer => offer.forecastNext30)),
    forecast60: sumOrNull(fresh.map(offer => offer.forecastNext60)),
    forecast90: sumOrNull(fresh.map(offer => offer.forecastNext90)),
    usedInReplenishment: offers.filter(offer => snsReplenishmentGate(offer, today).used).length,
    eligible: offers.filter(offer => offer.eligibility === 'ELIGIBLE').length,
    blocked: offers.filter(offer => offer.eligibility !== null && SNS_BLOCKED_ELIGIBILITY.includes(offer.eligibility)).length,
    unknownEligibility: offers.filter(offer => offer.eligibility === null).length,
  }
}

// ---- 指标卡 ----

export interface CardsInput {
  current: WindowTotals
  /** 对比期合计；没有对比期为 null。 */
  previous: WindowTotals | null
  rangeDays: number
  active: { value: number; asOf: string } | null
  forecast: ForecastTotals
}

const card = (key: SnsCardKey, over: Partial<SnsCard> & Pick<SnsCard, 'unit' | 'state'>): SnsCard => ({
  key,
  label: SNS_CARD_LABEL[key],
  value: null,
  currency: null,
  others: [],
  previous: null,
  note: null,
  ...over,
})

function forecastCard(key: 'forecast30' | 'forecast60' | 'forecast90', value: number | null, forecast: ForecastTotals): SnsCard {
  if (forecast.offers === 0) return card(key, { unit: 'count', state: 'NO_DATA' })
  if (forecast.freshOffers === 0) return card(key, { unit: 'count', state: 'STALE', note: `报价快照 ${forecast.snapshotDate} 已超过 ${SNS_FORECAST_MAX_AGE_DAYS} 天，没有可用的预测` })
  if (value === null) return card(key, { unit: 'count', state: 'NO_DATA', note: '亚马逊没有给出这个时间段的预测' })
  const partial = forecast.staleStores.length > 0 ? `；${forecast.staleStores.join('、')} 的快照已过期，未计入` : ''
  return card(key, { unit: 'count', state: 'OK', value, note: `依据 ${forecast.snapshotDate} 的报价快照${partial}` })
}

/** 八张指标卡：没有数字的写状态与原因，不用 0 冒充。 */
export function buildCards(input: CardsInput): SnsCard[] {
  const { current, previous, forecast } = input
  const currency = mainCurrency(current.revenue)
  const amount = current.revenue.find(item => item.currency === currency)?.amount ?? null
  const previousAmount = currency === null || !previous ? null : (previous.revenue.find(item => item.currency === currency)?.amount ?? null)
  const coverage = current.dataDays < input.rangeDays ? `范围内 ${current.dataDays} / ${input.rangeDays} 天有日级记录` : null
  const unknown = current.unknownCurrencyRows > 0 ? `${current.unknownCurrencyRows} 条记录没有币种，未计入` : null
  const eligibility = [
    `可订阅 ${forecast.eligible}`,
    forecast.blocked > 0 ? `不可订阅或已暂停 ${forecast.blocked}` : null,
    forecast.unknownEligibility > 0 ? `未提供状态 ${forecast.unknownEligibility}` : null,
  ]
  return [
    input.active
      ? card('activeSubscribers', { unit: 'count', state: 'OK', value: input.active.value, note: `截至 ${input.active.asOf}` })
      : card('activeSubscribers', { unit: 'count', state: 'NO_DATA' }),
    current.shippedUnits === null
      ? card('shippedUnits', { unit: 'count', state: 'NO_DATA' })
      : card('shippedUnits', { unit: 'count', state: 'OK', value: current.shippedUnits, previous: previous?.shippedUnits ?? null, note: coverage }),
    amount === null
      ? card('revenue', { unit: 'money', state: 'NO_DATA', note: unknown })
      : card('revenue', {
          unit: 'money',
          state: 'OK',
          value: amount,
          currency,
          others: current.revenue.filter(item => item.currency !== currency),
          previous: previousAmount,
          note: [coverage, unknown].filter(Boolean).join('；') || null,
        }),
    card('cancellations', { unit: 'count', state: 'NOT_CONNECTED', note: SNS_CANCEL_NOTE }),
    forecastCard('forecast30', forecast.forecast30, forecast),
    forecastCard('forecast60', forecast.forecast60, forecast),
    forecastCard('forecast90', forecast.forecast90, forecast),
    forecast.offers === 0 ? card('offers', { unit: 'count', state: 'NO_DATA' }) : card('offers', { unit: 'count', state: 'OK', value: forecast.offers, note: eligibility.filter(Boolean).join('，') }),
  ]
}

// ---- 明细行 ----

const gateOf = (offer: OfferRecord, today: string) => snsReplenishmentGate(offer, today)

export function offerRowOf(offer: OfferRecord, today: string): SnsOfferRow {
  return {
    key: `${offer.sellerAccountId}|${offer.sku}`,
    sku: offer.sku,
    asin: offer.asin,
    sellerAccountId: offer.sellerAccountId,
    storeName: offer.storeName,
    snapshotDate: offer.snapshotDate,
    eligibility: offer.eligibility,
    eligibilityLabel: snsEligibilityLabel(offer.eligibility),
    fulfillment: offer.fulfillment,
    discountPct: offer.sellerFundedBasePct,
    price: offer.price,
    currency: offer.currency,
    inventory: offer.inventory,
    stockRisk: offer.stockRisk,
    subscriptions: offer.subscriptions,
    forecastNext30: offer.forecastNext30,
    replenishment: gateOf(offer, today),
  }
}

/** 同一店铺同一 ASIN 的报价合并成一行（没有 ASIN 的报价按 SKU 单独成行）；任一报价被补货采用就算采用，否则写第一条的原因。 */
export function asinRowsOf(offers: readonly OfferRecord[], today: string): SnsAsinRow[] {
  const groups = new Map<string, OfferRecord[]>()
  for (const offer of offers) {
    const key = `${offer.sellerAccountId}|${offer.asin || `sku:${offer.sku}`}`
    groups.set(key, [...(groups.get(key) ?? []), offer])
  }
  return [...groups.entries()].map(([key, group]) => {
    const first = group[0] as OfferRecord
    const gates = group.map(offer => gateOf(offer, today))
    const used = gates.some(gate => gate.used)
    return {
      key,
      asin: first.asin,
      skus: group.map(offer => offer.sku).sort(),
      sellerAccountId: first.sellerAccountId,
      storeName: first.storeName,
      snapshotDate: first.snapshotDate,
      subscriptions: sumOrNull(group.map(offer => offer.subscriptions)),
      shippedUnitsPrevMonth: sumOrNull(group.map(offer => offer.shippedUnitsPrevMonth)),
      forecastNext30: sumOrNull(group.map(offer => offer.forecastNext30)),
      forecastNext60: sumOrNull(group.map(offer => offer.forecastNext60)),
      forecastNext90: sumOrNull(group.map(offer => offer.forecastNext90)),
      replenishment: used ? { used: true, reason: null } : { used: false, reason: gates[0]?.reason ?? null },
      productId: null,
    }
  })
}

/** 搜索词匹配 SKU 或 ASIN（包含，不区分大小写）。 */
export const matchesOffer = (offer: Pick<OfferRecord, 'sku' | 'asin'>, q: string | undefined) => {
  if (!q) return true
  const needle = q.toLowerCase()
  return offer.sku.toLowerCase().includes(needle) || offer.asin.toLowerCase().includes(needle)
}
