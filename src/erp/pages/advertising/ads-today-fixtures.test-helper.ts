import type { AdsTodayHour, AdsTodayResponse } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 今日广告测试用的假服务端数据（只在测试里使用）。

const rules = { CPC_RATIO: 1.5, CPC_MIN_CLICKS: 10, BASELINE_MIN_CLICKS: 50, NO_CONVERSION_MIN_SPEND: 20, NO_CONVERSION_MIN_CLICKS: 20 } as const

const hours = (elapsed: number): AdsTodayHour[] =>
  Array.from({ length: 24 }, (_, index) => ({
    hourStart: new Date(Date.UTC(2026, 9, 23, index)).toISOString(),
    elapsed: index < elapsed,
    spend: index < elapsed ? 3 : null,
    clicks: index < elapsed ? 10 : null,
    sales: null,
    orders: null,
    band: index >= 3 && index < elapsed ? { spendMin: 1, spendMax: 5, clicksMin: 4, clicksMax: 14, samples: 5 } : null,
  }))

const base = (): AdsTodayResponse => ({
  streamState: 'NOT_CONNECTED',
  note: '营销数据流接收端未配置',
  updateNote: '花费与点击来自营销数据流，最快每 15 分钟更新一次；转化滞后。',
  businessDate: '2026-10-23',
  asOf: null,
  currency: 'USD',
  metricVersion: 'p3-06@1',
  otherCurrencies: [],
  totals: { state: 'NOT_CONNECTED', note: '数据流未接入', value: null, yesterdaySameHour: null },
  fallback: null,
  hours: { state: 'NOT_CONNECTED', note: '数据流未接入，没有小时指标', items: [], historyDays: 14 },
  budget: { state: 'NOT_CONNECTED', note: '没有小时指标，无法计算预算消耗', dailyBudgetTotal: null, spentToday: null, progress: null, budgetedCampaigns: 0, ambiguous: 0, rows: [], truncated: false },
  outOfBudget: { state: 'NOT_CONNECTED', note: '尚未接入活动管理数据', count: 0, rows: [] },
  anomalies: { state: 'NOT_CONNECTED', note: '没有小时指标，无法判断异常', rules, count: 0, items: [] },
  stockout: { state: 'NOT_CONNECTED', note: '尚未接入被推广商品日报表', lookbackDays: 3, items: [] },
  truncated: false,
})

export const notConnectedToday = (patch: Partial<AdsTodayResponse> = {}): AdsTodayResponse => ({
  ...base(),
  fallback: {
    summaryDate: '2026-10-22',
    totals: { spend: 321.5, clicks: 700, impressions: 90000, cpc: 0.46, sales: 1500, orders: 40 },
    refreshedAt: '2026-10-22T20:00:00Z',
  },
  ...patch,
})

export const noDataToday = (): AdsTodayResponse => ({
  ...base(),
  streamState: 'NO_DATA',
  note: '接收端已配置，但今天还没有收到小时指标',
  totals: { state: 'NO_DATA', note: '今天还没有小时指标', value: null, yesterdaySameHour: null },
  hours: { state: 'NO_DATA', note: '今天还没有小时指标', items: [], historyDays: 14 },
})

export const liveToday = (patch: Partial<AdsTodayResponse> = {}): AdsTodayResponse => ({
  ...base(),
  streamState: 'LIVE',
  note: null,
  asOf: '2026-10-23T06:15:00Z',
  totals: {
    state: 'OK',
    note: null,
    value: { spend: 18, clicks: 60, impressions: 5000, cpc: 0.3, sales: 52.5, orders: 2 },
    yesterdaySameHour: { spend: 15, clicks: 50, impressions: 4000, cpc: 0.3, sales: 40, orders: 1 },
  },
  hours: { state: 'OK', note: null, items: hours(6), historyDays: 14 },
  budget: {
    state: 'OK',
    note: '估算：按今天已过去时间的平均花费速度外推',
    dailyBudgetTotal: 70,
    spentToday: 18,
    progress: 0.2571,
    budgetedCampaigns: 2,
    ambiguous: 0,
    rows: [
      { key: 'p|c1', adsProfileId: 'p', campaignId: 'c1', name: '核心词活动', dailyBudget: 20, spend: 12, progress: 0.6, exhaust: 'PROJECTED', exhaustAt: '2026-10-23T10:00:00Z' },
      { key: 'p|c2', adsProfileId: 'p', campaignId: 'c2', name: '品牌词活动', dailyBudget: 50, spend: null, progress: null, exhaust: 'NO_SPEND', exhaustAt: null },
    ],
    truncated: false,
  },
  outOfBudget: {
    state: 'OK',
    note: '超预算状态来自活动管理接口的投放状态，不是实时的。',
    count: 1,
    rows: [{ key: 'p|SP|c9', adsProfileId: 'p', adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c9', name: '预算用完活动', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' }],
  },
  anomalies: {
    state: 'OK',
    note: null,
    rules,
    count: 2,
    items: [
      { key: 'p|c1', kind: 'CPC_SURGE', adsProfileId: 'p', campaignId: 'c1', name: '核心词活动', spend: 12, clicks: 30, orders: 1, cpc: 0.4, baselineCpc: 0.2, ratio: 2 },
      { key: 'p|c3', kind: 'SPEND_NO_CONVERSION', adsProfileId: 'p', campaignId: 'c3', name: '无转化活动', spend: 25, clicks: 40, orders: 0, cpc: 0.625, baselineCpc: null, ratio: null },
    ],
  },
  stockout: {
    state: 'OK',
    note: '库存是日级快照，不是实时库存。',
    lookbackDays: 3,
    items: [{ key: 'a|B0AAA', asin: 'B0AAA', sellerAccountId: 'a', storeName: '美国店', sellable: 0, snapshotDate: '2026-10-22', spend: 30, days: 3, dailyWaste: 10 }],
  },
  ...patch,
})

export const todayHandlers = (today: (url: URL) => unknown): Record<string, Handler> => ({ '/ads/today': url => ok(today(url)) })
