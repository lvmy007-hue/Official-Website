import type { AuditDetailResponse, AuditListResponse, AuditOptionsResponse, AuditRow, PiiViewListResponse, PiiViewRow } from '@nova/api-contracts'

// 审计中心页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

const pageInfo = (hasMore = false) => ({ pageSize: 20, nextCursor: hasMore ? 'cursor-2' : null, hasMore, approxTotal: null })

export const auditRow = (over: Partial<AuditRow> = {}): AuditRow => ({
  id: 'a1',
  occurredAt: '2026-10-25T08:00:00.000Z',
  actor: { id: 'u2', name: '林客服', kind: 'USER' },
  source: 'PAGE',
  sourceLabel: '页面操作',
  page: '/app/roles',
  action: 'ROLE_UPDATED',
  actionLabel: '修改角色',
  resourceType: 'Role',
  resourceLabel: '角色',
  resourceId: 'role-1',
  result: 'SUCCEEDED',
  resultLabel: '成功',
  requestId: 'req-a1',
  reason: null,
  accessMode: 'NORMAL',
  accessModeLabel: '正常访问',
  ...over,
})

export const systemRow = (): AuditRow =>
  auditRow({
    id: 'a2',
    actor: { id: null, name: '系统', kind: 'SYSTEM' },
    source: 'SYSTEM',
    sourceLabel: '系统任务',
    page: null,
    action: 'EXPORT_COMPLETED',
    actionLabel: '导出完成',
    resourceType: 'ExportJob',
    resourceLabel: '导出任务',
    resourceId: 'exp-1',
    requestId: 'req-a2',
  })

export const supportRow = (): AuditRow =>
  auditRow({
    id: 'a3',
    actor: { id: null, name: '平台人员', kind: 'SUPPORT' },
    source: 'API',
    sourceLabel: '接口调用',
    page: null,
    result: 'DENIED',
    resultLabel: '被拒绝',
    action: 'SUPPORT_ACCESS_REQUEST',
    actionLabel: '平台支持访问请求',
    resourceType: 'Tenant',
    resourceLabel: 'Tenant',
    resourceId: null,
    reason: '客户报障排查',
    accessMode: 'SUPPORT',
    accessModeLabel: '平台支持访问',
    requestId: 'req-a3',
  })

export const auditList = (items: AuditRow[], over: Partial<AuditListResponse> = {}): AuditListResponse => ({ items, pageInfo: pageInfo(), canExport: true, exportBlockedReason: null, ...over })

export const auditOptions = (over: Partial<AuditOptionsResponse> = {}): AuditOptionsResponse => ({
  windowDays: 90,
  actions: [
    { value: 'ROLE_UPDATED', label: '修改角色' },
    { value: 'EXPORT_COMPLETED', label: '导出完成' },
  ],
  resourceTypes: [{ value: 'Role', label: '角色' }],
  pages: ['/app/roles', '/app/orders'],
  actors: [{ value: 'u2', label: '林客服' }],
  truncated: false,
  ...over,
})

export const piiRow = (over: Partial<PiiViewRow> = {}): PiiViewRow => ({
  id: 'p1',
  occurredAt: '2026-10-25T09:00:00.000Z',
  actor: { id: 'u2', name: '林客服', kind: 'USER' },
  reason: '客户来电核对收货信息',
  object: { type: 'Order', typeLabel: '订单', id: 'o1', label: '111-0000001-0000001', path: '/app/orders/o1' },
  fields: ['姓名', '城市'],
  outcome: 'OK',
  outcomeLabel: '已查看',
  accessMode: 'NORMAL',
  accessModeLabel: '正常访问',
  requestId: 'req-p1',
  ...over,
})

export const piiList = (items: PiiViewRow[], over: Partial<PiiViewListResponse> = {}): PiiViewListResponse => ({
  items,
  pageInfo: pageInfo(),
  summary: { last24h: 2, last7d: 5, topViewers: [{ actorId: 'u2', name: '林客服', count: 4 }] },
  alertRule: { enabled: true, windowMinutes: 60, maxViews: 20 },
  ...over,
})

export const auditDetail = (over: Partial<AuditDetailResponse> = {}): AuditDetailResponse => ({
  event: {
    ...auditRow(),
    ip: '203.0.113.7',
    userAgent: 'Mozilla/5.0 Test',
    writeRunId: null,
    stepUpVerified: true,
    initiator: null,
  },
  changes: [
    { field: 'name', before: '运营', after: '运营主管' },
    { field: 'contactEmail', before: '[已隐藏]', after: '[已隐藏]' },
    { field: 'note', before: null, after: '新增备注' },
  ],
  hasSnapshot: true,
  extra: [{ key: 'permissionCount', value: '12' }],
  resource: {
    type: 'Role',
    label: '角色',
    id: 'role-1',
    path: '/app/roles',
    recent: [{ id: 'a9', occurredAt: '2026-10-24T08:00:00.000Z', actorName: '林然', actionLabel: '新建角色', result: 'SUCCEEDED', resultLabel: '成功' }],
    recentTruncated: false,
  },
  ...over,
})
