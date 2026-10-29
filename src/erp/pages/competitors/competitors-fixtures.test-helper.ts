import type { CompetitorCandidate, CompetitorCandidatesResponse, CompetitorDetailResponse, CompetitorListResponse, CompetitorRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from '../listings/listing-quality-fixtures.test-helper'

// 竞品监控页测试用的假服务端数据（只在测试里使用）。

export { ok }

const freshness = { lastSuccessAt: '2026-10-24T06:00:00Z', sources: ['竞品监控'], qualityIssues: 0 } as CompetitorListResponse['freshness']
const pageInfo = (count: number) => ({ pageSize: 20, nextCursor: null, hasMore: false, approxTotal: count })

export const competitorRow = (patch: Partial<CompetitorRow> = {}): CompetitorRow => ({
  id: 'w1',
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0COMPET01',
  ownAsin: 'B0OWN00001',
  ownTitle: '我方旅行箱 24 寸',
  reason: 'SEARCH_TERM',
  reasonNote: 'luggage',
  title: '竞品旅行箱 24 寸',
  brand: 'Acme',
  imageCount: 6,
  price: 25.5,
  currency: 'USD',
  featured: 'HAS_FEATURED',
  fulfillment: 'FBA',
  memberEligible: true,
  rank: 80,
  rankName: '行李箱',
  ownPrice: 20,
  priceGap: 5.5,
  priceGapPct: 0.275,
  ownRank: 100,
  rankGap: -20,
  rankNote: null,
  clickShare: 0.438095,
  clickShareTerms: { hit: 2, total: 3 },
  observedAt: '2026-10-24T05:00:00Z',
  addedAt: '2026-10-20T00:00:00Z',
  ...patch,
})

/** 还在等待首次同步的关注：所有数据字段都是 null。 */
export const waitingRow = (patch: Partial<CompetitorRow> = {}): CompetitorRow =>
  competitorRow({
    id: 'w2',
    asin: 'B0COMPET02',
    ownAsin: null,
    ownTitle: null,
    reason: 'MANUAL',
    reasonNote: null,
    title: null,
    brand: null,
    imageCount: null,
    price: null,
    featured: null,
    fulfillment: null,
    memberEligible: null,
    rank: null,
    rankName: null,
    ownPrice: null,
    priceGap: null,
    priceGapPct: null,
    ownRank: null,
    rankGap: null,
    rankNote: '没有指定我方对应商品',
    clickShare: null,
    clickShareTerms: null,
    observedAt: null,
    ...patch,
  })

export const listResponse = (patch: Partial<CompetitorListResponse> = {}): CompetitorListResponse => ({
  state: 'OK',
  note: null,
  items: [competitorRow(), waitingRow()],
  pageInfo: pageInfo(2),
  summary: { watched: 2, withSnapshot: 1, waiting: 1 },
  stores: [{ id: 'st1', name: 'Northstar US' }],
  truncated: false,
  freshness,
  basis: '竞品来源只有官方接口与报告。不抓取亚马逊前台页面。核心词点击份额是下限。',
  ...patch,
})

export const candidate = (patch: Partial<CompetitorCandidate> = {}): CompetitorCandidate => ({
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0COMPET03',
  title: '候选旅行箱',
  ownAsin: 'B0OWN00001',
  ownTitle: '我方旅行箱 24 寸',
  terms: [{ term: 'luggage', slot: 1, clickShare: 0.5, conversionShare: 0.2, volume: 900 }],
  termCount: 3,
  clickShare: 0.43,
  clickShareTerms: { hit: 2, total: 3 },
  ...patch,
})

export const candidatesResponse = (patch: Partial<CompetitorCandidatesResponse> = {}): CompetitorCandidatesResponse => ({
  state: 'OK',
  note: null,
  period: { kind: 'WEEK', start: '2026-10-12' },
  items: [candidate()],
  truncated: false,
  freshness,
  basis: '竞品来源只有官方接口与报告。核心词点击份额是下限。',
  ...patch,
})

export const detailResponse = (patch: Partial<CompetitorDetailResponse> = {}): CompetitorDetailResponse => ({
  asin: 'B0COMPET01',
  store: { id: 'st1', name: 'Northstar US' },
  ownAsin: 'B0OWN00001',
  ownTitle: '我方旅行箱 24 寸',
  watches: [{ id: 'w1', ownAsin: 'B0OWN00001', ownTitle: '我方旅行箱 24 寸', reason: 'SEARCH_TERM', reasonNote: 'luggage', addedAt: '2026-10-20T00:00:00Z' }],
  latest: {
    title: '竞品旅行箱 24 寸',
    brand: 'Acme',
    imageCount: 6,
    price: 25.5,
    currency: 'USD',
    featured: 'HAS_FEATURED',
    fulfillment: 'FBA',
    memberEligible: true,
    rank: 80,
    rankName: '行李箱',
    rankClassificationId: 'c1',
    observedAt: '2026-10-24T05:00:00Z',
  },
  trend: {
    state: 'OK',
    note: null,
    range: { from: '2026-07-26T00:00:00Z', to: '2026-10-24T06:00:00Z' },
    points: [
      { at: '2026-10-22T00:00:00Z', price: 24, ownPrice: 20, rank: 90, ownRank: 100 },
      { at: '2026-10-24T05:00:00Z', price: 25.5, ownPrice: 20, rank: 80, ownRank: 100 },
    ],
    truncated: false,
    currency: 'USD',
  },
  changes: { state: 'OK', note: null, items: [{ at: '2026-10-23T00:00:00Z', field: 'title', label: '标题', before: '旧标题', after: '竞品旅行箱 24 寸' }], truncated: false },
  shareTrend: {
    state: 'OK',
    note: null,
    points: [
      { periodStart: '2026-10-05', share: 0.17, hit: 1, total: 3 },
      { periodStart: '2026-10-12', share: 0.438095, hit: 2, total: 3 },
    ],
    coreTerms: 3,
  },
  compare: {
    state: 'OK',
    note: null,
    rows: [
      { key: 'price', label: '价格', own: '20.00 USD', competitor: '25.50 USD', note: null },
      { key: 'brand', label: '品牌', own: null, competitor: 'Acme', note: null },
      { key: 'rank', label: '销售排名', own: '第 100 名（行李箱）', competitor: '第 80 名（行李箱）', note: null },
    ],
  },
  otherOffers: {
    state: 'OK',
    note: '这是我方商品页面上的其他卖家报价',
    observedAt: '2026-10-24T04:00:00Z',
    items: [{ fulfillment: 'FBA', condition: 'New', price: 19.5, shipping: null, isFeatured: false, isOwn: false }],
  },
  rating: { state: 'NO_OFFICIAL_SOURCE', note: '竞品的评分与评分数没有官方来源（客户反馈接口只提供我方商品，本系统不抓取亚马逊前台页面），所以这里不显示' },
  freshness,
  basis: '竞品来源只有官方接口与报告。',
  ...patch,
})

export const competitorHandlers = (response: () => CompetitorListResponse, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/competitors': () => ok(response()),
  '/competitors/candidates': () => ok(candidatesResponse()),
  ...extra,
})
