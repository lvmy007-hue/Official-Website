import { ADS_BUCKET_RULE, ADS_CAMPAIGN_ADVICE_RULES, ADS_OVER_BUDGET_NOTE, ADS_WRITE_PENDING, adsCampaignTabsFor, summarizeLevel } from '@nova/api-contracts'
import type {
  AdsLevelCountsResponse,
  AdsLevelSummary,
  AdsWriteStatusResponse,
  AdsAdviceRule,
  AdsCampaignDetailResponse,
  AdsCampaignListResponse,
  AdsCampaignRow,
  AdsCampaignTrendResponse,
  AdsTermList,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告活动列表与详情测试用的假服务端数据（只在测试里使用）。

/** 活动列表里某一行（按活动 id）的全部文字；列表是 AG Grid 骨架，行不是 <tr>。 */
export const rowText = (id: string) =>
  Array.from(document.querySelectorAll(`[row-id="${id}"]`))
    .map(element => element.textContent ?? '')
    .join(' ')

export const campaignRow = (patch: Partial<AdsCampaignRow> = {}): AdsCampaignRow => ({
  id: 'cam-1',
  adsProfileId: 'ap-a',
  externalCampaignId: 'c1',
  adProduct: 'SPONSORED_PRODUCTS',
  productLabel: '商品推广',
  name: '春季推广',
  targetingType: 'MANUAL',
  state: 'ENABLED',
  servingStatus: null,
  portfolioId: 'PF1',
  portfolioName: '春季组合',
  budget: 100,
  budgetType: 'DAILY',
  currency: 'USD',
  bidStrategy: null,
  startDate: null,
  endDate: null,
  totals: { impressions: 1500, clicks: 75, spend: 60, sales: 200, orders: 6 },
  ratios: { acos: 0.3, roas: 3.33, ctr: 0.05, cpc: 0.8, cvr: 0.08 },
  adsShare: 0.12,
  budgetUtilization: 0.6,
  anomaly: null,
  tags: ['主推'],
  ownerId: 'u1',
  ownerName: '林然',
  storeName: 'Northstar US',
  accountName: '美国账户',
  syncedAt: '2026-10-22T07:00:00Z',
  version: 2,
  ...patch,
})

const baseList = (patch: Partial<AdsCampaignListResponse> = {}): Omit<AdsCampaignListResponse, 'summary'> & { summary?: AdsLevelSummary } => ({
  state: 'OK',
  note: null,
  items: [
    campaignRow(),
    campaignRow({
      id: 'cam-sb',
      name: '品牌旗舰',
      adProduct: 'SPONSORED_BRANDS',
      productLabel: '品牌推广',
      totals: null,
      ratios: null,
      adsShare: null,
      budgetUtilization: null,
      tags: [],
      ownerId: null,
      ownerName: null,
      targetingType: null,
    }),
  ],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
  currency: 'USD',
  filterOptions: { portfolios: [{ id: 'PF1', name: '春季组合' }], tags: ['主推'], owners: [{ id: 'u1', name: '林然' }] },
  members: [{ id: 'u1', name: '林然' }],
  canWrite: true,
  avgOverBudget: { state: 'NOT_CONNECTED', note: ADS_OVER_BUDGET_NOTE },
  write: ADS_WRITE_PENDING,
  truncated: false,
  metricsTruncated: false,
  ...patch,
})

/** 汇总跟着 items 走（服务端口径：筛选后全部对象的合计）；测试可以用 patch.summary 覆盖。 */
export const listResponse = (patch: Partial<AdsCampaignListResponse> = {}): AdsCampaignListResponse => {
  const base = baseList(patch)
  return { ...base, summary: base.summary ?? summarizeLevel(base.items.map(item => item.totals)) }
}

export const emptyList = (patch: Partial<AdsCampaignListResponse> = {}) =>
  listResponse({
    state: 'NOT_CONNECTED',
    note: '可见范围内还没有同步到广告活动；连接广告账户并同步活动后才会出现',
    items: [],
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 0 },
    filterOptions: { portfolios: [], tags: [], owners: [] },
    members: [],
    ...patch,
  })

export const countsResponse = (patch: Partial<AdsLevelCountsResponse> = {}): AdsLevelCountsResponse => ({
  level: 'campaigns',
  state: 'OK',
  note: null,
  range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
  total: 2,
  buckets: { CONVERTED: 1, CLICK_NO_ORDER: 0, IMPRESSION_NO_CLICK: 0, NO_IMPRESSION: 0 },
  withoutMetrics: 1,
  rule: ADS_BUCKET_RULE,
  truncated: false,
  ...patch,
})

export const writeStatus = (enabled = true): AdsWriteStatusResponse => ({
  kinds: (['CAMPAIGN_STATE', 'CAMPAIGN_BUDGET', 'CAMPAIGN_BID_STRATEGY'] as const).map(kind => ({
    kind,
    label: kind,
    permitted: true,
    switchKey: 'ads.write',
    switchEnabled: enabled,
    reason: enabled ? null : '广告写入开关未开启（默认只读）',
  })),
  runs: [],
})

export const listHandlers = (response: (url: URL) => AdsCampaignListResponse): Record<string, Handler> => ({
  '/ads/campaigns': url => ok(response(url)),
  '/ads/campaigns/counts': () => ok(countsResponse()),
  '/ads/writes': () => ok(writeStatus()),
})

const RULES = ADS_CAMPAIGN_ADVICE_RULES
const adviceRules = (patch: Partial<Record<AdsAdviceRule['kind'], Partial<AdsAdviceRule>>> = {}): AdsAdviceRule[] =>
  (
    [
      { kind: 'RAISE_BUDGET', rule: '提高预算', state: 'NOT_CONNECTED', note: '需要预算消耗数据', hits: [] },
      {
        kind: 'WASTED_TARGETS',
        rule: `投放对象花费高但无成交（近 ${RULES.WINDOW_DAYS} 天）`,
        state: 'HIT',
        note: null,
        hits: [
          {
            id: 'waste:K1:EXACT',
            title: '投放词“yoga mat”（EXACT）花费高但没有订单',
            evidence: '近 30 天花费 USD 30.00，点击 30 次，订单 0',
            impact: '最多可省约 USD 30.00 / 30 天',
            risk: '否定后该词不再展示',
            action: 'LOWER_BID',
            recommendationId: null,
          },
        ],
      },
      {
        kind: 'OFFICIAL_RECOMMENDATION',
        rule: '亚马逊官方推荐',
        state: 'HIT',
        note: null,
        hits: [{ id: 'official:rec-1', title: '亚马逊推荐：BUDGET_RULE', evidence: '建议提高预算', impact: '推荐日预算 USD 150.00', risk: '采纳等于写入', action: 'ADOPT', recommendationId: 'rec-1' }],
      },
      { kind: 'STOCKOUT_PRODUCTS', rule: '广告商品已断货', state: 'NO_HIT', note: null, hits: [] },
    ] satisfies AdsAdviceRule[]
  ).map(rule => ({ ...rule, ...patch[rule.kind] }))

export const detailResponse = (patch: Partial<AdsCampaignDetailResponse> = {}, product = 'SPONSORED_PRODUCTS'): AdsCampaignDetailResponse => ({
  identity: {
    id: 'cam-1',
    adsProfileId: 'ap-a',
    externalCampaignId: 'c1',
    adProduct: product,
    productLabel: product === 'SPONSORED_PRODUCTS' ? '商品推广' : '品牌推广',
    name: '春季推广',
    targetingType: 'MANUAL',
    state: 'ENABLED',
    servingStatus: 'CAMPAIGN_STATUS_ENABLED',
    budget: 100,
    budgetType: 'DAILY',
    currency: 'USD',
    bidStrategy: 'LEGACY_FOR_SALES',
    placementAdjustments: { state: 'NOT_CONNECTED', note: '广告位调整没有同步器写入' },
    portfolio: { id: 'PF1', name: '春季组合' },
    account: { name: '美国账户', adsAccountId: 'ACC-1', storeName: 'Northstar US', bindingStatus: 'MANUAL' },
    startDate: null,
    endDate: null,
    syncedAt: '2026-10-22T07:00:00Z',
    tags: ['主推'],
    owner: { id: 'u1', name: '林然' },
    version: 2,
  },
  metrics: {
    state: 'OK',
    note: null,
    period: { from: '2026-09-23', to: '2026-10-22', days: 30 },
    compare: { mode: 'previous', from: '2026-08-24', to: '2026-09-22', days: 30 },
    totals: { impressions: 1500, clicks: 75, spend: 60, sales: 200, orders: 6 },
    previous: { impressions: 1000, clicks: 50, spend: 40, sales: 100, orders: 3 },
    ratios: { acos: 0.3, roas: 3.33, ctr: 0.05, cpc: 0.8, cvr: 0.08 },
    previousRatios: { acos: 0.4, roas: 2.5, ctr: 0.05, cpc: 0.8, cvr: 0.06 },
    adsShare: 0.12,
    budgetUtilization: 0.6,
    avgOverBudget: { state: 'NOT_CONNECTED', note: ADS_OVER_BUDGET_NOTE },
  },
  advice: adviceRules(),
  tabs: adsCampaignTabsFor(product),
  canWrite: true,
  members: [{ id: 'u1', name: '林然' }],
  write: ADS_WRITE_PENDING,
  ...patch,
})

export const noAdviceDetail = (): AdsCampaignDetailResponse =>
  detailResponse({
    advice: adviceRules({ WASTED_TARGETS: { state: 'NO_HIT', hits: [] }, OFFICIAL_RECOMMENDATION: { state: 'NOT_CONNECTED', note: '官方推荐还没有同步', hits: [] } }),
  })

export const emptyMetricsDetail = (): AdsCampaignDetailResponse => {
  const detail = detailResponse()
  return {
    ...detail,
    metrics: { ...detail.metrics, state: 'NO_DATA', note: '所选范围内尚无广告汇总记录', totals: null, previous: null, ratios: null, previousRatios: null, adsShare: null, budgetUtilization: null },
  }
}

export const trendNotConnected = (): AdsCampaignTrendResponse => ({
  state: 'NO_DATA',
  note: '所选范围内尚无这个活动的广告汇总记录',
  period: { from: '2026-09-23', to: '2026-10-22', days: 30 },
  compare: null,
  currency: 'USD',
  points: [],
  previousPoints: [],
  totals: null,
  previous: null,
  events: [],
  amazonEvents: { state: 'NOT_CONNECTED', note: '亚马逊侧改动没有同步器' },
  attribution: { state: 'NO_DATA', note: null, spend: null, sales: null },
})

export const termList = (): AdsTermList => ({
  state: 'OK',
  note: null,
  period: { from: '2026-09-23', to: '2026-10-22', days: 30 },
  matchBasis: '搜索词与投放词完全相同（不分大小写与多余空格）才算已投放或已否定；广泛、词组匹配的命中不算',
  write: ADS_WRITE_PENDING,
  items: [
    { searchTerm: 'yoga mat', status: 'TARGETED', metrics: { impressions: 900, clicks: 30, spend: 12, sales: 90, orders: 3 } },
    { searchTerm: 'cheap yoga mat', status: 'NEGATED', metrics: { impressions: 400, clicks: 40, spend: 25, sales: 0, orders: 0 } },
    { searchTerm: 'yoga block', status: 'UNTARGETED', metrics: { impressions: 100, clicks: 5, spend: 4, sales: null, orders: 0 } },
  ],
  pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: 3 },
  truncated: false,
})

/** 详情页要用到的接口：详情、趋势与搜索词；其他页签没有登记时返回 404，页签会显示读取失败。 */
export const detailHandlers = (detail: () => AdsCampaignDetailResponse): Record<string, Handler> => ({
  '/ads/campaigns/cam-1': () => ok(detail()),
  '/ads/campaigns/cam-1/trend': () => ok(trendNotConnected()),
  '/ads/campaigns/cam-1/search-terms': () => ok(termList()),
})
