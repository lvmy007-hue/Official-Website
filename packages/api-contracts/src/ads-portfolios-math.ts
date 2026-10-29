import {
  ADS_PORTFOLIO_MAX_PERIOD_DAYS,
  ADS_PORTFOLIO_PACE_RULES,
  ADS_PORTFOLIO_SORTS,
  type AdsBudgetAdvice,
  type AdsPortfolioBudgetKind,
  type AdsPortfolioCurvePoint,
  type AdsPortfolioPace,
  type AdsPortfolioPaceVerdict,
  type AdsPortfolioRow,
  type AdsPortfolioSort,
  type AdsPortfolioSummary,
  type AdsPortfolioWindow,
} from './ads-portfolios'
import { addNullable } from './ads-overview-math'

// 广告组合与预算的纯函数（P3-11）：预算周期窗口、历史节奏、理想曲线、节奏判断、调整建议、排序与汇总。API 与前端共用；日期都是 YYYY-MM-DD 文本。
// 全部可空：没有来源的值是 null，不当 0。

const DAY_MS = 86_400_000
const dayNumber = (text: string) => Math.round(Date.parse(`${text}T00:00:00Z`) / DAY_MS)
const textOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10)
export const addDaysToText = (text: string, days: number): string => textOf(dayNumber(text) + days)
/** 含首尾的天数；止日早于起日为 0。 */
export const periodDays = (from: string, to: string): number => Math.max(0, dayNumber(to) - dayNumber(from) + 1)
const weekdayOf = (text: string) => new Date(`${text}T00:00:00Z`).getUTCDay()
const money = (value: number) => `$${value.toFixed(2)}`
const round6 = (value: number) => Math.round(value * 1e6) / 1e6

const lastDayOfMonth = (today: string): string => {
  const [year, month] = today.split('-').map(Number)
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
}

/**
 * 预算周期窗口。亚马逊返回的周期取值没有对真实账户核对，这里按文字里是否含 MONTH、DATE 或 RANGE 判断：
 * 含 MONTH 是按月循环（取“今天”所在的自然月）；含 DATE 或 RANGE 是指定日期范围（要有起止日）；
 * 没有周期文字但有起止日也按指定日期范围；其余（例如 DAILY）与缺起止日都算“认不出”，不猜。
 */
export function budgetWindowOf(input: { budgetPeriod: string | null; budgetStart: string | null; budgetEnd: string | null }, today: string): AdsPortfolioWindow {
  const unknown = (issue: string): AdsPortfolioWindow => ({ kind: 'UNKNOWN', from: null, to: null, totalDays: null, issue })
  const text =
    input.budgetPeriod
      ?.trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_') ?? ''
  const kind: AdsPortfolioBudgetKind | null = text.includes('MONTH') ? 'MONTHLY' : text.includes('DATE') || text.includes('RANGE') || (!text && input.budgetStart) ? 'DATE_RANGE' : null
  if (kind === 'MONTHLY') {
    const from = `${today.slice(0, 7)}-01`
    const to = lastDayOfMonth(today)
    return { kind, from, to, totalDays: periodDays(from, to), issue: null }
  }
  if (kind === 'DATE_RANGE') {
    if (!input.budgetStart || !input.budgetEnd) return unknown('指定日期范围的预算没有同步到起止日，无法计算节奏')
    const totalDays = periodDays(input.budgetStart, input.budgetEnd)
    if (totalDays === 0 || totalDays > ADS_PORTFOLIO_MAX_PERIOD_DAYS) return unknown(`预算周期天数不合理（${totalDays} 天，上限 ${ADS_PORTFOLIO_MAX_PERIOD_DAYS} 天），不计算节奏`)
    return { kind, from: input.budgetStart, to: input.budgetEnd, totalDays, issue: null }
  }
  return unknown(text ? `预算周期“${input.budgetPeriod}”不是按月或指定日期范围，不计算节奏` : '没有同步到预算周期，无法计算节奏')
}

/**
 * 历史节奏：按星期几（0 周日到 6 周六）给权重，1 表示平均水平。history 是逐日花费（有行才有，缺的天按 0 算，从最早有数据的那天起算）；
 * 跨度不足 minHistoryDays、没有花费或某个星期几没有样本时返回 null（调用方退回按天均摊）。
 */
export function weekdayWeights(history: ReadonlyArray<{ date: string; spend: number }>, rules = ADS_PORTFOLIO_PACE_RULES): number[] | null {
  if (history.length === 0) return null
  const byDate = new Map(history.map(item => [item.date, item.spend]))
  const dates = [...byDate.keys()].sort()
  const first = dates[0]
  const last = dates[dates.length - 1]
  const span = periodDays(first, last)
  if (span < rules.minHistoryDays) return null
  const sums = new Array<number>(7).fill(0)
  const counts = new Array<number>(7).fill(0)
  let total = 0
  for (let day = dayNumber(first); day <= dayNumber(last); day += 1) {
    const text = textOf(day)
    const spend = byDate.get(text) ?? 0
    sums[weekdayOf(text)] += spend
    counts[weekdayOf(text)] += 1
    total += spend
  }
  if (total <= 0 || counts.some(count => count === 0)) return null
  const mean = total / span
  return sums.map((sum, index) => sum / counts[index] / mean)
}

/** 周期内每天结束时的理想累计花费：预算上限按权重（没有权重按天均摊）分到每一天，最后一天等于预算上限。 */
export function idealCumulative(from: string, to: string, cap: number, weights: readonly number[] | null): Array<{ date: string; ideal: number }> {
  const days = periodDays(from, to)
  const dates = Array.from({ length: days }, (_item, index) => addDaysToText(from, index))
  const weightOf = (date: string) => (weights ? weights[weekdayOf(date)] : 1)
  const total = dates.reduce((sum, date) => sum + weightOf(date), 0)
  let running = 0
  return dates.map(date => {
    running += weightOf(date)
    return { date, ideal: total > 0 ? round6((cap * running) / total) : 0 }
  })
}

export interface PaceInput {
  window: AdsPortfolioWindow
  cap: number | null
  currency: string
  /** 截至昨天的实际累计花费；没有来源为 null。 */
  spent: number | null
  today: string
  weights: readonly number[] | null
}

const verdictOf = (ratio: number): AdsPortfolioPaceVerdict => (ratio > 1 + ADS_PORTFOLIO_PACE_RULES.tolerance ? 'AHEAD' : ratio < 1 - ADS_PORTFOLIO_PACE_RULES.tolerance ? 'BEHIND' : 'ON_TRACK')

/** 节奏：先判能不能算（没有预算、周期不认识、非美元、没有花费来源、周期还没走完第一天），能算就比较实际累计与理想累计。 */
export function paceOf(input: PaceInput): AdsPortfolioPace {
  const { window, cap, spent, today } = input
  const base = { verdict: null, elapsedDays: 0, totalDays: window.totalDays, idealSpent: null, spent, ratio: null, shape: null, capReached: false } as const
  const blocked = (state: AdsPortfolioPace['state'], note: string): AdsPortfolioPace => ({ ...base, state, note })
  if (cap === null) return blocked('NO_BUDGET', '这个组合没有设置预算上限')
  if (window.kind === 'UNKNOWN' || window.from === null || window.to === null) return blocked('UNKNOWN_PERIOD', window.issue ?? '预算周期未知，无法计算节奏')
  if (input.currency !== 'USD') return blocked('OTHER_CURRENCY', `组合币种是 ${input.currency}，节奏只按美元计算，不折算`)
  if (spent === null) return blocked('NO_SPEND_DATA', '没有这个组合下活动的花费汇总，也没有亚马逊同步来的已用金额，无法比较节奏')
  const yesterday = addDaysToText(today, -1)
  const counted = yesterday < window.to ? yesterday : window.to
  const elapsedDays = counted >= window.from ? periodDays(window.from, counted) : 0
  if (elapsedDays === 0) {
    const note = today < window.from ? `预算周期从 ${window.from} 开始，还没有可比较的数据` : '预算周期的第一天，还没有完整的一天可以比较'
    return { ...blocked('NOT_STARTED', note), totalDays: window.totalDays, capReached: spent >= cap && cap > 0 }
  }
  const ideal = idealCumulative(window.from, window.to, cap, input.weights)
  const idealSpent = ideal[elapsedDays - 1].ideal
  const ratio = idealSpent > 0 ? spent / idealSpent : null
  return {
    state: 'OK',
    note: input.weights ? null : '历史花费不足，理想曲线按天均摊',
    verdict: ratio === null ? null : verdictOf(ratio),
    elapsedDays,
    totalDays: window.totalDays,
    idealSpent,
    spent,
    ratio,
    shape: input.weights ? 'HISTORY' : 'LINEAR',
    capReached: cap > 0 && spent >= cap,
  }
}

/** 整个周期逐日的理想与实际累计；daily 是逐日花费（缺的天按“没有汇总行”，今天及以后不画实际）。没有预算上限时理想列为 null。 */
export function curveOf(window: AdsPortfolioWindow, cap: number | null, weights: readonly number[] | null, daily: ReadonlyMap<string, number>, today: string): AdsPortfolioCurvePoint[] {
  if (window.from === null || window.to === null) return []
  const ideal = new Map((cap === null ? [] : idealCumulative(window.from, window.to, cap, weights)).map(item => [item.date, item.ideal]))
  const points: AdsPortfolioCurvePoint[] = []
  let running = 0
  for (let index = 0; index < periodDays(window.from, window.to); index += 1) {
    const date = addDaysToText(window.from, index)
    const past = date < today
    const spend = past ? (daily.get(date) ?? null) : null
    if (past) running += spend ?? 0
    // 没有任何逐日花费时实际线整条为空（不画成 0）
    points.push({ date, ideal: ideal.get(date) ?? null, actual: past && daily.size > 0 ? round6(running) : null, daily: spend })
  }
  return points
}

export interface AdviceInput {
  pace: AdsPortfolioPace
  window: AdsPortfolioWindow
  cap: number | null
  today: string
  /** 启用中美元日预算活动的日预算合计。 */
  currentDailyBudget: number | null
  /** 最近几天的日均花费。 */
  recentDaily: number | null
}

/** 调整建议：只在节奏已算出且偏快或偏慢时给；返回 note 说明没有建议的原因。 */
export function adviceOf(input: AdviceInput): { advice: AdsBudgetAdvice | null; note: string | null } {
  const { pace, window, cap, today } = input
  if (pace.state !== 'OK' || cap === null || window.to === null) return { advice: null, note: pace.note ?? '节奏没有算出，没有调整建议' }
  const remainingDays = Math.max(0, periodDays(today, window.to))
  const remainingBudget = pace.spent === null ? null : Math.max(0, cap - pace.spent)
  const sustainableDaily = remainingBudget !== null && remainingDays > 0 ? round6(remainingBudget / remainingDays) : null
  const common = { remainingDays, remainingBudget, sustainableDaily, currentDailyBudget: input.currentDailyBudget, recentDaily: input.recentDaily, exhaustDate: null as string | null }
  if (pace.capReached) {
    return { advice: { ...common, kind: 'CAP_REACHED', text: `已用金额已达到预算上限 ${money(cap)}，组合下的活动可能已被亚马逊暂停投放；需要继续投放请提高预算上限` }, note: null }
  }
  if (remainingDays === 0) return { advice: null, note: '预算周期已经结束，没有可以调整的剩余天数' }
  if (pace.verdict === null || pace.verdict === 'ON_TRACK') return { advice: null, note: pace.verdict === 'ON_TRACK' ? '节奏正常，没有调整建议' : '理想累计为 0，没有调整建议' }
  const percent = pace.ratio === null ? '' : `${Math.abs((pace.ratio - 1) * 100).toFixed(0)}%`
  if (pace.verdict === 'AHEAD') {
    const exhaust = input.recentDaily && input.recentDaily > 0 && remainingBudget !== null ? addDaysToText(today, Math.ceil(remainingBudget / input.recentDaily)) : null
    const early = exhaust !== null && exhaust < window.to
    const lead = `实际花费比理想节奏快 ${percent}`
    if (early) {
      return {
        advice: {
          ...common,
          exhaustDate: exhaust,
          kind: 'EXHAUST_EARLY',
          text: `${lead}；按最近 ${ADS_PORTFOLIO_PACE_RULES.recentDays} 天日均 ${money(input.recentDaily ?? 0)} 估算，预算会在 ${exhaust} 前后用完，早于周期结束日 ${window.to}。可以降低日预算，剩余 ${remainingDays} 天每天最多 ${money(sustainableDaily ?? 0)}`,
        },
        note: null,
      }
    }
    return {
      advice: { ...common, kind: 'LOWER_DAILY', text: `${lead}，但按最近的花费速度周期内用得完；如要更平稳，剩余 ${remainingDays} 天每天最多花 ${money(sustainableDaily ?? 0)}` },
      note: null,
    }
  }
  const lead = `实际花费比理想节奏慢 ${percent}`
  const current = input.currentDailyBudget
  if (current === null) return { advice: { ...common, kind: 'BEHIND', text: `${lead}；没有可用的日预算数据，无法判断是否被预算限制` }, note: null }
  if (sustainableDaily !== null && current < sustainableDaily) {
    return { advice: { ...common, kind: 'RAISE_DAILY', text: `${lead}；启用中的日预算合计 ${money(current)}，低于剩余预算平均每天可花的 ${money(sustainableDaily)}，可以提高日预算` }, note: null }
  }
  return {
    advice: {
      ...common,
      kind: 'NOT_LIMITED_BY_BUDGET',
      text: `${lead}；启用中的日预算合计 ${money(current)} 已不低于剩余预算平均每天可花的 ${money(sustainableDaily ?? 0)}，慢不是日预算限制的，可以检查竞价、投放词与库存`,
    },
    note: null,
  }
}

/** 名称包含关键字（不分大小写）。 */
export const portfolioMatches = (row: Pick<AdsPortfolioRow, 'name'>, q: string | undefined): boolean => !q || row.name.toLowerCase().includes(q.toLowerCase())

function sortValue(row: AdsPortfolioRow, sort: AdsPortfolioSort): number | string | null {
  switch (sort) {
    case 'name':
      return row.name
    case 'budget':
      return row.budget.cap
    case 'spent':
      return row.spent
    case 'paceRatio':
      return row.pace.ratio
    case 'campaigns':
      return row.campaigns.total
    case 'spend':
      return row.totals?.spend ?? null
    case 'sales':
      return row.totals?.sales ?? null
    default:
      return row.ratios?.[sort] ?? null
  }
}

/** 列表排序：空值永远排最后（不论升降序），并列按名称再按编号，翻页顺序稳定。普通字符串比较，不用 localeCompare。 */
export function comparePortfolios(a: AdsPortfolioRow, b: AdsPortfolioRow, sort: AdsPortfolioSort, dir: 'asc' | 'desc'): number {
  const left = sortValue(a, sort)
  const right = sortValue(b, sort)
  if (left === null && right !== null) return 1
  if (left !== null && right === null) return -1
  if (left !== null && right !== null && left !== right) return (left < right ? -1 : 1) * (dir === 'asc' ? 1 : -1)
  if (a.name !== b.name) return a.name < b.name ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export const isPortfolioSort = (value: string): value is AdsPortfolioSort => (ADS_PORTFOLIO_SORTS as readonly string[]).includes(value)

/** 过滤后全部行的汇总；预算上限与已用金额只合计已算出节奏的美元组合。 */
export function summarizePortfolios(rows: readonly AdsPortfolioRow[]): AdsPortfolioSummary {
  const computed = rows.filter(row => row.pace.state === 'OK' && row.budget.cap !== null)
  const count = (verdict: AdsPortfolioPaceVerdict) => rows.filter(row => row.pace.verdict === verdict).length
  return {
    portfolios: rows.length,
    withBudget: rows.filter(row => row.budget.cap !== null).length,
    ahead: count('AHEAD'),
    onTrack: count('ON_TRACK'),
    behind: count('BEHIND'),
    cap: addNullable(computed.map(row => row.budget.cap)),
    spent: addNullable(computed.map(row => row.spent)),
  }
}

/** 预算规则参数摘要：只展开第一层，嵌套内容压成一行 JSON，最多 12 项，过长截断；不解释含义。 */
export function describeRuleParams(params: unknown): Array<{ key: string; value: string }> {
  if (params === null || typeof params !== 'object' || Array.isArray(params)) return params === null || params === undefined ? [] : [{ key: 'params', value: clip(JSON.stringify(params)) }]
  return Object.entries(params as Record<string, unknown>)
    .slice(0, 12)
    .map(([key, value]) => ({ key, value: typeof value === 'string' ? clip(value) : clip(JSON.stringify(value) ?? '') }))
}
const clip = (text: string) => (text.length > 120 ? `${text.slice(0, 117)}...` : text)
