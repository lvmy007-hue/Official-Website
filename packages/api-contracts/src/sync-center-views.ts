import type { CursorPageInfo } from './query'
import type { SyncDataDomain, SyncDomainAvailability, SyncState } from './sync-center'

// 同步中心的接口响应结构与队列、令牌桶的小工具（P5-06）。

// ---- 响应 ----

export interface SyncJobRow {
  id: string
  type: string
  typeLabel: string
  domain: SyncDataDomain
  domainLabel: string
  /** 接口族：SP-API 或广告接口；连接信息缺失时为 null */
  apiLabel: string | null
  storeName: string | null
  state: SyncState
  status: string
  attempts: number
  maxAttempts: number
  priority: number
  priorityLabel: string
  progressCurrent: number
  progressTotal: number
  requestId: string
  failureCode: string | null
  failureText: string | null
  /** 运行日志摘要：最近一条过程事件，没有记录时为 null（旧任务） */
  logSummary: string | null
  deadLettered: boolean
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  canRetry: boolean
  retryBlockedReason: string | null
  writeType: boolean
}

export interface SyncDomainSummary {
  domain: SyncDataDomain
  label: string
  availability: SyncDomainAvailability
  note: string | null
  /** 近 24 小时各状态任务数；还没有任何任务时全部为 0 且 hasJobs 为 false，页面写“尚无记录” */
  succeeded: number
  failed: number
  active: number
  hasJobs: boolean
  lastSuccessAt: string | null
  lastFailureText: string | null
}

export interface SyncJobListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: SyncJobRow[]
  pageInfo: CursorPageInfo
  /** 各状态条数：受数据域与搜索词影响，不受状态筛选影响 */
  counts: Record<SyncState, number>
  /** 各数据域近 24 小时的概况（最多读取 5000 个任务，超过时 summaryTruncated 为真） */
  domains: SyncDomainSummary[]
  summaryTruncated: boolean
}

export interface SyncDetailParam {
  label: string
  value: string
}
export interface SyncStepView {
  seq: number
  name: string
  status: string
  attempt: number
  errorCode: string | null
  startedAt: string | null
  finishedAt: string | null
}
export interface SyncWorkflowView {
  kind: string
  status: string
  errorCode: string | null
  startedAt: string
  finishedAt: string | null
  steps: SyncStepView[]
}
export interface SyncTimelineItem {
  at: string
  label: string
  text: string | null
  tone: 'default' | 'success' | 'error' | 'warning'
}
export interface SyncLinkedReport {
  id: string
  kind: 'SP_API' | 'ADS' | 'DATA_KIOSK'
  label: string
  status: string
  path: string
}
export interface SyncDeadLetterView {
  id: string
  queue: string
  attempts: number
  errorCode: string
  createdAt: string
  replayedAt: string | null
}

export interface SyncJobDetailResponse {
  job: SyncJobRow
  params: SyncDetailParam[]
  connection: { id: string; provider: string; state: string; lastErrorCode: string | null } | null
  queue: string
  sourceKey: string | null
  hasCheckpoint: boolean
  timeline: SyncTimelineItem[]
  workflows: SyncWorkflowView[]
  /** 写入统计；任务没有记录统计时为 null，页面写“尚无统计” */
  stats: Array<{ key: string; label: string; value: number }> | null
  deadLetter: SyncDeadLetterView | null
  reports: SyncLinkedReport[]
  notes: string[]
}

export interface SyncQueueRow {
  queue: string
  label: string
  /** 队列里等待、执行、延后、失败的任务数：整个平台的合计，不区分企业 */
  waiting: number
  active: number
  delayed: number
  failed: number
  /** 当前企业在该队列的任务；不适用的队列（报表、导出等不走同步任务表）为 null */
  tenant: { waiting: number; active: number; completedLastHour: number; failedLastHour: number } | null
  /** 当前企业占该队列等待与执行任务的份额（0 到 1）；队列空闲或不适用时为 null */
  tenantShare: number | null
}

export interface SyncQueuesResponse {
  state: 'OK' | 'UNAVAILABLE'
  note: string | null
  queues: SyncQueueRow[]
  /** 公平调度：企业同时占用的并发槽位；读不到时为 null */
  concurrency: { active: number; limit: number } | null
  notes: string[]
}

export interface SyncRateBucket {
  connectionId: string
  storeName: string | null
  apiLabel: string | null
  family: string
  ratePerSecond: number
  burst: number
  /** 此刻桶里的可用令牌（按补充速率折算到现在） */
  tokens: number
  blocked: boolean
  blockedUntil: string | null
  lastLimitedAt: string | null
  updatedAt: string | null
}

export interface SyncRateLimitsResponse {
  state: 'OK' | 'NO_DATA' | 'UNAVAILABLE'
  note: string | null
  items: SyncRateBucket[]
  truncated: boolean
  notes: string[]
}

export const SYNC_QUEUE_LABEL: Readonly<Record<string, string>> = {
  'sync-orders': '订单同步',
  'sync-inventory': '库存同步',
  'sync-finance': '财务同步',
  'sync-ads': '广告同步',
  'sync-inbound': '入仓同步',
  'sync-awd': '上游仓储同步',
  'sync-reports': '报告任务',
  'sync-general': '其他同步（商品、定价、促销、数据中心等）',
  sync: '旧同步队列（升级前遗留）',
  reports: '报表',
  exports: '导出',
  notifications: '通知',
  lifecycle: '企业生命周期',
}

/** 令牌桶在 now 时刻的可用令牌：从记录时间起按速率补充，不超过突发上限；被冻结时不补充（冻结期内不放行）。 */
export function bucketTokensAt(bucket: { tokens: number; updatedAt: number; rate: number; burst: number }, now: number): number {
  const elapsed = Math.max(0, now - bucket.updatedAt) / 1000
  return Math.min(bucket.burst, bucket.tokens + elapsed * bucket.rate)
}
