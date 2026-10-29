import { describe, expect, it } from 'vitest'
import { ADS_METRICS_DATASETS, ADS_METRICS_DATASET_KEYS, ADS_METRICS_DIMENSION_KEYS, ADS_METRICS_KEYS, type AdsMetricsRow } from './ads-metrics'
import { addSums, compareMetricRows, emptySums, metricValuesOf, metricsCsv, metricsRequestIssues, parseKeyList } from './ads-metrics-math'
import { AdsMetricsQuerySchema } from './ads-metrics-query'

const row = (key: string, values: AdsMetricsRow['values'], dims: AdsMetricsRow['dims'] = {}): AdsMetricsRow => ({ key, dims, values, link: null })

describe('广告指标：数据集定义', () => {
  it('每个数据集的维度、指标都在总目录里，默认选项在可选范围内，且至少有一个维度或指标', () => {
    for (const key of ADS_METRICS_DATASET_KEYS) {
      const dataset = ADS_METRICS_DATASETS[key]
      expect(dataset.key).toBe(key)
      for (const item of dataset.dimensions) expect(ADS_METRICS_DIMENSION_KEYS).toContain(item)
      for (const item of dataset.metrics) expect(ADS_METRICS_KEYS).toContain(item)
      for (const item of dataset.defaultDimensions) expect(dataset.dimensions).toContain(item)
      for (const item of dataset.defaultMetrics) expect(dataset.metrics).toContain(item)
      expect(dataset.metrics.length).toBeGreaterThan(0)
    }
  })

  it('小时数据集没有日期维度；转化商品只有件数与销售额', () => {
    expect(ADS_METRICS_DATASETS.HOURLY.hasDate).toBe(false)
    expect(ADS_METRICS_DATASETS.HOURLY.dimensions).toContain('hour')
    expect(ADS_METRICS_DATASETS.CONVERTED_PRODUCT.metrics).toEqual(['units', 'sales'])
  })
})

describe('广告指标：求和与派生指标', () => {
  it('求和跳过空值，全是空仍是空，不当 0', () => {
    const total = addSums([
      { impressions: 100, clicks: 10, spend: null, sales: null, orders: 1, units: null },
      { impressions: 50, clicks: 5, spend: 12.5, sales: null, orders: null, units: null },
    ])
    expect(total).toEqual({ impressions: 150, clicks: 15, spend: 12.5, sales: null, orders: 1, units: null })
    expect(addSums([])).toEqual(emptySums())
  })

  it('派生指标：分母为 0 或没有就是空；有值按公式算', () => {
    const values = metricValuesOf({ impressions: 1000, clicks: 50, spend: 25, sales: 100, orders: 5 }, ['ctr', 'cpc', 'cvr', 'acos', 'roas', 'spend'])
    expect(values.ctr).toBeCloseTo(0.05)
    expect(values.cpc).toBeCloseTo(0.5)
    expect(values.cvr).toBeCloseTo(0.1)
    expect(values.acos).toBeCloseTo(0.25)
    expect(values.roas).toBeCloseTo(4)
    expect(values.spend).toBe(25)
    const empty = metricValuesOf({ impressions: 0, clicks: 0, spend: 25, sales: null, orders: 0 }, ['ctr', 'cpc', 'acos', 'roas'])
    expect(empty).toEqual({ ctr: null, cpc: null, acos: null, roas: null })
    expect(metricValuesOf({ spend: 25, sales: 0 }, ['roas', 'acos'])).toEqual({ roas: 0, acos: null })
  })
})

describe('广告指标：请求检查', () => {
  it('逗号列表去重，并区分不认识的取值', () => {
    expect(parseKeyList('date, campaign,date,x', ADS_METRICS_DIMENSION_KEYS)).toEqual({ values: ['date', 'campaign'], invalid: ['x'] })
    expect(parseKeyList(undefined, ADS_METRICS_DIMENSION_KEYS)).toEqual({ values: [], invalid: [] })
  })

  it('合法组合没有问题；数据集不支持的维度、指标、广告产品筛选都给中文原因', () => {
    expect(metricsRequestIssues({ dataset: 'CAMPAIGN', dimensions: ['date', 'campaign'], metrics: ['spend', 'acos'] })).toEqual([])
    expect(metricsRequestIssues({ dataset: 'PLACEMENT', dimensions: ['searchTerm'], metrics: ['spend'] })[0]).toContain('不支持维度：搜索词')
    expect(metricsRequestIssues({ dataset: 'CONVERTED_PRODUCT', dimensions: [], metrics: ['acos'] })[0]).toContain('不支持指标：广告成本销售比')
    expect(metricsRequestIssues({ dataset: 'PLACEMENT', dimensions: [], metrics: ['spend'], adProduct: 'SPONSORED_PRODUCTS' })[0]).toContain('没有广告产品列')
    expect(metricsRequestIssues({ dataset: 'CAMPAIGN', dimensions: [], metrics: [] })).toContain('至少选一个指标')
    expect(metricsRequestIssues({ dataset: 'SEARCH_TERM', dimensions: ['date', 'adProduct', 'campaign', 'searchTerm'], metrics: ['spend'] })[0]).toContain('最多选 3 个维度')
    expect(metricsRequestIssues({ dataset: 'CAMPAIGN', dimensions: [], metrics: ['spend'], invalidMetrics: ['foo'] })[0]).toContain('foo')
  })
})

describe('广告指标：排序与导出', () => {
  it('按指标排序，空值永远在最后（升降序都一样），并列按行键稳定', () => {
    const rows = [row('b', { spend: 5 }), row('a', { spend: 5 }), row('c', { spend: null }), row('d', { spend: 9 })]
    expect([...rows].sort(compareMetricRows({ field: 'spend', dir: 'desc' })).map(item => item.key)).toEqual(['d', 'a', 'b', 'c'])
    expect([...rows].sort(compareMetricRows({ field: 'spend', dir: 'asc' })).map(item => item.key)).toEqual(['a', 'b', 'd', 'c'])
    expect([...rows].sort(compareMetricRows({ field: 'key', dir: 'desc' })).map(item => item.key)).toEqual(['d', 'c', 'b', 'a'])
  })

  it('CSV：中文表头、空值留空不写 0、含逗号与引号的文字加引号、公式开头加单引号', () => {
    const csv = metricsCsv([row('1', { spend: 12.5, sales: null }, { campaign: '=SUM(A1)' }), row('2', { spend: 0, sales: 3 }, { campaign: '春季, "新品"' })], ['campaign'], ['spend', 'sales'])
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('广告活动,花费,广告销售额')
    expect(lines[1]).toBe("'=SUM(A1),12.5,")
    expect(lines[2]).toBe('"春季, ""新品""",0,3')
  })
})

describe('广告指标：请求校验', () => {
  it('数据集、粒度、广告产品、排序字段按白名单；未知参数拒绝', () => {
    expect(AdsMetricsQuerySchema.safeParse({ dataset: 'CAMPAIGN', dims: 'date,campaign', metrics: 'spend,sales', grain: 'week', sort: 'acos:asc' }).success).toBe(true)
    expect(AdsMetricsQuerySchema.safeParse({ dataset: 'ORDERS' }).success).toBe(false)
    expect(AdsMetricsQuerySchema.safeParse({ grain: 'year' }).success).toBe(false)
    expect(AdsMetricsQuerySchema.safeParse({ sort: 'name:asc' }).success).toBe(false)
    expect(AdsMetricsQuerySchema.safeParse({ nope: '1' }).success).toBe(false)
  })
})
