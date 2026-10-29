import {
  ADS_BUDGET_RULES_DISABLED_NOTE,
  ADS_BUDGET_RULES_FLAG,
  ADS_PORTFOLIO_PACE_BASIS,
  ADS_PORTFOLIO_WRITE_PENDING,
  summarizePortfolios,
  type AdsPortfolioCampaignShare,
  type AdsPortfolioDetailResponse,
  type AdsPortfolioListResponse,
  type AdsPortfolioRow,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告组合页测试用的假服务端数据（只在测试里使用）。

const TOTALS = { impressions: 12000, clicks: 240, spend: 135, sales: 540, orders: 18 }
const RATIOS = { acos: 0.25, roas: 4, ctr: 0.02, cpc: 0.56, cvr: 0.075 }

export const portfolioRow = (patch: Partial<AdsPortfolioRow> = {}): AdsPortfolioRow => ({
  id: 'pf-1',
  portfolioId: 'PF1',
  name: '春季组合',
  status: 'ENABLED',
  adsProfileId: 'ap-a',
  accountName: '美国账户',
  storeName: 'Northstar US',
  currency: 'USD',
  budget: { cap: 300, kind: 'DATE_RANGE', from: '2026-10-14', to: '2026-11-12', issue: null },
  spent: 135,
  spentSource: 'REPORTS',
  reportedSpent: 7,
  pace: { state: 'OK', note: '历史花费不足，理想曲线按天均摊', verdict: 'AHEAD', elapsedDays: 9, totalDays: 30, idealSpent: 90, spent: 135, ratio: 1.5, shape: 'LINEAR', capReached: false },
  campaigns: { total: 2, enabled: 1 },
  totals: TOTALS,
  ratios: RATIOS,
  syncedAt: '2026-10-22T08:00:00.000Z',
  ...patch,
})

/** 四行：偏快；偏慢；没有预算上限；周期不认识且非美元（不折算）。 */
export const sampleRows = (): AdsPortfolioRow[] => [
  portfolioRow(),
  portfolioRow({
    id: 'pf-2',
    portfolioId: 'PF2',
    name: '夏季组合',
    spent: 45,
    pace: { state: 'OK', note: null, verdict: 'BEHIND', elapsedDays: 9, totalDays: 30, idealSpent: 90, spent: 45, ratio: 0.5, shape: 'HISTORY', capReached: false },
    totals: { impressions: 3000, clicks: 60, spend: 45, sales: 180, orders: 6 },
  }),
  portfolioRow({
    id: 'pf-3',
    portfolioId: 'PF3',
    name: '无预算组合',
    storeName: null,
    budget: { cap: null, kind: 'UNKNOWN', from: null, to: null, issue: '没有同步到预算周期，无法计算节奏' },
    spent: 0,
    spentSource: 'PORTFOLIO',
    pace: { state: 'NO_BUDGET', note: '这个组合没有设置预算上限', verdict: null, elapsedDays: 0, totalDays: null, idealSpent: null, spent: 0, ratio: null, shape: null, capReached: false },
    campaigns: { total: 0, enabled: 0 },
    totals: null,
    ratios: null,
  }),
  portfolioRow({
    id: 'pf-4',
    portfolioId: 'PF4',
    name: '加元组合',
    currency: 'CAD',
    budget: { cap: 100, kind: 'UNKNOWN', from: null, to: null, issue: '预算周期“DAILY”不是按月或指定日期范围，不计算节奏' },
    spent: 20,
    spentSource: 'PORTFOLIO',
    pace: {
      state: 'OTHER_CURRENCY',
      note: '组合币种是 CAD，节奏只按美元计算，不折算',
      verdict: null,
      elapsedDays: 0,
      totalDays: null,
      idealSpent: null,
      spent: 20,
      ratio: null,
      shape: null,
      capReached: false,
    },
    totals: null,
    ratios: null,
  }),
]

export const listResponse = (patch: Partial<AdsPortfolioListResponse> = {}): AdsPortfolioListResponse => {
  const items = patch.items ?? sampleRows()
  return {
    state: 'OK',
    note: null,
    items,
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
    businessDate: '2026-10-23',
    currency: 'USD',
    summary: summarizePortfolios(items),
    paceBasis: ADS_PORTFOLIO_PACE_BASIS,
    write: ADS_PORTFOLIO_WRITE_PENDING,
    truncated: false,
    metricsTruncated: false,
    ...patch,
  }
}

export const emptyList = (patch: Partial<AdsPortfolioListResponse> = {}) =>
  listResponse({ state: 'NOT_CONNECTED', note: '可见范围内还没有同步到广告组合；连接广告账户并同步广告组合后才会出现', items: [], ...patch })

export const listHandlers = (response: (url: URL) => AdsPortfolioListResponse): Record<string, Handler> => ({ '/ads/portfolios': url => ok(response(url)) })

const dayText = (index: number) => `2026-10-${String(14 + index).padStart(2, '0')}`

export const shares = (): AdsPortfolioCampaignShare[] => [
  {
    id: 'cam-1',
    name: '春季推广',
    adProduct: 'SPONSORED_PRODUCTS',
    productLabel: '商品推广',
    state: 'ENABLED',
    servingStatus: null,
    budget: 50,
    budgetType: 'DAILY',
    currency: 'USD',
    spend: 90,
    spendShare: 2 / 3,
    budgetShare: 1,
  },
  {
    id: 'cam-2',
    name: '春季暂停',
    adProduct: 'SPONSORED_PRODUCTS',
    productLabel: '商品推广',
    state: 'PAUSED',
    servingStatus: null,
    budget: 30,
    budgetType: 'DAILY',
    currency: 'USD',
    spend: 45,
    spendShare: 1 / 3,
    budgetShare: null,
  },
  {
    id: 'cam-3',
    name: '没有汇总的活动',
    adProduct: 'SPONSORED_BRANDS',
    productLabel: '品牌推广',
    state: 'ENABLED',
    servingStatus: null,
    budget: null,
    budgetType: null,
    currency: 'USD',
    spend: null,
    spendShare: null,
    budgetShare: null,
  },
]

export const detailResponse = (patch: Partial<AdsPortfolioDetailResponse> = {}): AdsPortfolioDetailResponse => ({
  row: portfolioRow(),
  businessDate: '2026-10-23',
  // 周期 10-14 至 11-12（30 天），到 10-22 走完 9 天，实际 135，理想按天均摊 10 / 天
  curve: Array.from({ length: 30 }, (_item, index) => ({
    date: index < 18 ? dayText(index) : `2026-11-${String(index - 17).padStart(2, '0')}`,
    ideal: (index + 1) * 10,
    actual: index < 9 ? (index + 1) * 15 : null,
    daily: index < 9 ? 15 : null,
  })),
  advice: {
    kind: 'EXHAUST_EARLY',
    text: '实际花费比理想节奏快 50%；预算会在 2026-11-03 前后用完，早于周期结束日 2026-11-12。可以降低日预算，剩余 21 天每天最多 $7.86',
    remainingDays: 21,
    remainingBudget: 165,
    sustainableDaily: 7.857143,
    currentDailyBudget: 50,
    recentDaily: 16.43,
    exhaustDate: '2026-11-03',
  },
  adviceNote: null,
  allocation: { state: 'OK', note: null, items: shares(), truncated: false, period: { from: '2026-10-14', to: '2026-10-22', basis: 'BUDGET_PERIOD' } },
  rules: { state: 'DISABLED', note: ADS_BUDGET_RULES_DISABLED_NOTE, flag: ADS_BUDGET_RULES_FLAG, items: [] },
  range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
  paceBasis: ADS_PORTFOLIO_PACE_BASIS,
  write: ADS_PORTFOLIO_WRITE_PENDING,
  ...patch,
})

export const detailHandlers = (response: () => AdsPortfolioDetailResponse = () => detailResponse()): Record<string, Handler> => ({ '/ads/portfolios/pf-1': () => ok(response()) })
