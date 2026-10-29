import type { EChartsOption } from 'echarts'
import { ADS_METRICS_INFO, ADS_METRICS_LIMITS, type AdsMetricsDimension, type AdsMetricsKey, type AdsMetricsRow } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 广告指标页的纯函数（P3-15）：指标取值的显示、图表配置。空值显示“—”，图上断开，都不补成 0。

export const EMPTY_TEXT = '—'

export function metricText(key: AdsMetricsKey, value: number | null | undefined): string {
  if (value === null || value === undefined) return EMPTY_TEXT
  switch (ADS_METRICS_INFO[key].format) {
    case 'money':
      return formatMoney(value, 'USD', { digits: 2 })
    case 'percent':
      return formatPercent(value, { digits: 2 })
    case 'ratio':
      return formatNumber(value, { digits: 2 })
    default:
      return formatNumber(value, { digits: 0 })
  }
}

const TIME_DIMENSIONS: readonly AdsMetricsDimension[] = ['date', 'hour']
const TOTAL_NAME = '合计'

/** 一行的名称：各维度显示值连接起来，没有维度时是“合计”。 */
export const rowName = (row: AdsMetricsRow, dimensions: readonly AdsMetricsDimension[]) => (dimensions.length === 0 ? TOTAL_NAME : dimensions.map(key => row.dims[key] ?? EMPTY_TEXT).join(' / '))

export type ChartPlan =
  | { kind: 'line'; time: AdsMetricsDimension; categories: string[]; series: Array<{ name: string; data: Array<number | null> }> }
  | { kind: 'bar'; categories: string[]; data: Array<number | null> }
  | null

/**
 * 图表数据：有日期或小时维度时按时间画折线，其余维度组合成系列（最多 compareMax 条，按图表指标的合计从大到小取，空值排最后）；
 * 没有时间维度时画条形图（选中的行优先，最多 compareMax 条；没选就取前 10 行）。只用当前页已有的行，不补缺口。
 */
export function planChart(rows: readonly AdsMetricsRow[], dimensions: readonly AdsMetricsDimension[], metric: AdsMetricsKey, selected: readonly string[]): ChartPlan {
  if (rows.length === 0) return null
  const time = dimensions.find(key => TIME_DIMENSIONS.includes(key))
  const valueOf = (row: AdsMetricsRow) => row.values[metric] ?? null
  if (!time) {
    const chosen = selected.length > 0 ? rows.filter(row => selected.includes(row.key)).slice(0, ADS_METRICS_LIMITS.compareMax) : rows.slice(0, 10)
    return chosen.length === 0 ? null : { kind: 'bar', categories: chosen.map(row => rowName(row, dimensions)), data: chosen.map(valueOf) }
  }
  const others = dimensions.filter(key => key !== time)
  const categories = [...new Set(rows.map(row => row.dims[time] ?? EMPTY_TEXT))].sort()
  const groups = new Map<string, Map<string, number | null>>()
  for (const row of rows) {
    const name = others.length === 0 ? TOTAL_NAME : others.map(key => row.dims[key] ?? EMPTY_TEXT).join(' / ')
    const bucket = groups.get(name) ?? new Map<string, number | null>()
    bucket.set(row.dims[time] ?? EMPTY_TEXT, valueOf(row))
    groups.set(name, bucket)
  }
  const total = (bucket: Map<string, number | null>) => [...bucket.values()].reduce<number | null>((sum, value) => (value === null ? sum : (sum ?? 0) + value), null)
  const ordered = [...groups.entries()].sort(([, a], [, b]) => (total(b) ?? -Infinity) - (total(a) ?? -Infinity)).slice(0, ADS_METRICS_LIMITS.compareMax)
  return { kind: 'line', time, categories, series: ordered.map(([name, bucket]) => ({ name, data: categories.map(category => bucket.get(category) ?? null) })) }
}

export function chartOption(plan: Exclude<ChartPlan, null>, metric: AdsMetricsKey): EChartsOption {
  const label = ADS_METRICS_INFO[metric].label
  const valueFormatter = (value: unknown) => metricText(metric, typeof value === 'number' ? value : null)
  const axis = { type: 'value' as const, axisLabel: { formatter: (value: number) => metricText(metric, value) } }
  if (plan.kind === 'bar') {
    return {
      tooltip: { trigger: 'axis', valueFormatter },
      grid: { left: 64, right: 24, top: 24, bottom: 48 },
      xAxis: { type: 'category', data: plan.categories, axisLabel: { interval: 0, width: 90, overflow: 'truncate' } },
      yAxis: axis,
      series: [{ name: label, type: 'bar', data: plan.data }],
    }
  }
  return {
    tooltip: { trigger: 'axis', valueFormatter },
    legend: { top: 0 },
    grid: { left: 64, right: 24, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: plan.categories },
    yAxis: axis,
    series: plan.series.map(item => ({ name: item.name === TOTAL_NAME ? label : item.name, type: 'line' as const, data: item.data, connectNulls: false, showSymbol: plan.categories.length < 40 })),
  }
}
