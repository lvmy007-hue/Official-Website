import {
  PRICING_AUTO_SWITCH,
  PRICING_RULE_MODE_LABEL,
  PRICING_RULE_STATUS_LABEL,
  PRICING_STRATEGY_LABEL,
  PRICING_UPDATE_SWITCH,
  RULE_RUN_OUTCOME_LABEL,
  describeMatrix,
  describeParams,
  describeScope,
  guardrailResultText,
  normalizeMatrix,
  type GuardrailView,
  type PriceCompare,
  type PricingBreaker,
  type PricingParams,
  type PricingRuleMode,
  type PricingRuleStatus,
  type PricingRuleView,
  type PricingStrategy,
  type PricingTargetScope,
  type RuleRunOutcome,
  type RuleRunView,
} from '@nova/api-contracts'
import type { PricingRule, PricingRuleRun } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { num, type GuardrailRecord } from './pricing-load'

// 定价规则与执行记录的视图（P4-11）。自动模式要两个开关（sw.pricing.update 与 sw.pricing.rule.auto）都打开才会真正执行，页面据此显示“能不能自动执行”和原因。

export interface SwitchState {
  update: boolean
  auto: boolean
}

export async function switchStateOf(prisma: PrismaService, tenantId: string): Promise<SwitchState> {
  const on = await prisma.integrationSwitch.findMany({
    where: { tenantId, switchKey: { in: [PRICING_UPDATE_SWITCH, PRICING_AUTO_SWITCH] }, sellerAccountId: null, enabled: true },
    select: { switchKey: true },
    take: 4,
  })
  const keys = new Set(on.map(row => row.switchKey))
  return { update: keys.has(PRICING_UPDATE_SWITCH), auto: keys.has(PRICING_AUTO_SWITCH) }
}

const scopeOf = (value: unknown): PricingTargetScope => {
  const row = (value && typeof value === 'object' ? value : {}) as Partial<PricingTargetScope>
  return { all: row.all === true, skus: Array.isArray(row.skus) ? row.skus.map(String) : [], asins: Array.isArray(row.asins) ? row.asins.map(String) : [] }
}
const paramsOf = (value: unknown): PricingParams => (value && typeof value === 'object' ? (value as PricingParams) : {})

export function autoNoteOf(mode: string, state: SwitchState): { ready: boolean; note: string | null } {
  if (mode !== 'AUTO') return { ready: false, note: null }
  const off = [state.update ? null : `改价开关（${PRICING_UPDATE_SWITCH}）`, state.auto ? null : `规则自动执行开关（${PRICING_AUTO_SWITCH}）`].filter((item): item is string => item !== null)
  return off.length === 0 ? { ready: true, note: null } : { ready: false, note: `自动执行需要先打开：${off.join('、')}；在此之前命中的商品只生成待确认的建议` }
}

export function ruleViewOf(rule: PricingRule, storeName: string, pending: number, state: SwitchState): PricingRuleView {
  const strategy = rule.strategy as PricingStrategy
  const params = paramsOf(rule.paramsJson)
  const scope = scopeOf(rule.targetScopeJson)
  const auto = autoNoteOf(rule.mode, state)
  const matrix = normalizeMatrix(rule.scenarioMatrix)
  const breaker: PricingBreaker = { failureStreak: rule.breakerFailures, conversionDropPct: num(rule.breakerConversionDrop), minMarginPct: num(rule.breakerMinMargin) }
  return {
    id: rule.id,
    storeId: rule.sellerAccountId,
    storeName,
    name: rule.name,
    mode: rule.mode as PricingRuleMode,
    modeLabel: PRICING_RULE_MODE_LABEL[rule.mode as PricingRuleMode] ?? rule.mode,
    strategy,
    strategyLabel: PRICING_STRATEGY_LABEL[strategy] ?? rule.strategy,
    params,
    paramsText: describeParams(strategy, params),
    scope,
    scopeText: describeScope(scope),
    status: rule.status as PricingRuleStatus,
    statusLabel: PRICING_RULE_STATUS_LABEL[rule.status as PricingRuleStatus] ?? rule.status,
    maxChangePct: Number(rule.maxChangePct.toString()),
    dailyLimit: rule.dailyLimit,
    breaker,
    scenarioMatrix: matrix,
    scenarioText: matrix ? describeMatrix(matrix) : null,
    breakerReason: rule.breakerReason,
    lastEvaluatedAt: rule.lastEvaluatedAt?.toISOString() ?? null,
    autoReady: auto.ready,
    autoNote: auto.note,
    version: rule.version,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
    pendingSuggestions: pending,
  }
}

export function ruleRunViewOf(run: PricingRuleRun, ruleName: string, compare: PriceCompare | null): RuleRunView {
  return {
    id: run.id,
    ruleId: run.ruleId,
    ruleName,
    sku: run.sku,
    asin: run.asin,
    currentPrice: num(run.currentPrice),
    rawPrice: num(run.rawPrice),
    suggestedPrice: num(run.suggestedPrice),
    guardrailResult: run.guardrailResult,
    guardrailText: guardrailResultText(run.guardrailResult),
    outcome: run.outcome as RuleRunOutcome,
    outcomeLabel: RULE_RUN_OUTCOME_LABEL[run.outcome as RuleRunOutcome] ?? run.outcome,
    message: run.message,
    writeRunId: run.writeRunId,
    runAt: run.runAt.toISOString(),
    compare,
  }
}

export const guardrailViewOf = (row: GuardrailRecord, storeName: string): GuardrailView => ({
  id: row.id,
  storeId: row.sellerAccountId,
  storeName,
  scope: row.scope as GuardrailView['scope'],
  scopeRef: row.scopeRef,
  minPrice: row.minPrice,
  maxPrice: row.maxPrice,
  minMarginPct: row.minMarginPct,
  maxChangePct: row.maxChangePct,
  enabled: row.enabled,
  version: row.version,
  updatedAt: row.updatedAt.toISOString(),
})
