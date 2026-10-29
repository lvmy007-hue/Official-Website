import { ADS_WRITE_LIMITS, type AdsWriteRunRow } from './ads-write'
import type { CursorPageInfo } from './query'

// 广告新增分析与工具（P6-24，16 章第 8 节）：超预算时间条、归因窗口、词研究一键加词、冲突检查、重复关键词。
// 本文件只有常量、类型与纯函数（没有 zod），请求校验在 ads-tools-query.ts。前后端共用同一套判定，页面不自己再算一遍。

// ---- 超预算时间条 ----

/** 小时指标只有营销数据流提供，历史最多 14 天（亚马逊不提供更长的）。 */
export const ADS_BUDGET_TIMELINE_DAYS = 14

export const ADS_BUDGET_TIMELINE_PRECISION =
  '精度说明：小时数据只来自营销数据流（配置之后才开始累积，不补历史，可能延迟或被亚马逊事后修正）；小时与日期按企业时区划分，亚马逊按广告账户时区结算日预算，两者不同时日界线会错位；' +
  '预算取活动当前的日预算，历史上的预算调整没有同步器、不回溯；“超预算”按当日累计花费超过日预算判断，亚马逊允许单日最多超出约 25%，所以只作为“预算已用尽”的参考，不是计费结论'

export interface BudgetHourInput {
  spend: number | null
  impressions: number
  clicks: number
}

export interface BudgetTimelineHour {
  hour: number
  /** 这个小时没有记录是 null（不是 0）。 */
  spend: number | null
  /** 截至本小时末的累计花费；当天还没有任何记录是 null。 */
  cumulative: number | null
  /** 有曝光或花费的小时算“活跃”。 */
  active: boolean
  /** 累计花费已超过日预算。 */
  over: boolean
}

export interface BudgetTimelineDay {
  date: string
  hoursRecorded: number
  spend: number | null
  /** 第一次累计花费超过日预算的小时（0 至 23）；没超过或预算未知是 null。 */
  exceededAtHour: number | null
  /** 从超预算那个小时起到当天结束的小时数；没超过是 0，预算未知是 null。 */
  overBudgetHours: number | null
  activeHours: number
  /** 超预算小时之前的活跃小时数（没超过就是全部活跃小时）；预算未知是 null。 */
  activeHoursWithinBudget: number | null
  hours: BudgetTimelineHour[]
}

const money = (value: number) => Math.round(value * 1e6) / 1e6

/** 一天的时间条：24 个小时格，累计花费与超预算判断。`budget` 为 null 表示预算未知或不是日预算，不做超预算判断。 */
export function budgetTimelineDay(date: string, budget: number | null, byHour: ReadonlyMap<number, BudgetHourInput>): BudgetTimelineDay {
  const known = budget !== null && Number.isFinite(budget) && budget > 0
  let running: number | null = null
  let exceededAtHour: number | null = null
  const hours: BudgetTimelineHour[] = []
  for (let hour = 0; hour < 24; hour += 1) {
    const row = byHour.get(hour)
    if (row?.spend !== null && row?.spend !== undefined) running = money((running ?? 0) + row.spend)
    const over = known && running !== null && running > (budget as number)
    if (over && exceededAtHour === null) exceededAtHour = hour
    hours.push({
      hour,
      spend: row?.spend ?? null,
      cumulative: running,
      active: Boolean(row && (row.impressions > 0 || (row.spend ?? 0) > 0)),
      over: known && exceededAtHour !== null && hour >= exceededAtHour,
    })
  }
  const activeHours = hours.filter(item => item.active).length
  return {
    date,
    hoursRecorded: byHour.size,
    spend: running,
    exceededAtHour: known ? exceededAtHour : null,
    overBudgetHours: known ? (exceededAtHour === null ? 0 : 24 - exceededAtHour) : null,
    activeHours,
    activeHoursWithinBudget: known ? hours.filter(item => item.active && !item.over).length : null,
    hours,
  }
}

/** 平均超预算时长（M-507）：只统计有记录且预算已知的日子；一天都没有是 null。 */
export function averageOverBudgetHours(days: readonly BudgetTimelineDay[]): number | null {
  const counted = days.filter(day => day.hoursRecorded > 0 && day.overBudgetHours !== null)
  if (counted.length === 0) return null
  return Math.round((counted.reduce((sum, day) => sum + (day.overBudgetHours ?? 0), 0) / counted.length) * 10) / 10
}

// ---- 归因窗口 ----

export const ADS_ATTRIBUTION_WINDOWS = [1, 7, 14, 30] as const
export type AdsAttributionWindow = (typeof ADS_ATTRIBUTION_WINDOWS)[number]
/** 页面主表默认的归因窗口（报告同步器按 7 天取销售额与订单）。 */
export const ADS_DEFAULT_ATTRIBUTION_WINDOW: AdsAttributionWindow = 7

export interface AdsAttributionWindowView {
  window: AdsAttributionWindow
  available: boolean
  /** 不可用的原因（置灰时显示）。 */
  reason: string | null
  sales: number | null
  orders: number | null
  coveredDays: number
  totalDays: number
}

const numberOfRaw = (raw: Record<string, unknown>, keys: readonly string[]): number | null => {
  for (const key of keys) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return null
}

/**
 * 各归因窗口的销售额与订单：每个窗口要求范围内**每一天**的报告行都带有该窗口的列（`sales{N}d`、`purchases{N}d`，也认下划线写法），
 * 否则整个窗口置灰并写明覆盖了几天，不用别的窗口顶替、不推算。没有任何报告行时全部置灰。
 */
export function attributionWindows(rows: ReadonlyArray<{ date: string; raw: unknown }>): AdsAttributionWindowView[] {
  const days = [...new Set(rows.map(row => row.date))]
  return ADS_ATTRIBUTION_WINDOWS.map((window): AdsAttributionWindowView => {
    const base = { window, totalDays: days.length }
    if (days.length === 0) return { ...base, available: false, reason: '所选范围内没有广告报告行，无法提供归因窗口', sales: null, orders: null, coveredDays: 0 }
    let sales = 0
    let orders = 0
    const covered = new Set<string>()
    for (const row of rows) {
      const raw = row.raw && typeof row.raw === 'object' && !Array.isArray(row.raw) ? (row.raw as Record<string, unknown>) : {}
      const daySales = numberOfRaw(raw, [`sales${window}d`, `sales_${window}d`])
      if (daySales === null) continue
      sales += daySales
      orders += numberOfRaw(raw, [`purchases${window}d`, `purchases_${window}d`, `orders${window}d`]) ?? 0
      covered.add(row.date)
    }
    if (covered.size < days.length)
      return {
        ...base,
        available: false,
        reason: `报告里没有 ${window} 天归因窗口的列（${covered.size}/${days.length} 天有）；报告需要带 sales${window}d 列`,
        sales: null,
        orders: null,
        coveredDays: covered.size,
      }
    return { ...base, available: true, reason: null, sales: money(sales), orders, coveredDays: covered.size }
  })
}

// ---- 词研究一键加词 ----

/** 批量加词一次最多的条数（与写入流水线一致）。 */
export const ADS_BULK_ADD_LIMIT = ADS_WRITE_LIMITS.batchMax
export const ADS_BULK_ADD_MODES = ['KEYWORD', 'NEGATIVE'] as const
export type AdsBulkAddMode = (typeof ADS_BULK_ADD_MODES)[number]
export const ADS_BULK_ADD_SOURCES = ['MANUAL', 'BRAND_SEARCH_TERM', 'TERM_CENTER'] as const
export type AdsBulkAddSource = (typeof ADS_BULK_ADD_SOURCES)[number]
export const ADS_BULK_ADD_SOURCE_LABEL: Record<AdsBulkAddSource, string> = { MANUAL: '手动输入', BRAND_SEARCH_TERM: '品牌分析搜索词', TERM_CENTER: '词级中心候选词' }

/** 词的比较口径：去首尾空白、连续空白合并成一个、不分大小写（亚马逊的关键词不区分大小写）。 */
export const normalizeKeywordText = (text: string): string => text.trim().replace(/\s+/g, ' ').toLowerCase()
export const keywordKey = (text: string, matchType: string): string => `${normalizeKeywordText(text)}|${matchType.toUpperCase()}`

export interface AdsBulkAddSkipped {
  index: number
  text: string
  matchType: string
  reason: string
}

export interface AdsBulkAddItem {
  text: string
  matchType: string
  amount?: number
}

/** 批内重复与目标里已存在的词不再提交：返回要提交的项和被跳过的项（带原因）。幂等：同一份请求重复提交，第二次全部是“已存在”。 */
export function splitBulkItems(items: readonly AdsBulkAddItem[], existing: ReadonlySet<string>): { pending: Array<AdsBulkAddItem & { index: number }>; skipped: AdsBulkAddSkipped[] } {
  const seen = new Set<string>()
  const pending: Array<AdsBulkAddItem & { index: number }> = []
  const skipped: AdsBulkAddSkipped[] = []
  items.forEach((item, index) => {
    const key = keywordKey(item.text, item.matchType)
    if (existing.has(key)) skipped.push({ index, text: item.text, matchType: item.matchType, reason: '目标里已经有这个词和匹配方式，没有重复添加' })
    else if (seen.has(key)) skipped.push({ index, text: item.text, matchType: item.matchType, reason: '本次请求里重复了，只提交第一条' })
    else {
      seen.add(key)
      pending.push({ ...item, index })
    }
  })
  return { pending, skipped }
}

// ---- 重复关键词 ----

export interface DuplicateKeywordRecord {
  id: string
  adsProfileId: string
  campaignId: string
  adGroupId: string
  text: string
  matchType: string
  bid: number | null
  state: string
}

export interface AdsDuplicateLocation {
  /** 关键词的系统编号（投放详情页用）。 */
  keywordId: string
  adGroupExternalId: string
  adGroupId: string | null
  adGroupName: string | null
  campaignId: string | null
  campaignName: string | null
  state: string
  bid: number | null
}

export interface AdsDuplicateKeyword {
  key: string
  adsProfileId: string
  text: string
  matchType: string
  matchLabel: string
  adGroupCount: number
  locations: AdsDuplicateLocation[]
}

const MATCH_LABEL: Record<string, string> = { EXACT: '精确匹配', PHRASE: '词组匹配', BROAD: '广泛匹配' }
export const keywordMatchLabel = (matchType: string): string => MATCH_LABEL[matchType.toUpperCase()] ?? matchType

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 同一广告账户下，同一个词、同一匹配方式出现在两个及以上不同广告组的分组；已归档的不算。同一广告组里的重复不在这里（那是单个广告组自己的问题）。 */
export function groupDuplicateKeywords(records: readonly DuplicateKeywordRecord[]): Array<{ key: string; adsProfileId: string; text: string; matchType: string; records: DuplicateKeywordRecord[] }> {
  const groups = new Map<string, { key: string; adsProfileId: string; text: string; matchType: string; records: DuplicateKeywordRecord[] }>()
  for (const record of records) {
    if (record.state.toUpperCase() === 'ARCHIVED') continue
    const key = `${record.adsProfileId}|${keywordKey(record.text, record.matchType)}`
    const group = groups.get(key) ?? { key, adsProfileId: record.adsProfileId, text: normalizeKeywordText(record.text), matchType: record.matchType.toUpperCase(), records: [] }
    group.records.push(record)
    groups.set(key, group)
  }
  return [...groups.values()]
    .filter(group => new Set(group.records.map(record => `${record.campaignId}|${record.adGroupId}`)).size >= 2)
    .map(group => ({ ...group, records: [...group.records].sort(byId) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

export interface AdsDuplicateKeywordsResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: AdsDuplicateKeyword[]
  pageInfo: CursorPageInfo
  total: number
  truncated: boolean
}

// ---- 超预算时间条的接口响应 ----

export interface AdsBudgetTimelineResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  precisionNote: string
  zone: string
  currency: string
  /** 当前日预算；预算未同步或不是日预算是 null（只显示花费，不判断超预算）。 */
  budget: number | null
  budgetNote: string | null
  historyDays: number
  period: { from: string; to: string }
  days: BudgetTimelineDay[]
  averageOverBudgetHours: number | null
  defaultWindow: AdsAttributionWindow
  windows: AdsAttributionWindowView[]
}

export interface AdsBulkAddResponse {
  state: 'QUEUED' | 'NOTHING_TO_ADD'
  requested: number
  runs: AdsWriteRunRow[]
  skipped: AdsBulkAddSkipped[]
}
