import {
  AD_TERM_ADVICE_LABEL,
  AD_TERM_ANOMALY_TABS,
  AD_TERM_RULES,
  AD_TERM_ROOT_EXAMPLES,
  AD_TERM_ROOT_FORMS,
  type AdTermAdvice,
  type AdTermAnomaly,
  type AdTermCampaigns,
  type AdTermListTab,
  type AdTermQuadrantPoint,
  type AdTermRootRow,
  type AdTermRootSort,
  type AdTermSort,
  type AdTermSummary,
} from './ad-terms'
import { termKey } from './ads-campaigns-math'
import type { AdsTermStatus } from './ads-campaigns-tabs'
import type { AdsQuadrant } from './ads-overview'
import { addNullable, addTotals, adsRatios, quadrantOf, type AdsRatios, type AdsTotals } from './ads-overview-math'

// 词级中心的纯函数（P3-10）：异常分组、状态、排序、四象限、词根与词形还原、推荐动作。API 与前端共用；全部可空：来源没给的值是 null，不当 0。

const roundTo = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits

// ---- 状态与异常分组 ----

/** 一个词在若干活动里的综合状态：每个活动都已否定 → 已否定；任一活动已投放 → 已投放；其余 → 未投放（至少有一个活动既没投放也没否定）。 */
export function termRowStatus(campaigns: AdTermCampaigns): AdsTermStatus {
  if (campaigns.total > 0 && campaigns.negated >= campaigns.total) return 'NEGATED'
  return campaigns.targeted > 0 ? 'TARGETED' : 'UNTARGETED'
}

/**
 * 一个词命中的异常分组（规则与默认值见 AD_TERM_RULES）；可以同时命中多个。
 * 加词与否定候选只对搜索词有意义，并且要求这个词还没有被投放（状态“未投放”）。花费为空（来源没给）的词不判断与花费有关的规则。
 */
export function termAnomaliesOf(totals: AdsTotals, context: { kind: 'target' | 'search-term'; status?: AdsTermStatus }): AdTermAnomaly[] {
  const found: AdTermAnomaly[] = []
  const { spend, sales, clicks, orders } = totals
  if (spend !== null && spend >= AD_TERM_RULES.MIN_SPEND && clicks >= AD_TERM_RULES.MIN_CLICKS && orders === 0) found.push('HIGH_SPEND_NO_ORDER')
  if (orders >= AD_TERM_RULES.SCALE_MIN_ORDERS && spend !== null && sales !== null && sales > 0 && spend / sales <= AD_TERM_RULES.SCALE_MAX_ACOS) found.push('SCALE_UP')
  if (context.kind === 'search-term' && context.status === 'UNTARGETED') {
    if (orders >= AD_TERM_RULES.ADD_MIN_ORDERS && clicks > 0 && orders / clicks >= AD_TERM_RULES.ADD_MIN_CVR) found.push('ADD_KEYWORD')
    if (orders === 0 && spend !== null && clicks >= AD_TERM_RULES.NEGATIVE_MIN_CLICKS && spend >= AD_TERM_RULES.NEGATIVE_MIN_SPEND) found.push('NEGATIVE_CANDIDATE')
  }
  return found
}

/** 某个异常分组是否适用于这个页签（不适用的分组在该页签筛选会被拒绝，避免“以为生效实际被忽略”）。 */
export const anomalyAppliesTo = (anomaly: AdTermAnomaly, tab: AdTermListTab): boolean => AD_TERM_ANOMALY_TABS[anomaly].includes(tab)

/** 页签与筛选的组合是否合法：返回第一条问题，没问题为 null。 */
export function termFilterIssue(tab: AdTermListTab, filters: { anomaly?: AdTermAnomaly; status?: string; level?: string; matchType?: string; subject?: string }): string | null {
  if (filters.anomaly && !anomalyAppliesTo(filters.anomaly, tab)) return '这个异常分组不适用于当前页签'
  if (filters.status && tab !== 'search-terms') return '“已投放/已否定/未投放”状态筛选只适用于搜索词页签'
  if (filters.level && tab !== 'negatives') return '“活动级/广告组级”筛选只适用于否定词库页签'
  if (filters.matchType && tab !== 'targets' && tab !== 'negatives') return '匹配方式筛选只适用于投放对象与否定词库页签'
  if (filters.subject && tab !== 'quadrant') return '四象限的对象选择只适用于四象限页签'
  return null
}

export const emptyAnomalyCounts = (): Record<AdTermAnomaly, number> => ({ HIGH_SPEND_NO_ORDER: 0, SCALE_UP: 0, ADD_KEYWORD: 0, NEGATIVE_CANDIDATE: 0 })

type Measured = { totals: AdsTotals; ratios: AdsRatios; anomalies: readonly AdTermAnomaly[] }
/** 一批词的合计与每个异常分组命中的词数。 */
export function summarizeTerms(rows: readonly Measured[]): AdTermSummary {
  const totals = addTotals(rows.map(row => row.totals))
  const anomalies = emptyAnomalyCounts()
  for (const row of rows) for (const anomaly of row.anomalies) anomalies[anomaly] += 1
  return { total: rows.length, totals, ratios: adsRatios(totals), anomalies }
}

// ---- 关键字与排序 ----

/** 词包含关键字（不分大小写）。 */
export const termMatches = (label: string, q: string | undefined): boolean => !q || label.toLowerCase().includes(q.toLowerCase())

type Sortable = { key: string; totals: AdsTotals; ratios: AdsRatios }
type RootSortable = Sortable & { terms?: number; stores?: number }

function sortValue(row: RootSortable, label: string, sort: AdTermSort | AdTermRootSort): number | string | null {
  switch (sort) {
    case 'spend':
      return row.totals.spend
    case 'sales':
      return row.totals.sales
    case 'orders':
      return row.totals.orders
    case 'clicks':
      return row.totals.clicks
    case 'impressions':
      return row.totals.impressions
    case 'terms':
      return row.terms ?? null
    case 'stores':
      return row.stores ?? null
    case 'term':
      return label.toLowerCase()
    default:
      return row.ratios[sort]
  }
}

/** 列表排序：空值永远排在最后（不论升降序），并列按词再按行键，保证翻页顺序稳定。普通字符串比较，不用 localeCompare。 */
export function compareTermRows(a: RootSortable & { label: string }, b: RootSortable & { label: string }, sort: AdTermSort | AdTermRootSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, a.label, sort)
  const right = sortValue(b, b.label, sort)
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  const byLabel = a.label.toLowerCase()
  const otherLabel = b.label.toLowerCase()
  if (byLabel !== otherLabel) return byLabel < otherLabel ? -1 : 1
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

// ---- 四象限 ----

export interface QuadrantInput {
  key: string
  name: string
  totals: AdsTotals
}
export interface QuadrantResult {
  points: AdTermQuadrantPoint[]
  spendLine: number | null
  acosLine: number | null
  counts: Record<AdsQuadrant, number>
  total: number
  withoutSales: { terms: number; spend: number | null }
}

/**
 * 四象限：能画的点是花费与广告销售额都大于 0 的词（广告成本销售比 = 花费 ÷ 广告销售额）；
 * 分界线是这些点的平均花费与整体广告成本销售比（花费合计 ÷ 广告销售额合计）。
 * 有花费但没有广告销售额的词没法画，单独计数并给出花费，不当成极大值画在图上。点只留花费最高的 limit 个，象限计数覆盖全部可画的点。
 */
export function buildTermQuadrant(inputs: readonly QuadrantInput[], limit: number): QuadrantResult {
  const drawable: Array<{ input: QuadrantInput; spend: number; sales: number }> = []
  const missing: number[] = []
  for (const input of inputs) {
    const { spend, sales } = input.totals
    if (spend === null || spend <= 0) continue
    if (sales === null || sales <= 0) missing.push(spend)
    else drawable.push({ input, spend, sales })
  }
  const withoutSales = { terms: missing.length, spend: addNullable(missing) }
  const counts: Record<AdsQuadrant, number> = { STAR: 0, WASTE: 0, POTENTIAL: 0, LOW: 0 }
  if (drawable.length === 0) return { points: [], spendLine: null, acosLine: null, counts, total: 0, withoutSales }
  const spendLine = drawable.reduce((total, item) => total + item.spend, 0) / drawable.length
  const acosLine = drawable.reduce((total, item) => total + item.spend, 0) / drawable.reduce((total, item) => total + item.sales, 0)
  const points = drawable.map((item): AdTermQuadrantPoint => {
    const acos = item.spend / item.sales
    const quadrant = quadrantOf(item.spend, acos, spendLine, acosLine)
    counts[quadrant] += 1
    return { key: item.input.key, name: item.input.name, spend: item.spend, sales: item.sales, orders: item.input.totals.orders, acos, quadrant }
  })
  points.sort((a, b) => b.spend - a.spend || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.key < b.key ? -1 : 1))
  return { points: points.slice(0, limit), spendLine, acosLine, counts, total: drawable.length, withoutSales }
}

// ---- 词根与词形还原 ----

const STOPWORDS = /* @__PURE__ */ new Set(['a', 'an', 'the', 'and', 'or', 'for', 'with', 'of', 'to', 'in', 'on', 'by', 'at', 'from', 'up', 'is', 'it', 'as', 'my', 'your', 'be', 'no'])
const IRREGULAR: Record<string, string> = {
  men: 'man',
  women: 'woman',
  children: 'child',
  feet: 'foot',
  teeth: 'tooth',
  mice: 'mouse',
  geese: 'goose',
  knives: 'knife',
  wives: 'wife',
  lives: 'life',
  leaves: 'leaf',
  shelves: 'shelf',
  wolves: 'wolf',
}
/** 不是单复数变化的以 s 结尾的词，原样保留。 */
const KEEP_S = /* @__PURE__ */ new Set(['glass', 'dress', 'bass', 'grass', 'bus', 'gas', 'lens', 'yoga', 'canvas', 'plus', 'chess', 'boss', 'cross', 'moss', 'class', 'mattress', 'cactus'])
const ASIN_LIKE = /^b0[a-z0-9]{8}$/i

/** 把一个英文单词还原成词根：不规则复数查表，其余按常见复数规则（ies→y、sses→ss、ches/shes/xes/zes 去 es、结尾 s 去掉）。不是完整的词形还原。 */
export function lemmaOf(word: string): string {
  const w = word.toLowerCase()
  const irregular = IRREGULAR[w]
  if (irregular) return irregular
  if (w.length <= 3 || KEEP_S.has(w) || !w.endsWith('s')) return w
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`
  if (w.endsWith('sses')) return w.slice(0, -2)
  if (/(ches|shes|xes|zes)$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('ss') || w.endsWith('us') || w.endsWith('is')) return w
  return w.slice(0, -1)
}

export interface TermToken {
  root: string
  form: string
}
/** 搜索词拆成词根：转小写、按非字母数字拆开、去掉单字符与虚词与 ASIN 样式的词；同一个词根在一个搜索词里只算一次。 */
export function termTokens(term: string): TermToken[] {
  const seen = new Set<string>()
  const tokens: TermToken[] = []
  for (const piece of term.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (piece.length < 2 || STOPWORDS.has(piece) || ASIN_LIKE.test(piece)) continue
    const root = lemmaOf(piece)
    if (seen.has(root)) continue
    seen.add(root)
    tokens.push({ root, form: piece })
  }
  return tokens
}

export interface RootInput {
  term: string
  storeId: string | null
  totals: AdsTotals
}

interface RootBucket {
  root: string
  forms: Map<string, number>
  terms: Map<string, { term: string; spend: number | null }>
  stores: Set<string>
  totals: AdsTotals[]
}

/** 词根汇总：每个词根的搜索词数、店铺数（只数绑定了店铺的）、合计、写法与花费最高的例子词。输入按（词 × 档案）分组，同一个词的多行会合并。 */
export function aggregateRoots(inputs: readonly RootInput[]): AdTermRootRow[] {
  const buckets = new Map<string, RootBucket>()
  for (const input of inputs) {
    const key = termKey(input.term)
    for (const token of termTokens(input.term)) {
      const bucket: RootBucket = buckets.get(token.root) ?? { root: token.root, forms: new Map(), terms: new Map(), stores: new Set(), totals: [] }
      bucket.forms.set(token.form, (bucket.forms.get(token.form) ?? 0) + 1)
      const held = bucket.terms.get(key) ?? { term: input.term, spend: null }
      held.spend = addNullable([held.spend, input.totals.spend])
      bucket.terms.set(key, held)
      if (input.storeId) bucket.stores.add(input.storeId)
      bucket.totals.push(input.totals)
      buckets.set(token.root, bucket)
    }
  }
  return [...buckets.values()].map((bucket): AdTermRootRow => {
    const totals = addTotals(bucket.totals)
    const examples = [...bucket.terms.values()]
      .sort((a, b) => (b.spend ?? -1) - (a.spend ?? -1) || (a.term < b.term ? -1 : a.term > b.term ? 1 : 0))
      .slice(0, AD_TERM_ROOT_EXAMPLES)
      .map(item => ({ term: item.term, spend: item.spend }))
    const forms = [...bucket.forms.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, AD_TERM_ROOT_FORMS)
      .map(([form]) => form)
    return { root: bucket.root, forms, terms: bucket.terms.size, stores: bucket.stores.size, totals, ratios: adsRatios(totals), examples }
  })
}

// ---- 推荐动作 ----

const money = (value: number | null) => (value === null ? '—' : `$${roundTo(value, 2).toFixed(2)}`)

/**
 * 词级分析页的推荐动作（规则见 AD_TERM_RULES，与异常分组一一对应）：
 *   否定候选 → 加为否定词；高花费无成交 → 已投放的降价或暂停、没投放的加为否定词；高转化可加词 → 加为关键词；可扩量 → 已投放的提价、没投放的加为关键词。
 * 每个动作只出现一次，写明依据数字；推荐只是建议，执行（写亚马逊）随 P3-17。
 */
export function termAdviceOf(totals: AdsTotals, status: AdsTermStatus, anomalies: readonly AdTermAnomaly[], windowDays: number): AdTermAdvice[] {
  const advice = new Map<AdTermAdvice['action'], string>()
  const window = `近 ${windowDays} 天`
  const targeted = status === 'TARGETED'
  for (const anomaly of anomalies) {
    if (anomaly === 'NEGATIVE_CANDIDATE') advice.set('NEGATE', `${window}点击 ${totals.clicks} 次、花费 ${money(totals.spend)}、没有订单，且还没有被投放或否定`)
    else if (anomaly === 'HIGH_SPEND_NO_ORDER') {
      const reason = `${window}花费 ${money(totals.spend)}、点击 ${totals.clicks} 次、没有订单`
      if (targeted) advice.set('LOWER_BID', reason)
      else if (!advice.has('NEGATE')) advice.set('NEGATE', reason)
    } else if (anomaly === 'ADD_KEYWORD') {
      advice.set('ADD_KEYWORD', `${window}${totals.orders} 单、转化率 ${totals.clicks > 0 ? `${roundTo((totals.orders / totals.clicks) * 100, 1)}%` : '—'}，还没有被投放`)
    } else if (anomaly === 'SCALE_UP') {
      const acos = totals.spend !== null && totals.sales ? `${roundTo((totals.spend / totals.sales) * 100, 1)}%` : '—'
      const reason = `${window}${totals.orders} 单、广告成本销售比 ${acos}`
      if (targeted) advice.set('RAISE_BID', reason)
      else if (!advice.has('ADD_KEYWORD')) advice.set('ADD_KEYWORD', reason)
    }
  }
  return [...advice.entries()].map(([action, reason]) => ({ action, label: AD_TERM_ADVICE_LABEL[action], reason }))
}
