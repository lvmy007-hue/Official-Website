import { REVIEWS_LIMITS, lastMonths, rateFromPercent, type ReviewSentiment, type ReviewTrendScope } from '@nova/api-contracts'

// 客户反馈接口的响应解析（importers.md I-15，P4-13）：纯函数，不访问数据库与网络。
// 字段名依据亚马逊官方文档整理，没有拿真实响应核对（CR-088 披露），所以解析一律宽容：认得出的写进结果，认不出的计入 skipped，永远不抛错。
// 规则：
//   - 主题的情感可能是条目自己的 sentiment 字段（POSITIVE / NEGATIVE），也可能按 positiveTopics / negativeTopics 或 topics.positive / topics.negative 分组；分组优先；
//   - 提及量取接口给的区间文字原样（mentionRange / reviewCountBucket，允许在 asinMetrics 等子对象里）；找不到就是 null，绝不估算，也不当 0；
//   - 趋势里的占比是百分数（0 到 100），用 rateFromPercent 转成小数；超出范围的行丢弃并计入 outOfRange；
//   - 趋势的口径（scope）只认得出 ALL（类目全部商品）与 TOP25（类目前 25% 商品）：从点上的键名（allProducts、top25Percent …）或 scope 一类的字段读；读不出口径的点计入 skipped，不猜；
//   - 每个商品每种情感最多保留 REVIEWS_LIMITS.topicsPerSentiment 条，名次从 1 起按接口给的顺序；类目趋势只保留最近 REVIEWS_LIMITS.trendMonths 个月。

type Loose = Record<string, unknown>
const record = (value: unknown): Loose | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null)
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)
const unwrap = (body: unknown): Loose | null => {
  const root = record(body)
  return record(root?.payload) ?? root
}

const TOPIC_MAX = 200
const RANGE_MAX = 100
const NAME_KEYS = ['topic', 'topicName', 'name', 'topicKey', 'title', 'reason', 'returnReason', 'returnTopic'] as const

/** 主题名：条目是字符串就是它本身；是对象就按常见字段名找，字段值是对象时再往里找一层。 */
function nameOf(entry: unknown, depth = 0): string | null {
  const direct = text(entry, TOPIC_MAX)
  if (direct) return direct
  const item = record(entry)
  if (!item || depth > 1) return null
  for (const key of NAME_KEYS) {
    const found = nameOf(item[key], depth + 1)
    if (found) return found
  }
  return text(item.text, TOPIC_MAX) ?? text(item.displayName, TOPIC_MAX)
}

function sentimentOf(value: unknown): ReviewSentiment | null {
  const label = typeof value === 'string' ? value.trim() : ''
  if (/^pos/i.test(label)) return 'POSITIVE'
  if (/^neg/i.test(label)) return 'NEGATIVE'
  return null
}
const entrySentiment = (entry: unknown): ReviewSentiment | null => {
  const item = record(entry)
  return item ? (sentimentOf(item.sentiment) ?? sentimentOf(item.topicSentiment) ?? sentimentOf(item.polarity)) : null
}

interface TopicEntry {
  entry: unknown
  sentiment: ReviewSentiment | null
}
const GROUP_KEYS: ReadonlyArray<readonly [string, ReviewSentiment]> = [
  ['positiveTopics', 'POSITIVE'],
  ['negativeTopics', 'NEGATIVE'],
  ['positive', 'POSITIVE'],
  ['negative', 'NEGATIVE'],
]
const LIST_KEYS = ['topics', 'reviewTopics', 'returnTopics', 'returnReasons', 'topicTrends', 'items'] as const

/** 把响应里所有主题条目收集起来，并标上所属的情感分组（分组优先于条目自己的字段）。 */
function collectTopics(body: unknown): TopicEntry[] {
  const base = unwrap(body)
  if (!base) return []
  const out: TopicEntry[] = []
  const grouped = record(base.topics)
  for (const holder of [base, grouped]) {
    if (!holder) continue
    for (const [key, sentiment] of GROUP_KEYS) for (const entry of list(holder[key])) out.push({ entry, sentiment })
  }
  for (const key of LIST_KEYS) for (const entry of list(base[key])) out.push({ entry, sentiment: entrySentiment(entry) })
  return out
}

/** 提及量区间文字：先看条目本身，再看常见的指标子对象；只认文字，不认数字（数字不是区间，不能当区间用）。 */
function rangeOf(entry: unknown, key: 'mentionRange' | 'reviewCountBucket'): string | null {
  const item = record(entry)
  if (!item) return null
  for (const holder of [item, record(item.asinMetrics), record(item.metrics), record(item.mentions)]) {
    const found = text(holder?.[key], RANGE_MAX)
    if (found) return found
  }
  return null
}

// ---- 商品评论主题 ----

export interface ParsedTopic {
  topicKey: string
  sentiment: ReviewSentiment
  /** 该情感下的名次（从 1 起）。 */
  rank: number
  mentionRange: string | null
  reviewCountBucket: string | null
}
export interface ParsedTopics {
  rows: ParsedTopic[]
  /** 认不出主题名或情感的条目数。 */
  skipped: number
}

export function parseItemTopics(body: unknown): ParsedTopics {
  const rows: ParsedTopic[] = []
  const seen = new Set<string>()
  const ranks: Record<ReviewSentiment, number> = { POSITIVE: 0, NEGATIVE: 0 }
  let skipped = 0
  for (const { entry, sentiment } of collectTopics(body)) {
    const topicKey = nameOf(entry)
    if (!topicKey || !sentiment) {
      skipped += 1
      continue
    }
    const identity = topicKey.toLowerCase()
    // 同一商品同一天的主题名唯一（数据库唯一键不含情感）：同名的后一条丢弃
    if (seen.has(identity) || ranks[sentiment] >= REVIEWS_LIMITS.topicsPerSentiment) continue
    seen.add(identity)
    ranks[sentiment] += 1
    rows.push({ topicKey, sentiment, rank: ranks[sentiment], mentionRange: rangeOf(entry, 'mentionRange'), reviewCountBucket: rangeOf(entry, 'reviewCountBucket') })
  }
  return { rows, skipped }
}

// ---- 浏览节点 ----

export interface ParsedBrowseNode {
  browseNodeId: string | null
  browseNodeName: string | null
}

const idText = (value: unknown): string | null => {
  const raw = typeof value === 'number' && Number.isFinite(value) ? String(value) : value
  const id = text(raw, 40)
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null
}

/** 商品所在的浏览节点：编号与名称都可能在根上、browseNode 对象里，或 browseNodes 列表的第一项里；认不出就是 null。 */
export function parseBrowseNode(body: unknown): ParsedBrowseNode {
  const base = unwrap(body)
  const candidates = [base, record(base?.browseNode), record(list(base?.browseNodes)[0])]
  for (const item of candidates) {
    if (!item) continue
    const browseNodeId = idText(item.browseNodeId) ?? idText(item.nodeId) ?? idText(item.id)
    if (!browseNodeId) continue
    const browseNodeName = text(item.browseNodeName, 200) ?? text(item.displayName, 200) ?? text(item.name, 200) ?? text(item.browseNodeDisplayName, 200)
    return { browseNodeId, browseNodeName }
  }
  return { browseNodeId: null, browseNodeName: null }
}

// ---- 类目趋势（评论主题与退货主题共用） ----

export interface ParsedTrend {
  scope: ReviewTrendScope
  /** 月份第一天，YYYY-MM-01。 */
  month: string
  topicKey: string
  /** 评论趋势才有；退货趋势为 null。 */
  sentiment: ReviewSentiment | null
  /** 0 到 1 的小数。 */
  rate: number
}
export interface ParsedTrends {
  rows: ParsedTrend[]
  /** 认不出主题名、情感、月份、口径或没给占比的条目数。 */
  skipped: number
  /** 占比不在 0 到 100 之内、被丢弃的行数。 */
  outOfRange: number
}

const POINT_KEYS = ['trends', 'monthlyTrends', 'trend', 'dataPoints', 'points', 'months', 'data', 'history'] as const
const PERCENT_KEYS = ['occurrencePercentage', 'percentage', 'percent', 'rate', 'share', 'value'] as const

/** 按单词判断口径（驼峰、下划线都拆开），避免 small 这类词里的 all 被当成“全部商品”。 */
const scopeOfLabel = (label: string): ReviewTrendScope | null => {
  const words = label
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const joined = words.join('')
  if (joined.includes('top25') || joined.includes('topquartile')) return 'TOP25'
  return words.includes('all') || words.includes('overall') ? 'ALL' : null
}
const percentOf = (value: unknown): unknown => {
  const item = record(value)
  if (!item) return value
  for (const key of PERCENT_KEYS) if (item[key] !== undefined && item[key] !== null) return item[key]
  return undefined
}

/** 趋势点的月份：支持 2026-09、2026-09-01、带时间的 ISO 文字，以及 startDate / dateRange.startDate 这类写法。 */
function monthOf(point: Loose): string | null {
  const candidates = [point.month, point.startDate, record(point.dateRange)?.startDate, record(point.period)?.startDate, point.date, point.period, point.periodStart]
  for (const candidate of candidates) {
    const match = typeof candidate === 'string' ? /^(\d{4})-(\d{2})(?:-\d{2})?/.exec(candidate.trim()) : null
    if (match && Number(match[2]) >= 1 && Number(match[2]) <= 12) return `${match[1]}-${match[2]}-01`
  }
  return null
}

export function parseTrends(body: unknown, kind: 'review' | 'return'): ParsedTrends {
  const byKey = new Map<string, ParsedTrend>()
  let skipped = 0
  let outOfRange = 0
  const readPoint = (point: unknown, topicKey: string, sentiment: ReviewSentiment | null, forced: ReviewTrendScope | null) => {
    const item = record(point)
    const month = item ? monthOf(item) : null
    if (!item || !month) {
      skipped += 1
      return
    }
    const readings: Array<{ scope: ReviewTrendScope; raw: unknown }> = []
    for (const [key, value] of Object.entries(item)) {
      const scope = scopeOfLabel(key)
      if (scope) readings.push({ scope, raw: percentOf(value) })
    }
    const labelled = [item.scope, item.segment, item.group, item.productGroup, item.benchmark].map(value => (typeof value === 'string' ? scopeOfLabel(value) : null)).find(Boolean) ?? forced
    if (readings.length === 0 && labelled) readings.push({ scope: labelled, raw: percentOf(item) })
    if (readings.length === 0) skipped += 1
    for (const { scope, raw } of readings) {
      if (raw === undefined || raw === null) {
        skipped += 1
        continue
      }
      const rate = rateFromPercent(typeof raw === 'string' ? raw.replace(/%\s*$/, '') : raw)
      if (rate === null) {
        outOfRange += 1
        continue
      }
      byKey.set(`${scope}|${month}|${topicKey}`, { scope, month, topicKey, sentiment, rate })
    }
  }
  for (const { entry, sentiment } of collectTopics(body)) {
    const topicKey = nameOf(entry)
    const item = record(entry)
    if (!topicKey || !item || (kind === 'review' && !sentiment)) {
      skipped += 1
      continue
    }
    const side = kind === 'review' ? sentiment : null
    for (const key of POINT_KEYS) for (const point of list(item[key])) readPoint(point, topicKey, side, null)
    // 口径放在条目的键上：{ topic, allProducts: [点], top25Percent: [点] }
    for (const [key, value] of Object.entries(item)) {
      const scope = scopeOfLabel(key)
      if (scope && Array.isArray(value)) for (const point of value) readPoint(point, topicKey, side, scope)
    }
  }
  const keep = new Set(lastMonths([...byKey.values()].map(row => row.month)))
  return { rows: [...byKey.values()].filter(row => keep.has(row.month)), skipped, outOfRange }
}
