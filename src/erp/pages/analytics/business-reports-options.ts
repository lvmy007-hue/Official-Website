import type { EChartsOption } from 'echarts'
import { BR_METRIC_INFO, type BrMetricKey, type BrPoint } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 业务报告页的图表配置（纯函数）：主指标（柱，左轴）与可选的次指标（线，右轴）逐日或逐期对比，可叠加对比期。
// 某天没有记录或官方没给值是 null：柱缺失、线断开，不画成 0；提示框里写“尚无记录”。

const PRIMARY = '#4c6ef5'
const SECONDARY = '#f08c00'
const COMPARE = '#adb5bd'

export const METRIC_CHOICES = (Object.keys(BR_METRIC_INFO) as BrMetricKey[]).map(key => ({ value: key, label: BR_METRIC_INFO[key].label }))

export const metricOf = (point: BrPoint, key: BrMetricKey): number | null => point[key]

/** 按指标的格式把数字显示成文字：金额两位、件数整数、比率一位百分比。 */
export function formatMetric(key: BrMetricKey, value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined) return '尚无记录'
  const info = BR_METRIC_INFO[key]
  if (info.format === 'money') return formatMoney(value, 'USD', { digits: options.compact ? 0 : 2, compact: options.compact })
  if (info.format === 'percent') return formatPercent(value, { digits: options.compact ? 1 : 2 })
  return formatNumber(value, { digits: 0, compact: options.compact })
}

export interface TrendInput {
  primary: BrMetricKey
  secondary: BrMetricKey | null
  points: readonly BrPoint[]
  /** 对比期的点，按位置与本期逐个对齐（只对主指标画）。 */
  comparePoints?: readonly BrPoint[] | null
  /** 周、月粒度时横轴写的是该周或该月的起始日。 */
  dateLabel?: (date: string) => string
}

export function buildTrendOption(input: TrendInput): EChartsOption {
  const { primary, secondary, points, comparePoints } = input
  const label = input.dateLabel ?? ((date: string) => date)
  const primaryInfo = BR_METRIC_INFO[primary]
  const hasSecondary = secondary !== null && secondary !== primary
  const compare = comparePoints && comparePoints.length > 0 ? comparePoints : null
  const axis = (key: BrMetricKey) => ({ type: 'value' as const, axisLabel: { formatter: (value: number) => formatMetric(key, value, { compact: true }) } })
  const series: NonNullable<EChartsOption['series']> = [
    {
      name: primaryInfo.label,
      type: 'bar',
      itemStyle: { color: PRIMARY },
      data: points.map(point => metricOf(point, primary)),
      tooltip: { valueFormatter: (value: unknown) => formatMetric(primary, typeof value === 'number' ? value : null) },
    },
  ]
  if (compare) {
    series.push({
      name: `对比期：${primaryInfo.label}`,
      type: 'line',
      connectNulls: false,
      lineStyle: { type: 'dashed', color: COMPARE },
      itemStyle: { color: COMPARE },
      data: points.map((_, index) => (compare[index] ? metricOf(compare[index]!, primary) : null)),
      tooltip: { valueFormatter: (value: unknown) => formatMetric(primary, typeof value === 'number' ? value : null) },
    })
  }
  if (hasSecondary) {
    series.push({
      name: BR_METRIC_INFO[secondary!].label,
      type: 'line',
      yAxisIndex: 1,
      connectNulls: false,
      itemStyle: { color: SECONDARY },
      data: points.map(point => metricOf(point, secondary!)),
      tooltip: { valueFormatter: (value: unknown) => formatMetric(secondary!, typeof value === 'number' ? value : null) },
    })
  }
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 64, right: hasSecondary ? 64 : 16, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: points.map(point => label(point.date)) },
    yAxis: hasSecondary ? [axis(primary), { ...axis(secondary!), splitLine: { show: false } }] : [axis(primary)],
    series,
  }
}
