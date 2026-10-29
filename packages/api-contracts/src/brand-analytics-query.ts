import { z } from 'zod'
import { BA_PERIODS } from './brand-analytics.js'
import { BA_BASKET_SORTS, BA_CATALOG_SORTS, BA_REPEAT_SORTS, BA_SQP_SORTS, BA_TERM_FILTERS } from './brand-analytics-types.js'
import { isDateText, isPeriodStart } from './brand-analytics-math.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 品牌分析的请求校验（P4-04）。店铺范围由全局范围参数（ScopeSearchSchema）校验；这里只校验各页自己的参数：
// 周期种类（周、月、季）与周期起始日（必须对齐：周日、1 日、季首月 1 日）、维度、关键词、排序与游标。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

const periodShape = {
  period: z.enum(BA_PERIODS, { error: '周期只能是 WEEK、MONTH、QUARTER' }).default('WEEK'),
  periodStart: z
    .string()
    .trim()
    .refine(value => isDateText(value), { error: '周期起始日应为 YYYY-MM-DD' })
    .optional(),
}

const keyword = z.string().trim().min(1).max(120).optional()
const asin = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9]{10}$/, { error: 'ASIN 应为 10 位字母或数字' })
  .transform(value => value.toUpperCase())
  .optional()
const brand = z.string().trim().min(1).max(120).optional()
const dimension = z.enum(['ASIN', 'BRAND'], { error: '维度只能是 ASIN 或 BRAND' })

/** 周期起始日必须与周期种类对齐，否则取不到任何周期。 */
function alignedPeriod<T extends { period: (typeof BA_PERIODS)[number]; periodStart?: string }>(value: T, ctx: z.RefinementCtx) {
  if (value.periodStart && !isPeriodStart(value.period, value.periodStart)) {
    ctx.addIssue({ code: 'custom', path: ['periodStart'], message: '周期起始日与周期种类不对齐：周要选周日，月要选 1 日，季要选 1、4、7、10 月的 1 日' })
  }
}

export const BaSqpQuerySchema = z
  .object({
    ...periodShape,
    dimension: dimension.default('BRAND'),
    asin,
    brand,
    q: keyword,
    sort: sortSchema(BA_SQP_SORTS, { field: 'searchVolume', dir: 'desc' }),
    ...CursorParamsSchema.shape,
  })
  .superRefine(alignedPeriod)
export type BaSqpQuery = z.infer<typeof BaSqpQuerySchema>

export const BaCatalogQuerySchema = z
  .object({ ...periodShape, brand, q: keyword, sort: sortSchema(BA_CATALOG_SORTS, { field: 'purchases', dir: 'desc' }), ...CursorParamsSchema.shape })
  .superRefine(alignedPeriod)
export type BaCatalogQuery = z.infer<typeof BaCatalogQuerySchema>

export const BaTermsQuerySchema = z
  .object({
    ...periodShape,
    q: keyword,
    filter: z.enum(BA_TERM_FILTERS, { error: '分组只能是 ALL、OPPORTUNITY、RISK、TOP3' }).default('ALL'),
    /** 选中一个词时一并返回它最近若干周期的排名与我方份额。 */
    term: z.string().trim().min(1).max(200).optional(),
    ...CursorParamsSchema.shape,
  })
  .superRefine(alignedPeriod)
export type BaTermsQuery = z.infer<typeof BaTermsQuerySchema>

export const BaBasketQuerySchema = z
  .object({ ...periodShape, asin, q: keyword, sort: sortSchema(BA_BASKET_SORTS, { field: 'combinationPct', dir: 'desc' }), ...CursorParamsSchema.shape })
  .superRefine(alignedPeriod)
export type BaBasketQuery = z.infer<typeof BaBasketQuerySchema>

export const BaRepeatQuerySchema = z
  .object({
    ...periodShape,
    dimension: dimension.default('ASIN'),
    brand,
    q: keyword,
    sort: sortSchema(BA_REPEAT_SORTS, { field: 'repeatRevenue', dir: 'desc' }),
    ...CursorParamsSchema.shape,
  })
  .superRefine(alignedPeriod)
export type BaRepeatQuery = z.infer<typeof BaRepeatQuerySchema>
