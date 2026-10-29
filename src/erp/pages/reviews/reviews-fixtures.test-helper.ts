import type { EligibleOrderRow, ImprovementRow, RatingGrowthRow, RatingRow, RatingsTabResponse, ReturnsTabResponse, SolicitTabResponse, TopicRow, TopicsTabResponse } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { LIVE_PAGES, type LivePages } from '../../routes/live-pages'
import { ok } from '../listings/listing-quality-fixtures.test-helper'

// 评价与反馈页测试用的假服务端数据（只在测试里使用）。

export { ok }

/** 用真实的登记项（含地址栏参数规则），这样 tab、storeId、asin、nodeId 才不会被丢掉。 */
export const reviewsPages: LivePages = { ReviewsPage: LIVE_PAGES.ReviewsPage }

type Calls = { calls: Array<{ path: string; search: string; method: string }> }
export const callsOf = (app: Calls, path: string, method = 'GET') => app.calls.filter(call => call.path === path && call.method === method)
/** 某个路径最近一次请求的查询参数。 */
export const lastParams = (app: Calls, path: string) => {
  const list = callsOf(app, path)
  return new URLSearchParams(list[list.length - 1]?.search)
}

const pageInfo = (count: number) => ({ pageSize: 50, nextCursor: null, hasMore: false, approxTotal: count })
const stores = [{ id: 'st1', name: 'Northstar US' }]
const freshness = { lastSuccessAt: '2026-10-24T06:00:00Z', sources: ['客户反馈'], qualityIssues: 0 }

// ---- 评分概况 ----

export const ratingRow = (patch: Partial<RatingRow> = {}): RatingRow => ({
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0RATE0001',
  title: '旅行箱 24 寸',
  avgRating: 4.3,
  ratingCount: 1280,
  captureDate: '2026-10-24',
  distribution: { '1': 40, '2': 30, '3': 80, '4': 250, '5': 880 },
  sourceLabel: '文件导入',
  sourceFileName: 'ratings-1024.csv',
  importedBy: '林然',
  ratingDelta: -0.1,
  countDelta: 25,
  previousDate: '2026-10-17',
  trend: [
    { date: '2026-10-17', avgRating: 4.4, ratingCount: 1255 },
    { date: '2026-10-24', avgRating: 4.3, ratingCount: 1280 },
  ],
  ...patch,
})

/** 只有一次采集、没有星级分布、没有导入人的行。 */
export const singleRatingRow = (patch: Partial<RatingRow> = {}): RatingRow =>
  ratingRow({
    asin: 'B0RATE0002',
    title: '收纳袋',
    avgRating: 3.8,
    ratingCount: null,
    distribution: null,
    importedBy: null,
    ratingDelta: null,
    countDelta: null,
    previousDate: null,
    trend: [{ date: '2026-10-24', avgRating: 3.8, ratingCount: null }],
    ...patch,
  })

export const ratingsResponse = (patch: Partial<RatingsTabResponse> = {}): RatingsTabResponse => ({
  tab: 'ratings',
  state: 'OK',
  note: null,
  items: [ratingRow(), singleRatingRow()],
  pageInfo: pageInfo(2),
  summary: { catalogAsins: 12, withRating: 2, latestCapture: '2026-10-24', lowestRating: 3.8, below4: 1 },
  stores,
  truncated: false,
  basis: '平均星级与评分数只能由你导入的文件提供。',
  ...patch,
})

// ---- 评论主题 ----

export const topicRow = (patch: Partial<TopicRow> = {}): TopicRow => ({
  rank: 1,
  topic: 'Zipper broke',
  sentiment: 'NEGATIVE',
  mentionRange: '100-200',
  reviewCountBucket: null,
  categoryAll: 0.12,
  categoryTop: 0.08,
  ...patch,
})

export const topicsResponse = (patch: Partial<TopicsTabResponse> = {}): TopicsTabResponse => ({
  tab: 'topics',
  state: 'OK',
  note: null,
  options: [
    { storeId: 'st1', storeName: 'Northstar US', asin: 'B0RATE0001', title: '旅行箱 24 寸', snapshotDate: '2026-10-20' },
    { storeId: 'st1', storeName: 'Northstar US', asin: 'B0RATE0002', title: '收纳袋', snapshotDate: '2026-10-20' },
  ],
  selected: {
    storeId: 'st1',
    storeName: 'Northstar US',
    asin: 'B0RATE0001',
    title: '旅行箱 24 寸',
    snapshotDate: '2026-10-20',
    browseNodeId: 'n1',
    browseNodeName: '行李箱',
    positive: [topicRow({ rank: 1, topic: 'Sturdy wheels', sentiment: 'POSITIVE', mentionRange: '200-300', categoryAll: 0.2, categoryTop: 0.25 })],
    negative: [topicRow(), topicRow({ rank: 2, topic: 'Handle loose', mentionRange: null, categoryAll: null, categoryTop: null })],
    trend: [
      {
        topic: 'Zipper broke',
        sentiment: 'NEGATIVE',
        scope: 'ALL',
        points: [
          { month: '2026-09-01', rate: 0.1 },
          { month: '2026-10-01', rate: 0.12 },
        ],
      },
      { topic: 'Zipper broke', sentiment: 'NEGATIVE', scope: 'TOP25', points: [{ month: '2026-10-01', rate: 0.08 }] },
    ],
    trendMonths: ['2026-09-01', '2026-10-01'],
    categoryNote: null,
  },
  stores,
  freshness,
  basis: '评论主题来自亚马逊客户反馈接口。',
  ...patch,
})

// ---- 退货主题与改进清单 ----

export const improvementRow = (patch: Partial<ImprovementRow> = {}): ImprovementRow => ({
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0RATE0001',
  title: '旅行箱 24 寸',
  negativeTopics: [
    { topic: 'Zipper broke', mentionRange: '100-200' },
    { topic: 'Handle loose', mentionRange: null },
  ],
  returnUnits: 18,
  returnReasons: [
    { code: 'DEFECTIVE', label: '商品有缺陷', units: 10, share: 0.5556 },
    { code: 'NOT_AS_DESCRIBED', label: '与描述不符', units: 5, share: 0.2778 },
  ],
  possiblyRelated: true,
  snapshotDate: '2026-10-20',
  suggestion: '负面主题“Zipper broke”与退货原因文字有重合：优先核对商品本身。',
  ...patch,
})

export const returnsResponse = (patch: Partial<ReturnsTabResponse> = {}): ReturnsTabResponse => ({
  tab: 'returns',
  state: 'OK',
  note: null,
  nodes: [
    { storeId: 'st1', storeName: 'Northstar US', browseNodeId: 'n1', browseNodeName: '行李箱', asinCount: 3 },
    { storeId: 'st1', storeName: 'Northstar US', browseNodeId: 'n2', browseNodeName: '收纳用品', asinCount: 1 },
  ],
  selectedNode: {
    storeId: 'st1',
    storeName: 'Northstar US',
    browseNodeId: 'n1',
    browseNodeName: '行李箱',
    months: ['2026-09-01', '2026-10-01'],
    topics: [
      {
        topic: 'Too small',
        rateAll: 0.15,
        rateTop: null,
        latestMonth: '2026-10-01',
        series: [
          { month: '2026-09-01', all: 0.1, top: null },
          { month: '2026-10-01', all: 0.15, top: null },
        ],
      },
    ],
  },
  improvements: { state: 'OK', note: null, rows: [improvementRow()], days: 90 },
  stores,
  freshness,
  basis: '退货主题只到类目级。',
  ...patch,
})

// ---- 请求评价 ----

export const eligibleRow = (patch: Partial<EligibleOrderRow> = {}): EligibleOrderRow => ({
  storeId: 'st1',
  storeName: 'Northstar US',
  amazonOrderId: '111-0000001-0000001',
  purchaseDate: '2026-10-05T10:00:00Z',
  deliveredAt: '2026-10-10T10:00:00Z',
  dayAfterDelivery: 14,
  daysLeft: 16,
  asins: ['B0RATE0001'],
  lastStatus: null,
  ...patch,
})

export const growthRow = (patch: Partial<RatingGrowthRow> = {}): RatingGrowthRow => ({
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0RATE0001',
  title: '旅行箱 24 寸',
  requestedOrders: 20,
  firstRequestAt: '2026-10-01T00:00:00Z',
  beforeCount: 1200,
  beforeDate: '2026-10-01',
  afterCount: 1280,
  afterDate: '2026-10-24',
  delta: 80,
  note: null,
  ...patch,
})

export const solicitResponse = (patch: Partial<SolicitTabResponse> = {}): SolicitTabResponse => ({
  tab: 'solicit',
  state: 'OK',
  note: null,
  items: [eligibleRow(), eligibleRow({ amazonOrderId: '111-0000002-0000002', lastStatus: 'FAILED', dayAfterDelivery: 29, daysLeft: 1 })],
  pageInfo: pageInfo(2),
  coverage: [{ storeId: 'st1', storeName: 'Northstar US', deliveredOrders: 200, requestedOrders: 50, coverage: 0.25, eligibleNow: 2 }],
  growth: [growthRow(), growthRow({ asin: 'B0RATE0002', title: '收纳袋', afterCount: null, afterDate: null, delta: null, note: '需要再导入一次评分：请求前后各要有一次评分导入才能对照' })],
  recent: [
    { amazonOrderId: '111-0000009-0000009', storeName: 'Northstar US', status: 'REQUESTED', statusLabel: '已请求', requestedAt: '2026-10-23T08:00:00Z', failureCode: null },
    { amazonOrderId: '111-0000008-0000008', storeName: 'Northstar US', status: 'UNAVAILABLE', statusLabel: '亚马逊不允许请求', requestedAt: '2026-10-22T08:00:00Z', failureCode: null },
  ],
  stores,
  truncated: false,
  basis: '可请求订单：送达后第 5 至 30 天。',
  growthBasis: '增长只反映时间上的先后。',
  ...patch,
})

/** 路径精确匹配；/reviews 按 tab 参数分发。 */
export const reviewsHandlers = (
  responses: { ratings?: () => RatingsTabResponse; topics?: () => TopicsTabResponse; returns?: () => ReturnsTabResponse; solicit?: () => SolicitTabResponse } = {},
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  '/reviews': url => {
    const tab = url.searchParams.get('tab')
    if (tab === 'topics') return ok((responses.topics ?? topicsResponse)())
    if (tab === 'returns') return ok((responses.returns ?? returnsResponse)())
    if (tab === 'solicit') return ok((responses.solicit ?? solicitResponse)())
    return ok((responses.ratings ?? ratingsResponse)())
  },
  '/members/options': () => ok([{ status: 'ACTIVE', user: { id: 'u2', displayName: '王工', email: 'wang@example.com' } }]),
  ...extra,
})
