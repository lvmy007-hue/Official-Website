import { z } from 'zod'
import { BR_ASIN_SORTS, BR_GRANULARITIES, BR_LEVELS } from './business-reports.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 业务报告的请求校验（P4-02）。全局范围参数（店铺、日期、对比期）由 ScopeSearchSchema 校验，这里只校验本页自己的参数。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

/** 按日期：粒度（日、周、月），缺省按日。 */
export const BrDateQuerySchema = z.object({ granularity: z.enum(BR_GRANULARITIES, { error: '粒度只能是 DAY、WEEK、MONTH' }).default('DAY') })
export type BrDateQuery = z.infer<typeof BrDateQuerySchema>

const search = z.string().trim().min(1).max(120).optional()

/** 按 ASIN 的明细：层级、搜索、排序（白名单）、游标分页。 */
export const BrAsinQuerySchema = z.object({
  level: z.enum(BR_LEVELS, { error: '层级只能是 PARENT、CHILD、SKU' }).default('CHILD'),
  q: search,
  sort: sortSchema(BR_ASIN_SORTS, { field: 'orderedSales', dir: 'desc' }),
  ...CursorParamsSchema.shape,
})
export type BrAsinQuery = z.infer<typeof BrAsinQuerySchema>

/** 单个 ASIN 的逐日趋势：亚马逊 ASIN 都是 10 位字母数字。 */
export const BrTrendsQuerySchema = z.object({
  asin: z
    .string({ error: '需要提供 asin' })
    .trim()
    .regex(/^[A-Za-z0-9]{10}$/, { error: 'ASIN 应为 10 位字母或数字' })
    .transform(value => value.toUpperCase()),
})
export type BrTrendsQuery = z.infer<typeof BrTrendsQuerySchema>
