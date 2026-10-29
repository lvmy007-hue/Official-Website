import { ADS_METRICS_DATASETS, ADS_METRICS_LIMITS, type AdsMetricsDatasetKey, type AdsMetricsDimension, type AdsMetricsKey, type AdsReportAdProduct } from '@nova/api-contracts'
import type { DashGranularity } from '@nova/api-contracts'

// 广告指标页的筛选状态（P3-15）：数据集决定能选的维度与指标；换数据集就回到该数据集的默认组合，已选的不跨数据集保留。

export type MetricsState = {
  dataset: AdsMetricsDatasetKey
  dims: AdsMetricsDimension[]
  metrics: AdsMetricsKey[]
  grain: DashGranularity
  adProduct?: AdsReportAdProduct
  adsProfileId?: string
  /** 不设置时由服务端按默认排序（花费从高到低，没选花费就取第一个指标）。 */
  sortField?: 'key' | AdsMetricsKey
  sortDir: 'asc' | 'desc'
  pageSize: number
}

export const initialState = (dataset: AdsMetricsDatasetKey = 'CAMPAIGN'): MetricsState => {
  const spec = ADS_METRICS_DATASETS[dataset]
  return { dataset, dims: [...spec.defaultDimensions], metrics: [...spec.defaultMetrics], grain: 'day', sortDir: 'desc', pageSize: 50 }
}

/** 换数据集：维度、指标回到默认，产品筛选在没有产品列的数据集里去掉；档案筛选保留。 */
export const withDataset = (state: MetricsState, dataset: AdsMetricsDatasetKey): MetricsState => ({
  ...initialState(dataset),
  adsProfileId: state.adsProfileId,
  adProduct: ADS_METRICS_DATASETS[dataset].hasAdProduct ? state.adProduct : undefined,
  pageSize: state.pageSize,
})

/** 排序字段必须是“名称”或已选指标；取消选择了正在排序的指标时回到默认排序。 */
export const sortStillValid = (state: MetricsState) => state.sortField === undefined || state.sortField === 'key' || state.metrics.includes(state.sortField)

export function paramsOf(state: MetricsState): Record<string, string | number | undefined> {
  const spec = ADS_METRICS_DATASETS[state.dataset]
  return {
    dataset: state.dataset,
    dims: state.dims.length > 0 ? state.dims.join(',') : 'none',
    metrics: state.metrics.join(','),
    grain: state.dims.includes('date') ? state.grain : undefined,
    adProduct: spec.hasAdProduct ? state.adProduct : undefined,
    adsProfileId: state.adsProfileId,
    sort: state.sortField ? `${state.sortField}:${state.sortDir}` : undefined,
    pageSize: state.pageSize,
  }
}

export const LIMIT_TEXT = `最多选 ${ADS_METRICS_LIMITS.maxDimensions} 个维度、${ADS_METRICS_LIMITS.maxMetrics} 个指标`
