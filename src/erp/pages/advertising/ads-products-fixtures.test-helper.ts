import { ADS_ASIN_HALO_NOTE, ADS_ASIN_ORGANIC_BASIS, ADS_ASIN_PROFIT_NOTE, ADS_ASIN_WRITE_PENDING, summarizeAsins, summarizeLevel } from '@nova/api-contracts'
import type { AdsAsinListResponse, AdsAsinRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告商品页测试用的假服务端数据（只在测试里使用）。

export const asinRow = (patch: Partial<AdsAsinRow> = {}): AdsAsinRow => ({
  key: 's1|B0AAA',
  asin: 'B0AAA',
  title: '瑜伽垫 加厚',
  imageUrl: null,
  storeId: 's1',
  storeName: 'Northstar US',
  totals: { impressions: 1500, clicks: 75, spend: 40, sales: 160, orders: 6 },
  ratios: { acos: 0.25, roas: 4, ctr: 0.05, cpc: 0.53, cvr: 0.08 },
  totalSales: 400,
  adsShare: 0.1,
  organicSales: 240,
  organicIssue: null,
  haloSales: 15,
  campaigns: 3,
  ads: { enabled: 2, total: 3 },
  stock: 'IN_STOCK',
  sellable: 18,
  snapshotDate: '2026-10-22',
  ...patch,
})

/** 三行：有货的、断货仍在花钱的（口径不符）、什么都没有的（未绑定店铺）。 */
export const sampleRows = (): AdsAsinRow[] => [
  asinRow(),
  asinRow({
    key: 's1|B0BBB',
    asin: 'B0BBB',
    title: '泡沫轴',
    totals: { impressions: 800, clicks: 40, spend: 25, sales: 100, orders: 3 },
    ratios: { acos: 0.25, roas: 4, ctr: 0.05, cpc: 0.62, cvr: 0.07 },
    totalSales: 50,
    adsShare: 0.5,
    organicSales: null,
    organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL',
    haloSales: 0,
    campaigns: 1,
    ads: null,
    stock: 'OUT_OF_STOCK',
    sellable: 0,
  }),
  asinRow({
    key: '-|B0CCC',
    asin: 'B0CCC',
    title: null,
    storeId: null,
    storeName: null,
    totals: { impressions: 100, clicks: 5, spend: 4, sales: null, orders: 0 },
    ratios: { acos: null, roas: null, ctr: 0.05, cpc: 0.8, cvr: 0 },
    totalSales: null,
    adsShare: null,
    organicSales: null,
    haloSales: null,
    campaigns: 1,
    ads: null,
    stock: 'UNKNOWN',
    sellable: null,
    snapshotDate: null,
  }),
]

export const listResponse = (patch: Partial<AdsAsinListResponse> = {}): AdsAsinListResponse => {
  const items = patch.items ?? sampleRows()
  return {
    state: 'OK',
    note: null,
    items,
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    range: { from: '2026-09-23', to: '2026-10-22', defaulted: true },
    currency: 'USD',
    summary: summarizeAsins(items),
    level: summarizeLevel(items.map(item => item.totals)),
    halo: { state: 'OK', note: null },
    profit: { state: 'NOT_CONNECTED', note: ADS_ASIN_PROFIT_NOTE },
    organicBasis: ADS_ASIN_ORGANIC_BASIS,
    write: ADS_ASIN_WRITE_PENDING,
    truncated: false,
    metricsTruncated: false,
    ...patch,
  }
}

export const emptyList = (patch: Partial<AdsAsinListResponse> = {}) =>
  listResponse({ state: 'NOT_CONNECTED', note: '被推广商品日报表还没有同步（需要广告报表的“被推广商品”报告）', items: [], halo: { state: 'NOT_CONNECTED', note: ADS_ASIN_HALO_NOTE }, ...patch })

export const listHandlers = (response: (url: URL) => AdsAsinListResponse): Record<string, Handler> => ({ '/ads/products': url => ok(response(url)) })
