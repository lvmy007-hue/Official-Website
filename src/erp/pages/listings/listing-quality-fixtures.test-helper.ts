import {
  LISTING_QUALITY_BASIS,
  type ListingChangeRow,
  type ListingInactiveRow,
  type ListingIssueRow,
  type ListingQualityResponse,
  type ListingRestrictionRow,
  type ListingRunView,
  type ListingWriteStatus,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'

// 刊登质量页测试用的假服务端数据（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const GOOD: ListingWriteStatus = { allowed: true, step: null, reason: null, remedyPath: null }
export const writeOk = { validate: GOOD, update: GOOD, batch: GOOD }

export const issueRow = (patch: Partial<ListingIssueRow> = {}): ListingIssueRow => ({
  id: 'i1',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  productId: 'p1',
  title: '玻璃保鲜盒套装',
  imageUrl: null,
  kind: 'ISSUE',
  code: '90220',
  attributeName: 'color',
  category: 'MISSING_ATTRIBUTE',
  severity: 'ERROR',
  impact: 'SEARCH_SUPPRESSED',
  message: '缺少必填属性：颜色',
  advice: '补充颜色属性后重新提交',
  firstSeenAt: '2026-10-20T08:00:00Z',
  lastSeenAt: '2026-10-23T08:00:00Z',
  resolvedAt: null,
  durationHours: 72,
  status: 'NEW',
  ownerUserId: 'u1',
  ownerName: '林然',
  estimate: { isEstimate: true, state: 'OK', note: null, spanDays: 3, duringDaily: 20, beforeDaily: 60, estimatedChange: -120 },
  ...patch,
})

export const noEstimateRow = () => issueRow({ id: 'i2', sku: 'SKU-2', title: '没有销售记录的商品', estimate: null, severity: 'WARNING', status: 'IN_PROGRESS', ownerName: null, ownerUserId: null })

export const changeRow = (): ListingChangeRow => ({
  id: 'c1',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-1',
  asin: 'B0TEST0001',
  productId: 'p1',
  title: '玻璃保鲜盒套装',
  kind: 'CONTENT_CHANGE',
  fieldPath: 'item_name',
  fieldLabel: '标题',
  before: '旧标题',
  after: '新标题',
  actor: 'UNKNOWN',
  actorLabel: '未知（非本系统）',
  occurredAt: '2026-10-22T08:00:00Z',
})

export const inactiveRow = (): ListingInactiveRow => ({
  id: 'n1',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-9',
  asin: 'B0TEST0009',
  productId: null,
  title: null,
  imageUrl: null,
  productType: null,
  statuses: [],
  statusSince: '2026-09-01T00:00:00Z',
  inactiveDays: 53,
  syncedAt: '2026-10-23T02:00:00Z',
})

export const restrictionRow = (): ListingRestrictionRow => ({
  runId: 'r9',
  storeId: 'st1',
  storeName: 'Northstar US',
  asin: 'B0AAAAAAAA',
  conditionType: 'new_new',
  restricted: true,
  reasons: [{ code: 'APPROVAL_REQUIRED', label: '需要亚马逊审核', message: '该品牌需要审核', links: [{ title: '去亚马逊处理', url: 'https://sellercentral.amazon.com/apply' }] }],
  checkedAt: '2026-10-24T08:00:00Z',
  expiresAt: '2026-10-24T09:00:00Z',
})

export const qualityResponse = (patch: Partial<ListingQualityResponse> = {}): ListingQualityResponse => ({
  tab: 'issues',
  state: 'OK',
  note: null,
  issueRows: [issueRow(), noEstimateRow()],
  changeRows: [],
  inactiveRows: [],
  restrictionRows: [],
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: 2 },
  counts: { issues: 2, suppressed: 1, restrictions: 1, missing: 1, productType: 0, otherEdits: 1, inactive: 3 },
  stats: {
    range: { from: '2026-09-25', to: '2026-10-24', days: 30, defaulted: true },
    newCount: 5,
    resolvedCount: 3,
    inProgressCount: 1,
    openCount: 2,
    openErrors: 1,
    openWarnings: 1,
    openImpactCount: 1,
    avgResolveHours: 30,
    resolveSampleTruncated: false,
  },
  sources: [
    { key: 'listings.items-v2021', label: '刊登接口（每日同步）', state: 'OK', note: null },
    { key: 'GET_MERCHANTS_LISTINGS_FYP_REPORT', label: '被搜索抑制报告（每日）', state: 'NO_DATA', note: null },
    { key: 'notifications', label: '亚马逊推送（实时）', state: 'NOT_CONNECTED', note: '推送接收端暂缓接入，没有实时事件；以每日同步为准' },
  ],
  freshness: { lastSuccessAt: '2026-10-24T02:00:00Z', sources: ['刊登接口'], qualityIssues: 0 } as ListingQualityResponse['freshness'],
  basis: LISTING_QUALITY_BASIS,
  write: writeOk,
  stores: [
    { id: 'st1', name: 'Northstar US' },
    { id: 'st2', name: 'Oak & Pine' },
  ],
  ...patch,
})

export const runView = (patch: Partial<ListingRunView> = {}): ListingRunView => ({
  id: 'r1',
  kind: 'VALIDATE',
  kindLabel: '校验预览',
  status: 'SUCCEEDED',
  statusLabel: '已完成',
  storeId: 'st1',
  storeName: 'Northstar US',
  sku: 'SKU-1',
  productType: 'LUGGAGE',
  validation: 'VALID',
  previewRunId: null,
  itemCount: 1,
  issues: [],
  rows: [],
  summary: null,
  failureCode: null,
  failureText: null,
  requestedBy: '林然',
  createdAt: '2026-10-24T08:00:00Z',
  finishedAt: '2026-10-24T08:00:05Z',
  usableUntil: '2026-10-24T08:30:00Z',
  ...patch,
})

export const qualityHandlers = (response: () => ListingQualityResponse, extra: Record<string, Handler> = {}): Record<string, Handler> => ({
  '/listings/quality': () => ok(response()),
  '/listings/runs': () => ok({ items: [], truncated: false }),
  ...extra,
})
