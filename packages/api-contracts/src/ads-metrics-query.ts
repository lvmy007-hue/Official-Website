import type { z } from 'zod'
import { ADS_METRICS_DATASET_KEYS } from './ads-metrics'
import { ADS_REPORT_AD_PRODUCTS } from './ads-reports'
import { DASH_GRANULARITIES } from './dashboard'
import { cursorListQuery } from './query'

// 广告指标（自由分析）的请求校验（P3-15）。单独成文件：zod 构造是顶层调用，不要和前端首屏要用的常量放在一起（见 PROGRESS 的 sideEffects 一条）。
// 维度与指标是逗号分隔的键；它们能不能用在所选数据集上，由 metricsRequestIssues 检查（不合法返回 422）；dims=none 表示不分组（只看合计一行）。

export const AdsMetricsQuerySchema = cursorListQuery({
  sortable: ['key', 'impressions', 'clicks', 'spend', 'sales', 'orders', 'units', 'ctr', 'cpc', 'cvr', 'acos', 'roas'] as const,
  defaultSort: { field: 'spend', dir: 'desc' },
  filters: {
    dataset: { type: 'enum', values: ADS_METRICS_DATASET_KEYS },
    dims: { type: 'text', max: 200 },
    metrics: { type: 'text', max: 200 },
    grain: { type: 'enum', values: DASH_GRANULARITIES },
    adProduct: { type: 'enum', values: ADS_REPORT_AD_PRODUCTS },
    adsProfileId: { type: 'text', max: 64 },
  },
})
export type AdsMetricsQuery = z.infer<typeof AdsMetricsQuerySchema>
