import type { z } from 'zod'
import { ADS_AD_GROUP_SORTS, ADS_LEVEL_FILTERS } from './ads-levels'
import { cursorListQuery } from './query'

// 广告组列表的请求校验（P6-23）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** GET /ads/ad-groups：范围参数加名称搜索、状态、广告组合、指标区间与分类筛选；排序字段白名单。 */
export const AdsAdGroupListQuerySchema = cursorListQuery({
  sortable: ADS_AD_GROUP_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    state: { type: 'text', max: 40 },
    portfolioId: { type: 'text', max: 64 },
    campaignId: { type: 'text', max: 64 },
    ...ADS_LEVEL_FILTERS,
  },
})
export type AdsAdGroupListQuery = z.infer<typeof AdsAdGroupListQuerySchema>
