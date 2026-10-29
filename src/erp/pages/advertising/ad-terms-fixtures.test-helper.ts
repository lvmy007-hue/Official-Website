import {
  AD_TERM_AGGREGATE_BASIS,
  AD_TERM_MATCH_BASIS,
  AD_TERM_NEGATIVES_BASIS,
  AD_TERM_QUADRANT_BASIS,
  AD_TERM_ROOT_BASIS,
  AD_TERM_TARGETS_BASIS,
  ADS_WRITE_PENDING,
  summarizeTerms,
  type AdTermDetailResponse,
  type AdTermNegativeRow,
  type AdTermNegativesResponse,
  type AdTermQuadrantResponse,
  type AdTermRootRow,
  type AdTermRootsResponse,
  type AdTermSearchResponse,
  type AdTermSearchRow,
  type AdTermTargetRow,
  type AdTermTargetsResponse,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 词级中心测试用的假服务端数据（只在测试里使用）。

const period = { from: '2026-09-23', to: '2026-10-22', days: 30 }
const range = { from: '2026-09-23', to: '2026-10-22', defaulted: true }
const pageInfo = (count: number) => ({ pageSize: 50, nextCursor: null, hasMore: false, approxTotal: count })
const shell = { period, range, currency: 'USD' as const, truncated: false, write: ADS_WRITE_PENDING }

const totalsOf = (spend: number | null, sales: number | null, orders: number, clicks: number) => ({ impressions: clicks * 20, clicks, spend, sales, orders })
const ratiosOf = (spend: number | null, sales: number | null, orders: number, clicks: number) => ({
  acos: spend !== null && sales ? spend / sales : null,
  roas: spend && sales !== null ? sales / spend : null,
  ctr: 0.05,
  cpc: spend !== null && clicks ? spend / clicks : null,
  cvr: clicks ? orders / clicks : null,
})
const metrics = (spend: number | null, sales: number | null, orders: number, clicks: number) => ({ totals: totalsOf(spend, sales, orders, clicks), ratios: ratiosOf(spend, sales, orders, clicks) })

/** 四个搜索词：已投放正常的、没成交的（销售额为空）、可加词可扩量的、已否定的。 */
export const searchRows = (): AdTermSearchRow[] => [
  { key: 'yoga mat', searchTerm: 'yoga mat', status: 'TARGETED', campaigns: { total: 2, targeted: 1, negated: 0 }, stores: 1, anomalies: [], ...metrics(40, 150, 6, 80) },
  {
    key: 'free yoga',
    searchTerm: 'free yoga',
    status: 'UNTARGETED',
    campaigns: { total: 1, targeted: 0, negated: 0 },
    stores: 1,
    anomalies: ['HIGH_SPEND_NO_ORDER', 'NEGATIVE_CANDIDATE'],
    ...metrics(30, null, 0, 30),
  },
  {
    key: 'foam roller',
    searchTerm: 'foam roller',
    status: 'UNTARGETED',
    campaigns: { total: 1, targeted: 0, negated: 0 },
    stores: 2,
    anomalies: ['SCALE_UP', 'ADD_KEYWORD'],
    ...metrics(12, 80, 4, 20),
  },
  { key: 'old term', searchTerm: 'old term', status: 'NEGATED', campaigns: { total: 1, targeted: 0, negated: 1 }, stores: 1, anomalies: [], ...metrics(3, 10, 1, 5) },
]

export const searchResponse = (patch: Partial<AdTermSearchResponse> = {}): AdTermSearchResponse => {
  const items = patch.items ?? searchRows()
  return {
    state: 'OK',
    note: null,
    ...shell,
    items,
    pageInfo: pageInfo(items.length),
    basis: `${AD_TERM_AGGREGATE_BASIS}。${AD_TERM_MATCH_BASIS}`,
    summary: summarizeTerms(items),
    undisclosedSpend: null,
    targetingNote: null,
    ...patch,
  }
}

export const targetRows = (): AdTermTargetRow[] => [
  {
    key: 'k1',
    adsProfileId: 'ap1',
    externalCampaignId: 'C-1',
    campaignName: '春季推广',
    adGroupId: 'ag-1',
    adGroupName: '核心词组',
    targetId: 'kw-1',
    expression: 'yoga mat',
    matchType: 'EXACT',
    storeName: 'Northstar US',
    bid: 1.2,
    state: 'ENABLED',
    anomalies: [],
    ...metrics(40, 150, 6, 80),
  },
  {
    key: 'k2',
    adsProfileId: 'ap1',
    externalCampaignId: 'C-2',
    campaignName: null,
    adGroupId: null,
    adGroupName: null,
    targetId: null,
    expression: 'asin="B0XYZ"',
    matchType: null,
    storeName: null,
    bid: null,
    state: null,
    anomalies: ['HIGH_SPEND_NO_ORDER'],
    ...metrics(25, null, 0, 25),
  },
]

export const targetsResponse = (patch: Partial<AdTermTargetsResponse> = {}): AdTermTargetsResponse => {
  const items = patch.items ?? targetRows()
  return { state: 'OK', note: null, ...shell, items, pageInfo: pageInfo(items.length), basis: AD_TERM_TARGETS_BASIS, summary: summarizeTerms(items), ...patch }
}

export const negativeRows = (): AdTermNegativeRow[] => [
  {
    id: 'n1',
    expression: 'free',
    matchType: 'NEGATIVE_PHRASE',
    level: 'CAMPAIGN',
    externalCampaignId: 'C-1',
    campaignName: '春季推广',
    adGroupId: null,
    adGroupName: null,
    storeName: 'Northstar US',
    accountName: '美国账户',
    syncedAt: '2026-10-22T08:00:00.000Z',
  },
  {
    id: 'n2',
    expression: 'cheap',
    matchType: 'NEGATIVE_EXACT',
    level: 'AD_GROUP',
    externalCampaignId: 'C-1',
    campaignName: null,
    adGroupId: 'ag-1',
    adGroupName: '核心词组',
    storeName: null,
    accountName: '美国账户',
    syncedAt: '2026-10-22T08:00:00.000Z',
  },
]

export const negativesResponse = (patch: Partial<AdTermNegativesResponse> = {}): AdTermNegativesResponse => {
  const items = patch.items ?? negativeRows()
  return { state: 'OK', note: null, ...shell, items, pageInfo: pageInfo(items.length), basis: AD_TERM_NEGATIVES_BASIS, total: items.length, ...patch }
}

export const quadrantResponse = (patch: Partial<AdTermQuadrantResponse> = {}): AdTermQuadrantResponse => ({
  state: 'OK',
  note: null,
  period,
  range,
  currency: 'USD',
  subject: 'search-terms',
  spendLine: 27.5,
  acosLine: 0.3,
  points: [
    { key: 'yoga mat', name: 'yoga mat', spend: 40, sales: 150, orders: 6, acos: 0.2667, quadrant: 'STAR' },
    { key: 'foam roller', name: 'foam roller', spend: 12, sales: 80, orders: 4, acos: 0.15, quadrant: 'POTENTIAL' },
  ],
  counts: { STAR: 1, WASTE: 0, POTENTIAL: 1, LOW: 0 },
  withoutSales: { terms: 2, spend: 33 },
  total: 2,
  truncated: false,
  basis: AD_TERM_QUADRANT_BASIS,
  ...patch,
})

export const rootRows = (): AdTermRootRow[] => [
  {
    root: 'yoga',
    forms: ['yoga'],
    terms: 3,
    stores: 1,
    examples: [
      { term: 'yoga mat', spend: 40 },
      { term: 'free yoga', spend: 30 },
    ],
    ...metrics(75, 150, 6, 120),
  },
  { root: 'mat', forms: ['mat', 'mats'], terms: 2, stores: 1, examples: [{ term: 'yoga mat', spend: 40 }], ...metrics(45, 150, 6, 90) },
]

export const rootsResponse = (patch: Partial<AdTermRootsResponse> = {}): AdTermRootsResponse => {
  const items = patch.items ?? rootRows()
  return { state: 'OK', note: null, period, range, currency: 'USD', items, pageInfo: pageInfo(items.length), truncated: false, basis: AD_TERM_ROOT_BASIS, termCount: 4, ...patch }
}

export const emptyShell = { state: 'NOT_CONNECTED' as const, note: '词级报表还没有同步（需要广告报表的搜索词报告）', items: [] as never[] }

export const detailResponse = (patch: Partial<AdTermDetailResponse> = {}): AdTermDetailResponse => ({
  term: 'yoga mat',
  state: 'OK',
  note: null,
  period,
  currency: 'USD',
  status: 'TARGETED',
  campaigns: { total: 2, targeted: 1, negated: 0 },
  totals: totalsOf(40, 150, 6, 80),
  ratios: ratiosOf(40, 150, 6, 80),
  anomalies: ['SCALE_UP'],
  trend: [
    { date: '2026-10-20', impressions: 400, clicks: 20, spend: 10, sales: 40, orders: 2 },
    { date: '2026-10-21', impressions: 400, clicks: 20, spend: 12, sales: null, orders: 0 },
  ],
  relations: {
    items: [
      {
        key: 'r1',
        adsProfileId: 'ap1',
        externalCampaignId: 'C-1',
        campaignName: '春季推广',
        adGroupId: 'ag-1',
        adGroupName: '核心词组',
        targetExpression: 'yoga',
        matchType: 'BROAD',
        status: 'TARGETED',
        ...metrics(40, 150, 6, 80),
      },
    ],
    truncated: false,
  },
  targeting: {
    state: 'OK',
    note: null,
    items: [{ id: 't1', kind: 'KEYWORD', expression: 'yoga mat', matchType: 'EXACT', bid: 1.2, state: 'ENABLED', externalCampaignId: 'C-1', adGroupId: 'ag-1' }],
  },
  advice: [{ action: 'RAISE_BID', label: '提高竞价', reason: '近 30 天广告成本销售比 26.7%，订单 6 个，可以小幅提高竞价扩量' }],
  history: {
    state: 'OK',
    note: null,
    truncated: false,
    items: [
      {
        id: 'h1',
        at: '2026-10-10T08:00:00.000Z',
        actor: '王运营',
        source: 'manual',
        beforeBid: 1,
        afterBid: 1.2,
        title: '调价',
        expression: 'yoga mat',
        before: { days: 7, daysWithData: 7, totals: totalsOf(20, 60, 2, 40), ratios: ratiosOf(20, 60, 2, 40) },
        after: { days: 7, daysWithData: 0, totals: null, ratios: null },
      },
    ],
  },
  brand: null,
  basis: AD_TERM_AGGREGATE_BASIS,
  write: ADS_WRITE_PENDING,
  ...patch,
})

/** 一个处理器按页签返回对应的数据；各页签可单独覆盖。 */
export function termHandlers(
  over: { search?: (url: URL) => unknown; targets?: (url: URL) => unknown; negatives?: (url: URL) => unknown; quadrant?: (url: URL) => unknown; roots?: (url: URL) => unknown; views?: Handler } = {},
): Record<string, Handler> {
  return {
    '/ads/terms': url => {
      const tab = url.searchParams.get('tab')
      if (tab === 'search-terms') return ok((over.search ?? (() => searchResponse()))(url))
      if (tab === 'negatives') return ok((over.negatives ?? (() => negativesResponse()))(url))
      if (tab === 'quadrant') return ok((over.quadrant ?? (() => quadrantResponse()))(url))
      return ok((over.targets ?? (() => targetsResponse()))(url))
    },
    '/ads/terms/roots': url => ok((over.roots ?? (() => rootsResponse()))(url)),
    '/views': over.views ?? (() => ok({ items: [], limit: 20 })),
  }
}
