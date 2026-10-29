import { ADS_PARITY_JOB } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { shouldRunParity } from '../parity/store'
import type { QueueRegistry } from '../runtime/queues'

// 迁移期核对的定时排任务（P3-15）：每 6 小时看一遍，每个已发现广告账户编号、旧通道仍开着、距上次核对满 24 小时的广告档案排一个核对任务。
// 核对本身再检查一次间隔（shouldRunParity），所以这里多排或早排都不会多跑。没有已授权的广告连接的企业不排。

export const ADS_PARITY_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000
const PROFILE_LIMIT = 2000

export interface AdsParityScheduleDeps {
  systemPrisma: Pick<PrismaClient, 'tenant'>
  prisma: PrismaClient
  queues: Pick<QueueRegistry, 'addSync'>
  now?: () => Date
}

/** 已经在租户上下文里时调用；返回排出的任务数。 */
export async function scheduleTenantAdsParity(prisma: PrismaClient, queues: AdsParityScheduleDeps['queues'], tenantId: string, now: Date): Promise<number> {
  const connection = await prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED' }, select: { id: true } })
  if (!connection) return 0
  const profiles = await prisma.adsProfile.findMany({
    where: { tenantId, adsAccountId: { not: null } },
    select: { id: true, parityState: { select: { legacyEnabled: true, lastRunAt: true } } },
    orderBy: { id: 'asc' },
    take: PROFILE_LIMIT,
  })
  let queued = 0
  for (const profile of profiles) {
    if (!shouldRunParity(profile.parityState ?? { legacyEnabled: true, lastRunAt: null }, now)) continue
    const sourceKey = syncSourceKey(connection.id, ADS_PARITY_JOB, profile.id)
    if ((await prisma.syncJob.count({ where: { tenantId, connectionId: connection.id, type: ADS_PARITY_JOB, sourceKey, status: { in: ['PENDING', 'RUNNING'] } } })) > 0) continue
    const job = await prisma.syncJob.create({
      data: {
        tenantId,
        connectionId: connection.id,
        type: ADS_PARITY_JOB,
        status: 'PENDING',
        requestId: 'schedule',
        domain: syncDomainOf(ADS_PARITY_JOB),
        priority: PRIORITY.SCHEDULED,
        sourceKey,
        context: { adsProfileId: profile.id },
      },
    })
    await queues.addSync(ADS_PARITY_JOB, { tenantId, syncJobId: job.id, requestId: 'schedule', adsProfileId: profile.id }, { jobId: job.id, priority: PRIORITY.SCHEDULED })
    queued += 1
  }
  return queued
}

export async function scheduleAdsParity(deps: AdsParityScheduleDeps): Promise<{ tenants: number; queued: number }> {
  const now = deps.now?.() ?? new Date()
  const tenants = await deps.systemPrisma.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let queued = 0
  for (const tenant of tenants) queued += await runWithTenant(tenant.id, () => scheduleTenantAdsParity(deps.prisma, deps.queues, tenant.id, now))
  return { tenants: tenants.length, queued }
}
