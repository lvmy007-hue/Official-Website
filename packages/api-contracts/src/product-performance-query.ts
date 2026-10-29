import { z } from 'zod'
import { PP_DIMENSIONS, PP_IDS_MAX, PP_METRIC_KEYS, PP_PAGE_SIZE_MAX, PP_SORT_FIELDS, PP_TREND_METRICS } from './product-performance.js'

// 商品表现宽表的请求校验（P6-22）：POST 请求体。全局范围参数（店铺、日期、对比期）在地址栏，由 ScopeSearchSchema 校验。
// 单独成文件：zod 校验不能进前端首屏（见 PROGRESS.md 的 sideEffects 一条）。

const word = z.string().trim().min(1).max(120)
const dimension = z.enum(PP_DIMENSIONS, { error: '维度只能是 asin、parentAsin、sku、store、owner、brand、category' }).default('asin')
const ASIN_TEXT = /^[A-Za-z0-9]{10}$/

/** 筛选：所有接口共用（查询、汇总），决定“哪些行”。 */
const filterShape = {
  dimension,
  /** 展开父 ASIN：只列这个父体下的子体（只和 asin 维度一起用）。 */
  parentAsin: z
    .string()
    .trim()
    .regex(ASIN_TEXT, { error: '父 ASIN 应为 10 位字母或数字' })
    .transform(value => value.toUpperCase())
    .optional(),
  q: word.optional(),
  brand: word.optional(),
  category: word.optional(),
  owner: word.optional(),
}

const metricList = z
  .array(z.enum(PP_METRIC_KEYS as [string, ...string[]], { error: '指标键不在可选列表里' }))
  .max(PP_METRIC_KEYS.length)
  .optional()

export const ProductPerformanceQuerySchema = z
  .object({
    ...filterShape,
    /** 只取这些指标（可见列）；不给就取全部有权限的。 */
    metrics: metricList,
    sort: z
      .object({
        field: z.enum(PP_SORT_FIELDS as [string, ...string[]], { error: '这一列不支持排序' }),
        direction: z.enum(['asc', 'desc'], { error: '排序方向只能是 asc 或 desc' }),
      })
      .default({ field: 'sales', direction: 'desc' }),
    page: z.number({ error: '页码应为整数' }).int().min(1).max(10_000).default(1),
    pageSize: z.number({ error: '每页条数应为整数' }).int().min(1).max(PP_PAGE_SIZE_MAX).default(50),
  })
  .refine(value => value.parentAsin === undefined || value.dimension === 'asin', { message: '展开父 ASIN 只能在 ASIN 维度下使用', path: ['parentAsin'] })
export type ProductPerformanceQuery = z.infer<typeof ProductPerformanceQuerySchema>

export const ProductPerformanceSummarySchema = z
  .object({ ...filterShape, metrics: metricList })
  .refine(value => value.parentAsin === undefined || value.dimension === 'asin', { message: '展开父 ASIN 只能在 ASIN 维度下使用', path: ['parentAsin'] })
export type ProductPerformanceSummaryQuery = z.infer<typeof ProductPerformanceSummarySchema>

const ids = z
  .array(z.string().trim().min(3).max(300))
  .min(1, { error: '至少要给一个行编号' })
  .max(PP_IDS_MAX, { error: `一次最多取 ${PP_IDS_MAX} 行` })

export const ProductPerformanceTrendSchema = z.object({
  dimension,
  ids,
  metric: z.enum(PP_TREND_METRICS, { error: '趋势指标只能是 sales、units、sessions、adSpend' }).default('sales'),
})
export type ProductPerformanceTrendQuery = z.infer<typeof ProductPerformanceTrendSchema>

export const ProductPerformanceAsyncSchema = z.object({ dimension, ids, metrics: metricList })
export type ProductPerformanceAsyncQuery = z.infer<typeof ProductPerformanceAsyncSchema>
