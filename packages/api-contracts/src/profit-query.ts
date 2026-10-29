import { z } from 'zod'
import { PROFIT_BASES } from './profit.js'
import { PROFIT_DIMENSIONS, PROFIT_SORTS } from './profit-view.js'
import { CursorParamsSchema, sortSchema } from './query.js'

// 利润分析页的请求校验（P2b-10）。全局范围参数（店铺、日期、对比期）由 ScopeSearchSchema 校验，这里只校验本页自己的参数。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

const recognition = z.enum(PROFIT_BASES, { error: '收入确认口径只能是 ORDERED、SHIPPED、SETTLED' }).default('ORDERED')

/** 总览、店铺利润、利润桥对比：只有收入确认口径。 */
export const ProfitQuerySchema = z.object({ recognition })
export type ProfitQuery = z.infer<typeof ProfitQuerySchema>

const search = z.string().trim().min(1).max(120).optional()

/** 按 ASIN、SKU、父体看的列表与广告利润列表：游标分页，排序字段白名单。 */
export const ProfitGroupsQuerySchema = z.object({
  recognition,
  by: z.enum(PROFIT_DIMENSIONS).default('SKU'),
  q: search,
  sort: sortSchema(PROFIT_SORTS, { field: 'revenue', dir: 'desc' }),
  ...CursorParamsSchema.shape,
})
export type ProfitGroupsQuery = z.infer<typeof ProfitGroupsQuerySchema>

/** 成本覆盖：只看有问题的 SKU，可按店铺范围、关键字筛选。 */
export const ProfitCoverageQuerySchema = z.object({
  recognition,
  q: search,
  ...CursorParamsSchema.shape,
})
export type ProfitCoverageQuery = z.infer<typeof ProfitCoverageQuerySchema>
