import {
  ADS_METRICS_BASE_KEYS,
  ADS_METRICS_DATASETS,
  ADS_METRICS_DIMENSION_LABEL,
  ADS_METRICS_INFO,
  ADS_METRICS_LIMITS,
  type AdsMetricsBase,
  type AdsMetricsDatasetKey,
  type AdsMetricsDimension,
  type AdsMetricsKey,
  type AdsMetricsRow,
  type AdsMetricsValues,
} from './ads-metrics'
import { addNullable } from './ads-overview-math'

// 广告指标（自由分析）的纯函数（P3-15）：求和、派生指标、请求检查、排序、导出文字。API 与前端共用。
// 全部可空：来源没给的值是 null，求和时跳过空值（全是空仍是空），分母为 0 或没有时比率是 null，不编造“无穷大”。

export type AdsMetricsSums = Record<AdsMetricsBase, number | null>

export const emptySums = (): AdsMetricsSums => ({ impressions: null, clicks: null, spend: null, sales: null, orders: null, units: null })

export function addSums(items: ReadonlyArray<Partial<AdsMetricsSums>>): AdsMetricsSums {
  const result = emptySums()
  for (const key of ADS_METRICS_BASE_KEYS) result[key] = addNullable(items.map(item => item[key]))
  return result
}

const divide = (numerator: number | null, denominator: number | null): number | null => (numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator)

/** 把基础指标的和换成要显示的指标（基础指标原样，派生指标现算）。 */
export function metricValuesOf(sums: Partial<AdsMetricsSums>, wanted: readonly AdsMetricsKey[]): AdsMetricsValues {
  const value = (key: AdsMetricsKey): number | null => {
    switch (key) {
      case 'ctr':
        return divide(sums.clicks ?? null, sums.impressions ?? null)
      case 'cpc':
        return divide(sums.spend ?? null, sums.clicks ?? null)
      case 'cvr':
        return divide(sums.orders ?? null, sums.clicks ?? null)
      case 'acos':
        return divide(sums.spend ?? null, sums.sales ?? null)
      case 'roas':
        return divide(sums.sales ?? null, sums.spend ?? null)
      default:
        return sums[key] ?? null
    }
  }
  return Object.fromEntries(wanted.map(key => [key, value(key)])) as AdsMetricsValues
}

/** 逗号分隔的参数 → 去重后的取值与不认识的取值。 */
export function parseKeyList<T extends string>(raw: string | undefined, allowed: readonly T[]): { values: T[]; invalid: string[] } {
  const values: T[] = []
  const invalid: string[] = []
  for (const part of (raw ?? '').split(',')) {
    const item = part.trim()
    if (!item) continue
    if ((allowed as readonly string[]).includes(item)) {
      if (!values.includes(item as T)) values.push(item as T)
    } else if (!invalid.includes(item)) invalid.push(item)
  }
  return { values, invalid }
}

/** 检查维度与指标的组合：返回给用户看的中文原因，空数组表示可以查询。 */
export function metricsRequestIssues(input: {
  dataset: AdsMetricsDatasetKey
  dimensions: readonly string[]
  metrics: readonly string[]
  invalidDimensions?: readonly string[]
  invalidMetrics?: readonly string[]
  adProduct?: string
}): string[] {
  const info = ADS_METRICS_DATASETS[input.dataset]
  const issues: string[] = []
  if (input.invalidDimensions?.length) issues.push(`数据集“${info.label}”不支持维度：${input.invalidDimensions.join('、')}`)
  const unsupportedDimension = input.dimensions.filter(item => !(info.dimensions as readonly string[]).includes(item))
  if (unsupportedDimension.length) issues.push(`数据集“${info.label}”不支持维度：${unsupportedDimension.map(item => ADS_METRICS_DIMENSION_LABEL[item as AdsMetricsDimension] ?? item).join('、')}`)
  if (input.dimensions.length > ADS_METRICS_LIMITS.maxDimensions) issues.push(`一次最多选 ${ADS_METRICS_LIMITS.maxDimensions} 个维度`)
  if (input.invalidMetrics?.length) issues.push(`数据集“${info.label}”不支持指标：${input.invalidMetrics.join('、')}`)
  const unsupportedMetric = input.metrics.filter(item => !(info.metrics as readonly string[]).includes(item))
  if (unsupportedMetric.length) issues.push(`数据集“${info.label}”不支持指标：${unsupportedMetric.map(item => ADS_METRICS_INFO[item as AdsMetricsKey]?.label ?? item).join('、')}`)
  if (input.metrics.length === 0) issues.push('至少选一个指标')
  if (input.metrics.length > ADS_METRICS_LIMITS.maxMetrics) issues.push(`一次最多选 ${ADS_METRICS_LIMITS.maxMetrics} 个指标`)
  if (input.adProduct && !info.hasAdProduct) issues.push(`数据集“${info.label}”没有广告产品列，不能按广告产品筛选`)
  return issues
}

/** 按指标（或行键）排序：空值永远排最后，并列按行键稳定。 */
export function compareMetricRows(sort: { field: string; dir: 'asc' | 'desc' }) {
  const sign = sort.dir === 'asc' ? 1 : -1
  return (a: AdsMetricsRow, b: AdsMetricsRow): number => {
    if (sort.field !== 'key') {
      const left = a.values[sort.field as AdsMetricsKey] ?? null
      const right = b.values[sort.field as AdsMetricsKey] ?? null
      if (left === null && right !== null) return 1
      if (left !== null && right === null) return -1
      if (left !== null && right !== null && left !== right) return (left - right) * sign
    } else if (a.key !== b.key) return (a.key < b.key ? -1 : 1) * sign
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  }
}

const csvCell = (text: string) => (/[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text)
/** 文字单元格以公式字符开头时前面补一个单引号，免得表格软件当公式执行。 */
const safeText = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text)

/** 导出当前结果的 CSV（表头中文，指标取原始数值，空值留空，不写 0）。不含 BOM，由调用方决定。 */
export function metricsCsv(rows: readonly AdsMetricsRow[], dimensions: readonly AdsMetricsDimension[], metrics: readonly AdsMetricsKey[]): string {
  const header = [...dimensions.map(key => ADS_METRICS_DIMENSION_LABEL[key]), ...metrics.map(key => ADS_METRICS_INFO[key].label)].map(csvCell).join(',')
  const lines = rows.slice(0, ADS_METRICS_LIMITS.exportRows).map(row =>
    [
      ...dimensions.map(key => csvCell(safeText(row.dims[key] ?? ''))),
      ...metrics.map(key => {
        const value = row.values[key]
        return value === null || value === undefined ? '' : String(Math.round(value * 1e6) / 1e6)
      }),
    ].join(','),
  )
  return [header, ...lines].join('\r\n')
}
