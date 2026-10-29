import type { EChartsOption, SeriesOption } from 'echarts'
import { TREND_METRIC_LABEL, type TrendPoint, type TrendResponse } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 趋势图的图表配置（纯函数）：主指标、环比线、同比线、净利润第二轴。
// 没有数据的点保持为空（图上断开），不补成 0。

const values = (points: readonly TrendPoint[] | null | undefined) => (points ?? []).map(point => point.value)

export type TrendLines = { previous: boolean; yoy: boolean }

export function buildTrendOption(data: TrendResponse, lines: TrendLines): EChartsOption {
  const label = TREND_METRIC_LABEL[data.metric]
  const money = data.unit === 'money'
  const format = (value: number) => (money ? formatMoney(value, 'USD', { digits: 2 }) : formatNumber(value, { digits: 0 }))
  const axis = (value: number) => (money ? formatMoney(value, 'USD', { digits: 0, compact: true }) : formatNumber(value, { compact: true }))
  const profitPoints = data.profit.state === 'OK' ? data.profit.points : null
  const series: SeriesOption[] = [
    {
      name: label,
      type: data.granularity === 'day' ? 'line' : 'bar',
      data: values(data.points),
      connectNulls: false,
      showSymbol: data.points.length <= 45,
      tooltip: { valueFormatter: v => format(Number(v)) },
    },
  ]
  if (lines.previous && data.previous)
    series.push({ name: '上一期', type: 'line', data: values(data.previous), showSymbol: false, lineStyle: { type: 'dashed' }, tooltip: { valueFormatter: v => format(Number(v)) } })
  if (lines.yoy && data.yoy)
    series.push({ name: '去年同期', type: 'line', data: values(data.yoy), showSymbol: false, lineStyle: { type: 'dotted' }, tooltip: { valueFormatter: v => format(Number(v)) } })
  if (profitPoints)
    series.push({
      name: TREND_METRIC_LABEL.profit,
      type: 'line',
      yAxisIndex: 1,
      data: values(profitPoints),
      showSymbol: false,
      tooltip: { valueFormatter: v => formatMoney(Number(v), 'USD', { digits: 2 }) },
    })
  return {
    tooltip: { trigger: 'axis' },
    legend: { top: 0 },
    grid: { left: 56, right: profitPoints ? 56 : 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: data.points.map(point => point.key) },
    yAxis: profitPoints
      ? [
          { type: 'value', axisLabel: { formatter: axis } },
          { type: 'value', axisLabel: { formatter: (value: number) => formatMoney(value, 'USD', { digits: 0, compact: true }) }, splitLine: { show: false } },
        ]
      : [{ type: 'value', axisLabel: { formatter: axis } }],
    series,
  }
}
