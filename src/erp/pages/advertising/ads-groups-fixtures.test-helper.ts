import { ADS_GROUP_TABS, ADS_GROUP_WRITE_NOTE, ADS_TARGET_WRITE_NOTE, ADS_WRITE_PENDING, adsTargetTabsFor } from '@nova/api-contracts'
import type {
  AdsEntityMetricsBlock,
  AdsGroupDetailResponse,
  AdsGroupProductRow,
  AdsNegativeList,
  AdsTabList,
  AdsTargetBidHistoryResponse,
  AdsTargetDetailResponse,
  AdsTargetRow,
  AdsTargetTermList,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { trendNotConnected } from './ads-campaigns-fixtures.test-helper'
import { ok } from './ads-fixtures.test-helper'

// 广告组与投放对象详情测试用的假服务端数据（只在测试里使用）。

const period = { from: '2026-09-23', to: '2026-10-22', days: 30 }
const pageInfo = { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: 1 }
const account = { name: '美国账户', adsAccountId: 'ACC-1', storeName: 'Northstar US', bindingStatus: 'MANUAL' }
const campaign = { id: 'cam-1', externalCampaignId: 'c1', name: '春季推广', productLabel: '商品推广' }

const metricsBlock = (patch: Partial<AdsEntityMetricsBlock> = {}): AdsEntityMetricsBlock => ({
  state: 'OK',
  note: null,
  period,
  compare: { mode: 'previous', from: '2026-08-24', to: '2026-09-22', days: 30 },
  totals: { impressions: 1500, clicks: 75, spend: 60, sales: 200, orders: 6 },
  previous: { impressions: 1000, clicks: 50, spend: 40, sales: 100, orders: 3 },
  ratios: { acos: 0.3, roas: 3.33, ctr: 0.05, cpc: 0.8, cvr: 0.08 },
  previousRatios: { acos: 0.4, roas: 2.5, ctr: 0.05, cpc: 0.8, cvr: 0.06 },
  ...patch,
})

export const groupDetail = (patch: Partial<AdsGroupDetailResponse> = {}): AdsGroupDetailResponse => ({
  identity: { id: 'ag-1', adsProfileId: 'ap-a', adGroupId: 'AG1', name: '核心词组', state: 'ENABLED', defaultBid: 1.2, currency: 'USD', campaign, account, syncedAt: '2026-10-22T07:00:00Z' },
  metrics: metricsBlock(),
  tabs: ADS_GROUP_TABS.map(tab => ({ key: tab.key, label: tab.label })),
  write: { state: ADS_WRITE_PENDING.state, note: ADS_GROUP_WRITE_NOTE },
  ...patch,
})

export const targetDetail = (kind: 'KEYWORD' | 'PRODUCT' = 'KEYWORD', patch: Partial<AdsTargetDetailResponse> = {}): AdsTargetDetailResponse => ({
  identity: {
    id: kind === 'KEYWORD' ? 'kw-1' : 'tg-1',
    adsProfileId: 'ap-a',
    targetId: 'K1',
    kind,
    kindLabel: kind === 'KEYWORD' ? '关键词' : '商品',
    expression: kind === 'KEYWORD' ? 'yoga mat' : 'asin="B0XYZ"',
    matchType: kind === 'KEYWORD' ? 'EXACT' : null,
    state: 'ENABLED',
    bid: 1.5,
    currency: 'USD',
    suggestedBid: { low: 0.8, high: 1.6, point: 1.2, receivedAt: '2026-10-22T00:00:00Z' },
    campaign,
    adGroup: { id: 'ag-1', adGroupId: 'AG1', name: '核心词组' },
    account,
    syncedAt: '2026-10-22T07:00:00Z',
  },
  metrics: metricsBlock(),
  tabs: adsTargetTabsFor(kind),
  write: { state: ADS_WRITE_PENDING.state, note: ADS_TARGET_WRITE_NOTE },
  ...patch,
})

export const noMetricsGroup = (): AdsGroupDetailResponse =>
  groupDetail({ metrics: metricsBlock({ state: 'NO_DATA', note: '所选范围内尚无这个广告组的指标记录', totals: null, previous: null, ratios: null, previousRatios: null }) })

const targetRow = (patch: Partial<AdsTargetRow> = {}): AdsTargetRow => ({
  id: 'kw-1',
  key: 'K1',
  targetId: 'K1',
  kind: 'KEYWORD',
  expression: 'yoga mat',
  matchType: 'EXACT',
  bid: 1.5,
  state: 'ENABLED',
  adGroupId: 'AG1',
  adGroupName: '核心词组',
  suggestedBid: 1.2,
  metrics: { impressions: 1000, clicks: 30, spend: 30, sales: 100, orders: 6 },
  ...patch,
})

const list = <T>(items: T[], patch: Partial<AdsTabList<T>> = {}): AdsTabList<T> => ({ state: 'OK', note: null, items, pageInfo, truncated: false, ...patch })

const products = (): AdsTabList<AdsGroupProductRow> =>
  list([
    {
      adId: 'AD1',
      asin: 'B0AAA',
      sku: 'SKU-1',
      state: 'ENABLED',
      title: '瑜伽垫',
      imageUrl: null,
      metrics: { impressions: 100, clicks: 10, spend: 12, sales: 30, orders: 2 },
      sellable: 0,
      snapshotDate: '2026-10-21',
      stock: 'OUT_OF_STOCK',
    },
    { adId: 'AD2', asin: null, sku: null, state: 'PAUSED', title: null, imageUrl: null, metrics: null, sellable: null, snapshotDate: null, stock: 'UNKNOWN' },
  ])

const negatives = (): AdsNegativeList => ({
  ...list([
    { negativeId: 'N1', level: 'CAMPAIGN' as const, expression: 'cheap yoga mat', matchType: 'NEGATIVE_EXACT' },
    { negativeId: 'N2', level: 'AD_GROUP' as const, expression: 'free yoga', matchType: 'NEGATIVE_PHRASE' },
  ]),
  write: { state: ADS_WRITE_PENDING.state, note: ADS_GROUP_WRITE_NOTE },
})

export const groupHandlers = (detail: () => AdsGroupDetailResponse = groupDetail): Record<string, Handler> => ({
  '/ads/ad-groups/ag-1': () => ok(detail()),
  '/ads/ad-groups/ag-1/trend': () => ok(trendNotConnected()),
  '/ads/ad-groups/ag-1/targets': () => ok(list([targetRow(), targetRow({ id: 'tg-1', key: 'T1', kind: 'PRODUCT', expression: 'asin="B0XYZ"', matchType: null, metrics: null, suggestedBid: null })])),
  '/ads/ad-groups/ag-1/products': () => ok(products()),
  '/ads/ad-groups/ag-1/negatives': () => ok(negatives()),
  '/ads/ad-groups/ag-1/history': () =>
    ok({
      state: 'NO_DATA',
      note: `本系统内还没有对这个广告组做过改动（${ADS_GROUP_WRITE_NOTE}）`,
      items: [],
      truncated: false,
      amazonSide: { state: 'NOT_CONNECTED', note: '亚马逊侧改动没有同步器' },
    }),
})

const termList = (): AdsTargetTermList => ({
  ...list([{ searchTerm: 'yoga mat', matchedExpression: 'yoga mat', metrics: { impressions: 900, clicks: 30, spend: 12, sales: 90, orders: 3 } }]),
  period,
})

const side = (days: number, totals: { spend: number; orders: number; acos: number } | null) => ({
  days: 7,
  daysWithData: days,
  totals: totals ? { impressions: 100, clicks: 10, spend: totals.spend, sales: totals.spend / totals.acos, orders: totals.orders } : null,
  ratios: totals ? { acos: totals.acos, roas: 1 / totals.acos, ctr: 0.1, cpc: 1, cvr: 0.1 } : null,
})

export const bidHistory = (withChange = true): AdsTargetBidHistoryResponse => ({
  current: { bid: 1.5, currency: 'USD', suggestedBid: { low: 0.8, high: 1.6, point: 1.2, receivedAt: null } },
  changes: withChange
    ? {
        state: 'OK',
        note: null,
        truncated: false,
        items: [
          {
            id: 'ev-1',
            at: '2026-10-19T12:00:00Z',
            actor: '林然',
            source: 'manual',
            beforeBid: 1.2,
            afterBid: 1.5,
            title: '竞价 1.2 → 1.5',
            before: side(1, { spend: 10, orders: 1, acos: 0.5 }),
            after: side(0, null),
          },
        ],
      }
    : { state: 'NO_DATA', note: '本系统内还没有对这个投放对象调过价', items: [], truncated: false },
  amazonSide: { state: 'NOT_CONNECTED', note: '亚马逊侧调价没有同步器' },
  write: { state: ADS_WRITE_PENDING.state, note: ADS_TARGET_WRITE_NOTE },
})

export const targetHandlers = (
  id = 'kw-1',
  detail: () => AdsTargetDetailResponse = () => targetDetail(),
  history: () => AdsTargetBidHistoryResponse = () => bidHistory(),
): Record<string, Handler> => ({
  [`/ads/targets/${id}`]: () => ok(detail()),
  [`/ads/targets/${id}/trend`]: () => ok(trendNotConnected()),
  [`/ads/targets/${id}/search-terms`]: () => ok(termList()),
  [`/ads/targets/${id}/placements`]: () => ok({ state: 'NOT_CONNECTED', note: '亚马逊的广告位报告只到活动级', campaignId: 'cam-1' }),
  [`/ads/targets/${id}/bid-history`]: () => ok(history()),
  [`/ads/targets/${id}/brand-analytics`]: () => ok({ state: 'NOT_CONNECTED', note: '品牌分析随 P4-04', keyword: 'yoga mat' }),
})
