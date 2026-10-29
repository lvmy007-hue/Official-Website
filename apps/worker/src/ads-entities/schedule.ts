import { ADS_ENTITY_REFRESH_INTERVAL_MS, ADS_ENTITY_SYNC_JOB, ADS_SCHEDULE_PROFILE_LIMIT } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { refreshAllowed } from '../listeners/schedule-jobs'
import { loadRefreshPolicy } from '../platform/tenant-policy'
import type { QueueRegistry } from '../runtime/queues'

// 广告实体同步的定时排任务（P5-12A）：每 2 小时看一遍，每个已发现广告账户编号的广告档案排一个实体同步任务。
// - 没有已授权的广告连接（未连接、已断开、令牌已清除）的企业不排；暂停、停用、注销中的企业不扫描；
// - 企业在设置里暂停或放慢了“广告实体”数据域就照办（refreshAllowed）；
// - 同一档案已有排队中或进行中的任务、或最近 90 分钟内已经排过，不重复排（启动补排与定时器、多个进程同时扫描都不会多排）；
// - 没发现账户编号的档案不排：账户发现随 FBA_ADS 档案同步完成，之后下一次扫描自然会排上。

export const ADS_ENTITY_SCHEDULE_INTERVAL_MS = ADS_ENTITY_REFRESH_INTERVAL_MS
const RECENT_MS = 90 * 60 * 1000

export interface AdsEntityScheduleDeps {
  systemPrisma: Pick<PrismaClient, 'tenant'>
  prisma: PrismaClient
  queues: Pick<QueueRegistry, 'addSync'>
  now?: () => Date
}

/** 已经在租户上下文里时调用；返回排出的任务数。 */
export async function scheduleTenantAdsEntities(prisma: PrismaClient, queues: AdsEntityScheduleDeps['queues'], tenantId: string, now: Date): Promise<number> {
  const connection = await prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } }, select: { id: true } })
  if (!connection) return 0
  if (!(await refreshAllowed(prisma, await loadRefreshPolicy(prisma, tenantId), connection.id, ADS_ENTITY_SYNC_JOB, now))) return 0
  const profiles = await prisma.adsProfile.findMany({
    where: { tenantId, adsAccountId: { not: null }, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: ADS_SCHEDULE_PROFILE_LIMIT,
  })
  if (profiles.length === 0) return 0
  // 一次查出这批档案里已有排队中、进行中或刚排过的任务（不在循环里逐个查）
  const sourceKeys = new Map(profiles.map(profile => [profile.id, syncSourceKey(connection.id, ADS_ENTITY_SYNC_JOB, profile.id)]))
  const busyJobs = await prisma.syncJob.findMany({
    where: {
      tenantId,
      connectionId: connection.id,
      type: ADS_ENTITY_SYNC_JOB,
      sourceKey: { in: [...sourceKeys.values()] },
      OR: [{ status: { in: ['PENDING', 'RUNNING'] } }, { requestId: 'schedule', createdAt: { gte: new Date(now.getTime() - RECENT_MS) } }],
    },
    select: { sourceKey: true },
    take: ADS_SCHEDULE_PROFILE_LIMIT * 20,
  })
  const busy = new Set(busyJobs.map(job => job.sourceKey))
  let queued = 0
  for (const profile of profiles) {
    const sourceKey = sourceKeys.get(profile.id) as string
    if (busy.has(sourceKey)) continue
    const job = await prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: ADS_ENTITY_SYNC_JOB,
        status: 'PENDING',
        requestId: 'schedule',
        domain: syncDomainOf(ADS_ENTITY_SYNC_JOB),
        priority: PRIORITY.SCHEDULED,
        sourceKey,
        // 实体同步不改任何指标，不触发日汇总与利润重算（derivers/trigger.ts 看 skipSummaries）
        context: { adsProfileId: profile.id, skipSummaries: true },
      },
    })
    await queues.addSync(ADS_ENTITY_SYNC_JOB, { tenantId, syncJobId: job.id, requestId: 'schedule', adsProfileId: profile.id }, { jobId: job.id, priority: PRIORITY.SCHEDULED })
    queued += 1
  }
  return queued
}

export async function scheduleAdsEntities(deps: AdsEntityScheduleDeps): Promise<{ tenants: number; queued: number }> {
  const now = deps.now?.() ?? new Date()
  const tenants = await deps.systemPrisma.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let queued = 0
  for (const tenant of tenants) queued += await runWithTenant(tenant.id, () => scheduleTenantAdsEntities(deps.prisma, deps.queues, tenant.id, now))
  return { tenants: tenants.length, queued }
}
