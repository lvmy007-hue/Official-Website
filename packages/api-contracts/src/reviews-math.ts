import { REVIEWS_LIMITS, type RatingPoint, type RatingsImportError } from './reviews.js'

// 评价与反馈的纯计算（P4-13）：请求评价的期限、评分变化与增长、覆盖率、评分文件解析、主题与退货原因的文字重合。不含 zod，前后端共用。

const DAY_MS = 86_400_000

export const REVIEW_ASIN_PATTERN = /^[A-Z0-9]{10}$/
export const normalizeReviewAsin = (value: string): string => value.trim().toUpperCase()
const round = (value: number, digits: number): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

// ---- 请求评价期限 ----

export type SolicitationWindowState = 'TOO_EARLY' | 'OPEN' | 'CLOSED'
export interface SolicitationWindow {
  state: SolicitationWindowState
  /** 送达后已过去的整天数（送达当天为 0）。 */
  daysSince: number
  /** 请求期限还剩几天（送达后第 30 天为 0）；未到期限或已过期为 null。 */
  daysLeft: number | null
}

/** 订单送达后第 5 至 30 天（含）内可以请求评价；按整天数计算，不看具体钟点。 */
export function solicitationWindowOf(deliveredAt: Date, now: Date): SolicitationWindow {
  const daysSince = Math.floor((now.getTime() - deliveredAt.getTime()) / DAY_MS)
  if (daysSince < REVIEWS_LIMITS.windowStartDay) return { state: 'TOO_EARLY', daysSince, daysLeft: null }
  if (daysSince > REVIEWS_LIMITS.windowEndDay) return { state: 'CLOSED', daysSince, daysLeft: null }
  return { state: 'OPEN', daysSince, daysLeft: REVIEWS_LIMITS.windowEndDay - daysSince }
}

/** 可请求订单的送达时间范围：最晚送达时间（第 5 天）与最早送达时间（第 30 天）；两端含。 */
export function eligibleDeliveredRange(now: Date): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - (REVIEWS_LIMITS.windowEndDay + 1) * DAY_MS + 1), to: new Date(now.getTime() - REVIEWS_LIMITS.windowStartDay * DAY_MS) }
}

/** 请求覆盖率 = 已请求 ÷ 已送达；没有已送达订单为 null（不是 0）。 */
export const solicitCoverageOf = (delivered: number, requested: number): number | null => (delivered > 0 ? round(Math.min(requested, delivered) / delivered, 6) : null)

// ---- 评分变化与增长 ----

export interface RatingSnapshotLite {
  date: string
  avgRating: number | null
  ratingCount: number | null
}

/** 最近的采集点（输入按日期从旧到新）：保留最后 N 个。 */
export const recentRatingPoints = (rows: readonly RatingSnapshotLite[], limit: number = REVIEWS_LIMITS.ratingTrendPoints): RatingPoint[] => rows.slice(-limit).map(row => ({ ...row }))

/** 最新一次与上一次采集的变化；上一次没有对应字段时该项为 null。 */
export function ratingDeltaOf(rows: readonly RatingSnapshotLite[]): { ratingDelta: number | null; countDelta: number | null; previousDate: string | null } {
  if (rows.length < 2) return { ratingDelta: null, countDelta: null, previousDate: null }
  const last = rows[rows.length - 1]
  const prev = rows[rows.length - 2]
  return {
    ratingDelta: last.avgRating !== null && prev.avgRating !== null ? round(last.avgRating - prev.avgRating, 2) : null,
    countDelta: last.ratingCount !== null && prev.ratingCount !== null ? last.ratingCount - prev.ratingCount : null,
    previousDate: prev.date,
  }
}

export interface RatingGrowth {
  beforeCount: number | null
  beforeDate: string | null
  afterCount: number | null
  afterDate: string | null
  delta: number | null
  note: string | null
}
const GROWTH_NEED_IMPORT = '需要再导入一次评分：请求前后各要有一次评分导入才能对照'

/**
 * 请求后评分数增长：请求前 = 首次请求当天或之前最近一次有评分数的采集；请求后 = 首次请求之后最近一次有评分数的采集。
 * 缺任何一次都不推测，写明原因。输入按日期从旧到新，firstRequestDay 是 YYYY-MM-DD。
 */
export function ratingGrowthOf(rows: readonly RatingSnapshotLite[], firstRequestDay: string): RatingGrowth {
  const counted = rows.filter(row => row.ratingCount !== null)
  const before = [...counted].reverse().find(row => row.date <= firstRequestDay) ?? null
  const after = [...counted].reverse().find(row => row.date > firstRequestDay) ?? null
  if (counted.length === 0) return { beforeCount: null, beforeDate: null, afterCount: null, afterDate: null, delta: null, note: '这个商品还没有导入过评分数' }
  const base = { beforeCount: before?.ratingCount ?? null, beforeDate: before?.date ?? null, afterCount: after?.ratingCount ?? null, afterDate: after?.date ?? null }
  if (!before) return { ...base, delta: null, note: '首次请求之前没有评分导入，没有“请求前”的数字' }
  if (!after) return { ...base, delta: null, note: GROWTH_NEED_IMPORT }
  return { ...base, delta: (after.ratingCount as number) - (before.ratingCount as number), note: null }
}

// ---- 类目趋势月份 ----

/** 日期所在月的第一天（UTC，YYYY-MM-01）。 */
export const monthStartOf = (value: Date | string): string => {
  const text = typeof value === 'string' ? value : value.toISOString()
  return `${text.slice(0, 7)}-01`
}

/** 按月份升序取最近 N 个不同的月份。 */
export const lastMonths = (months: Iterable<string>, count: number = REVIEWS_LIMITS.trendMonths): string[] => [...new Set(months)].sort().slice(-count)

/** 接口给的百分数（0 到 100）转成 0 到 1 的小数；超出范围或不是数字为 null，不夹取。 */
export function rateFromPercent(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(n) || n < 0 || n > 100) return null
  return round(n / 100, 6)
}

// ---- 评论主题与退货原因 ----

const STOP = new Set(['the', 'and', 'for', 'with', 'not', 'too', 'issue', 'issues', 'problem', 'problems', 'product', 'item', 'quality', 'of', 'to', 'is', 'in', 'a'])
const tokensOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 3 && !STOP.has(token))

/** 评论主题与退货原因（代码或名称）的英文词有重合就算“可能相关”：只做文字比对，不判断语义。 */
export function topicMatchesReason(topic: string, reason: string): boolean {
  const reasonTokens = new Set(tokensOf(reason))
  return tokensOf(topic).some(token => reasonTokens.has(token))
}

export function improvementSuggestion(input: { topic: string | null; reasonLabel: string | null; possiblyRelated: boolean }): string {
  if (!input.topic) return '这个商品最新没有负面评论主题，先看退货原因分布。'
  const reason = input.reasonLabel ? `，近期退货最多的原因是“${input.reasonLabel}”` : ''
  return input.possiblyRelated
    ? `负面主题“${input.topic}”与退货原因文字有重合${reason}：优先核对商品本身与详情页描述是否一致，再安排产品或供应链跟进。`
    : `最突出的负面主题是“${input.topic}”${reason}：两者文字上没有重合，建议先阅读该主题的评论再判断是否同一个问题。`
}

// ---- 评分文件解析（F-01） ----

export interface RatingsFileRow {
  line: number
  asin: string
  captureDate: string
  avgRating: number | null
  ratingCount: number | null
  distribution: Record<string, number> | null
}
export interface RatingsFileParse {
  rows: RatingsFileRow[]
  errors: RatingsImportError[]
}

const COLUMN_ALIASES: Record<string, readonly string[]> = {
  asin: ['asin'],
  captureDate: ['采集日期', '日期', 'capturedate', 'capture_date', 'date'],
  avgRating: ['平均星级', '平均评分', '星级', 'avgrating', 'avg_rating', 'averagerating', 'rating'],
  ratingCount: ['评分数', '评分数量', '评价数', 'ratingcount', 'rating_count', 'ratings', 'reviews'],
  star1: ['1星', '一星', 'star1', 'star_1', '1star'],
  star2: ['2星', '二星', 'star2', 'star_2', '2star'],
  star3: ['3星', '三星', 'star3', 'star_3', '3star'],
  star4: ['4星', '四星', 'star4', 'star_4', '4star'],
  star5: ['5星', '五星', 'star5', 'star_5', '5star'],
}
const STAR_KEYS = ['star1', 'star2', 'star3', 'star4', 'star5'] as const

/** 拆一行：支持逗号、制表符、分号分隔与双引号包裹（引号里的分隔符和双双引号按字面）。 */
function splitLine(line: string, delimiter: string): string[] {
  const cells: string[] = []
  let current = ''
  let quoted = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        current += '"'
        index += 1
      } else if (char === '"') quoted = false
      else current += char
    } else if (char === '"') quoted = true
    else if (char === delimiter) {
      cells.push(current)
      current = ''
    } else current += char
  }
  cells.push(current)
  return cells.map(cell => cell.trim())
}

const delimiterOf = (header: string): string => {
  const counts = [',', '\t', ';'].map(delimiter => ({ delimiter, count: header.split(delimiter).length - 1 }))
  return counts.sort((a, b) => b.count - a.count)[0].delimiter
}

const isRealDate = (text: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false
  const date = new Date(`${text}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text
}
/** 日期兼容 YYYY-MM-DD 与 YYYY/M/D；其余格式按不合法处理。 */
const normalizeDate = (text: string): string => {
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text.trim())
  return match ? `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}` : text.trim()
}
const numberOf = (text: string): number | null => {
  const clean = text.replace(/,/g, '').trim()
  return clean !== '' && /^-?\d+(\.\d+)?$/.test(clean) ? Number(clean) : null
}

/**
 * 解析评分文件（CSV 或制表符分隔文本）。一行有错整份拒绝：返回的 rows 只在 errors 为空时才该被使用。
 * 必须有 ASIN、采集日期两列，且至少有平均星级、评分数之一；星级 1 到 5；评分数与分布人数是不小于 0 的整数；采集日期不晚于 today；同一 ASIN 同一日期不能出现两次。
 */
export function parseRatingsFile(text: string, today: string): RatingsFileParse {
  const errors: RatingsImportError[] = []
  const rows: RatingsFileRow[] = []
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, line: index + 1 }))
    .filter(entry => entry.raw.trim() !== '')
  if (lines.length === 0) return { rows, errors: [{ line: 1, column: '', code: 'FILE_COLUMN_MISSING', message: '文件是空的' }] }
  const delimiter = delimiterOf(lines[0].raw)
  const headers = splitLine(lines[0].raw, delimiter).map(cell => cell.toLowerCase().replace(/\s+/g, ''))
  const indexOf = (key: string): number => headers.findIndex(header => COLUMN_ALIASES[key].includes(header))
  const columns = Object.fromEntries(Object.keys(COLUMN_ALIASES).map(key => [key, indexOf(key)])) as Record<string, number>
  if (columns.asin < 0) errors.push({ line: lines[0].line, column: 'ASIN', code: 'FILE_COLUMN_MISSING', message: '缺少“ASIN”列' })
  if (columns.captureDate < 0) errors.push({ line: lines[0].line, column: '采集日期', code: 'FILE_COLUMN_MISSING', message: '缺少“采集日期”列' })
  if (columns.avgRating < 0 && columns.ratingCount < 0) errors.push({ line: lines[0].line, column: '平均星级', code: 'FILE_COLUMN_MISSING', message: '“平均星级”和“评分数”至少要有一列' })
  if (errors.length > 0) return { rows, errors }
  if (lines.length - 1 > REVIEWS_LIMITS.importRowsMax) return { rows, errors: [{ line: 1, column: '', code: 'FILE_VALUE_INVALID', message: `一次最多导入 ${REVIEWS_LIMITS.importRowsMax} 行` }] }
  const seen = new Map<string, number>()
  for (const entry of lines.slice(1)) {
    const cells = splitLine(entry.raw, delimiter)
    const cell = (key: string): string => (columns[key] >= 0 ? (cells[columns[key]] ?? '') : '')
    const fail = (column: string, code: RatingsImportError['code'], message: string) => errors.push({ line: entry.line, column, code, message })
    const before = errors.length
    const asin = normalizeReviewAsin(cell('asin'))
    if (!REVIEW_ASIN_PATTERN.test(asin)) fail('ASIN', 'FILE_VALUE_INVALID', 'ASIN 要是 10 位字母或数字')
    const captureDate = normalizeDate(cell('captureDate'))
    if (!isRealDate(captureDate)) fail('采集日期', 'FILE_VALUE_INVALID', '采集日期格式应为 YYYY-MM-DD')
    else if (captureDate > today) fail('采集日期', 'FILE_VALUE_RANGE', '采集日期不能晚于今天')
    let avgRating: number | null = null
    if (cell('avgRating') !== '') {
      avgRating = numberOf(cell('avgRating'))
      if (avgRating === null) fail('平均星级', 'FILE_VALUE_INVALID', '平均星级要是数字')
      else if (avgRating < 1 || avgRating > 5) fail('平均星级', 'FILE_VALUE_RANGE', '平均星级要在 1 到 5 之间')
      else avgRating = round(avgRating, 2)
    }
    let ratingCount: number | null = null
    if (cell('ratingCount') !== '') {
      const value = numberOf(cell('ratingCount'))
      if (value === null || !Number.isInteger(value)) fail('评分数', 'FILE_VALUE_INVALID', '评分数要是整数')
      else if (value < 0) fail('评分数', 'FILE_VALUE_RANGE', '评分数不能为负')
      else ratingCount = value
    }
    if (errors.length === before && avgRating === null && ratingCount === null) fail('平均星级', 'FILE_VALUE_INVALID', '平均星级与评分数不能同时为空')
    let distribution: Record<string, number> | null = null
    STAR_KEYS.forEach((key, position) => {
      if (cell(key) === '') return
      const value = numberOf(cell(key))
      if (value === null || !Number.isInteger(value) || value < 0) fail(`${position + 1}星`, 'FILE_VALUE_RANGE', '星级分布要是不小于 0 的整数')
      else distribution = { ...(distribution ?? {}), [String(position + 1)]: value }
    })
    if (errors.length === before) {
      const key = `${asin}|${captureDate}`
      const firstLine = seen.get(key)
      if (firstLine !== undefined) fail('ASIN', 'FILE_DUPLICATE', `与第 ${firstLine} 行重复（同一 ASIN 同一采集日期只能有一行）`)
      else {
        seen.set(key, entry.line)
        rows.push({ line: entry.line, asin, captureDate, avgRating, ratingCount, distribution })
      }
    }
  }
  return { rows, errors }
}
