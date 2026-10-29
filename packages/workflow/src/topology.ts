// 队列拓扑（12.3）：接口服务与后台任务共用同一份定义，保证“往哪个队列放”和“从哪个队列取”一致。
// - 同步任务按数据域拆分队列，订单回补占满不会拖慢库存与财务；
// - 报表、导出、通知、生命周期各有独立队列；
// - 旧的 'sync' 队列仍有消费者，用来处理升级前已入队的消息，之后不再往里写。

import { backoffDelayMs, type BackoffOptions } from './backoff'
import { classifyError } from './errors'
import { PRIORITY } from './priority'

export const SYNC_DOMAINS = ['orders', 'inventory', 'finance', 'ads', 'inbound', 'awd', 'reports', 'general'] as const
export type SyncDomain = (typeof SYNC_DOMAINS)[number]

export const LEGACY_SYNC_QUEUE = 'sync'
// lifecycle：租户生命周期任务（注销流程，P1-19）
export const AUXILIARY_QUEUES = ['reports', 'exports', 'notifications', 'lifecycle'] as const
export type AuxiliaryQueue = (typeof AUXILIARY_QUEUES)[number]

export const syncQueueName = (domain: SyncDomain) => `sync-${domain}`
export const ALL_SYNC_QUEUES: readonly string[] = SYNC_DOMAINS.map(syncQueueName)

/** 同步任务类型 → 数据域。未知类型进 general，不会丢任务。 */
export function syncDomainOf(type: string | null | undefined): SyncDomain {
  const value = (type ?? '').toUpperCase()
  if (value.startsWith('FBA_ORDERS')) return 'orders'
  if (value.startsWith('FBA_INVENTORY') || value.startsWith('FBA_REPLENISHMENT')) return 'inventory'
  if (value.startsWith('FBA_FINANCE')) return 'finance'
  if (value.startsWith('FBA_ADS') || value.startsWith('ADS_')) return 'ads'
  if (value.startsWith('FBA_INBOUND')) return 'inbound'
  if (value.startsWith('AWD_')) return 'awd' // P2a-08：上游仓储的同步与写入同走一个队列，同店铺同域互斥（读写不并发）
  if (value.startsWith('FBA_REPORT')) return 'reports'
  return 'general'
}

/** 每个数据域的消费并发上限：回补量大的域并发低一些，保护亚马逊配额。 */
export const DOMAIN_CONCURRENCY: Record<SyncDomain, number> = { orders: 2, inventory: 2, finance: 2, ads: 2, inbound: 2, awd: 2, reports: 3, general: 2 }

export interface JobOptions {
  jobId?: string
  priority: number
  attempts: number
  backoff: { type: 'custom' }
  removeOnComplete: number
  removeOnFail: number
  delay?: number
}

export const MAX_ATTEMPTS = 5

/** 统一的入队参数：优先级、最大尝试次数、自定义退避（见 backoffStrategy）。 */
export function jobOptions(input: { jobId?: string; priority?: number; delayMs?: number; attempts?: number } = {}): JobOptions {
  return {
    ...(input.jobId ? { jobId: input.jobId } : {}),
    priority: input.priority ?? PRIORITY.SCHEDULED,
    attempts: input.attempts ?? MAX_ATTEMPTS,
    backoff: { type: 'custom' },
    removeOnComplete: 1000,
    removeOnFail: 5000,
    ...(input.delayMs ? { delay: input.delayMs } : {}),
  }
}

/** BullMQ Worker 的 settings.backoffStrategy：指数退避 + 抖动，并遵守亚马逊的 Retry-After。 */
export function backoffStrategy(options: BackoffOptions = {}) {
  return (attemptsMade: number, _type?: string, error?: Error): number => backoffDelayMs(attemptsMade, options, error ? classifyError(error).retryAfterMs : undefined)
}

/** 任务去重键：同一店铺授权、同一任务类型（及可选的细分参数）同一时刻只应有一个活动任务。 */
export function syncSourceKey(connectionId: string, type: string, ...parts: Array<string | null | undefined>): string {
  return [connectionId, type, ...parts.filter((part): part is string => !!part)].join(':')
}
