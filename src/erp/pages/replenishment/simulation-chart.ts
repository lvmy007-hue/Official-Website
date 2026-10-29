import type { EChartsOption } from 'echarts'
import type { StockoutRange, TrendSimulation } from '@nova/api-contracts'
import { formatNumber } from '../../format'

// 90 天库存趋势图（纯函数）：不补货、按建议补货、自定义三条曲线；0 线以下就是断货。没有数据的曲线不画。

const COLORS = { none: '#cf1322', recommended: '#389e0d', custom: '#1677ff' } as const

export function trendOption(points: TrendSimulation['points']): EChartsOption {
  const line = (name: string, color: string, pick: (point: TrendSimulation['points'][number]) => number | null) => ({
    name,
    type: 'line' as const,
    showSymbol: false,
    smooth: false,
    lineStyle: { color, width: 2 },
    itemStyle: { color },
    data: points.map(pick),
  })
  const hasRecommended = points.some(point => point.recommended !== null)
  const hasCustom = points.some(point => point.custom !== null)
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => formatNumber(Number(value), { digits: 0 }) },
    legend: { top: 0 },
    grid: { left: 56, right: 16, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: { type: 'value', name: '库存（件）', axisLabel: { formatter: (value: number) => formatNumber(value, { compact: true }) } },
    series: [
      { ...line('不补货', COLORS.none, point => point.none), markLine: { silent: true, symbol: 'none', data: [{ yAxis: 0 }], lineStyle: { color: '#8c8c8c', type: 'dashed' } } },
      ...(hasRecommended ? [line('按建议补货', COLORS.recommended, point => point.recommended)] : []),
      ...(hasCustom ? [line('自定义补货', COLORS.custom, point => point.custom)] : []),
    ],
  }
}

/** 断货区间的一句话：几号到几号、共几天、缺口多少件。 */
export function stockoutText(range: StockoutRange): string {
  return `${range.from} 至 ${range.to}，断货 ${range.days} 天，缺口约 ${formatNumber(range.shortage, { digits: 0 })} 件`
}
