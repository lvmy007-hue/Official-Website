import { ADS_RULE_LEVEL_ACTIONS, ADS_RULE_LIMITS, type AdsRuleAction, type AdsRuleActionType, type AdsRuleLevel, type AdsRuleRow } from '@nova/api-contracts'

// 自动规则表单的取值与请求体互转（P3-13）：表单里动作的几种参数是平铺的字段，这里还原成接口要的动作与护栏，并把空值统一成 null。
// 纯函数，不碰界面。

export type RuleFormValues = Record<string, unknown>

const numberOrNull = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)

export const defaultRuleValues = (): RuleFormValues => ({
  level: 'CAMPAIGN',
  mode: 'SUGGEST',
  status: 'PAUSED',
  frequency: 'DAILY',
  conditions: [{ metric: 'acos', windowDays: 7, op: 'gt' }],
  textFilters: [],
  campaignIds: [],
  actionType: 'PAUSE',
  adjustMode: 'PERCENT',
  negateMatch: 'NEGATIVE_EXACT',
  keywordMatch: 'EXACT',
  dailyLimit: ADS_RULE_LIMITS.dailyLimitDefault,
})

export function valuesOfRule(rule: AdsRuleRow): RuleFormValues {
  const { action, guardrails } = rule.spec
  return {
    ...defaultRuleValues(),
    name: rule.name,
    adsProfileId: rule.adsProfileId,
    level: rule.spec.level,
    mode: rule.mode,
    status: rule.status,
    frequency: rule.frequency,
    conditions: rule.spec.conditions,
    textFilters: rule.spec.textFilters,
    campaignIds: rule.spec.campaignIds,
    actionType: action.type,
    ...(action.type === 'ADJUST_BID' || action.type === 'ADJUST_BUDGET' ? { adjustMode: action.mode, adjustValue: action.value } : {}),
    ...(action.type === 'NEGATE' ? { negateMatch: action.matchType } : {}),
    ...(action.type === 'ADD_KEYWORD' ? { keywordMatch: action.matchType, keywordBid: action.bid } : {}),
    minValue: guardrails.minValue ?? undefined,
    maxValue: guardrails.maxValue ?? undefined,
    maxChangePercent: guardrails.maxChangePercent ?? undefined,
    dailyLimit: guardrails.dailyLimit,
  }
}

/** 层级改变后，动作要换成这个层级能做的第一个。 */
export const firstActionOf = (level: AdsRuleLevel): AdsRuleActionType => ADS_RULE_LEVEL_ACTIONS[level][0]!

export function actionOfValues(values: RuleFormValues): AdsRuleAction {
  const type = values.actionType as AdsRuleActionType
  switch (type) {
    case 'ADJUST_BID':
    case 'ADJUST_BUDGET':
      return { type, mode: values.adjustMode === 'AMOUNT' ? 'AMOUNT' : 'PERCENT', value: Number(values.adjustValue ?? 0) }
    case 'NEGATE':
      return { type, matchType: values.negateMatch === 'NEGATIVE_PHRASE' ? 'NEGATIVE_PHRASE' : 'NEGATIVE_EXACT' }
    case 'ADD_KEYWORD':
      return { type, matchType: values.keywordMatch === 'PHRASE' ? 'PHRASE' : values.keywordMatch === 'BROAD' ? 'BROAD' : 'EXACT', bid: Number(values.keywordBid ?? 0) }
    default:
      return { type }
  }
}

/** 创建与修改共用的内容部分；护栏里不适用的项送 null（服务端会拒绝不适用的项，避免留下无意义的设置）。 */
export function contentOfValues(values: RuleFormValues) {
  const action = actionOfValues(values)
  const adjusting = action.type === 'ADJUST_BID' || action.type === 'ADJUST_BUDGET'
  const bounded = adjusting || action.type === 'ADD_KEYWORD'
  return {
    name: String(values.name ?? '').trim(),
    mode: values.mode,
    status: values.status,
    frequency: values.frequency,
    conditions: ((values.conditions as Array<Record<string, unknown>> | undefined) ?? []).map(item => ({
      metric: item.metric,
      windowDays: item.windowDays,
      op: item.op,
      value: Number(item.value ?? 0),
    })),
    textFilters: ((values.textFilters as Array<Record<string, unknown>> | undefined) ?? []).map(item => ({ field: item.field, mode: item.mode, text: String(item.text ?? '').trim() })),
    campaignIds: (values.campaignIds as string[] | undefined) ?? [],
    action,
    guardrails: {
      minValue: bounded ? numberOrNull(values.minValue) : null,
      maxValue: bounded ? numberOrNull(values.maxValue) : null,
      maxChangePercent: adjusting ? numberOrNull(values.maxChangePercent) : null,
      dailyLimit: numberOrNull(values.dailyLimit) ?? ADS_RULE_LIMITS.dailyLimitDefault,
    },
  }
}

export const createBodyOf = (values: RuleFormValues) => ({ adsProfileId: values.adsProfileId, level: values.level, ...contentOfValues(values) })
export const updateBodyOf = (values: RuleFormValues, version: number) => ({ version, ...contentOfValues(values) })
