import { inRefetchWindow } from '@nova/api-contracts'
import type { AdsReportWarning } from '../connectors/ads-v1-reports'
import type { AdsDayMetric } from '../importers/ads/report-v1-parse'
import { AMOUNT_EPSILON, money, type ParityDiff, type ParityReport } from './types'

// 广告新旧版本核对（P3-01，importers.md A-04）：旧版（报告第三版，已入库的日指标 AdsMetric）与新报告接口（Reporting API v1）在同一时间窗内，
// 按“活动 × 流量日期”逐行比对曝光、点击、花费、销售额、订单。每条差异必须归入四类之一并写明原因（P3-01 验收：差异全部分类）。
//
// 分类规则（启发式，不是亚马逊的结论，页面与记录里都这样说明）：
//   时间口径：日期落在“近 3 天会被回补修正”的区间（importers.md A-02）；
//   归因口径：曝光、点击、花费都一致，只有销售额与订单不同，且新版本不少于旧版本（新版本按流量日期归因、归因窗口更长，只会多不会少）；
//   范围：一边是全零行（旧版不返回没有曝光的行）、新版本里是旧版没有拉取的广告产品、或新报告自己带了警告信号（数据可能不完整）；
//   未解释：以上都说不通，需要人工看。

export type LegacyAdsDay = { date: string; campaignId: string; adProduct: string; impressions: number; clicks: number; cost: number | null; sales: number | null; purchases: number }

export type CompareAdsInput = {
  legacy: LegacyAdsDay[]
  next: AdsDayMetric[]
  /** 企业数据口径时区的今天 YYYY-MM-DD。 */
  today: string
  /** 旧版实际拉取过的广告产品；新报告里这之外的产品是“范围”差异。 */
  legacyAdProducts: ReadonlySet<string>
  /** 新报告返回的警告信号。 */
  warnings: readonly AdsReportWarning[]
}

type Totals = { adProduct: string; impressions: number | null; clicks: number | null; cost: number | null; sales: number | null; purchases: number | null }
const FIELDS = ['impressions', 'clicks', 'cost', 'sales', 'purchases'] as const
type Field = (typeof FIELDS)[number]
const TRAFFIC: readonly Field[] = ['impressions', 'clicks', 'cost']
const FIELD_LABEL: Record<Field, string> = { impressions: '曝光', clicks: '点击', cost: '花费', sales: '销售额', purchases: '订单' }

const keyOf = (campaignId: string, date: string) => `${campaignId}@${date}`
const add = (left: number | null, right: number | null) => (left === null ? right : right === null ? left : left + right)

/** 同一活动同一天可能有多行（不同广告产品）：合并成一行。 */
function totalsOf<T extends { date: string; campaignId: string; adProduct: string } & Record<Field, number | null>>(rows: readonly T[]) {
  const map = new Map<string, Totals>()
  for (const row of rows) {
    const key = keyOf(row.campaignId, row.date)
    const found = map.get(key)
    if (!found) map.set(key, { adProduct: row.adProduct, impressions: row.impressions, clicks: row.clicks, cost: row.cost, sales: row.sales, purchases: row.purchases })
    else for (const field of FIELDS) found[field] = add(found[field], row[field])
  }
  return map
}

const allZero = (row: Totals) => FIELDS.every(field => !row[field])
const show = (field: Field, value: number | null) => (value === null ? '无' : field === 'cost' || field === 'sales' ? money(value) : String(value))
const differs = (field: Field, left: number, right: number) => (field === 'cost' || field === 'sales' ? Math.abs(left - right) >= AMOUNT_EPSILON : left !== right)

export function compareAds(input: CompareAdsInput): ParityReport {
  const legacy = totalsOf(input.legacy)
  const next = totalsOf(input.next)
  const warned = input.warnings.length > 0
  const warningText = input.warnings.map(item => item.code).join('、')
  const diffs: ParityDiff[] = []
  let matched = 0

  const classify = (date: string, base: string): Pick<ParityDiff, 'category' | 'explanation'> =>
    inRefetchWindow(date, input.today)
      ? { category: 'TIME_BASIS', explanation: `${base}；该日期在近 3 天内，亚马逊还会按流量日期回补修正，两个版本取数时刻不同` }
      : warned
        ? { category: 'SCOPE', explanation: `${base}；新报告带有警告信号（${warningText}），数据可能不完整` }
        : { category: 'UNEXPLAINED', explanation: `${base}；不在近 3 天回补期内，新报告也没有警告信号` }

  for (const [key, old] of legacy) {
    const [campaignId, date] = key.split('@')
    const now = next.get(key)
    if (!now) {
      const base = { entityKey: key, field: 'presence', legacyValue: '有', newValue: '无' }
      if (allZero(old)) diffs.push({ ...base, category: 'SCOPE', explanation: '旧版里是全零行，新报告不返回没有任何活动数据的行' })
      else diffs.push({ ...base, ...classify(date, '旧版有这一天的数据，新报告没有') })
      continue
    }
    const before = diffs.length
    const wrong = FIELDS.filter(field => old[field] !== null && now[field] !== null && differs(field, old[field] as number, now[field] as number))
    const trafficWrong = wrong.filter(field => TRAFFIC.includes(field))
    let trafficCategory: ParityDiff['category'] | null = null
    for (const field of wrong) {
      const oldValue = old[field] as number
      const newValue = now[field] as number
      const base = `${campaignId} 在 ${date} 的${FIELD_LABEL[field]}不一致`
      let result: Pick<ParityDiff, 'category' | 'explanation'>
      if (TRAFFIC.includes(field)) result = classify(date, base)
      else if (trafficWrong.length > 0) result = { category: trafficCategory as ParityDiff['category'], explanation: `${base}；曝光、点击或花费也有差异，销售差异随之而来` }
      else if (newValue >= oldValue && !inRefetchWindow(date, input.today)) {
        result = { category: 'ATTRIBUTION_BASIS', explanation: `${base}；流量指标一致，新版本不少于旧版本：新版本按流量日期归因、归因窗口不同` }
      } else result = classify(date, base)
      if (TRAFFIC.includes(field) && trafficCategory === null) trafficCategory = result.category
      diffs.push({ entityKey: key, field, legacyValue: show(field, oldValue), newValue: show(field, newValue), ...result })
    }
    if (diffs.length === before) matched += 1
  }

  for (const [key, now] of next) {
    if (legacy.has(key)) continue
    const date = key.split('@')[1]
    const base = { entityKey: key, field: 'presence', legacyValue: '无', newValue: '有' }
    if (!input.legacyAdProducts.has(now.adProduct)) diffs.push({ ...base, category: 'SCOPE', explanation: `旧版没有拉取 ${now.adProduct} 这个广告产品，新报告跨产品返回` })
    else if (allZero(now)) diffs.push({ ...base, category: 'SCOPE', explanation: '新报告里是全零行，旧版不返回没有任何活动数据的行' })
    else diffs.push({ ...base, ...classify(date, '新报告有这一天的数据，旧版没有') })
  }
  return { legacyCount: legacy.size, newCount: next.size, matchedCount: matched, diffs }
}
