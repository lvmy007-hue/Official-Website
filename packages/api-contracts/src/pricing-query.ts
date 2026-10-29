import { z } from 'zod'
import { GUARDRAIL_SCOPES, PRICE_HEALTH_STATES, PRICING_LIMITS, PRICING_RULE_MODES, PRICING_RULE_STATUSES, PRICING_SORTS, PRICING_STRATEGIES, RULE_RUN_OUTCOMES } from './pricing.js'
import { pricingParamsIssue, pricingScopeIssue } from './pricing-math.js'
import { PRICING_ACTIONS, PRICING_SITUATIONS, SCENARIO_LIMITS, scenarioMatrixIssue, type PricingSituation } from './pricing-scenario.js'
import { cursorListQuery } from './query.js'

// 定价与购物车的请求校验（P4-11）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起。

/** 列表：全局范围参数加健康状态筛选；排序字段白名单；关键字 q 是 cursorListQuery 自带的。 */
export const PricingListQuerySchema = cursorListQuery({
  sortable: PRICING_SORTS,
  defaultSort: { field: 'gap', dir: 'desc' },
  filters: { health: { type: 'enum', values: PRICE_HEALTH_STATES } },
})
export type PricingListQuery = z.infer<typeof PricingListQuerySchema>

const StoreId = z.string().trim().min(1).max(64)
const Sku = z.string().trim().min(1).max(PRICING_LIMITS.skuMax)
const Price = z
  .number({ error: '价格要填数字' })
  .positive({ error: '价格要大于 0' })
  .max(PRICING_LIMITS.priceMax, { error: `价格不能超过 ${PRICING_LIMITS.priceMax}` })
const ProductType = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,79}$/, { error: '商品类型是大写字母、数字与下划线，例如 LUGGAGE' })
  .optional()
const Fraction = (max: number) => z.number().min(0).max(max)

/** 只带 SKU 所在店铺的查询（详情与模拟）。 */
export const PricingStoreQuerySchema = z.object({ storeId: StoreId }).strict()

export const PriceSimulationBodySchema = z.object({ storeId: StoreId, price: Price }).strict()
export type PriceSimulationBody = z.infer<typeof PriceSimulationBodySchema>

/** 校验预览：调刊登接口的校验预览模式检查这个价格（不会真的改）；SKU 在路径里。 */
export const PriceValidateBodySchema = z.object({ storeId: StoreId, price: Price, productType: ProductType }).strict()
export type PriceValidateBody = z.infer<typeof PriceValidateBodySchema>

/** 改价：必须带上一步校验通过的预览编号，价格要与校验过的完全一致；来自规则建议时带上建议记录编号。 */
export const PriceUpdateBodySchema = z
  .object({ storeId: StoreId, price: Price, productType: ProductType, previewRunId: z.string().trim().min(1).max(64), ruleRunId: z.string().trim().min(1).max(64).optional() })
  .strict()
export type PriceUpdateBody = z.infer<typeof PriceUpdateBodySchema>

const Limit = z.number().nullable().optional()
export const GuardrailUpsertBodySchema = z
  .object({
    storeId: StoreId,
    scope: z.enum(GUARDRAIL_SCOPES),
    scopeRef: z.string().trim().max(200).default(''),
    minPrice: Limit.refine(value => value == null || (value > 0 && value <= PRICING_LIMITS.priceMax), { error: '最低价要大于 0' }),
    maxPrice: Limit.refine(value => value == null || (value > 0 && value <= PRICING_LIMITS.priceMax), { error: '最高价要大于 0' }),
    minMarginPct: Limit.refine(value => value == null || (value >= 0 && value <= 0.95), { error: '最低利润率要在 0% 到 95% 之间' }),
    maxChangePct: Limit.refine(value => value == null || (value > 0 && value <= 1), { error: '单次调幅上限要在 0% 到 100% 之间（不含 0）' }),
    enabled: z.boolean().default(true),
    expectedVersion: z.number().int().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === 'STORE' && value.scopeRef !== '') ctx.addIssue({ code: 'custom', message: '整个店铺的护栏不需要填对象', path: ['scopeRef'] })
    if (value.scope !== 'STORE' && value.scopeRef === '') ctx.addIssue({ code: 'custom', message: '请填写 SKU、ASIN 或类目', path: ['scopeRef'] })
    if (value.minPrice != null && value.maxPrice != null && value.minPrice > value.maxPrice) ctx.addIssue({ code: 'custom', message: '最低价不能高于最高价', path: ['maxPrice'] })
    if (value.enabled && [value.minPrice, value.maxPrice, value.minMarginPct, value.maxChangePct].every(item => item == null)) {
      ctx.addIssue({ code: 'custom', message: '至少设置一项限制（最低价、最高价、最低利润率或单次调幅上限），或把护栏停用', path: ['minPrice'] })
    }
  })
export type GuardrailUpsertBody = z.infer<typeof GuardrailUpsertBodySchema>

export const GuardrailListQuerySchema = z.object({ storeId: StoreId.optional() }).strict()

const ParamsSchema = z.object({ offsetPct: z.number().optional(), targetMarginPct: z.number().optional(), offsetAmount: z.number().optional() }).strict()
const ScopeSchema = z
  .object({
    all: z.boolean().default(false),
    skus: z.array(Sku).max(PRICING_LIMITS.ruleSkusMax).default([]),
    asins: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^[A-Z0-9]{10}$/, { error: 'ASIN 是 10 位字母或数字' }),
      )
      .max(PRICING_LIMITS.ruleSkusMax)
      .default([]),
  })
  .strict()
const BreakerSchema = z
  .object({
    failureStreak: z.number().int().min(1).max(10).default(3),
    conversionDropPct: z.number().min(0.05).max(0.9).nullable().default(0.3),
    minMarginPct: z.number().min(0).max(0.9).nullable().default(null),
  })
  .strict()
/** 情形 × 动作矩阵（P6-17）：每个情形一格，缺的格子按“不调价”；加减额只有“跟随对方价格”用；问题文字与页面共用（scenarioMatrixIssue）。 */
const CellSchema = z
  .object({
    action: z.enum(PRICING_ACTIONS),
    offset: z.number().min(-SCENARIO_LIMITS.offsetMax).max(SCENARIO_LIMITS.offsetMax).optional(),
  })
  .strict()
export const ScenarioMatrixSchema = z
  .object({
    cells: z.object(Object.fromEntries(PRICING_SITUATIONS.map(situation => [situation, CellSchema.optional()])) as Record<PricingSituation, z.ZodOptional<typeof CellSchema>>).strict(),
    basePrice: z.number().positive().max(SCENARIO_LIMITS.basePriceMax).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = scenarioMatrixIssue(value)
    if (issue) ctx.addIssue({ code: 'custom', message: issue, path: ['cells'] })
  })
const RuleName = z.string().trim().min(1, { error: '请填写规则名称' }).max(80)

const ruleChecks = (value: { strategy: (typeof PRICING_STRATEGIES)[number]; params: z.infer<typeof ParamsSchema>; scope: z.infer<typeof ScopeSchema> }, ctx: z.RefinementCtx) => {
  const params = pricingParamsIssue(value.strategy, value.params)
  if (params) ctx.addIssue({ code: 'custom', message: params, path: ['params'] })
  const scope = pricingScopeIssue(value.scope)
  if (scope) ctx.addIssue({ code: 'custom', message: scope, path: ['scope'] })
}

export const PricingRuleCreateBodySchema = z
  .object({
    storeId: StoreId,
    name: RuleName,
    mode: z.enum(PRICING_RULE_MODES),
    strategy: z.enum(PRICING_STRATEGIES),
    params: ParamsSchema.default({}),
    scope: ScopeSchema,
    maxChangePct: Fraction(0.5)
      .refine(value => value > 0, { error: '单次调幅上限要大于 0' })
      .default(0.05),
    dailyLimit: z.number().int().min(1).max(10).default(1),
    breaker: BreakerSchema.default({ failureStreak: 3, conversionDropPct: 0.3, minMarginPct: null }),
    status: z.enum(['ACTIVE', 'PAUSED']).default('PAUSED'),
    scenarioMatrix: ScenarioMatrixSchema.nullable().default(null),
  })
  .strict()
  .superRefine(ruleChecks)
export type PricingRuleCreateBody = z.infer<typeof PricingRuleCreateBodySchema>

/** 修改：策略不能改（新建一条规则），其余字段可改；参数与适用商品在服务里按规则的策略再校验。 */
export const PricingRuleUpdateBodySchema = z
  .object({
    expectedVersion: z.number().int().min(1),
    name: RuleName.optional(),
    mode: z.enum(PRICING_RULE_MODES).optional(),
    params: ParamsSchema.optional(),
    scope: ScopeSchema.optional(),
    maxChangePct: Fraction(0.5)
      .refine(value => value > 0, { error: '单次调幅上限要大于 0' })
      .optional(),
    dailyLimit: z.number().int().min(1).max(10).optional(),
    breaker: BreakerSchema.optional(),
    status: z.enum(PRICING_RULE_STATUSES).optional(),
    /** 不传不改；传 null 取消矩阵、改回按策略求价。 */
    scenarioMatrix: ScenarioMatrixSchema.nullable().optional(),
  })
  .strict()
export type PricingRuleUpdateBody = z.infer<typeof PricingRuleUpdateBodySchema>

export const DryRunBodySchema = z.object({ days: z.number().int().min(1).max(PRICING_LIMITS.dryRunDaysMax).default(PRICING_LIMITS.dryRunDaysDefault) }).strict()
export type DryRunBody = z.infer<typeof DryRunBodySchema>

export const RuleRunListQuerySchema = cursorListQuery({
  sortable: ['runAt'] as const,
  defaultSort: { field: 'runAt', dir: 'desc' },
  filters: { outcome: { type: 'enum', values: RULE_RUN_OUTCOMES } },
})
export type RuleRunListQuery = z.infer<typeof RuleRunListQuerySchema>

/** 忽略一条待确认的建议。 */
export const RuleRunDismissBodySchema = z.object({ reason: z.string().trim().max(200).optional() }).strict()
