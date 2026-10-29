import { COMPETITOR_FEATURED_LABEL, COMPETITOR_LIMITS, memberEligibleOf, type CompetitorCompareRow, type CompetitorTrendPoint } from '@nova/api-contracts'
import type { OwnPrice, OwnProduct, SnapshotRow } from './competitors-load'

// 竞品详情里的纯计算（P4-12）：价格与名次趋势按时间并集对齐（各自沿用最近一次已知值，不补 0），以及并排对照表。

export interface TimedValue {
  at: Date
  value: number
}

const lastBefore = (series: readonly TimedValue[], pointer: { i: number }, time: number): number | null => {
  while (pointer.i + 1 < series.length && (series[pointer.i + 1] as TimedValue).at.getTime() <= time) pointer.i += 1
  const item = series[pointer.i]
  return item && item.at.getTime() <= time ? item.value : null
}

/**
 * 趋势点：时间取四条序列的并集，每个点上各条序列取“不晚于该时刻的最近一次已知值”（还没有记录就是 null）。
 * 只输出 from 之后的点；超过 limit 个点时保留最近的，并标记截断。竞品名次只取与指定分类一致的快照。
 */
export function buildTrend(
  input: { price: readonly TimedValue[]; rank: readonly TimedValue[]; ownPrice: readonly TimedValue[]; ownRank: readonly TimedValue[] },
  from: Date,
  limit: number = COMPETITOR_LIMITS.trendRowsMax,
): { points: CompetitorTrendPoint[]; truncated: boolean } {
  const times = [...new Set([...input.price, ...input.rank, ...input.ownPrice, ...input.ownRank].map(item => item.at.getTime()))].filter(time => time >= from.getTime()).sort((a, b) => a - b)
  const pointers = { price: { i: -1 }, rank: { i: -1 }, ownPrice: { i: -1 }, ownRank: { i: -1 } }
  const all = times.map(time => ({
    at: new Date(time).toISOString(),
    price: lastBefore(input.price, pointers.price, time),
    ownPrice: lastBefore(input.ownPrice, pointers.ownPrice, time),
    rank: lastBefore(input.rank, pointers.rank, time),
    ownRank: lastBefore(input.ownRank, pointers.ownRank, time),
  }))
  return { points: all.slice(-limit), truncated: all.length > limit }
}

/** 配送方式的统一叫法：亚马逊配送 → FBA，卖家自配送 → FBM，其他原样显示。 */
export const fulfillmentLabel = (value: string | null): string | null => {
  if (!value) return null
  if (/^(AMAZON|AFN|FBA)$/i.test(value)) return 'FBA'
  if (/^(MERCHANT|MFN|FBM)$/i.test(value)) return 'FBM'
  return value
}

export interface OwnSummary {
  featuredIsOwn: boolean | null
  featuredPrice: number | null
  viewWeightMember: number | null
}

const money = (price: number | null, currency: string) => (price === null ? null : `${price.toFixed(2)} ${currency}`)
const rankText = (rank: number | null, name: string | null) => (rank === null ? null : `第 ${rank} 名${name ? `（${name}）` : ''}`)
const memberText = (value: boolean | null) => (value === null ? null : value ? '会员可享' : '会员不可享')

export function buildCompare(input: {
  competitor: SnapshotRow | null
  own: OwnProduct | undefined
  ownPrice: OwnPrice | undefined
  ownSummary: OwnSummary | undefined
  ownRank: { rank: number; name: string } | null
  rankNote: string | null
}): CompetitorCompareRow[] {
  const { competitor, own, ownPrice, ownSummary, ownRank } = input
  const ownMember = ownSummary ? memberText(memberEligibleOf(ownSummary.featuredPrice !== null, ownSummary.viewWeightMember)) : null
  const ownFeatured = ownSummary ? (ownSummary.featuredIsOwn === true ? '我方持有推荐报价' : ownSummary.featuredPrice !== null ? '推荐报价在其他卖家' : COMPETITOR_FEATURED_LABEL.NONE) : null
  const row = (key: string, label: string, mine: string | null, theirs: string | null, note: string | null = null): CompetitorCompareRow => ({ key, label, own: mine, competitor: theirs, note })
  return [
    row('title', '标题', own?.title ?? null, competitor?.title ?? null),
    row('brand', '品牌', own?.brand ?? null, competitor?.brand ?? null),
    row('price', '价格', money(ownPrice?.price ?? null, ownPrice?.currency ?? 'USD'), money(competitor?.price ?? null, competitor?.currency ?? 'USD')),
    row('featured', '推荐报价', ownFeatured, competitor?.featured ? COMPETITOR_FEATURED_LABEL[competitor.featured] : null),
    row('fulfillment', '配送方式', fulfillmentLabel(own?.fulfillmentChannel ?? null), fulfillmentLabel(competitor?.fulfillment ?? null)),
    row('member', '会员资格', ownMember, memberText(competitor?.memberEligible ?? null)),
    row('rank', '销售排名', rankText(ownRank?.rank ?? null, ownRank?.name ?? null), rankText(competitor?.rank ?? null, competitor?.rankName ?? null), input.rankNote),
  ]
}
