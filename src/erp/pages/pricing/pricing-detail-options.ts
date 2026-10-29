import type { EChartsOption } from 'echarts'
import type { PricingHistoryPoint } from '@nova/api-contracts'
import { formatMoney } from '../../format'

// 价格历史曲线的配置（纯函数）：我方价、推荐报价价格、最低竞争价、预期获胜价四条线。
// 没有记录的时刻保持为空（线断开），不补成 0；价格快照只在价格变化或每 24 小时写一条，所以曲线是阶梯状。

const SERIES: Array<{ key: keyof Omit<PricingHistoryPoint, 'at'>; name: string }> = [
  { key: 'ownPrice', name: '我方价格' },
  { key: 'featuredPrice', name: '推荐报价价格' },
  { key: 'lowestPrice', name: '最低竞争价' },
  { key: 'expectedPrice', name: '预期获胜价' },
]

export function buildPriceHistoryOption(points: readonly PricingHistoryPoint[], currency: string): EChartsOption {
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatMoney(value, currency, { digits: 2 }) : '尚无记录') },
    legend: { top: 0 },
    grid: { left: 64, right: 24, top: 32, bottom: 28 },
    xAxis: { type: 'category', data: points.map(point => point.at.slice(0, 16).replace('T', ' ')) },
    yAxis: { type: 'value', scale: true, axisLabel: { formatter: (value: number) => formatMoney(value, currency, { digits: 2 }) } },
    series: SERIES.map(item => ({
      name: item.name,
      type: 'line' as const,
      step: 'end' as const,
      connectNulls: false,
      showSymbol: points.length <= 60,
      data: points.map(point => point[item.key]),
    })),
  }
}
