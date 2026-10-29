import {
  SYNC_DATA_DOMAINS,
  SYNC_DOMAIN_AVAILABILITY,
  SYNC_DOMAIN_LABEL,
  SYNC_STATES,
  type SyncJobDetailResponse,
  type SyncJobListResponse,
  type SyncJobRow,
  type SyncQueuesResponse,
  type SyncRateLimitsResponse,
  type SyncState,
} from '@nova/api-contracts'

// 同步中心页面测试用的接口返回样例（只在测试里使用）。

export const ok = (data: unknown) => ({ body: { success: true, data } })

export const syncRow = (over: Partial<SyncJobRow> = {}): SyncJobRow => ({
  id: 'j1',
  type: 'FBA_ORDERS',
  typeLabel: '订单同步',
  domain: 'ORDERS',
  domainLabel: '订单',
  apiLabel: 'Amazon SP-API',
  storeName: '美国主店',
  state: 'SUCCEEDED',
  status: 'SUCCEEDED',
  attempts: 1,
  maxAttempts: 5,
  priority: 3,
  priorityLabel: '定时',
  progressCurrent: 1,
  progressTotal: 1,
  requestId: 'req-1',
  failureCode: null,
  failureText: null,
  logSummary: '执行完成',
  deadLettered: false,
  createdAt: '2026-10-25T01:00:00.000Z',
  startedAt: '2026-10-25T01:00:05.000Z',
  finishedAt: '2026-10-25T01:01:00.000Z',
  canRetry: false,
  retryBlockedReason: '只有失败的任务可以重试；排队、运行和等待中的任务会自动继续',
  writeType: false,
  ...over,
})

export const failedRow = (over: Partial<SyncJobRow> = {}): SyncJobRow =>
  syncRow({
    id: 'j2',
    type: 'FBA_INVENTORY',
    typeLabel: '库存同步',
    domain: 'INVENTORY',
    domainLabel: '库存',
    state: 'FAILED',
    status: 'FAILED_PERMANENT',
    attempts: 5,
    progressCurrent: 0,
    requestId: 'req-2',
    failureCode: 'AUTH_EXPIRED',
    failureText: '亚马逊授权已过期，请重新授权',
    logSummary: '任务失败：亚马逊授权已过期，请重新授权',
    deadLettered: true,
    finishedAt: '2026-10-25T01:05:00.000Z',
    canRetry: true,
    retryBlockedReason: null,
    ...over,
  })

export const domainSummaries = (patch: Record<string, Partial<SyncJobListResponse['domains'][number]>> = {}): SyncJobListResponse['domains'] =>
  SYNC_DATA_DOMAINS.map(domain => ({
    domain,
    label: SYNC_DOMAIN_LABEL[domain],
    availability: SYNC_DOMAIN_AVAILABILITY[domain].availability,
    note: SYNC_DOMAIN_AVAILABILITY[domain].note,
    succeeded: 0,
    failed: 0,
    active: 0,
    hasJobs: false,
    lastSuccessAt: null,
    lastFailureText: null,
    ...patch[domain],
  }))

export const syncList = (items: SyncJobRow[] = [syncRow()], over: Partial<SyncJobListResponse> = {}): SyncJobListResponse => {
  const counts = Object.fromEntries(SYNC_STATES.map(state => [state, 0])) as Record<SyncState, number>
  for (const item of items) counts[item.state] += 1
  return {
    state: items.length ? 'OK' : 'NO_DATA',
    note: items.length ? null : '尚无记录：还没有同步任务。授权店铺后，系统会按计划创建同步任务；也可以在各数据页点“立即同步”。',
    items,
    pageInfo: { pageSize: 20, nextCursor: null, hasMore: false, approxTotal: items.length },
    counts,
    domains: domainSummaries(
      items.length
        ? { ORDERS: { hasJobs: true, succeeded: 1, lastSuccessAt: '2026-10-25T01:01:00.000Z' }, INVENTORY: { hasJobs: true, failed: 1, lastFailureText: '亚马逊授权已过期，请重新授权' } }
        : {},
    ),
    summaryTruncated: false,
    ...over,
  }
}

export const syncDetail = (over: Partial<SyncJobDetailResponse> = {}): SyncJobDetailResponse => ({
  job: failedRow(),
  params: [
    { label: '任务类型', value: '库存同步' },
    { label: '数据域', value: '库存' },
    { label: '店铺', value: '美国主店' },
    { label: '站点', value: 'ATVPDKIKX0DER' },
  ],
  connection: { id: 'c1', provider: 'AMAZON_SP_API', state: 'AUTHORIZED', lastErrorCode: 'AUTH_EXPIRED' },
  queue: 'sync-inventory',
  sourceKey: 'c1:FBA_INVENTORY:ATVPDKIKX0DER',
  hasCheckpoint: true,
  timeline: [
    { at: '2026-10-25T01:00:05.000Z', label: '开始执行', text: '第 1 次尝试', tone: 'default' },
    { at: '2026-10-25T01:00:30.000Z', label: '尝试失败，等待重试', text: '亚马逊授权已过期，请重新授权（第 1/5 次尝试失败）', tone: 'warning' },
    { at: '2026-10-25T01:05:00.000Z', label: '任务失败', text: '亚马逊授权已过期，请重新授权', tone: 'error' },
  ],
  workflows: [
    {
      kind: 'inventory.sync',
      status: 'FAILED',
      errorCode: 'AUTH_EXPIRED',
      startedAt: '2026-10-25T01:00:06.000Z',
      finishedAt: '2026-10-25T01:05:00.000Z',
      steps: [{ seq: 1, name: 'fetch-inventory', status: 'FAILED', attempt: 1, errorCode: 'AUTH_EXPIRED', startedAt: '2026-10-25T01:00:07.000Z', finishedAt: null }],
    },
  ],
  stats: null,
  deadLetter: { id: 'dl1', queue: 'sync-inventory', attempts: 5, errorCode: 'AUTH_EXPIRED', createdAt: '2026-10-25T01:05:00.000Z', replayedAt: null },
  reports: [],
  notes: [],
  ...over,
})

export const queuesResponse = (over: Partial<SyncQueuesResponse> = {}): SyncQueuesResponse => ({
  state: 'OK',
  note: null,
  queues: [
    { queue: 'sync-orders', label: '订单同步', waiting: 6, active: 2, delayed: 1, failed: 4, tenant: { waiting: 3, active: 1, completedLastHour: 20, failedLastHour: 2 }, tenantShare: 0.5 },
    { queue: 'sync-inventory', label: '库存同步', waiting: 0, active: 0, delayed: 0, failed: 0, tenant: { waiting: 0, active: 0, completedLastHour: 0, failedLastHour: 0 }, tenantShare: null },
    { queue: 'exports', label: '导出', waiting: 1, active: 0, delayed: 0, failed: 0, tenant: null, tenantShare: null },
  ],
  concurrency: { active: 1, limit: 2 },
  notes: ['积压数是整个平台的合计，队列本身不区分企业；“本企业”一列来自本企业的同步任务记录。'],
  ...over,
})

export const rateLimitsResponse = (over: Partial<SyncRateLimitsResponse> = {}): SyncRateLimitsResponse => ({
  state: 'OK',
  note: null,
  items: [
    {
      connectionId: 'c1',
      storeName: '美国主店',
      apiLabel: 'Amazon SP-API',
      family: 'orders',
      ratePerSecond: 0.5,
      burst: 2,
      tokens: 1.5,
      blocked: false,
      blockedUntil: null,
      lastLimitedAt: null,
      updatedAt: '2026-10-25T01:00:00.000Z',
    },
    {
      connectionId: 'c1',
      storeName: '美国主店',
      apiLabel: 'Amazon SP-API',
      family: 'finance',
      ratePerSecond: 0.25,
      burst: 1,
      tokens: 0,
      blocked: true,
      blockedUntil: '2026-10-25T01:10:00.000Z',
      lastLimitedAt: '2026-10-25T01:09:00.000Z',
      updatedAt: '2026-10-25T01:09:00.000Z',
    },
  ],
  truncated: false,
  notes: ['每个店铺授权、每个接口族一个令牌桶。'],
  ...over,
})
