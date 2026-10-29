import { z } from 'zod'
import { pageListQuery } from './query.js'
import { RETURN_CYCLE_ANCHORS, RETURN_CYCLE_DIMENSIONS, RETURN_TIME_BASES } from './returns-analysis.js'
import { parseBounds } from './returns-analysis-math.js'
import { RETURN_REASON_CATEGORIES, RETURN_REASON_PUT_MAX } from './returns-reason.js'

// 退货分析与原因映射的请求校验（P6-13）。单独成文件：zod 构造是顶层调用，前端不引用。
// 范围参数（店铺、日期等）仍由 ScopeQuerySchema 校验；这里只管本页自己的参数，不适用的参数一律 422，避免“以为生效实际被忽略”。

const timeBasis = z.enum(RETURN_TIME_BASES, { error: '时间口径只能是 return（按退货时间）或 order（按下单时间）' }).default('return')

/** 概览、跨月退货、队列退货率、库存属性×处置结果：只有时间口径。 */
export const ReturnBasisParamsSchema = z.object({ timeBasis }).strict()
export type ReturnBasisParams = z.infer<typeof ReturnBasisParamsSchema>

/** 退货周期：时间口径、起点（下单或发货）、天数段上界、切片维度。 */
export const ReturnCycleParamsSchema = z
  .object({
    timeBasis,
    anchor: z.enum(RETURN_CYCLE_ANCHORS, { error: '周期起点只能是 order（下单日期）或 ship（发货日期）' }).default('order'),
    bounds: z.string().max(60).optional(),
    dimension: z.enum(RETURN_CYCLE_DIMENSIONS, { error: '切片维度只能是 none、asin、reason 或 disposition' }).default('none'),
    // ASIN 360 的退货周期区块只看这一个商品（P6-21）；店铺由范围参数 storeIds 限定
    asin: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{10}$/, { error: 'ASIN 必须是 10 位字母或数字' })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const parsed = parseBounds(value.bounds)
    if (parsed.error) ctx.addIssue({ code: 'custom', path: ['bounds'], message: parsed.error })
  })
export type ReturnCycleParams = z.infer<typeof ReturnCycleParamsSchema>

/** 本页自己的参数键（其余键交给范围参数校验）。 */
export const RETURN_ANALYSIS_PARAM_KEYS = ['timeBasis', 'anchor', 'bounds', 'dimension', 'asin'] as const

/** 把请求参数拆成范围参数与本页参数：范围参数交给 ScopeQuerySchema，本页参数交给上面的校验。 */
export function splitAnalysisQuery(raw: Record<string, string>): { scope: Record<string, string>; params: Record<string, string> } {
  const scope: Record<string, string> = {}
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) (RETURN_ANALYSIS_PARAM_KEYS.includes(key as (typeof RETURN_ANALYSIS_PARAM_KEYS)[number]) ? params : scope)[key] = value
  return { scope, params }
}

// ---- 原因映射 ----

export const ReturnReasonMapQuerySchema = pageListQuery({
  scope: false,
  sortable: ['code', 'category', 'updatedAt'] as const,
  defaultSort: { field: 'category', dir: 'asc' },
  filters: { category: { type: 'enum', values: RETURN_REASON_CATEGORIES } },
})
export type ReturnReasonMapQuery = z.infer<typeof ReturnReasonMapQuerySchema>

const ReasonItemSchema = z
  .object({
    code: z.string().trim().min(1, { error: '原因代码不能为空' }).max(80, { error: '原因代码最长 80 个字符' }),
    labelZh: z.string().trim().min(1, { error: '中文释义不能为空' }).max(60, { error: '中文释义最长 60 个字符' }),
    category: z.enum(RETURN_REASON_CATEGORIES, { error: '大类必须从列表里选择' }),
  })
  .strict()

/** 保存映射：一次最多 50 行，同一代码不能重复（大小写不分）；不在预置里的代码会新增为企业自己的映射。 */
export const ReturnReasonMapBodySchema = z
  .object({
    items: z
      .array(ReasonItemSchema)
      .min(1, { error: '至少要改一行' })
      .max(RETURN_REASON_PUT_MAX, { error: `一次最多保存 ${RETURN_REASON_PUT_MAX} 行` }),
  })
  .strict()
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.items.forEach((item, index) => {
      const key = item.code.toUpperCase()
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: ['items', index, 'code'], message: `原因代码 ${item.code} 重复了` })
      seen.add(key)
    })
  })
export type ReturnReasonMapBody = z.infer<typeof ReturnReasonMapBodySchema>
