import type { SupportCaseDetailResponse, SupportCaseListResponse, SupportCaseRow, SupportContactRow, SupportSync } from '@nova/api-contracts'

// 支持案件页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const freshness = { lastSuccessAt: '2026-10-23T08:00:00.000Z', sources: ['支持案件'], qualityIssues: 0 }

export const normalSync: SupportSync = { status: 'NORMAL', statusLabel: '正常', lastSuccessAt: '2026-10-23T08:00:00.000Z', errorCode: null, errorMessage: null, rolePending: false }
export const pendingSync: SupportSync = {
  status: 'UNAUTHORIZED',
  statusLabel: '未授权',
  lastSuccessAt: null,
  errorCode: 'SUP_ROLE_PENDING',
  errorMessage: '卖家支持受限角色未获批',
  rolePending: true,
}

export const supportCaseRow = (over: Partial<SupportCaseRow> = {}): SupportCaseRow => ({
  id: 'sc1',
  caseId: '123456789',
  sellerAccountId: 's1',
  storeName: '美国主店',
  subject: '货件 FBA15ABCDE 少收',
  status: 'PENDING_AMAZON_ACTION',
  statusLabel: '等待亚马逊处理',
  createdAt: '2026-10-20T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  resolvedAt: null,
  lastOutboundAt: null,
  contactCount: 2,
  reimbursementCaseId: null,
  reimbursementCaseNo: null,
  ...over,
})

export const contact = (over: Partial<SupportContactRow> = {}): SupportContactRow => ({
  id: 'k1',
  contactId: 'c1',
  channel: 'EMAIL',
  channelLabel: '邮件',
  direction: 'FROM_AMAZON',
  directionLabel: '亚马逊',
  senderName: null,
  body: '请补充入库证据',
  piiKinds: [],
  attachments: [],
  occurredAt: '2026-10-22T00:00:00.000Z',
  ...over,
})

export const supportList = (items: SupportCaseRow[] = [supportCaseRow()], over: Partial<SupportCaseListResponse> = {}): SupportCaseListResponse => ({
  state: items.length ? 'OK' : 'NO_DATA',
  note: null,
  items,
  pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
  sync: normalSync,
  freshness,
  ...over,
})

export const supportDetail = (over: Partial<SupportCaseDetailResponse> = {}): SupportCaseDetailResponse => ({
  case: supportCaseRow(),
  appointments: [],
  contacts: [contact(), contact({ id: 'k2', contactId: 'c2', direction: 'FROM_SELLER', directionLabel: '我方', body: '已补充', attachments: ['证据.pdf'], occurredAt: '2026-10-22T02:00:00.000Z' })],
  contactsState: 'OK',
  contactsNote: null,
  links: { reimbursement: null, shipments: [], products: [] },
  sync: normalSync,
  freshness,
  ...over,
})
