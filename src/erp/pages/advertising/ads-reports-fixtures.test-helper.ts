import { ADS_PARITY_SUNSET_NOTE, ADS_REPORT_HISTORY_NOTE, ADS_REPORT_TEMPLATES } from '@nova/api-contracts'
import type { AdsParityDiffsResponse, AdsParityResponse, AdsParityRunRow, AdsReportListResponse, AdsReportRow, AdsReportTemplatesResponse } from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { ok } from './ads-fixtures.test-helper'

// 广告报表页测试用的假服务端数据（只在测试里使用）。

const profile = { id: 'ap-a', name: '美国账户', storeName: 'Northstar US' }

export const reportRow = (patch: Partial<AdsReportRow> = {}): AdsReportRow => ({
  id: 'rp-1',
  source: 'V1',
  templateKey: 'CAMPAIGN_DAILY',
  title: '活动日报',
  adProduct: 'SPONSORED_PRODUCTS',
  granularity: 'DAILY',
  dimensions: ['date', 'adProduct', 'campaignId'],
  metrics: ['impressions', 'clicks', 'cost', 'sales', 'purchases'],
  from: '2026-09-01',
  to: '2026-09-30',
  status: 'READY',
  importedRows: 1280,
  skippedRows: 3,
  warnings: [],
  failureCode: null,
  failureText: null,
  attempt: 1,
  retryOfId: null,
  canRetry: false,
  createdAt: '2026-10-22T08:00:00.000Z',
  startedAt: '2026-10-22T08:00:05.000Z',
  finishedAt: '2026-10-22T08:03:00.000Z',
  profile,
  requestedByName: '王小明',
  ...patch,
})

/** 四条：已完成（带警告、跳过行）、失败（可重试）、排队中（没有行数）、旧版接口的失败任务（不能重试）。 */
export const sampleReports = (): AdsReportRow[] => [
  reportRow({ warnings: [{ code: 'DATA_DELAYED', message: '近 3 天的数据可能还会调整' }] }),
  reportRow({
    id: 'rp-2',
    title: '搜索词日报',
    templateKey: 'SEARCH_TERM_DAILY',
    status: 'FAILED',
    importedRows: null,
    skippedRows: null,
    failureCode: 'ADS_REPORT_ROWS_UNREADABLE',
    failureText: '报告里没有一行能按模板解析',
    canRetry: true,
  }),
  reportRow({ id: 'rp-3', title: '广告位日报', templateKey: 'PLACEMENT_DAILY', status: 'PENDING', importedRows: null, skippedRows: null, attempt: 2, retryOfId: 'rp-9' }),
  reportRow({
    id: 'rp-4',
    source: 'LEGACY',
    templateKey: null,
    title: 'spCampaigns',
    status: 'FAILED',
    importedRows: null,
    skippedRows: null,
    failureCode: 'FAILED',
    failureText: '任务失败（FAILED）',
    granularity: null,
    dimensions: [],
    metrics: [],
  }),
]

export const listResponse = (patch: Partial<AdsReportListResponse> = {}): AdsReportListResponse => {
  const items = patch.items ?? sampleReports()
  return {
    state: 'OK',
    note: null,
    items,
    counts: { PENDING: 1, GENERATING: 0, READY: 1, FAILED: 2 },
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    ...patch,
  }
}

export const templatesResponse = (patch: Partial<AdsReportTemplatesResponse> = {}): AdsReportTemplatesResponse => ({
  state: 'OK',
  note: null,
  templates: [...ADS_REPORT_TEMPLATES],
  profiles: [
    { ...profile, ready: true, notReadyReason: null, historyFrom: '2026-08-20', historyProbedAt: '2026-10-22T08:03:00.000Z' },
    { id: 'ap-u', name: '加拿大账户', storeName: null, ready: false, notReadyReason: '还没有发现统一接口的广告账户编号', historyFrom: null, historyProbedAt: null },
  ],
  historyNote: ADS_REPORT_HISTORY_NOTE,
  today: '2026-10-22',
  ...patch,
})

const runRow = (patch: Partial<AdsParityRunRow> = {}): AdsParityRunRow => ({
  id: 'run-1',
  adsProfileId: 'ap-a',
  profileName: '美国账户',
  windowStart: '2026-09-17',
  windowEnd: '2026-09-30',
  legacyCount: 10,
  newCount: 10,
  matchedCount: 8,
  unexplainedCount: 1,
  warningCount: 0,
  status: 'HAS_DIFFS',
  startedAt: '2026-10-22T02:00:00.000Z',
  finishedAt: '2026-10-22T02:01:00.000Z',
  counts: { TIME_BASIS: 1, ATTRIBUTION_BASIS: 0, SCOPE: 1, UNEXPLAINED: 1 },
  ...patch,
})

export const parityResponse = (patch: Partial<AdsParityResponse> = {}): AdsParityResponse => ({
  state: 'OK',
  note: null,
  sunsetNote: ADS_PARITY_SUNSET_NOTE,
  profiles: [
    {
      ...profile,
      adsAccountReady: true,
      legacyEnabled: true,
      consecutivePasses: 3,
      requiredPasses: 7,
      lastRunAt: '2026-10-22T02:00:00.000Z',
      closedAt: null,
      closedReason: null,
      lastStatus: 'HAS_DIFFS',
    },
    {
      id: 'ap-u',
      name: '加拿大账户',
      storeName: null,
      adsAccountReady: false,
      legacyEnabled: true,
      consecutivePasses: 0,
      requiredPasses: 7,
      lastRunAt: null,
      closedAt: null,
      closedReason: null,
      lastStatus: null,
    },
  ],
  runs: [runRow()],
  ...patch,
})

export const diffsResponse = (patch: Partial<AdsParityDiffsResponse> = {}): AdsParityDiffsResponse => ({
  run: runRow(),
  items: [
    { id: 'd-3', category: 'UNEXPLAINED', entityKey: '2026-09-20|C1', field: 'cost', legacyValue: '12.5', newValue: '13.1', explanation: '没有对应的口径说明' },
    { id: 'd-2', category: 'SCOPE', entityKey: '2026-09-18|C2', field: 'cost', legacyValue: null, newValue: '2', explanation: '旧版报告里没有这个活动' },
    { id: 'd-1', category: 'TIME_BASIS', entityKey: '2026-09-17|C1', field: 'sales', legacyValue: '5', newValue: '6', explanation: '时区不同导致日期错位' },
  ],
  truncated: false,
  ...patch,
})

export const reportHandlers = (extra: Record<string, Handler> = {}, list: () => AdsReportListResponse = () => listResponse()): Record<string, Handler> => ({
  '/ads/reports': (_url, init) => (init?.method === 'POST' ? ok({ report: reportRow({ id: 'rp-new', status: 'PENDING' }), syncJobId: 'sj-1' }) : ok(list())),
  '/ads/report-templates': () => ok(templatesResponse()),
  '/ads/parity': () => ok(parityResponse()),
  '/ads/parity/run-1/diffs': () => ok(diffsResponse()),
  '/ads/parity/run': () => ok({ syncJobId: 'sj-2' }),
  '/ads/reports/rp-2/retry': () => ok({ report: reportRow({ id: 'rp-5', status: 'PENDING', attempt: 2, retryOfId: 'rp-2' }), syncJobId: 'sj-3' }),
  '/ads/reports/backfill': () => ok({ reports: [], windows: [] }),
  ...extra,
})
