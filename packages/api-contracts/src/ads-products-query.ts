import type { z } from 'zod'
import { ADS_LEVEL_FILTERS } from './ads-levels'
import { ADS_ASIN_SORTS, ADS_ASIN_STOCKS } from './ads-products'
import { cursorListQuery } from './query'

// 广告商品页的请求校验（P3-09）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** 列表：范围参数加筛选；`q` 匹配 ASIN 或商品名称；`stock` 按库存状态筛选；排序字段白名单。 */
export const AdsAsinListQuerySchema = cursorListQuery({
  sortable: ADS_ASIN_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    stock: { type: 'enum', values: ADS_ASIN_STOCKS },
    ...ADS_LEVEL_FILTERS,
  },
})
export type AdsAsinListQuery = z.infer<typeof AdsAsinListQuerySchema>
