import type { ReportDetailResponse, ReportDomain, ReportListResponse, ReportRow, ReportStatus } from '@nova/api-contracts'

// 报表中心页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const reportRow = (over: Partial<ReportRow> = {}): ReportRow => ({
  id: 'r1',
  source: 'SP_API',
  domain: 'LOGISTICS',
  reportKey: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA',
  label: '客户退货报告',
  storeName: '美国主店',
  from: '2026-10-01',
  to: '2026-10-07',
  periodText: '2026-10-01 至 2026-10-07',
  status: 'READY',
  failureCode: null,
  failureText: null,
  fileState: 'STORED',
  parseState: 'DONE',
  readRows: 120,
  importedRows: 118,
  skippedRows: 2,
  retentionUntil: '2027-01-20T00:00:00.000Z',
  requirement: '所需角色：Amazon Fulfillment',
  createdAt: '2026-10-20T02:00:00.000Z',
  createdByName: '王运营',
  attempt: 1,
  retryOfId: null,
  canCancel: false,
  canRetry: false,
  canDownload: true,
  analysisPath: '/app/returns',
  createPath: null,
  ...over,
})

const zeroCounts = (): Record<ReportStatus, number> => ({ PENDING: 0, GENERATING: 0, READY: 0, FAILED: 0, CANCELLED: 0 })
const zeroDomains = (): Record<ReportDomain, number> => ({ LOGISTICS: 0, BUSINESS: 0, BRAND: 0, FINANCE: 0, ADS: 0, DATA_CENTER: 0 })

export const reportList = (items: ReportRow[] = [reportRow()], over: Partial<ReportListResponse> = {}): ReportListResponse => {
  const counts = zeroCounts()
  const domainCounts = zeroDomains()
  for (const item of items) {
    counts[item.status] += 1
    if (item.domain) domainCounts[item.domain] += 1
  }
  return {
    state: items.length ? 'OK' : 'NO_DATA',
    note: items.length ? null : '尚无记录：还没有创建过报告，也没有广告报告或数据中心任务',
    items,
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    counts,
    domainCounts,
    truncated: false,
    ...over,
  }
}

export const reportDetail = (over: Partial<ReportDetailResponse> = {}): ReportDetailResponse => ({
  report: reportRow(),
  request: { marketplaceId: 'ATVPDKIKX0DER', externalReportId: 'ext-1', requestId: 'req-1', requestedBy: 'u1', dimensions: [], metrics: [], adProduct: null, dataset: null, params: null },
  timeline: [
    { at: '2026-10-20T02:00:00.000Z', stage: 'REQUESTED', label: '已创建任务', side: 'LOCAL' },
    { at: '2026-10-20T02:00:05.000Z', stage: 'SUBMITTED', label: '已向亚马逊申请', side: 'AMAZON' },
    { at: '2026-10-20T02:03:00.000Z', stage: 'AMAZON_DONE', label: '亚马逊：生成完成', side: 'AMAZON' },
    { at: '2026-10-20T02:04:00.000Z', stage: 'IMPORTED', label: '导入完成', side: 'LOCAL' },
  ],
  stats: { read: 120, imported: 118, skipped: 2, ignored: 0, added: null, updated: null, failed: 0 },
  warnings: [],
  syncJob: { id: 'sj1', type: 'FBA_REPORT_CREATE', status: 'SUCCEEDED', attempts: 1, failureCode: null, startedAt: '2026-10-20T02:00:10.000Z', finishedAt: '2026-10-20T02:04:00.000Z' },
  notes: [],
  ...over,
})
