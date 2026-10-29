import {
  ADS_RULE_LIMITS,
  type AdsRuleAction,
  type AdsRuleCondition,
  type AdsRuleDay,
  type AdsRuleEvaluation,
  type AdsRuleHit,
  type AdsRuleMetric,
  type AdsRuleOp,
  type AdsRuleSkip,
  type AdsRuleSpec,
  type AdsRuleSubject,
  type AdsRuleTextFilter,
} from './ads-rules'

// 广告自动规则的评估纯函数（P3-13）：窗口合计、指标、条件、文本过滤、动作与护栏。API 的试运行与 worker 的定时评估共用，不碰数据库与时钟。
// 原则：没有数据的指标是 null，不是 0；null 的条件一律不成立（缺数据的对象不命中）；比率分母为 0 也是 null。

/** 日期文字（YYYY-MM-DD）加减天数，不受本机时区影响。 */
export function shiftDate(date: string, days: number): string {
  const moment = new Date(`${date}T00:00:00Z`)
  moment.setUTCDate(moment.getUTCDate() + days)
  return moment.toISOString().slice(0, 10)
}

/** 评估截止日：数据只到昨天（今天的指标不完整）。today 是企业时区的今天（YYYY-MM-DD）。 */
export const defaultAsOf = (today: string, lagDays = 1): string => shiftDate(today, -lagDays)

export interface RuleTotals {
  /** 窗口内有几天有数据行；0 表示整个窗口没有任何记录。 */
  rows: number
  impressions: number
  clicks: number
  spend: number | null
  sales: number | null
  orders: number
}

const addNullable = (current: number | null, value: number | null): number | null => (value === null ? current : (current ?? 0) + value)

/** 以 asOf 为最后一天、往前数 windowDays 天（含 asOf）的合计；花费或销售额在窗口里全是空就保持空。 */
export function windowTotals(days: readonly AdsRuleDay[], asOf: string, windowDays: number): RuleTotals {
  const from = shiftDate(asOf, -(windowDays - 1))
  const totals: RuleTotals = { rows: 0, impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 }
  for (const day of days) {
    if (day.date < from || day.date > asOf) continue
    totals.rows += 1
    totals.impressions += day.impressions
    totals.clicks += day.clicks
    totals.orders += day.orders
    totals.spend = addNullable(totals.spend, day.spend)
    totals.sales = addNullable(totals.sales, day.sales)
  }
  return totals
}

const ratio = (numerator: number | null, denominator: number | null, scale = 1): number | null =>
  numerator === null || denominator === null || denominator <= 0 ? null : (numerator / denominator) * scale

/** 指标取值：金额是美元，acos、ctr、cvr 是百分数，roas 是倍数；窗口里没有记录或分母为 0 返回 null。 */
export function metricValue(metric: AdsRuleMetric, totals: RuleTotals): number | null {
  if (totals.rows === 0) return null
  switch (metric) {
    case 'spend':
      return totals.spend
    case 'sales':
      return totals.sales
    case 'orders':
      return totals.orders
    case 'clicks':
      return totals.clicks
    case 'impressions':
      return totals.impressions
    case 'acos':
      return ratio(totals.spend, totals.sales, 100)
    case 'cpc':
      return ratio(totals.spend, totals.clicks)
    case 'ctr':
      return ratio(totals.clicks, totals.impressions, 100)
    case 'cvr':
      return ratio(totals.orders, totals.clicks, 100)
    case 'roas':
      return totals.spend !== null && totals.spend > 0 ? ratio(totals.sales, totals.spend) : null
  }
}

export function conditionHolds(op: AdsRuleOp, actual: number | null, threshold: number): boolean {
  if (actual === null) return false
  switch (op) {
    case 'gt':
      return actual > threshold
    case 'gte':
      return actual >= threshold
    case 'lt':
      return actual < threshold
    case 'lte':
      return actual <= threshold
  }
}

/** 触发证据里的键：指标与窗口，例如 acos:7。 */
export const evidenceKey = (condition: Pick<AdsRuleCondition, 'metric' | 'windowDays'>): string => `${condition.metric}:${condition.windowDays}`

/** 文本过滤：全部满足才保留（不分大小写）。所属活动名称未知时，“包含”不成立、“不包含”成立（无法证明它含有）。 */
export function matchesFilters(subject: Pick<AdsRuleSubject, 'label' | 'campaignLabel'>, filters: readonly AdsRuleTextFilter[]): boolean {
  return filters.every(filter => {
    const target = filter.field === 'NAME' ? subject.label : subject.campaignLabel
    const contains = target !== null && target.toLowerCase().includes(filter.text.trim().toLowerCase())
    return filter.mode === 'CONTAINS' ? contains : !contains
  })
}

const money = (value: number): string => value.toFixed(2)
const roundMoney = (value: number): number => Math.round(value * 100) / 100

export type Proposal = { ok: true; before: string | null; after: string | null; notes: string[] } | { ok: false; reason: string }

const STATE_LABEL: Record<string, string> = { ENABLED: '启用', PAUSED: '暂停', ARCHIVED: '已归档', TARGETED: '已投放', NEGATED: '已否定', UNTARGETED: '未投放' }
const stateText = (state: string | null): string => (state === null ? '未知' : (STATE_LABEL[state.toUpperCase()] ?? state))

function adjustProposal(action: Extract<AdsRuleAction, { type: 'ADJUST_BID' | 'ADJUST_BUDGET' }>, subject: AdsRuleSubject, spec: AdsRuleSpec): Proposal {
  const noun = action.type === 'ADJUST_BID' ? '竞价' : '日预算'
  if ((subject.state ?? '').toUpperCase() !== 'ENABLED') return { ok: false, reason: `当前状态是${stateText(subject.state)}，只有启用中的对象才调整${noun}` }
  const current = action.type === 'ADJUST_BID' ? subject.bid : subject.budget
  if (current === null || current <= 0) return { ok: false, reason: `当前${noun}还没有同步下来，无法计算调整后的值` }
  const { guardrails } = spec
  const notes: string[] = []
  const wanted = action.mode === 'PERCENT' ? current * (1 + action.value / 100) : current + action.value
  let next = wanted
  const changePercent = ((next - current) / current) * 100
  if (guardrails.maxChangePercent !== null && Math.abs(changePercent) > guardrails.maxChangePercent) {
    const sign = changePercent > 0 ? 1 : -1
    next = current * (1 + (sign * guardrails.maxChangePercent) / 100)
    notes.push(`超出单次调整幅度上限 ${guardrails.maxChangePercent}%，已收窄`)
  }
  if (guardrails.maxValue !== null && next > guardrails.maxValue) {
    next = guardrails.maxValue
    notes.push(`超出最高${noun} $${money(guardrails.maxValue)}，已收窄`)
  }
  if (guardrails.minValue !== null && next < guardrails.minValue) {
    next = guardrails.minValue
    notes.push(`低于最低${noun} $${money(guardrails.minValue)}，已抬高`)
  }
  next = roundMoney(Math.max(next, ADS_RULE_LIMITS.valueFloor))
  // 规则要提高、护栏却把结果压到比现在还低（或反过来）：当前值已经越过护栏，不替用户做反方向的事
  if ((wanted - current) * (next - current) < 0) return { ok: false, reason: `当前${noun} $${money(current)} 已经越过护栏范围，规则的调整方向与护栏冲突，不动作` }
  if (Math.abs(next - current) < 0.005) return { ok: false, reason: `按护栏限制后与当前${noun} $${money(current)} 相同，没有需要调整的` }
  return { ok: true, before: money(current), after: money(next), notes }
}

/** 命中之后能不能动作、动作前后的值：状态不符、缺当前值、护栏收窄后没变化都说明原因，不硬给。 */
export function proposeChange(spec: AdsRuleSpec, subject: AdsRuleSubject): Proposal {
  const { action } = spec
  const state = (subject.state ?? '').toUpperCase()
  switch (action.type) {
    case 'ADJUST_BID':
    case 'ADJUST_BUDGET':
      return adjustProposal(action, subject, spec)
    case 'PAUSE':
      return state === 'ENABLED' ? { ok: true, before: 'ENABLED', after: 'PAUSED', notes: [] } : { ok: false, reason: `当前状态是${stateText(subject.state)}，不需要暂停` }
    case 'ENABLE':
      return state === 'PAUSED' ? { ok: true, before: 'PAUSED', after: 'ENABLED', notes: [] } : { ok: false, reason: `当前状态是${stateText(subject.state)}，不需要启用` }
    case 'NEGATE':
      if (state === 'NEGATED') return { ok: false, reason: '这个搜索词已经被否定' }
      if (state === 'TARGETED') return { ok: false, reason: '这个搜索词已经是投放词，请改用调价或暂停，不要直接否定' }
      return { ok: true, before: 'UNTARGETED', after: action.matchType, notes: [] }
    case 'ADD_KEYWORD':
      if (state === 'NEGATED') return { ok: false, reason: '这个搜索词已经被否定，不再加为关键词' }
      if (state === 'TARGETED') return { ok: false, reason: '这个搜索词已经是投放词' }
      return { ok: true, before: 'UNTARGETED', after: `${action.matchType}@${money(action.bid)}`, notes: [] }
  }
}

const compareHits = (a: AdsRuleHit, b: AdsRuleHit): number => {
  if (a.spend === null && b.spend !== null) return 1
  if (a.spend !== null && b.spend === null) return -1
  if (a.spend !== null && b.spend !== null && a.spend !== b.spend) return b.spend - a.spend
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
}

const round4 = (value: number | null): number | null => (value === null ? null : Math.round(value * 10_000) / 10_000)

/**
 * 评估一条规则：subjects 先过文本过滤，再逐个判断全部条件（AND），命中的再判断能不能动作。
 * 命中按近 30 天花费从高到低排（没有花费的在后，并列按对象标识），所以“每日执行次数上限”截断时留下的是花费最高的对象。
 */
export function evaluateRule(spec: AdsRuleSpec, subjects: readonly AdsRuleSubject[], asOf: string): AdsRuleEvaluation {
  const candidates = subjects.filter(subject => matchesFilters(subject, spec.textFilters))
  const hits: AdsRuleHit[] = []
  const skipped: AdsRuleSkip[] = []
  let matched = 0
  for (const subject of candidates) {
    const metrics: Record<string, number | null> = {}
    let holds = true
    for (const condition of spec.conditions) {
      const value = metricValue(condition.metric, windowTotals(subject.daily, asOf, condition.windowDays))
      metrics[evidenceKey(condition)] = round4(value)
      if (!conditionHolds(condition.op, value, condition.value)) holds = false
    }
    if (!holds) continue
    matched += 1
    const proposal = proposeChange(spec, subject)
    if (!proposal.ok) {
      skipped.push({ key: subject.key, label: subject.label, reason: proposal.reason })
      continue
    }
    hits.push({
      key: subject.key,
      label: subject.label,
      campaignLabel: subject.campaignLabel,
      metrics,
      actionType: spec.action.type,
      before: proposal.before,
      after: proposal.after,
      notes: proposal.notes,
      spend: round4(windowTotals(subject.daily, asOf, 30).spend),
    })
  }
  hits.sort(compareHits)
  skipped.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { evaluated: candidates.length, matched, hits, skipped }
}
