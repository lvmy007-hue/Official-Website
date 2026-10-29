import { summarizeLevel, type AdsAdGroupListResponse, type AdsAdGroupListRow, type AdsLevelCountsResponse } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'
import { countsResponse } from './ads-campaigns-fixtures.test-helper'

// 广告层级统一骨架的测试数据：广告组列表与分类计数（只在测试里使用）。

export const groupRow = (patch: Partial<AdsAdGroupListRow> = {}): AdsAdGroupListRow => ({
  id: 'ag-1',
  adsProfileId: 'ap-1',
  adGroupId: 'AG1',
  name: '核心词组',
  state: 'ENABLED',
  defaultBid: 1.2,
  campaignId: 'cam-1',
  campaignName: '春季推广',
  externalCampaignId: 'C1',
  portfolioId: 'PF1',
  currency: 'USD',
  storeName: 'Northstar US',
  accountName: '美国账户',
  totals: { impressions: 1000, clicks: 100, spend: 40, sales: 100, orders: 5 },
  ratios: { acos: 0.4, roas: 2.5, ctr: 0.1, cpc: 0.4, cvr: 0.05 },
  ...patch,
})

export const groupList = (patch: Partial<AdsAdGroupListResponse> = {}): AdsAdGroupListResponse => {
  const items = patch.items ?? [groupRow(), groupRow({ id: 'ag-2', name: '无指标组', totals: null, ratios: null, campaignId: null, campaignName: null })]
  return {
    state: 'OK',
    note: null,
    items,
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
    currency: 'USD',
    summary: summarizeLevel(items.map(item => item.totals)),
    filterOptions: { portfolios: [{ id: 'PF1', name: '春季组合' }] },
    truncated: false,
    ...patch,
  }
}

export const groupCounts = (patch: Partial<AdsLevelCountsResponse> = {}) => countsResponse({ level: 'ad-groups', ...patch })

export const groupHandlers = (list: (url: URL) => AdsAdGroupListResponse = () => groupList(), counts: (url: URL) => AdsLevelCountsResponse = () => groupCounts()): Record<string, Handler> => ({
  '/ads/ad-groups': url => ok(list(url)),
  '/ads/ad-groups/counts': url => ok(counts(url)),
})
