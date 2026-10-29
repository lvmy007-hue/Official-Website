import { Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SYNC_QUEUE_LABEL, SYNC_READ, bucketTokensAt, type SyncQueueRow, type SyncQueuesResponse, type SyncRateBucket, type SyncRateLimitsResponse } from '@nova/api-contracts'
import { ALL_SYNC_QUEUES, AUXILIARY_QUEUES, LEGACY_SYNC_QUEUE, syncDomainOf, syncQueueName } from '@nova/workflow'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { RateLimitService } from '../../platform/rate-limit.service'
import { connectionWhere, ContextService } from '../auth'

const HOUR_MS = 3_600_000
const QUEUES: readonly string[] = [...ALL_SYNC_QUEUES, LEGACY_SYNC_QUEUE, ...AUXILIARY_QUEUES]
const SYNC_QUEUE_SET = new Set<string>(ALL_SYNC_QUEUES)
const RATE_LIMIT_MAX = 200
const NOTE_QUEUE_DOWN = '队列服务暂时读不到：后台任务不受影响，稍后刷新再看'
const NOTE_RATE_DOWN = '限速状态暂时读不到：后台任务不受影响，稍后刷新再看'
const NOTE_RATE_NONE = '尚无记录：近一小时没有向亚马逊发起过请求（令牌桶一小时没人用就会过期，最近一次限速的时间也随之消失）'

type TenantCounts = { waiting: number; active: number; completedLastHour: number; failedLastHour: number }

// 同步中心的“队列监控”与“限速状态”（09 章 9.8）。队列与令牌桶都在 Redis 里，读不到时如实返回“暂时读不到”，不拿 0 冒充。
@Injectable()
export class SyncMonitorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly rateLimit: RateLimitService,
    private readonly context: ContextService,
    private readonly config: ConfigService,
  ) {}

  async queues(req: RequestWithContext, now: Date = new Date()): Promise<SyncQueuesResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SYNC_READ, {})
    const tenantId = context.tenantId
    const notes = ['积压数是整个平台的合计，队列本身不区分企业；“本企业”一列来自本企业的同步任务记录。', '吞吐按本企业近一小时完成与失败的任务数统计；队列不保留已完成任务，没有平台级的吞吐数据。']
    const [counts, tenant] = await Promise.all([this.queue.counts(QUEUES).catch(() => null), this.tenantCounts(tenantId, connectionWhere(scope), now)])
    if (!counts) return { state: 'UNAVAILABLE', note: NOTE_QUEUE_DOWN, queues: [], concurrency: null, notes }
    const queues = QUEUES.map((name): SyncQueueRow => {
      const mine = SYNC_QUEUE_SET.has(name) ? (tenant.get(name) ?? { waiting: 0, active: 0, completedLastHour: 0, failedLastHour: 0 }) : null
      const raw = counts[name] ?? { waiting: 0, active: 0, delayed: 0, failed: 0 }
      const load = raw.waiting + raw.active
      return { queue: name, label: SYNC_QUEUE_LABEL[name] ?? name, ...raw, tenant: mine, tenantShare: mine && load > 0 ? Math.min(1, (mine.waiting + mine.active) / load) : null }
    })
    const slots = await this.rateLimit.tenantSlots(tenantId, now.getTime()).catch(() => null)
    const limit = Number(this.config.get<string>('TENANT_MAX_CONCURRENT_JOBS'))
    return { state: 'OK', note: null, queues, concurrency: slots === null ? null : { active: slots, limit: limit > 0 ? limit : 2 }, notes }
  }

  /** 本企业各同步队列的任务：等待与执行取当前状态，完成与失败取近一小时。 */
  private async tenantCounts(tenantId: string, connection: ReturnType<typeof connectionWhere>, now: Date): Promise<Map<string, TenantCounts>> {
    const since = new Date(now.getTime() - HOUR_MS)
    const [current, recent] = await Promise.all([
      this.prisma.syncJob.groupBy({ by: ['type', 'status'], where: { tenantId, connection, status: { in: ['PENDING', 'RUNNING'] } }, _count: { _all: true }, orderBy: { type: 'asc' } }),
      this.prisma.syncJob.groupBy({
        by: ['type', 'status'],
        where: { tenantId, connection, finishedAt: { gte: since }, status: { notIn: ['PENDING', 'RUNNING'] } },
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
    ])
    const out = new Map<string, TenantCounts>()
    const of = (type: string) => {
      const name = syncQueueName(syncDomainOf(type))
      const found = out.get(name) ?? { waiting: 0, active: 0, completedLastHour: 0, failedLastHour: 0 }
      out.set(name, found)
      return found
    }
    for (const group of current) of(group.type)[group.status === 'RUNNING' ? 'active' : 'waiting'] += group._count._all
    for (const group of recent) of(group.type)[group.status === 'SUCCEEDED' ? 'completedLastHour' : 'failedLastHour'] += group._count._all
    return out
  }

  async rateLimits(req: RequestWithContext, now: Date = new Date()): Promise<SyncRateLimitsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SYNC_READ, {})
    const tenantId = context.tenantId
    const notes = ['每个店铺授权、每个接口族一个令牌桶：亚马逊返回的速率会校正桶的速率，收到 429 时降速一半并冻结一小段时间。']
    const raw = await this.rateLimit.buckets(tenantId, RATE_LIMIT_MAX).catch(() => null)
    if (!raw) return { state: 'UNAVAILABLE', note: NOTE_RATE_DOWN, items: [], truncated: false, notes }
    const ids = [...new Set(raw.items.map(item => item.connectionId))]
    const connections =
      ids.length === 0
        ? []
        : await this.prisma.platformConnection.findMany({
            where: { tenantId, id: { in: ids }, ...connectionWhere(scope) },
            select: { id: true, provider: true, sellerAccount: { select: { displayName: true } } },
            take: ids.length,
          })
    const byId = new Map(connections.map(connection => [connection.id, connection]))
    const nowMs = now.getTime()
    const iso = (ms: number | null) => (ms && ms > 0 ? new Date(ms).toISOString() : null)
    const items = raw.items.flatMap((bucket): SyncRateBucket[] => {
      const connection = byId.get(bucket.connectionId) // 不在本人店铺范围内（或连接已删除）的桶不显示
      if (!connection) return []
      return [
        {
          connectionId: bucket.connectionId,
          storeName: connection.sellerAccount?.displayName ?? null,
          apiLabel: connection.provider === 'AMAZON_ADS_API' ? 'Amazon Ads API' : connection.provider === 'AMAZON_SP_API' ? 'Amazon SP-API' : null,
          family: bucket.family,
          ratePerSecond: bucket.rate,
          burst: bucket.burst,
          tokens: Math.round(bucketTokensAt(bucket, nowMs) * 100) / 100,
          blocked: bucket.blockedUntil > nowMs,
          blockedUntil: bucket.blockedUntil > nowMs ? iso(bucket.blockedUntil) : null,
          lastLimitedAt: iso(bucket.limitedAt),
          updatedAt: iso(bucket.updatedAt),
        },
      ]
    })
    items.sort((a, b) => `${a.storeName ?? ''}${a.family}`.localeCompare(`${b.storeName ?? ''}${b.family}`))
    return { state: items.length > 0 ? 'OK' : 'NO_DATA', note: items.length > 0 ? null : NOTE_RATE_NONE, items, truncated: raw.truncated, notes }
  }
}
