import type { Handler } from '../../test/app-harness'

// 广告控制台测试用的假服务端数据（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const PERIOD = { from: '2026-09-23', to: '2026-10-22', days: 30 }
const COMPARE = { mode: 'previous', from: '2026-08-24', to: '2026-09-22', days: 30 }

const KEYS = ['spend', 'sales', 'acos', 'adsShare', 'roas', 'ctr', 'cpc', 'cvr', 'orders', 'clicks', 'haloSales', 'overBudget'] as const
const FORMAT: Record<string, string> = {
  spend: 'money',
  sales: 'money',
  acos: 'percent',
  adsShare: 'percent',
  roas: 'number',
  ctr: 'percent',
  cpc: 'money',
  cvr: 'percent',
  orders: 'number',
  clicks: 'number',
  haloSales: 'money',
  overBudget: 'number',
}

const card = (key: string, patch: Record<string, unknown> = {}) => ({
  key,
  label: `${key}卡`,
  state: 'NOT_CONNECTED',
  format: FORMAT[key],
  value: null,
  compareValue: null,
  change: null,
  changeKind: 'ratio',
  trend: null,
  note: `${key}尚未接入的原因`,
  ...patch,
})

const anomalyRules = { MIN_SPEND: 20, MIN_CLICKS: 20, ACOS_LIMIT: 1 }

/** 一个全空的响应：从未有过广告汇总记录。 */
export const emptyOverview = (patch: Record<string, unknown> = {}) => ({
  period: PERIOD,
  compare: COMPARE,
  defaulted: true,
  currency: 'USD',
  state: 'NOT_CONNECTED',
  note: '可见范围内还没有广告汇总记录',
  refreshedAt: null,
  metricVersion: null,
  otherCurrencies: [],
  unboundSpend: null,
  granularity: 'day',
  cards: KEYS.map(key => card(key)),
  trend: { state: 'NOT_CONNECTED', note: '趋势尚未接入', points: [], events: [] },
  mix: { state: 'NOT_CONNECTED', note: '拆分尚未接入', points: [] },
  products: [
    { adProduct: 'SPONSORED_PRODUCTS', label: '商品推广', state: 'NOT_CONNECTED', note: '尚未同步', spend: null, sales: null, orders: 0, spendShare: null },
    { adProduct: 'SPONSORED_BRANDS', label: '品牌推广', state: 'NOT_CONNECTED', note: '同步器未交付', spend: null, sales: null, orders: 0, spendShare: null },
  ],
  funnel: { state: 'NOT_CONNECTED', note: '漏斗尚未接入', value: null },
  budget: { state: 'NOT_CONNECTED', note: '预算尚未接入', days: [], dailyBudgetTotal: null, utilization: null, budgetedCampaigns: 0, overBudget: { state: 'NOT_CONNECTED', note: '需要活动管理接口' } },
  targetAcos: { state: 'NOT_CONNECTED', note: '目标 ACoS 需要活动目标字段' },
  quadrant: { state: 'NOT_CONNECTED', note: '象限尚未接入', spendLine: null, acosLine: null, points: [], withoutSales: 0 },
  anomalies: { state: 'NOT_CONNECTED', note: '异常尚未接入', count: 0, items: [], rules: anomalyRules },
  attribution: { state: 'NOT_CONNECTED', note: '归因尚未接入', spend: null, sales: null },
  campaignsTruncated: false,
  ...patch,
})

const days = ['2026-10-01', '2026-10-02', '2026-10-03']

/** 一个有数据的响应。 */
export const dataOverview = (patch: Record<string, unknown> = {}) => ({
  ...emptyOverview(),
  state: 'OK',
  note: null,
  refreshedAt: '2026-10-22T07:00:00Z',
  metricVersion: 'v1',
  cards: KEYS.map(key => {
    if (key === 'haloSales' || key === 'overBudget') return card(key)
    return card(key, {
      state: 'OK',
      value: key === 'spend' ? 1234.5 : key === 'acos' ? 0.25 : 10,
      compareValue: 1000,
      change: key === 'acos' ? 0.02 : 0.1,
      changeKind: key === 'acos' ? 'points' : 'ratio',
      trend: [1, null, 3],
      note: null,
    })
  }),
  trend: { state: 'OK', note: null, points: days.map((key, index) => ({ key, spend: 10 + index, sales: index === 1 ? null : 40 + index })), events: [] },
  mix: { state: 'OK', note: null, points: days.map(key => ({ key, totalSales: 100, adSales: 40, organicSales: 60, adSpend: 10, adsShare: 0.1 })) },
  products: [
    { adProduct: 'SPONSORED_PRODUCTS', label: '商品推广', state: 'OK', note: null, spend: 1234.5, sales: 4938, orders: 77, spendShare: 1 },
    { adProduct: 'SPONSORED_BRANDS', label: '品牌推广', state: 'NOT_CONNECTED', note: '同步器未交付', spend: null, sales: null, orders: 0, spendShare: null },
  ],
  funnel: { state: 'OK', note: null, value: { impressions: 10000, clicks: 200, orders: 20, clickRate: 0.02, conversionRate: 0.1 } },
  budget: {
    state: 'OK',
    note: '估算：按今天的日预算回看',
    days: days.map(date => ({ date, spend: 12 })),
    dailyBudgetTotal: 50,
    utilization: 0.24,
    budgetedCampaigns: 2,
    overBudget: { state: 'NOT_CONNECTED', note: '需要活动管理接口' },
  },
  quadrant: {
    state: 'OK',
    note: null,
    spendLine: 50,
    acosLine: 0.3,
    withoutSales: 1,
    points: [
      { key: 'p:SP:c1', adsProfileId: 'p', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c1', name: '核心词活动', spend: 80, sales: 400, orders: 9, acos: 0.2, quadrant: 'STAR' },
      { key: 'p:SP:c2', adsProfileId: 'p', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c2', name: '烧钱活动', spend: 90, sales: 100, orders: 2, acos: 0.9, quadrant: 'WASTE' },
    ],
  },
  anomalies: {
    state: 'OK',
    note: null,
    count: 1,
    items: [{ key: 'p:SP:c3', adsProfileId: 'p', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c3', name: '无转化活动', kind: 'NO_CONVERSION', spend: 55, sales: 0, clicks: 60, orders: 0 }],
    rules: anomalyRules,
  },
  attribution: {
    state: 'OK',
    note: null,
    spend: {
      title: '广告花费',
      before: 100,
      after: 150,
      factors: [
        { key: 'clicks', label: '点击', before: 100, after: 120 },
        { key: 'cpc', label: '单次点击花费', before: 1, after: 1.25 },
      ],
    },
    sales: null,
  },
  ...patch,
})

export const adsHandlers = (overview: (url: URL) => unknown): Record<string, Handler> => ({ '/ads/overview': url => ok(overview(url)) })
