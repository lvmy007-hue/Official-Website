import type { z } from 'zod'
import { ADS_PORTFOLIO_PACES, ADS_PORTFOLIO_SORTS } from './ads-portfolios'
import { cursorListQuery } from './query'

// 广告组合列表的请求校验（P3-11）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。

/** 列表：范围参数加筛选；`q` 匹配组合名称；`pace` 按节奏判断筛选；排序字段白名单。 */
export const AdsPortfolioListQuerySchema = cursorListQuery({
  sortable: ADS_PORTFOLIO_SORTS,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    pace: { type: 'enum', values: ADS_PORTFOLIO_PACES },
  },
})
export type AdsPortfolioListQuery = z.infer<typeof AdsPortfolioListQuerySchema>
