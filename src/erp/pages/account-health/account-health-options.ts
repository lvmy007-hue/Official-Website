import type { EChartsOption } from 'echarts'
import { formatHealthValue, type HealthTrendPoint, type HealthTrendSeries } from '@nova/api-contracts'

// 账户健康的图表配置（纯函数）：账户健康评级趋势、订单缺陷率趋势。
// 横轴是快照日期（每天一份），没有快照的日子不补点；比率按百分比显示，计数原样。

export function buildRatingTrendOption(points: readonly HealthTrendPoint[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatHealthValue(value, 'COUNT') : '尚无记录') },
    grid: { left: 56, right: 24, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: { type: 'value', scale: true },
    series: [{ name: '账户健康评级', type: 'line' as const, connectNulls: false, showSymbol: points.length <= 60, data: points.map(point => point.value) }],
  }
}

export function buildDefectTrendOption(series: readonly HealthTrendSeries[]): EChartsOption {
  const dates = [...new Set(series.flatMap(item => item.points.map(point => point.date)))].sort()
  const unit = series[0]?.unit ?? null
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatHealthValue(value, unit) : '尚无记录') },
    legend: { top: 0 },
    grid: { left: 64, right: 24, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: dates },
    yAxis: { type: 'value', min: 0, axisLabel: { formatter: (value: number) => formatHealthValue(value, unit) } },
    series: series.map(item => {
      const byDate = new Map(item.points.map(point => [point.date, point.value]))
      return { name: item.label, type: 'line' as const, connectNulls: false, showSymbol: dates.length <= 60, data: dates.map(date => byDate.get(date) ?? null) }
    }),
  }
}
