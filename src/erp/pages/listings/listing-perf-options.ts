import type { EChartsOption } from 'echarts'
import { LISTING_TREND_LABEL, type ListingTrendMetric, type ListingTrendPoint } from '@nova/api-contracts'
import { formatMoney, formatNumber, formatPercent } from '../../format'

// 刊登表现顶部趋势图的配置（纯函数）：一次画一个指标。会话、浏览量、销量、销售额画柱，转化率与购物车获得率画线（百分比）。
// 没有记录的日子保持为空（图上断开或留空），不补成 0。

const RATIO: readonly ListingTrendMetric[] = ['conversion', 'buyBox']

export const formatTrendValue = (metric: ListingTrendMetric, value: unknown): string => {
  const number = Number(value)
  if (metric === 'sales') return formatMoney(number, 'USD', { digits: 2 })
  if (RATIO.includes(metric)) return formatPercent(number, { digits: 1 })
  return formatNumber(number, { digits: 0 })
}

export function buildListingTrendOption(points: readonly ListingTrendPoint[], metric: ListingTrendMetric): EChartsOption {
  const ratio = RATIO.includes(metric)
  return {
    tooltip: { trigger: 'axis' },
    grid: { left: 56, right: 24, top: 24, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.date) },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (value: number) => (ratio ? formatPercent(value, { digits: 0 }) : metric === 'sales' ? formatMoney(value, 'USD', { digits: 0 }) : formatNumber(value, { compact: true })),
      },
    },
    series: [
      {
        name: LISTING_TREND_LABEL[metric],
        type: ratio ? 'line' : 'bar',
        data: points.map(point => point[metric]),
        connectNulls: false,
        showSymbol: points.length <= 45,
        tooltip: { valueFormatter: value => formatTrendValue(metric, value) },
      },
    ],
  }
}
