import type { AdsMetricsKey, AdsMetricsResponse, AdsMetricsRow } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告指标页测试用的假服务端数据（只在测试里使用）。

const SPEND_SALES_ACOS: AdsMetricsKey[] = ['spend', 'sales', 'acos']

export const dayRow = (date: string, values: AdsMetricsRow['values']): AdsMetricsRow => ({ key: date, dims: { date }, values, link: null })

/** 按日三行：9-07 有花费与销售额，9-08 花费有、销售额没有（空值），9-14 完全没有金额。 */
export const dailyRows = (): AdsMetricsRow[] => [
  dayRow('2026-09-07', { spend: 6, sales: 20, acos: 0.3 }),
  dayRow('2026-09-08', { spend: 3, sales: null, acos: null }),
  dayRow('2026-09-14', { spend: null, sales: null, acos: null }),
]

export const campaignRows = (): AdsMetricsRow[] => [
  { key: 'C1', dims: { campaign: '春季活动' }, values: { spend: 9, sales: 20, acos: 0.45 }, link: '/app/advertising/campaigns/cam-1' },
  { key: 'C2', dims: { campaign: 'C2' }, values: { spend: 1, sales: 0, acos: null }, link: null },
]

export const metricsResponse = (patch: Partial<AdsMetricsResponse> = {}): AdsMetricsResponse => {
  const items = patch.items ?? dailyRows()
  return {
    state: 'OK',
    note: null,
    dataset: 'CAMPAIGN',
    dimensions: ['date'],
    metrics: SPEND_SALES_ACOS,
    grain: 'day',
    period: { from: '2026-09-23', to: '2026-10-22', days: 30 },
    defaulted: true,
    totals: { spend: 9, sales: 20, acos: 0.45 },
    groupCount: items.length,
    truncated: false,
    items,
    profiles: [{ id: 'ap-a', name: '美国账户', storeName: 'Northstar US' }],
    otherCurrencyRows: 0,
    pageInfo: { pageSize: 50, nextCursor: null, hasMore: false, approxTotal: items.length },
    ...patch,
  }
}

export const metricsHandlers = (response: (url: URL) => AdsMetricsResponse = () => metricsResponse()): Record<string, Handler> => ({ '/ads/metrics': url => ok(response(url)) })
