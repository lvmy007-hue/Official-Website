import type { EChartsOption } from 'echarts'
import { ASIN_METRIC_INFO, ASIN_METRIC_KEYS, type AsinMetricKey, type AsinSelection, type InventoryRiskLevel, type ParentTrendResponse, type TrafficRow } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// ASIN 与父体分析的图表配置与数值显示（纯函数）。某天没有记录是 null：线断开、柱缺失，不画成 0；提示框里写“尚无记录”。

export const ASIN_METRIC_CHOICES = ASIN_METRIC_KEYS.map(key => ({ value: key, label: ASIN_METRIC_INFO[key].label }))

const PALETTE = ['#4c6ef5', '#f08c00', '#12b886', '#e64980', '#7950f2', '#15aabf', '#fa5252', '#82c91e', '#868e96', '#fab005']

/** 按指标的格式把数字显示成文字：金额两位、比率一位百分比、天数一位小数、排名带 # 号；没有值写“尚无记录”。 */
export function formatAsin(key: AsinMetricKey, value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined) return '尚无记录'
  const { format } = ASIN_METRIC_INFO[key]
  if (format === 'money') return formatMoney(value, 'USD', { digits: options.compact ? 0 : 2, compact: options.compact })
  if (format === 'percent') return formatPercent(value, { digits: options.compact ? 1 : 2 })
  if (format === 'days') return `${formatNumber(value, { digits: 1 })} 天`
  if (format === 'rank') return `#${formatNumber(value, { digits: 0 })}`
  return formatNumber(value, { digits: 0, compact: options.compact })
}

const tip = (key: AsinMetricKey) => ({ valueFormatter: (value: unknown) => formatAsin(key, typeof value === 'number' ? value : null) })
const axis = (key: AsinMetricKey) => ({ type: 'value' as const, axisLabel: { formatter: (value: number) => formatAsin(key, value, { compact: true }) } })
const pointsOf = (selection: AsinSelection, key: AsinMetricKey) => selection.points.map(point => point[key])
const nameOf = (selection: AsinSelection) => (selection.kind === 'parent' ? `父体 ${selection.asin}` : selection.asin)

/** 选中对象的趋势：只选一个对象时主指标画柱、次指标画线（右轴）；对比模式（多个对象）每个对象一条线，只对比主指标。 */
export function buildSelectionOption(selections: readonly AsinSelection[], primary: AsinMetricKey, secondary: AsinMetricKey | null): EChartsOption {
  const first = selections[0]
  const dates = first ? first.points.map(point => point.date) : []
  const single = selections.length === 1 && secondary !== null && secondary !== primary
  const series: NonNullable<EChartsOption['series']> = single
    ? [
        { name: ASIN_METRIC_INFO[primary].label, type: 'bar', itemStyle: { color: PALETTE[0] }, data: pointsOf(first!, primary), tooltip: tip(primary) },
        { name: ASIN_METRIC_INFO[secondary!].label, type: 'line', yAxisIndex: 1, connectNulls: false, itemStyle: { color: PALETTE[1] }, data: pointsOf(first!, secondary!), tooltip: tip(secondary!) },
      ]
    : selections.map((selection, index) => ({
        name: nameOf(selection),
        type: 'line' as const,
        connectNulls: false,
        itemStyle: { color: PALETTE[index % PALETTE.length] },
        data: pointsOf(selection, primary),
        tooltip: tip(primary),
      }))
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 64, right: single ? 64 : 16, top: 32, bottom: 32 },
    xAxis: { type: 'category', data: dates },
    yAxis: single ? [axis(primary), { ...axis(secondary!), splitLine: { show: false } }] : [axis(primary)],
    series,
  }
}

export type TrendField = 'sales' | 'sessions' | 'units'
export const TREND_FIELD_CHOICES: Array<{ value: TrendField; label: string }> = [
  { value: 'sales', label: '销售额' },
  { value: 'sessions', label: '会话数' },
  { value: 'units', label: '订购件数' },
]
const FIELD_METRIC: Record<TrendField, AsinMetricKey> = { sales: 'sales', sessions: 'sessions', units: 'units' }

/** 子体趋势：各子体堆叠柱（销售额最高的前几个，其余合并成“其他”）；没有记录的日子不画。 */
export function buildParentTrendOption(data: ParentTrendResponse, field: TrendField): EChartsOption {
  const metric = FIELD_METRIC[field]
  const series: NonNullable<EChartsOption['series']> = data.series.map((item, index) => ({
    name: item.asin,
    type: 'bar' as const,
    stack: 'children',
    itemStyle: { color: PALETTE[index % PALETTE.length] },
    data: item[field],
    tooltip: tip(metric),
  }))
  if (data.others) series.push({ name: `其他 ${data.others.count} 个`, type: 'bar', stack: 'children', itemStyle: { color: '#ced4da' }, data: data.others[field], tooltip: tip(metric) })
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0, type: 'scroll' },
    grid: { left: 64, right: 16, top: 40, bottom: 32 },
    xAxis: { type: 'category', data: data.dates },
    yAxis: [axis(metric)],
    series,
  }
}

/** 流量占比：各子体会话占比从高到低（最多 15 个），横向柱。 */
export function buildTrafficOption(rows: readonly TrafficRow[]): EChartsOption {
  const shown = rows.filter(row => row.share !== null).slice(0, 15)
  const percent = (value: unknown) => formatPercent(typeof value === 'number' ? value : 0, { digits: 1 })
  return {
    tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
    grid: { left: 110, right: 24, top: 12, bottom: 24 },
    xAxis: { type: 'value', axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) } },
    yAxis: { type: 'category', inverse: true, data: shown.map(row => row.asin) },
    series: [{ name: '会话占比', type: 'bar', itemStyle: { color: PALETTE[0] }, data: shown.map(row => row.share), tooltip: { valueFormatter: percent } }],
  }
}

/** 贡献矩阵配色：数值越大底色越深；没有值不上色。 */
export function heatColor(value: number | null, scale: { min: number; max: number } | null): string | undefined {
  if (value === null || scale === null) return undefined
  const span = scale.max - scale.min
  const level = span <= 0 ? 0.5 : (value - scale.min) / span
  return `rgba(76, 110, 245, ${(0.08 + level * 0.5).toFixed(2)})`
}

export const RISK_COLOR: Record<InventoryRiskLevel, string> = { HIGH: 'error', MEDIUM: 'warning', EXCESS: 'purple', NORMAL: 'success' }
