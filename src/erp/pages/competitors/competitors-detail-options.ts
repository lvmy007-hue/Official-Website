import type { EChartsOption } from 'echarts'
import type { CompetitorSharePoint, CompetitorTrendPoint } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 竞品详情的图表配置（纯函数）：价格对比、销售排名对比、核心词点击份额趋势。
// 没有记录的时刻保持为空（线断开），不补成 0；快照只在变化或每 24 小时写一条，所以价格与排名曲线是阶梯状。

const label = (at: string) => at.slice(0, 16).replace('T', ' ')

export function buildPriceTrendOption(points: readonly CompetitorTrendPoint[], currency: string): EChartsOption {
  const series = [
    { name: '竞品价格', data: points.map(point => point.price) },
    { name: '我方价格', data: points.map(point => point.ownPrice) },
  ]
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatMoney(value, currency, { digits: 2 }) : '尚无记录') },
    legend: { top: 0 },
    grid: { left: 64, right: 24, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => label(point.at)) },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: (value: number) => formatMoney(value, currency, { digits: 2 }) } },
    series: series.map(item => ({ ...item, type: 'line' as const, step: 'end' as const, connectNulls: false, showSymbol: points.length <= 60 })),
  }
}

/** 销售排名：数字越小名次越靠前，所以纵轴反向（名次靠前的在上方）。 */
export function buildRankTrendOption(points: readonly CompetitorTrendPoint[]): EChartsOption {
  const series = [
    { name: '竞品销售排名', data: points.map(point => point.rank) },
    { name: '我方销售排名（同一分类）', data: points.map(point => point.ownRank) },
  ]
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? `第 ${formatNumber(value, { digits: 0 })} 名` : '尚无记录') },
    legend: { top: 0 },
    grid: { left: 64, right: 24, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => label(point.at)) },
    yAxis: { type: 'value', inverse: true, scale: true, axisLabel: { formatter: (value: number) => formatNumber(value, { digits: 0 }) } },
    series: series.map(item => ({ ...item, type: 'line' as const, step: 'end' as const, connectNulls: false, showSymbol: points.length <= 60 })),
  }
}

/** 核心词点击份额趋势（下限）：各周都用同一组核心词与权重，周与周之间才可比。 */
export function buildShareTrendOption(points: readonly CompetitorSharePoint[]): EChartsOption {
  return {
    tooltip: {
      trigger: 'axis',
      valueFormatter: value => (typeof value === 'number' ? formatPercent(value, { digits: 1 }) : '尚无记录'),
    },
    grid: { left: 64, right: 24, top: 16, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.periodStart) },
    yAxis: { type: 'value', min: 0, axisLabel: { formatter: (value: number) => formatPercent(value, { digits: 0 }) } },
    series: [{ name: '在核心词中的点击份额（下限）', type: 'line' as const, connectNulls: false, showSymbol: true, data: points.map(point => point.share) }],
  }
}
