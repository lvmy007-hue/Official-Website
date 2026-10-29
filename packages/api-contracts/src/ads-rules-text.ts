import {
  ADS_RULE_ACTION_LABEL,
  ADS_RULE_EFFECT_DAYS,
  ADS_RULE_FILTER_FIELD_LABEL,
  ADS_RULE_FILTER_MODE_LABEL,
  ADS_RULE_FREQUENCY_HOURS,
  ADS_RULE_KEYWORD_MATCH_LABEL,
  ADS_RULE_LEVEL_ACTIONS,
  ADS_RULE_LEVEL_LABEL,
  ADS_RULE_LIMITS,
  ADS_RULE_METRIC_INFO,
  ADS_RULE_NEGATE_MATCH_LABEL,
  ADS_RULE_OP_SYMBOL,
  type AdsRuleAction,
  type AdsRuleCondition,
  type AdsRuleDay,
  type AdsRuleEffect,
  type AdsRuleFrequency,
  type AdsRuleGuardrails,
  type AdsRuleMetric,
  type AdsRuleRow,
  type AdsRuleSpec,
  type AdsRuleTotalsView,
} from './ads-rules'
import { shiftDate, windowTotals, type RuleTotals } from './ads-rules-math'

// 自动规则的文字与校验（P3-13）：中文摘要、规则内容的合法性、是否到期、执行后效果。API 与前端共用，不碰数据库与时钟。

const trimmed = (value: number): string => String(Number(value.toFixed(2)))

/** 按指标的单位显示数值：美元带 $，百分数带 %，倍数带“倍”；null 写“无数据”。 */
export function formatRuleValue(metric: AdsRuleMetric, value: number | null): string {
  if (value === null) return '无数据'
  switch (ADS_RULE_METRIC_INFO[metric].unit) {
    case 'money':
      return `$${value.toFixed(2)}`
    case 'percent':
      return `${trimmed(value)}%`
    case 'times':
      return `${trimmed(value)} 倍`
    case 'count':
      return trimmed(value)
  }
}

export const describeCondition = (condition: AdsRuleCondition): string =>
  `近 ${condition.windowDays} 天${ADS_RULE_METRIC_INFO[condition.metric].label} ${ADS_RULE_OP_SYMBOL[condition.op]} ${formatRuleValue(condition.metric, condition.value)}`

const signed = (value: number, unit: '%' | '$'): string => `${value > 0 ? '+' : '-'}${unit === '$' ? '$' : ''}${trimmed(Math.abs(value))}${unit === '%' ? '%' : ''}`

export function describeAction(action: AdsRuleAction): string {
  switch (action.type) {
    case 'ADJUST_BID':
    case 'ADJUST_BUDGET': {
      const noun = action.type === 'ADJUST_BID' ? '竞价' : '日预算'
      return `${noun} ${action.mode === 'PERCENT' ? signed(action.value, '%') : signed(action.value, '$')}`
    }
    case 'PAUSE':
    case 'ENABLE':
      return ADS_RULE_ACTION_LABEL[action.type]
    case 'NEGATE':
      return `添加为否定投放（${ADS_RULE_NEGATE_MATCH_LABEL[action.matchType]}）`
    case 'ADD_KEYWORD':
      return `添加为关键词（${ADS_RULE_KEYWORD_MATCH_LABEL[action.matchType]}，出价 $${action.bid.toFixed(2)}）`
  }
}

export function describeGuardrails(guardrails: AdsRuleGuardrails, action: AdsRuleAction): string {
  const noun = action.type === 'ADJUST_BUDGET' ? '日预算' : action.type === 'ADD_KEYWORD' ? '出价' : '竞价'
  const parts: string[] = []
  if (guardrails.minValue !== null) parts.push(`最低${noun} $${guardrails.minValue.toFixed(2)}`)
  if (guardrails.maxValue !== null) parts.push(`最高${noun} $${guardrails.maxValue.toFixed(2)}`)
  if (guardrails.maxChangePercent !== null) parts.push(`单次调整幅度不超过 ${guardrails.maxChangePercent}%`)
  parts.push(`每天最多处理 ${guardrails.dailyLimit} 个对象`)
  return parts.join('；')
}

/** 列表与详情里的中文摘要。 */
export function describeRuleSpec(spec: AdsRuleSpec): AdsRuleRow['summary'] {
  return {
    conditions: spec.conditions.map(describeCondition).join(' 且 '),
    filters: spec.textFilters.length === 0 ? null : spec.textFilters.map(filter => `${ADS_RULE_FILTER_FIELD_LABEL[filter.field]}${ADS_RULE_FILTER_MODE_LABEL[filter.mode]}“${filter.text}”`).join('；'),
    action: describeAction(spec.action),
    guardrails: describeGuardrails(spec.guardrails, spec.action),
    scope: `${ADS_RULE_LEVEL_LABEL[spec.level]}；${spec.campaignIds.length === 0 ? '这个广告账户下的全部活动' : `限定 ${spec.campaignIds.length} 个活动`}`,
  }
}

/**
 * 规则内容的合法性（结合层级与动作）；合法返回 null，否则返回原因（中文）。
 * 调整竞价与预算必须设单次调整幅度上限；最低与最高值只属于带金额的动作；每日执行次数上限必填且有上限。
 */
export function ruleSpecIssues(spec: AdsRuleSpec): string | null {
  const { action, guardrails: guard, level } = spec
  if (!ADS_RULE_LEVEL_ACTIONS[level].includes(action.type))
    return `“${ADS_RULE_ACTION_LABEL[action.type]}”不适用于${ADS_RULE_LEVEL_LABEL[level]}，可选：${ADS_RULE_LEVEL_ACTIONS[level].map(type => ADS_RULE_ACTION_LABEL[type]).join('、')}`
  if (!Number.isInteger(guard.dailyLimit) || guard.dailyLimit < 1 || guard.dailyLimit > ADS_RULE_LIMITS.dailyLimitMax) return `每日执行次数上限必须是 1 至 ${ADS_RULE_LIMITS.dailyLimitMax} 的整数`
  const adjusting = action.type === 'ADJUST_BID' || action.type === 'ADJUST_BUDGET'
  const bounded = adjusting || action.type === 'ADD_KEYWORD'
  if (!bounded && (guard.minValue !== null || guard.maxValue !== null)) return '最低、最高值只用于调整竞价、调整预算与添加关键词'
  if (!adjusting && guard.maxChangePercent !== null) return '单次调整幅度上限只用于调整竞价与预算'
  if (guard.minValue !== null && guard.maxValue !== null && guard.minValue > guard.maxValue) return '最低值不能高于最高值'
  if (adjusting) {
    if (guard.maxChangePercent === null) return '调整竞价或预算必须设置单次调整幅度上限，避免一次调得太狠'
    if (action.value === 0) return '调整幅度不能是 0'
    if (action.mode === 'PERCENT' && (action.value < ADS_RULE_LIMITS.percentMin || action.value > ADS_RULE_LIMITS.percentMax))
      return `按百分比调整的幅度要在 ${ADS_RULE_LIMITS.percentMin}% 至 +${ADS_RULE_LIMITS.percentMax}% 之间`
    if (action.mode === 'AMOUNT' && Math.abs(action.value) > ADS_RULE_LIMITS.amountAbs) return `按金额调整的幅度不能超过 ±$${ADS_RULE_LIMITS.amountAbs}`
  }
  if (action.type === 'ADD_KEYWORD') {
    if (action.bid < ADS_RULE_LIMITS.valueFloor || action.bid > ADS_RULE_LIMITS.valueCeiling) return `新关键词的出价要在 $${ADS_RULE_LIMITS.valueFloor} 至 $${ADS_RULE_LIMITS.valueCeiling} 之间`
    if (guard.minValue !== null && action.bid < guard.minValue) return '新关键词的出价低于护栏的最低值'
    if (guard.maxValue !== null && action.bid > guard.maxValue) return '新关键词的出价高于护栏的最高值'
  }
  return null
}

const DUE_TOLERANCE_MS = 10 * 60_000

/** 按执行频率，这条规则此刻是否到期该评估（从没评估过就是到期；留 10 分钟的余量，免得定时器抖动错过一轮）。 */
export function ruleDueOf(frequency: AdsRuleFrequency, lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true
  return now.getTime() - lastRunAt.getTime() >= ADS_RULE_FREQUENCY_HOURS[frequency] * 3_600_000 - DUE_TOLERANCE_MS
}

// ---- 执行后效果 ----

export interface EffectPair {
  before: RuleTotals
  after: RuleTotals
}

/** 一次已执行动作前后各 7 天的合计；前后任何一边没有记录就不算（不拿空窗口当 0）。runDate 当天不算（动作可能发生在一天中间）。 */
export function effectPairOf(days: readonly AdsRuleDay[], runDate: string): EffectPair | null {
  const before = windowTotals(days, shiftDate(runDate, -1), ADS_RULE_EFFECT_DAYS)
  const after = windowTotals(days, shiftDate(runDate, ADS_RULE_EFFECT_DAYS), ADS_RULE_EFFECT_DAYS)
  return before.rows > 0 && after.rows > 0 ? { before, after } : null
}

const viewOf = (totals: RuleTotals): AdsRuleTotalsView => ({
  spend: totals.spend,
  sales: totals.sales,
  orders: totals.orders,
  clicks: totals.clicks,
  acos: totals.spend !== null && totals.sales !== null && totals.sales > 0 ? (totals.spend / totals.sales) * 100 : null,
})

const merge = (all: readonly RuleTotals[]): RuleTotals =>
  all.reduce<RuleTotals>(
    (sum, item) => ({
      rows: sum.rows + item.rows,
      impressions: sum.impressions + item.impressions,
      clicks: sum.clicks + item.clicks,
      spend: item.spend === null ? sum.spend : (sum.spend ?? 0) + item.spend,
      sales: item.sales === null ? sum.sales : (sum.sales ?? 0) + item.sales,
      orders: sum.orders + item.orders,
    }),
    { rows: 0, impressions: 0, clicks: 0, spend: null, sales: null, orders: 0 },
  )

/** 把多次已执行动作的前后合计汇总成规则的“执行后效果”；没有样本时给说明，不给数字。 */
export function summarizeEffect(pairs: readonly EffectPair[], executed: number): AdsRuleEffect {
  const base = { windowDays: ADS_RULE_EFFECT_DAYS }
  if (executed === 0)
    return {
      ...base,
      state: 'NOT_CONNECTED',
      note: '这条规则还没有真正执行过动作（自动执行随“广告写入接入”提供，建议模式只生成待办），所以没有执行后的效果可以统计',
      samples: 0,
      before: null,
      after: null,
    }
  if (pairs.length === 0)
    return {
      ...base,
      state: 'NO_DATA',
      note: `已执行 ${executed} 次，但执行后还不满 ${ADS_RULE_EFFECT_DAYS} 天，或前后窗口里没有指标记录，暂时没有效果可以统计`,
      samples: 0,
      before: null,
      after: null,
    }
  return {
    ...base,
    state: 'OK',
    note: `汇总 ${pairs.length} 次已执行动作，每次比较动作前后各 ${ADS_RULE_EFFECT_DAYS} 天（不含动作当天）；前后同时受季节、促销等因素影响，只作参考，不代表因果`,
    samples: pairs.length,
    before: viewOf(merge(pairs.map(pair => pair.before))),
    after: viewOf(merge(pairs.map(pair => pair.after))),
  }
}
