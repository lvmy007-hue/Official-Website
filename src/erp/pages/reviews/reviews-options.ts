import type { EChartsOption } from 'echarts'
import { REVIEW_TREND_SCOPE_LABEL, type RatingPoint, type ReturnTopicRow, type ReviewSentiment, type ReviewTrendScope, type TrendSeries } from '@nova/api-contracts'
import { formatPercent } from '../../format'

// 评价与反馈的图表配置与小计算（纯函数）：类目评论主题趋势、类目退货主题趋势、星级分布、最近趋势文字。
// 没有记录的月份保持为空（线断开），不补成 0。

const monthLabel = (month: string) => month.slice(0, 7)
const percentAxis = (value: number) => formatPercent(value, { digits: 0 })

type Line = { name: string; scope: ReviewTrendScope; data: Array<number | null> }

function lineOption(months: readonly string[], lines: readonly Line[]): EChartsOption {
  return {
    tooltip: { trigger: 'axis', valueFormatter: value => (typeof value === 'number' ? formatPercent(value, { digits: 1 }) : '尚无记录') },
    legend: { type: 'scroll', top: 0 },
    grid: { left: 56, right: 24, top: 40, bottom: 28 },
    xAxis: { type: 'category', data: months.map(monthLabel) },
    yAxis: { type: 'value', min: 0, axisLabel: { formatter: percentAxis } },
    series: lines.map(line => ({
      name: line.name,
      type: 'line' as const,
      connectNulls: false,
      showSymbol: true,
      lineStyle: line.scope === 'TOP25' ? { type: 'dashed' as const } : undefined,
      data: line.data,
    })),
  }
}

const rateAt = (points: ReadonlyArray<{ month: string; rate: number | null }>, month: string): number | null => points.find(point => point.month === month)?.rate ?? null

/** 类目评论主题趋势：只画所选情感的主题；“类目全部商品”画实线，“类目前 25% 商品”画虚线。 */
export function buildTopicTrendOption(series: readonly TrendSeries[], months: readonly string[], sentiment: ReviewSentiment): EChartsOption {
  const lines = series
    .filter(item => item.sentiment === sentiment)
    .map(item => ({ name: `${item.topic}（${REVIEW_TREND_SCOPE_LABEL[item.scope]}）`, scope: item.scope, data: months.map(month => rateAt(item.points, month)) }))
  return lineOption(months, lines)
}

/** 所选情感下有几条趋势线；为 0 时页面写“尚无记录”而不是画空图。 */
export const topicTrendCount = (series: readonly TrendSeries[], sentiment: ReviewSentiment): number => series.filter(item => item.sentiment === sentiment).length

/** 类目退货主题趋势：每个主题一条线，按所选档位（全部商品或前 25% 商品）取占比。 */
export function buildReturnTrendOption(topics: readonly ReturnTopicRow[], months: readonly string[], scope: ReviewTrendScope): EChartsOption {
  const lines = topics.map(topic => ({
    name: topic.topic,
    scope,
    data: months.map(month => {
      const point = topic.series.find(item => item.month === month)
      return (scope === 'ALL' ? point?.all : point?.top) ?? null
    }),
  }))
  return lineOption(months, lines)
}

export interface DistributionBar {
  star: number
  count: number
  /** 占全部评分人数的比例；总人数为 0 时为 null。 */
  share: number | null
}

/** 星级分布（5 星在上）：没有导入返回空数组；缺的星级按没有记录处理，不补 0 人。 */
export function distributionBars(distribution: Record<string, number> | null): DistributionBar[] {
  if (!distribution) return []
  const entries = [5, 4, 3, 2, 1].filter(star => typeof distribution[String(star)] === 'number')
  const total = entries.reduce((sum, star) => sum + distribution[String(star)], 0)
  return entries.map(star => ({ star, count: distribution[String(star)], share: total > 0 ? distribution[String(star)] / total : null }))
}

/** 最近几次采集的星级走势文字（旧到新）：4.40 → 4.50；没有星级的采集点跳过，不写成 0。 */
export function ratingTrendText(points: readonly RatingPoint[], keep = 4): string | null {
  const values = points.filter(point => point.avgRating !== null).slice(-keep)
  return values.length === 0 ? null : values.map(point => (point.avgRating as number).toFixed(2)).join(' → ')
}
