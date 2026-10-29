import type { AdsRuleAction, AdsRuleCondition, AdsRuleGuardrails, AdsRuleLevel, AdsRuleSpec, AdsRuleTextFilter } from '@nova/api-contracts'
import { ADS_RULE_LEVELS } from '@nova/api-contracts'

// 库里的规则还原成规格（接口侧 ads-rules-common.ts 的 specOf 的同款）：四块 JSON 的形状由写入时的校验与检查约束保证。

const objectOf = (json: unknown): Record<string, unknown> => (json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {})
const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

export interface RuleJson {
  level: string
  scopeJson: unknown
  conditionJson: unknown
  actionJson: unknown
  guardrailJson: unknown
}

export function specOfRule(record: RuleJson): AdsRuleSpec {
  const condition = objectOf(record.conditionJson)
  const level: AdsRuleLevel = (ADS_RULE_LEVELS as readonly string[]).includes(record.level) ? (record.level as AdsRuleLevel) : 'CAMPAIGN'
  return {
    level,
    conditions: listOf<AdsRuleCondition>(condition.conditions),
    textFilters: listOf<AdsRuleTextFilter>(condition.textFilters),
    campaignIds: listOf<string>(objectOf(record.scopeJson).campaignIds).filter(id => typeof id === 'string'),
    action: objectOf(record.actionJson) as unknown as AdsRuleAction,
    guardrails: objectOf(record.guardrailJson) as unknown as AdsRuleGuardrails,
  }
}

const DEFAULT_ZONE = 'America/Los_Angeles'

/** 企业时区的今天（YYYY-MM-DD）；时区无效按默认时区。 */
export function localDay(now: Date, zone: string | null | undefined): string {
  const format = (timeZone: string) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  try {
    return format(zone || DEFAULT_ZONE)
  } catch {
    return format(DEFAULT_ZONE)
  }
}
