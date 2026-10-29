import { z } from 'zod'
import { BR_GRANULARITIES } from './business-reports.js'
import { PageParamsSchema, sortSchema } from './query.js'
import { AW_DEFAULT_SORT, AW_SORT_FIELDS, MV_DEFAULT_SORT, MV_SORT_FIELDS, SS_DEFAULT_SORT, SS_DIMENSIONS, SS_METRICS, SS_SORT_FIELDS } from './stock-reports.js'

// 销量统计、跨仓总览、进销存报表的请求校验（P6-25）。全局范围参数（店铺、日期）由 ScopeSearchSchema 校验，这里只校验本页自己的参数；
// 不用 .strict()：地址栏上的范围参数原样带过。单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

const search = z.string().trim().min(1).max(120).optional()
const flag = z
  .enum(['true', 'false'], { error: '只能是 true 或 false' })
  .optional()
  .transform(value => value === 'true')

export const SalesStatQuerySchema = z.object({
  ...PageParamsSchema.shape,
  dimension: z.enum(SS_DIMENSIONS, { error: '维度只能是 asin、parentAsin、sku、store、owner' }).default('asin'),
  granularity: z.enum(BR_GRANULARITIES, { error: '粒度只能是 DAY、WEEK、MONTH' }).default('DAY'),
  metric: z.enum(SS_METRICS, { error: '指标只能是 units、sales' }).default('units'),
  q: search,
  sort: sortSchema(SS_SORT_FIELDS, SS_DEFAULT_SORT),
})
export type SalesStatQuery = z.infer<typeof SalesStatQuerySchema>

export const AllWarehousesQuerySchema = z.object({
  ...PageParamsSchema.shape,
  q: search,
  sort: sortSchema(AW_SORT_FIELDS, AW_DEFAULT_SORT),
})
export type AllWarehousesQuery = z.infer<typeof AllWarehousesQuerySchema>

export const MovementQuerySchema = z.object({
  ...PageParamsSchema.shape,
  q: search,
  unbalanced: flag,
  sort: sortSchema(MV_SORT_FIELDS, MV_DEFAULT_SORT),
})
export type MovementQuery = z.infer<typeof MovementQuerySchema>
