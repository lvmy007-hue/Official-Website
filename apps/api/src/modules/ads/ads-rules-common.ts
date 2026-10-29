import type { Prisma } from '@prisma/client'
import {
  ADS_RULE_ACTION_TYPES,
  ADS_RULE_FREQUENCIES,
  ADS_RULE_LEVELS,
  ADS_RULE_MODES,
  ADS_RULE_OUTCOME_LABEL,
  ADS_RULE_STATUSES,
  ADS_RULE_SWITCH,
  ADS_RULE_WRITE,
  describeRuleSpec,
  type AdsRuleAction,
  type AdsRuleActionType,
  type AdsRuleAutoStatus,
  type AdsRuleCondition,
  type AdsRuleFrequency,
  type AdsRuleGuardrails,
  type AdsRuleLevel,
  type AdsRuleMode,
  type AdsRuleRow,
  type AdsRuleRunOutcome,
  type AdsRuleRunRow,
  type AdsRuleSpec,
  type AdsRuleStatus,
  type AdsRuleTextFilter,
} from '@nova/api-contracts'
import { nameOrFormer } from '../../platform/people'
import type { ApiContext } from '../../platform/http'
import type { ActionGuardService } from '../../platform/write'
// 自动规则的公共部分（P3-13）：读取字段、库里 JSON 与规格的互转、行的组装、自动模式的开关状态。规则是系统自己的数据，同步器从不写。

export const RULE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const RULE_SELECT = {
  id: true,
  adsProfileId: true,
  name: true,
  level: true,
  mode: true,
  status: true,
  frequency: true,
  scopeJson: true,
  conditionJson: true,
  actionJson: true,
  guardrailJson: true,
  lastRunAt: true,
  lastEvaluated: true,
  lastMatched: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  updatedBy: true,
  adsProfile: { select: { displayName: true, profileId: true, sellerAccount: { select: { displayName: true } } } },
} satisfies Prisma.AdsAutomationRuleSelect
export type RuleRecord = Prisma.AdsAutomationRuleGetPayload<{ select: typeof RULE_SELECT }>

// 库里有检查约束保证枚举合法；落到兜底值说明数据被绕过约束改过，宁可按保守值处理也不让页面崩。
const pick = <T extends string>(list: readonly T[], value: string, fallback: T): T => ((list as readonly string[]).includes(value) ? (value as T) : fallback)
export const levelOf = (value: string): AdsRuleLevel => pick(ADS_RULE_LEVELS, value, 'CAMPAIGN')
export const modeOf = (value: string): AdsRuleMode => pick(ADS_RULE_MODES, value, 'SUGGEST')
export const statusOf = (value: string): AdsRuleStatus => pick(ADS_RULE_STATUSES, value, 'PAUSED')
export const frequencyOf = (value: string): AdsRuleFrequency => pick(ADS_RULE_FREQUENCIES, value, 'DAILY')
export const actionTypeOf = (value: string): AdsRuleActionType => pick(ADS_RULE_ACTION_TYPES, value, 'PAUSE')

const objectOf = (json: unknown): Record<string, unknown> => (json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {})
const listOf = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

/** 库里的四块 JSON 还原成规格（形状由写入时的校验与检查约束保证）。 */
export function specOf(record: Pick<RuleRecord, 'level' | 'scopeJson' | 'conditionJson' | 'actionJson' | 'guardrailJson'>): AdsRuleSpec {
  const condition = objectOf(record.conditionJson)
  return {
    level: levelOf(record.level),
    conditions: listOf<AdsRuleCondition>(condition.conditions),
    textFilters: listOf<AdsRuleTextFilter>(condition.textFilters),
    campaignIds: listOf<string>(objectOf(record.scopeJson).campaignIds).filter(id => typeof id === 'string'),
    action: objectOf(record.actionJson) as unknown as AdsRuleAction,
    guardrails: objectOf(record.guardrailJson) as unknown as AdsRuleGuardrails,
  }
}

/** 规格拆成库里的四块 JSON。 */
export function jsonOf(spec: AdsRuleSpec): { scopeJson: Prisma.InputJsonValue; conditionJson: Prisma.InputJsonValue; actionJson: Prisma.InputJsonValue; guardrailJson: Prisma.InputJsonValue } {
  return {
    scopeJson: { campaignIds: spec.campaignIds },
    conditionJson: JSON.parse(JSON.stringify({ conditions: spec.conditions, textFilters: spec.textFilters })) as Prisma.InputJsonValue,
    actionJson: JSON.parse(JSON.stringify(spec.action)) as Prisma.InputJsonValue,
    guardrailJson: JSON.parse(JSON.stringify(spec.guardrails)) as Prisma.InputJsonValue,
  }
}

export function ruleRowOf(record: RuleRecord, people: ReadonlyMap<string, string>): AdsRuleRow {
  const spec = specOf(record)
  return {
    id: record.id,
    adsProfileId: record.adsProfileId,
    accountName: record.adsProfile.displayName ?? record.adsProfile.profileId,
    storeName: record.adsProfile.sellerAccount?.displayName ?? null,
    name: record.name,
    mode: modeOf(record.mode),
    status: statusOf(record.status),
    frequency: frequencyOf(record.frequency),
    spec,
    summary: describeRuleSpec(spec),
    lastRunAt: record.lastRunAt?.toISOString() ?? null,
    lastEvaluated: record.lastEvaluated,
    lastMatched: record.lastMatched,
    version: record.version,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    updatedByName: nameOrFormer(people, record.updatedBy),
  }
}

/** 自动模式能不能用：看“自动规则执行”写入开关（默认关）。页面据此禁用选项并说明原因；服务端写入前再判断一次。 */
export async function autoStatusOf(guard: ActionGuardService, context: ApiContext): Promise<AdsRuleAutoStatus> {
  const decision = await guard.evaluate(context, { permission: ADS_RULE_WRITE, switchKey: ADS_RULE_SWITCH })
  return decision.allowed ? { allowed: true, reason: null } : { allowed: false, reason: decision.blockedBy?.message ?? '自动执行暂不可用' }
}

export const RUN_SELECT = {
  id: true,
  entityKey: true,
  entityLabel: true,
  actionType: true,
  beforeValue: true,
  afterValue: true,
  outcome: true,
  executed: true,
  message: true,
  workItemId: true,
  evidenceJson: true,
  runAt: true,
} satisfies Prisma.AdsAutomationRunSelect
export type RunRecord = Prisma.AdsAutomationRunGetPayload<{ select: typeof RUN_SELECT }>

export function runRowOf(record: RunRecord): AdsRuleRunRow {
  const evidence = objectOf(record.evidenceJson)
  return {
    id: record.id,
    entityKey: record.entityKey,
    entityLabel: record.entityLabel,
    actionType: actionTypeOf(record.actionType),
    before: record.beforeValue,
    after: record.afterValue,
    outcome: pick(Object.keys(ADS_RULE_OUTCOME_LABEL) as AdsRuleRunOutcome[], record.outcome, 'SKIPPED'),
    executed: record.executed,
    message: record.message,
    workItemId: record.workItemId,
    evidence: Object.fromEntries(Object.entries(evidence).map(([key, value]) => [key, typeof value === 'number' ? value : null])),
    runAt: record.runAt.toISOString(),
  }
}
