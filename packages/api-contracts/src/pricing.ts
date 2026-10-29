import type { CursorPageInfo } from './query.js'
import type { InventoryFreshness } from './inventory.js'
import type { ScenarioMatrix } from './pricing-scenario.js'

// 定价与购物车（P4-11，05 章 5.5）：常量、类型与口径文字。纯计算在 pricing-math.ts，请求校验在 pricing-query.ts（zod 单独成文件）。
// 价格数据来自 Product Pricing API v2022-05-01（推荐报价预期价格、竞争摘要）与刊登接口的报价；这些接口的字段依据官方文档整理，没有用真实店铺核对（CR-086）。
// 没有数据显示“尚无记录”，没有权限显示“无权限”，来源没接上显示“尚未接入”，永远不显示成 0。

export const PRICING_READ = 'pricing.read'
export const PRICING_PRICE_WRITE = 'pricing.price.write'
export const PRICING_RULE_WRITE = 'pricing.rule.write'
export const PRICING_UPDATE_SWITCH = 'sw.pricing.update'
export const PRICING_AUTO_SWITCH = 'sw.pricing.rule.auto'
export const PRICING_SYNC_JOB = 'PRICING_SYNC'
export const PRICING_FRESHNESS_KEY = 'pricing.api'
/** 定价接口的角色（“定价”）未获批时同步任务的失败码（不可重试）。 */
export const PRICING_ROLE_MISSING = 'PRICING_ROLE_MISSING'
export const PRICING_MARKETPLACE_ID = 'ATVPDKIKX0DER'

export const PRICING_LIMITS = {
  /** 推荐报价预期价格每批最多 40 个 SKU；竞争摘要每批最多 20 个 ASIN（官方批量上限）。 */
  featuredBatch: 40,
  summaryBatch: 20,
  /** 每次同步最多调用的批数：官方限速约 30 秒一次，30 批约 15 分钟；商品更多时按时间槽确定性轮转。 */
  syncBatchesMax: 30,
  /** 同步间隔（毫秒）：轮转的时间槽宽度，与 freshness 的 120 分钟一致。 */
  syncSlotMs: 2 * 3_600_000,
  /** 价格快照只在价格变化或距上一条超过 24 小时时才写，历史曲线不会因为每 2 小时一次的同步而膨胀。 */
  heartbeatMs: 24 * 3_600_000,
  /** 取“最近一次”时只看这么久以内的行（同步每 2 小时一次，每天至少一条心跳）。 */
  freshWindowMs: 3 * 24 * 3_600_000,
  historyDays: 90,
  historyRowsMax: 4000,
  eventsMax: 50,
  offersMax: 30,
  adjustmentsMax: 50,
  /** 调价前后对照：各取 7 天。 */
  compareDays: 7,
  ruleSkusMax: 200,
  ruleListMax: 100,
  runsPageMax: 100,
  dryRunDaysMax: 30,
  dryRunDaysDefault: 7,
  /** 价格在界面与接口里统一保留两位小数。 */
  priceMax: 100_000,
  rulesPerStoreMax: 50,
  skuMax: 40,
} as const

export const PRICE_RUN_KINDS = ['PRICE_VALIDATE', 'PRICE_PATCH'] as const
export type PriceRunKind = (typeof PRICE_RUN_KINDS)[number]
export const PRICE_RUN_KIND_LABEL: Record<PriceRunKind, string> = { PRICE_VALIDATE: '价格校验预览', PRICE_PATCH: '修改价格' }
export const PRICING_GUARDRAIL_ACTION = 'PRICE_GUARDRAIL_SAVED'
export const PRICING_RULE_ACTIONS = { created: 'PRICING_RULE_CREATED', updated: 'PRICING_RULE_UPDATED', dismissed: 'PRICING_SUGGESTION_DISMISSED', dryRun: 'PRICING_RULE_DRY_RUN' } as const
export const PRICING_SUBMITTED_ACTIONS = { PRICE_VALIDATE: 'PRICE_VALIDATE_REQUESTED', PRICE_PATCH: 'PRICE_CHANGE_SUBMITTED' } as const
/** 价格写入记录的价格来源：用户手工、手动规则确认、自动规则。 */
export const PRICE_CHANGE_SOURCES = ['MANUAL', 'RULE_CONFIRMED', 'RULE_AUTO'] as const
export type PriceChangeSource = (typeof PRICE_CHANGE_SOURCES)[number]
export const PRICE_CHANGE_SOURCE_LABEL: Record<PriceChangeSource, string> = { MANUAL: '手工调价', RULE_CONFIRMED: '规则建议（人工确认）', RULE_AUTO: '规则自动执行' }

// ---- 价格健康 ----

export const PRICE_HEALTH_STATES = ['WINNING', 'ABOVE_EXPECTED', 'NOT_FEATURED', 'NOT_ELIGIBLE', 'LOST_ELIGIBILITY', 'NO_COMPETITION', 'UNKNOWN'] as const
export type PriceHealth = (typeof PRICE_HEALTH_STATES)[number]
export const PRICE_HEALTH_LABEL: Record<PriceHealth, string> = {
  WINNING: '已获得推荐报价',
  ABOVE_EXPECTED: '价格高于预期获胜价',
  NOT_FEATURED: '未获得推荐报价（价格不是主因）',
  NOT_ELIGIBLE: '报价不具备获得资格',
  LOST_ELIGIBILITY: '因价格失去推荐报价资格',
  NO_COMPETITION: '没有竞争报价',
  UNKNOWN: '尚无记录',
}

// ---- 价格护栏 ----

export const GUARDRAIL_SCOPES = ['STORE', 'CATEGORY', 'ASIN', 'SKU'] as const
export type GuardrailScope = (typeof GUARDRAIL_SCOPES)[number]
export const GUARDRAIL_SCOPE_LABEL: Record<GuardrailScope, string> = { STORE: '整个店铺', CATEGORY: '类目', ASIN: 'ASIN', SKU: 'SKU' }
/** 同一个字段有多层护栏时，越具体越优先。 */
export const GUARDRAIL_SPECIFICITY: readonly GuardrailScope[] = ['SKU', 'ASIN', 'CATEGORY', 'STORE']

export interface GuardrailLimits {
  minPrice: number | null
  maxPrice: number | null
  /** 最低利润率（0 到 1 的小数）：按这个价格卖时的预计利润率不能低于它。 */
  minMarginPct: number | null
  /** 单次调幅上限（0 到 1 的小数）：新价格与当前价格相差不能超过它。 */
  maxChangePct: number | null
}
export const NO_LIMITS: GuardrailLimits = { minPrice: null, maxPrice: null, minMarginPct: null, maxChangePct: null }

export const GUARDRAIL_VIOLATION_CODES = ['BELOW_MIN', 'ABOVE_MAX', 'MARGIN_TOO_LOW', 'MARGIN_UNKNOWN', 'STEP_TOO_LARGE'] as const
export type GuardrailViolationCode = (typeof GUARDRAIL_VIOLATION_CODES)[number]
export interface GuardrailViolation {
  code: GuardrailViolationCode
  text: string
}

export interface GuardrailView {
  id: string
  storeId: string
  storeName: string
  scope: GuardrailScope
  scopeRef: string
  minPrice: number | null
  maxPrice: number | null
  minMarginPct: number | null
  maxChangePct: number | null
  enabled: boolean
  version: number
  updatedAt: string
}
export interface GuardrailListResponse {
  items: GuardrailView[]
  truncated: boolean
}

// ---- 定价规则 ----

export const PRICING_STRATEGIES = ['FOLLOW_EXPECTED', 'TARGET_MARGIN', 'MATCH_LOWEST'] as const
export type PricingStrategy = (typeof PRICING_STRATEGIES)[number]
export const PRICING_STRATEGY_LABEL: Record<PricingStrategy, string> = {
  FOLLOW_EXPECTED: '跟随推荐报价预期价格',
  TARGET_MARGIN: '按目标利润率定价',
  MATCH_LOWEST: '与最低竞争报价保持差额',
}
export const PRICING_RULE_MODES = ['MANUAL', 'AUTO'] as const
export type PricingRuleMode = (typeof PRICING_RULE_MODES)[number]
export const PRICING_RULE_MODE_LABEL: Record<PricingRuleMode, string> = { MANUAL: '手动（只生成建议）', AUTO: '自动执行' }
export const PRICING_RULE_STATUSES = ['ACTIVE', 'PAUSED', 'BREAKER'] as const
export type PricingRuleStatus = (typeof PRICING_RULE_STATUSES)[number]
export const PRICING_RULE_STATUS_LABEL: Record<PricingRuleStatus, string> = { ACTIVE: '启用中', PAUSED: '已暂停', BREAKER: '已熔断' }

/** 策略参数：FOLLOW_EXPECTED 用 offsetPct（相对预期价格的百分比，-0.2 到 0.2）；TARGET_MARGIN 用 targetMarginPct（0.01 到 0.9）；MATCH_LOWEST 用 offsetAmount（美元，-20 到 20）。 */
export interface PricingParams {
  offsetPct?: number
  targetMarginPct?: number
  offsetAmount?: number
}
export interface PricingTargetScope {
  all: boolean
  skus: string[]
  asins: string[]
}
/** 熔断阈值：连续失败次数；调价后转化率相对下降的比例；调价后实际利润率下限。 */
export interface PricingBreaker {
  failureStreak: number
  conversionDropPct: number | null
  minMarginPct: number | null
}
export const DEFAULT_BREAKER: PricingBreaker = { failureStreak: 3, conversionDropPct: 0.3, minMarginPct: null }
/** 调价后观察多久再判断转化率与利润率：满 3 天才判断，窗口取 7 天。 */
export const BREAKER_OBSERVE_DAYS = 3
export const BREAKER_WINDOW_DAYS = 7
/** 判断转化率下降要求调价前后各自的会话数不少于这个值，样本太小不熔断。 */
export const BREAKER_MIN_SESSIONS = 100

export interface PricingRuleSpec {
  id: string
  name: string
  mode: PricingRuleMode
  strategy: PricingStrategy
  params: PricingParams
  scope: PricingTargetScope
  /** 单次调幅上限（0 到 1 的小数）；规则自己的保护，与护栏的 maxChangePct 同时生效，取更严的。 */
  maxChangePct: number
  /** 每个 SKU 每天最多执行（或生成建议）几次。 */
  dailyLimit: number
  breaker: PricingBreaker
  /** 情形 × 动作矩阵（P6-17）：有矩阵时按矩阵求价，不再用 strategy；没有为空。 */
  matrix?: ScenarioMatrix | null
}

export interface PricingRuleView {
  id: string
  storeId: string
  storeName: string
  name: string
  mode: PricingRuleMode
  modeLabel: string
  strategy: PricingStrategy
  strategyLabel: string
  params: PricingParams
  paramsText: string
  scope: PricingTargetScope
  scopeText: string
  status: PricingRuleStatus
  statusLabel: string
  maxChangePct: number
  dailyLimit: number
  breaker: PricingBreaker
  /** 情形 × 动作矩阵（P6-17）；没有用矩阵的规则为 null。 */
  scenarioMatrix: ScenarioMatrix | null
  scenarioText: string | null
  breakerReason: string | null
  lastEvaluatedAt: string | null
  /** 自动模式能不能真的执行：需要写入开关 sw.pricing.rule.auto 与改价开关 sw.pricing.update 都打开。 */
  autoReady: boolean
  autoNote: string | null
  version: number
  createdAt: string
  updatedAt: string
  pendingSuggestions: number
}
export interface PricingRuleListResponse {
  items: PricingRuleView[]
  truncated: boolean
}

export const RULE_RUN_OUTCOMES = ['SUGGESTED', 'QUEUED', 'APPLIED', 'FAILED', 'BLOCKED', 'SKIPPED', 'DISMISSED'] as const
export type RuleRunOutcome = (typeof RULE_RUN_OUTCOMES)[number]
export const RULE_RUN_OUTCOME_LABEL: Record<RuleRunOutcome, string> = {
  SUGGESTED: '待确认的建议',
  QUEUED: '已提交，等待亚马逊确认',
  APPLIED: '已执行',
  FAILED: '执行失败',
  BLOCKED: '被护栏拦截',
  SKIPPED: '已跳过',
  DISMISSED: '已忽略',
}
export interface RuleRunView {
  id: string
  ruleId: string
  ruleName: string
  sku: string
  asin: string
  currentPrice: number | null
  rawPrice: number | null
  suggestedPrice: number | null
  guardrailResult: string
  guardrailText: string
  outcome: RuleRunOutcome
  outcomeLabel: string
  message: string | null
  writeRunId: string | null
  runAt: string
  /** 调价前后对照（已执行且观察期满后才有）。 */
  compare: PriceCompare | null
}
export interface RuleRunListResponse {
  items: RuleRunView[]
  pageInfo: CursorPageInfo
}

export interface DryRunHit {
  sku: string
  asin: string
  currentPrice: number | null
  rawPrice: number | null
  suggestedPrice: number | null
  guardrailResult: string
  guardrailText: string
  hit: boolean
}
export interface DryRunDay {
  date: string
  evaluated: number
  hits: number
  blocked: number
}
export interface DryRunResponse {
  ruleId: string
  days: number
  /** 按历史每天结束时的数据逐日模拟；今天按最新数据。 */
  daily: DryRunDay[]
  /** 按最新数据逐个 SKU 的结果（最多 200 个）。 */
  current: DryRunHit[]
  evaluated: number
  note: string
  basis: string
}

// ---- 前后对照 ----

export interface PriceCompareSide {
  days: number
  unitsPerDay: number | null
  sessions: number | null
  conversionPct: number | null
  buyBoxPct: number | null
}
export interface PriceCompare {
  state: 'OK' | 'WAITING' | 'NO_DATA'
  note: string | null
  before: PriceCompareSide | null
  after: PriceCompareSide | null
}

// ---- 列表 ----

export const PRICING_SORTS = ['sku', 'price', 'gap', 'margin', 'buyBox', 'lastChange'] as const
export type PricingSort = (typeof PRICING_SORTS)[number]

export interface PricingRow {
  id: string
  storeId: string
  storeName: string
  sku: string
  asin: string
  title: string
  imageUrl: string | null
  price: number | null
  currency: string
  priceObservedAt: string | null
  lowestPrice: number | null
  featured: { price: number | null; ownIsFeatured: boolean | null; fulfillment: string | null }
  expectedPrice: number | null
  expectedStatus: string | null
  /** 我方价格 − 预期获胜价（正数表示我方更贵）。 */
  gap: number | null
  /** 推荐报价获得率（近 30 天，按会话加权）。 */
  buyBoxPct: number | null
  viewWeight: { member: number | null; nonMember: number | null }
  health: PriceHealth
  healthLabel: string
  lastChange: { at: string; from: number | null; to: number } | null
  /** 利润率：state 不是 OK 时两个数都为 null，note 写原因。 */
  margin: { state: 'OK' | 'NO_DATA' | 'INCOMPLETE' | 'RESTRICTED'; note: string | null; atCurrent: number | null; atExpected: number | null }
  limits: GuardrailLimits | null
}

export interface PricingSummary {
  total: number
  health: Array<{ state: PriceHealth; label: string; count: number }>
  withPrice: number
  withoutPrice: number
}

export interface PricingWriteStatus {
  allowed: boolean
  step: 'PERMISSION' | 'CONNECTION' | 'SWITCH' | null
  reason: string | null
  remedyPath: string | null
}
export interface PricingWriteStatuses {
  /** 校验预览（只读，不需要开关）。 */
  validate: PricingWriteStatus
  /** 真正改价（需要 sw.pricing.update）。 */
  update: PricingWriteStatus
  /** 规则与护栏的写入权限。 */
  rule: PricingWriteStatus
}

export interface PricingListResponse {
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string | null
  items: PricingRow[]
  pageInfo: CursorPageInfo
  summary: PricingSummary
  currency: string
  stores: Array<{ id: string; name: string }>
  write: PricingWriteStatuses
  /** 利润率口径：近 30 天已发生的单位经济。 */
  marginBasis: string
  truncated: boolean
  freshness: InventoryFreshness
  basis: string
}
