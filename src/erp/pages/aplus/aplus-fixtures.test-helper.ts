import {
  APLUS_BASIS,
  APLUS_COMPARE_BASIS,
  APLUS_STATUS_LABEL,
  aplusActionsOf,
  aplusEmptyModule,
  aplusModulesFromAmazon,
  aplusModulesToAmazon,
  aplusRejectionOf,
  type AplusCompare,
  type AplusDetailResponse,
  type AplusFormModule,
  type AplusListResponse,
  type AplusRow,
  type AplusRunRow,
  type AplusStatus,
  type AplusUploadRow,
  type AplusUploadsResponse,
  type AplusWriteStatus,
} from '@nova/api-contracts'
import type { Handler } from '../../test/app-harness'
import { LIVE_PAGES, type LivePages } from '../../routes/live-pages'
import { ok } from '../listings/listing-quality-fixtures.test-helper'

// A+ 内容页测试用的假服务端数据（只在测试里使用，生产代码不引用）。数据都符合合约类型。

export { ok }

/** 用真实的登记项，页面与路由规则和线上一致。 */
export const aplusPages: LivePages = { AplusListPage: LIVE_PAGES.AplusListPage, AplusDetailPage: LIVE_PAGES.AplusDetailPage }

type Calls = { calls: Array<{ path: string; search: string; method: string }> }
export const callsOf = (app: Calls, path: string, method = 'GET') => app.calls.filter(call => call.path === path && call.method === method)
/** 某个路径最近一次请求的查询参数。 */
export const lastParams = (app: Calls, path: string) => {
  const list = callsOf(app, path)
  return new URLSearchParams(list[list.length - 1]?.search)
}

export const WRITE_OK: AplusWriteStatus = { allowed: true, step: null, reason: null, remedyPath: null }
export const WRITE_OFF: AplusWriteStatus = { allowed: false, step: 'SWITCH', reason: '写入开关“A+ 内容提交”未开启', remedyPath: '/app/settings/integrations' }

const stores = [{ id: 'st1', name: 'Northstar US' }]
const freshness = { lastSuccessAt: '2026-10-24T06:00:00Z', sources: ['A+ 内容'], qualityIssues: 0 }
const pageInfo = (count: number) => ({ pageSize: 50, nextCursor: null, hasMore: false, approxTotal: count })

// ---- 列表 ----

export const aplusRow = (patch: Partial<AplusRow> = {}): AplusRow => {
  const status: AplusStatus = patch.status ?? 'DRAFT'
  return {
    id: 'c1',
    storeId: 'st1',
    storeName: 'Northstar US',
    name: '旅行箱品牌故事',
    contentType: 'EBC',
    contentTypeLabel: '标准 A+ 内容',
    locale: 'en-US',
    status,
    statusLabel: APLUS_STATUS_LABEL[status],
    asinCount: 2,
    contentReferenceKey: 'ref-1',
    updatedAt: '2026-10-24T08:00:00Z',
    rejectionReason: null,
    publishedAt: null,
    pendingRun: null,
    ...patch,
  }
}

export const listRows = (): AplusRow[] => [
  aplusRow(),
  aplusRow({ id: 'c2', name: '收纳袋卖点', status: 'REJECTED', rejectionReason: 'The image shows a price and a promotion.' }),
  aplusRow({ id: 'c3', name: '行李箱对比图', status: 'PUBLISHED', publishedAt: '2026-09-01T00:00:00Z', asinCount: 3 }),
  aplusRow({ id: 'c4', name: '新品草稿', status: 'DRAFT', asinCount: 0, pendingRun: { kind: 'SUBMIT', kindLabel: '提交审核', status: 'QUEUED' } }),
]

export const listResponse = (patch: Partial<AplusListResponse> = {}): AplusListResponse => ({
  state: 'OK',
  note: null,
  items: listRows(),
  pageInfo: pageInfo(4),
  summary: { total: 4, byStatus: { DRAFT: 2, SUBMITTED: 0, APPROVED: 0, REJECTED: 1, PUBLISHED: 1 }, pending: 1 },
  stores,
  freshness,
  write: WRITE_OK,
  truncated: false,
  basis: APLUS_BASIS,
  ...patch,
})

// ---- 图片库 ----

export const uploadRow = (patch: Partial<AplusUploadRow> = {}): AplusUploadRow => ({
  id: 'u1',
  storeId: 'st1',
  storeName: 'Northstar US',
  fileName: 'banner-large.png',
  contentType: 'image/png',
  sizeBytes: 2 * 1024 * 1024,
  width: 1200,
  height: 800,
  status: 'SUCCEEDED',
  statusLabel: '已完成',
  uploadDestinationId: 'dest-large',
  failureCode: null,
  failureText: null,
  createdAt: '2026-10-23T08:00:00Z',
  requestedBy: '林然',
  ...patch,
})

export const uploadRows = (): AplusUploadRow[] => [
  uploadRow(),
  uploadRow({ id: 'u2', fileName: 'icon-small.png', width: 200, height: 200, sizeBytes: 40 * 1024, uploadDestinationId: 'dest-small' }),
  uploadRow({ id: 'u3', fileName: 'pending.jpg', contentType: 'image/jpeg', status: 'RUNNING', statusLabel: '处理中', uploadDestinationId: null }),
  uploadRow({
    id: 'u4',
    fileName: 'broken.jpg',
    contentType: 'image/jpeg',
    status: 'FAILED',
    statusLabel: '失败',
    uploadDestinationId: null,
    failureCode: 'SP_API_400',
    failureText: '亚马逊拒绝了这次请求（400）：图片不符合要求',
  }),
]

export const uploadsResponse = (patch: Partial<AplusUploadsResponse> = {}): AplusUploadsResponse => ({
  items: uploadRows(),
  stores,
  write: WRITE_OK,
  maxBytes: 5 * 1024 * 1024,
  types: ['image/jpeg', 'image/png'],
  ...patch,
})

// ---- 详情 ----

/** 两个模块：纯文字，加带图的大图文（图片编号 dest-large）。 */
export const formModules = (): AplusFormModule[] => [
  { type: 'STANDARD_TEXT', headline: '品牌故事', body: '我们从 2015 年开始做旅行箱。' },
  { type: 'STANDARD_HEADER_IMAGE_TEXT', headline: '轻盈出行', block: { image: { uploadDestinationId: 'dest-large', altText: '蓝色旅行箱正面' }, headline: '重量只有 2.8 公斤', body: '航空级材料。' } },
]

export const rawModules = (modules: readonly AplusFormModule[] = formModules()): unknown[] => aplusModulesToAmazon(modules)

const compareBase = { publishedAt: null, before: null, after: null, delta: null, relative: null, asinCount: 2, basis: APLUS_COMPARE_BASIS }
export const compareOf = (patch: Partial<AplusCompare> = {}): AplusCompare => ({ state: 'NOT_PUBLISHED', note: '内容还没有发布，发布后才能对比前后转化率', ...compareBase, ...patch })

export const compareOk = (): AplusCompare =>
  compareOf({
    state: 'OK',
    note: null,
    publishedAt: '2026-09-01T00:00:00Z',
    before: { from: '2026-08-04', to: '2026-08-31', days: 28, daysWithData: 28, sessions: 4000, units: 200, conversion: 0.05 },
    after: { from: '2026-09-02', to: '2026-09-29', days: 28, daysWithData: 27, sessions: 4200, units: 252, conversion: 0.06 },
    delta: 0.01,
    relative: 0.2,
  })

export const failedRun = (patch: Partial<AplusRunRow> = {}): AplusRunRow => ({
  id: 'run-1',
  kind: 'SUBMIT',
  kindLabel: '提交审核',
  status: 'FAILED',
  statusLabel: '失败',
  failureCode: 'SP_API_400',
  failureText: '亚马逊拒绝了这次请求（400）：内容或图片不符合要求，请修改后重新提交',
  warnings: ['图片 dest-large 的宽高比与要求略有差异'],
  requestedBy: '林然',
  createdAt: '2026-10-24T07:00:00Z',
  finishedAt: '2026-10-24T07:01:00Z',
  ...patch,
})

export const detailResponse = (patch: Partial<AplusDetailResponse> = {}): AplusDetailResponse => {
  const item = patch.item ?? aplusRow()
  const modules = patch.modules ?? rawModules()
  const view = aplusModulesFromAmazon(modules)
  const editable = patch.editable ?? view.editable
  const editNote = patch.editNote === undefined ? view.note : patch.editNote
  const busy = Boolean(item.pendingRun)
  return {
    item,
    modules,
    editable,
    editNote,
    version: 3,
    asins: [
      { asin: 'B0APLUS001', title: '旅行箱 24 寸', publishedAt: null },
      { asin: 'B0APLUS002', title: null, publishedAt: '2026-09-01T00:00:00Z' },
    ],
    asinsTruncated: false,
    timeline: [
      { status: 'DRAFT', statusLabel: '草稿', message: null, occurredAt: '2026-10-20T08:00:00Z', source: 'LOCAL' },
      { status: 'SUBMITTED', statusLabel: '已提交', message: null, occurredAt: '2026-10-21T08:00:00Z', source: 'SYNC' },
    ],
    rejection: aplusRejectionOf(item.status, item.rejectionReason),
    compare: compareOf(),
    runs: [],
    write: WRITE_OK,
    actions: aplusActionsOf({ status: item.status, hasKey: item.contentReferenceKey !== null, busy, asinCount: item.asinCount, editable, editNote }),
    freshness,
    basis: APLUS_BASIS,
    ...patch,
  }
}

/** 被拒：有拒绝原文与修复建议。 */
export const rejectedDetail = (reason: string | null = 'The image shows a price and a promotion.'): AplusDetailResponse =>
  detailResponse({
    item: aplusRow({ id: 'c1', status: 'REJECTED', rejectionReason: reason }),
    timeline: [
      { status: 'SUBMITTED', statusLabel: '已提交', message: null, occurredAt: '2026-10-21T08:00:00Z', source: 'LOCAL' },
      { status: 'REJECTED', statusLabel: '被拒', message: reason, occurredAt: '2026-10-22T08:00:00Z', source: 'SYNC' },
    ],
  })

/** 已发布：发布前后对照有结论。 */
export const publishedDetail = (): AplusDetailResponse => detailResponse({ item: aplusRow({ id: 'c1', status: 'PUBLISHED', publishedAt: '2026-09-01T00:00:00Z' }), compare: compareOk() })

/** 不可编辑：含不支持的模块。 */
export const readonlyDetail = (): AplusDetailResponse =>
  detailResponse({
    modules: [...rawModules([aplusEmptyModule('STANDARD_PRODUCT_DESCRIPTION')]), { contentModuleType: 'STANDARD_COMPARISON_TABLE', standardComparisonTable: {} }],
  })

export const runningDetail = (): AplusDetailResponse =>
  detailResponse({
    item: aplusRow({ id: 'c1', pendingRun: { kind: 'SUBMIT', kindLabel: '提交审核', status: 'RUNNING' } }),
    runs: [failedRun({ status: 'RUNNING', statusLabel: '处理中', failureCode: null, failureText: null, warnings: [], finishedAt: null })],
  })

/** 路径精确匹配：详情的编号固定为 c1。 */
export const aplusHandlers = (
  responses: { list?: () => AplusListResponse; detail?: () => AplusDetailResponse; uploads?: () => AplusUploadsResponse } = {},
  extra: Record<string, Handler> = {},
): Record<string, Handler> => ({
  '/aplus': () => ok((responses.list ?? listResponse)()),
  '/aplus/uploads': () => ok((responses.uploads ?? uploadsResponse)()),
  '/aplus/c1': () => ok((responses.detail ?? detailResponse)()),
  ...extra,
})
