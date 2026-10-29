import { z } from 'zod'
import { pageListQuery } from './query.js'
import { FORECAST_FACTOR_MAX, FORECAST_FIXED_MAX, FORECAST_MAX_DAYS, FORECAST_MODES, FORECAST_SCOPE_TYPES, FORECAST_STATUSES, forecastPeriodDays } from './replenishment-forecast.js'

// 人工预测规则的请求校验（P6-09）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

export const ForecastListQuerySchema = pageListQuery({
  sortable: ['from', 'to', 'scopeId', 'updatedAt'] as const,
  defaultSort: { field: 'from', dir: 'desc' },
  filters: {
    scopeType: { type: 'enum', values: FORECAST_SCOPE_TYPES },
    status: { type: 'enum', values: FORECAST_STATUSES },
  },
  scope: false,
})
export type ForecastListQuery = z.infer<typeof ForecastListQuerySchema>

const day = z
  .string({ error: '请填写日期' })
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: '日期格式应为 YYYY-MM-DD' })
  .refine(value => new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, { error: '日期不存在' })

const scopeId = z.string({ error: '请填写 SKU 或商品类型' }).trim().min(1, { error: '请填写 SKU 或商品类型' }).max(120, { error: '最多 120 个字符' })

const note = z
  .string()
  .trim()
  .max(200, { error: '备注最多 200 个字符' })
  .nullable()
  .optional()
  .transform(value => (value ? value : null))

const value = z
  .number({ error: '请填写数值' })
  .min(0, { error: '不能小于 0' })
  .max(FORECAST_FIXED_MAX, { error: `不能超过 ${FORECAST_FIXED_MAX}` })

/** 取值与模式的配合：固定日销可以是 0（这段时间不卖），同期系数必须大于 0 且不超过 20；时间段含首尾最长 366 天。 */
function refineRule(rule: { from?: string; to?: string; mode?: (typeof FORECAST_MODES)[number]; value?: number }, ctx: z.RefinementCtx) {
  if (rule.from && rule.to) {
    if (rule.to < rule.from) ctx.addIssue({ code: 'custom', path: ['to'], message: '结束日期不能早于开始日期' })
    else if (forecastPeriodDays(rule.from, rule.to) > FORECAST_MAX_DAYS) ctx.addIssue({ code: 'custom', path: ['to'], message: `时间段最长 ${FORECAST_MAX_DAYS} 天` })
  }
  if (rule.mode === 'YOY_FACTOR' && rule.value !== undefined) {
    if (rule.value <= 0) ctx.addIssue({ code: 'custom', path: ['value'], message: '同期系数必须大于 0' })
    if (rule.value > FORECAST_FACTOR_MAX) ctx.addIssue({ code: 'custom', path: ['value'], message: `同期系数不能超过 ${FORECAST_FACTOR_MAX}` })
  }
}

export const ForecastCreateBodySchema = z
  .object({ scopeType: z.enum(FORECAST_SCOPE_TYPES), scopeId, from: day, to: day, mode: z.enum(FORECAST_MODES), value, note })
  .strict()
  .superRefine(refineRule)
export type ForecastCreateBody = z.infer<typeof ForecastCreateBodySchema>

/** 修改：带着看到的版本号（乐观锁）；至少改一项；对象（SKU 或品类）不能改，换对象请新建。 */
export const ForecastUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    from: day.optional(),
    to: day.optional(),
    mode: z.enum(FORECAST_MODES).optional(),
    value: value.optional(),
    note: z.string().trim().max(200, { error: '备注最多 200 个字符' }).nullable().optional(),
  })
  .strict()
  .superRefine(refineRule)
export type ForecastUpdateBody = z.infer<typeof ForecastUpdateBodySchema>
