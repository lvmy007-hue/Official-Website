import type { EChartsOption } from 'echarts'
import type { Asin360CompareSeriesPoint, Asin360CompetitorCompareResponse } from '@nova/api-contracts'
import { formatMoney, formatNumber } from '../../format'

// 竞品对比的趋势图配置（纯函数）：每个并列的商品一条线，没有记录的日子断开，不补成 0。
// 销售排名数字越小越好，纵轴反向（名次靠前的在上方）；价格按各商品自己的币种显示。

export const COMPARE_METRICS = ['price', 'rank', 'rating', 'ratingCount'] as const
export type CompareMetric = (typeof COMPARE_METRICS)[number]
export const COMPARE_METRIC_LABEL: Record<CompareMetric, string> = { price: '价格', rank: '销售排名', rating: '评分', ratingCount: '评论数' }

const pick = (point: Asin360CompareSeriesPoint, metric: CompareMetric) => point[metric]

export const partyName = (party: { asin: string; isOwn: boolean }) => (party.isOwn ? `本品 ${party.asin}` : party.asin)

/** 这个指标下有没有任何一条线有数据（决定图画不画、还是给空状态）。 */
export const hasMetricData = (data: Asin360CompetitorCompareResponse, metric: CompareMetric) => data.parties.some(party => party.points.some(point => pick(point, metric) !== null))

export function buildCompareOption(data: Asin360CompetitorCompareResponse, metric: CompareMetric): EChartsOption {
  const dates = [...new Set(data.parties.flatMap(party => party.points.map(point => point.date)))].sort()
  const own = data.parties.find(party => party.isOwn)
  const money = (value: unknown) => formatMoney(Number(value), own?.currency ?? 'USD', { digits: 2 })
  const format = (value: unknown) => (metric === 'price' ? money(value) : metric === 'rating' ? formatNumber(Number(value), { digits: 2 }) : formatNumber(Number(value), { digits: 0 }))
  return {
    tooltip: { trigger: 'axis', valueFormatter: format },
    legend: { top: 0 },
    grid: { left: 56, right: 24, top: 36, bottom: 28 },
    xAxis: { type: 'category', data: dates },
    yAxis: {
      type: 'value',
      inverse: metric === 'rank',
      scale: true,
      axisLabel: { formatter: (value: number) => (metric === 'price' ? formatMoney(value, own?.currency ?? 'USD', { digits: 0, compact: true }) : formatNumber(value, { compact: true })) },
    },
    series: data.parties.map(party => {
      const byDate = new Map(party.points.map(point => [point.date, pick(point, metric)]))
      return {
        name: partyName(party),
        type: 'line',
        connectNulls: false,
        showSymbol: dates.length <= 45,
        lineStyle: party.isOwn ? { width: 3 } : undefined,
        data: dates.map(date => byDate.get(date) ?? null),
      }
    }),
  }
}
