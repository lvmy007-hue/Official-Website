import { z } from 'zod'
import { BUSINESS_RULE_KEYS, INVENTORY_COMPONENTS, MULTI_SITE_TODAY_MODES, NET_SALES_DEDUCTIONS, WEEK_START_DAYS, type BusinessRuleKey } from './business-rules.js'
import { FORMULA_KEYS, METRIC_KINDS, METRIC_VERSION_LIMITS, formulaIssues } from './metric-versions.js'

// 口径版本的请求校验（P6-31）。zod 单独成文件，不进前端首屏。

const reason = z.string().trim().min(2, '请填写修改原因（至少 2 个字）').max(METRIC_VERSION_LIMITS.reasonMax, `修改原因最多 ${METRIC_VERSION_LIMITS.reasonMax} 字`)
const latest = z.number().int().min(0).max(1_000_000)
const formulaKey = z.enum(FORMULA_KEYS as [string, ...string[]], { error: '项目不在利润公式表里' })

/** 提交利润公式：`version` 是客户端看到的“最新版本号”（含待审批与已驳回，还没有任何版本为 0）。 */
export const ProfitFormulaBodySchema = z
  .object({
    version: latest,
    gross: z.array(formulaKey).max(FORMULA_KEYS.length),
    denominator: z.array(formulaKey).max(FORMULA_KEYS.length),
    reason,
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const message of formulaIssues({ gross: value.gross as never, denominator: value.denominator as never })) ctx.addIssue({ code: 'custom', path: ['gross'], message })
  })
export type ProfitFormulaBody = z.infer<typeof ProfitFormulaBodySchema>

const uniqueStrings = <T extends readonly [string, ...string[]]>(values: T, label: string) =>
  z
    .array(z.enum(values, { error: `${label}的取值不合法` }))
    .max(values.length)
    .refine(list => new Set(list).size === list.length, `${label}不能重复`)

/** 单项业务口径的新值，形状随 key 变化。 */
export const BusinessRuleValueSchemas = {
  netSales: z.object({ deduct: uniqueStrings(NET_SALES_DEDUCTIONS, '扣减项') }).strict(),
  availableInventory: z.object({ components: uniqueStrings(INVENTORY_COMPONENTS, '库存组成项').refine(list => list.length > 0, '可用库存至少要选一个组成项') }).strict(),
  weekStart: z.object({ day: z.enum(WEEK_START_DAYS, { error: '周起始日只能是周一、周日或周六' }) }).strict(),
  multiSiteToday: z.object({ mode: z.enum(MULTI_SITE_TODAY_MODES, { error: '多站点“今日”的取法取值不合法' }) }).strict(),
} as const satisfies Record<BusinessRuleKey, z.ZodType>

export const BusinessRuleKeyParamSchema = z.enum(BUSINESS_RULE_KEYS, { error: '没有这项业务口径' })

export const BusinessRuleBodySchema = z.object({ version: latest, value: z.unknown(), reason }).strict()
export type BusinessRuleBody = z.infer<typeof BusinessRuleBodySchema>

/** 审批：通过或驳回（发起人自己驳回算撤回）；驳回必须写意见；version 是该版本行的乐观锁版本号。 */
export const MetricDecisionBodySchema = z
  .object({
    decision: z.enum(['APPROVED', 'REJECTED']),
    comment: z.string().trim().max(500, '意见最多 500 字').default(''),
    version: z.number().int().min(1).max(1_000_000),
  })
  .superRefine((value, ctx) => {
    if (value.decision === 'REJECTED' && value.comment.length < 2) ctx.addIssue({ code: 'custom', path: ['comment'], message: '驳回或撤回请写明原因（至少 2 个字）' })
  })
export type MetricDecisionBody = z.infer<typeof MetricDecisionBodySchema>

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => {
    const parsed = new Date(`${value}T00:00:00Z`)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && value >= '2000-01-01'
  }, '日期不合法')

/** 差异报告的区间：含首尾，不超过 366 天。 */
export const MetricDiffBodySchema = z
  .object({ from: day, to: day })
  .strict()
  .superRefine((value, ctx) => {
    const days = Math.round((Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86_400_000) + 1
    if (days < 1) ctx.addIssue({ code: 'custom', path: ['to'], message: '结束日期不能早于开始日期' })
    else if (days > METRIC_VERSION_LIMITS.diffMaxDays) ctx.addIssue({ code: 'custom', path: ['to'], message: `差异报告的区间最多 ${METRIC_VERSION_LIMITS.diffMaxDays} 天` })
  })
export type MetricDiffBody = z.infer<typeof MetricDiffBodySchema>

export const MetricVersionListQuerySchema = z
  .object({
    kind: z.enum(METRIC_KINDS, { error: '口径类型取值不合法' }).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict()
export type MetricVersionListQuery = z.infer<typeof MetricVersionListQuerySchema>
