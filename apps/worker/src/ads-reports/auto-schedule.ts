import {
  ADS_REPORT_SCHEDULE_INTERVAL_MS,
  ADS_REPORT_V1_JOB,
  ADS_SCHEDULE_PROFILE_LIMIT,
  adsReportDue,
  adsReportTemplateOf,
  adsReportWindowIssue,
  adsScheduledProducts,
  adsScheduledTemplates,
  adsScheduledWindow,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { tenantTimeZone } from '../derivers/summary-sql'
import { localDay } from '../importers/shared'
import { refreshAllowed } from '../listeners/schedule-jobs'
import { loadRefreshPolicy } from '../platform/tenant-policy'
import type { QueueRegistry } from '../runtime/queues'

// 广告报表的定时排任务（P5-12A，A-02，沿用 P3-01 的窗口规则）：每 6 小时看一遍，每个已发现广告账户编号的广告档案、
// 每个有活动的广告产品、每个模板，距上一次定时报告满 20 小时（失败的下一轮重排）就建一个新报告任务，所以实际每天一次。
//   - 窗口：模板第一次取按日 30 天、按小时 14 天；之后每天重拉最近 3 天（亚马逊按流量日期回补）；更早的历史用“历史回补”接口；
//   - 没有已授权的广告连接的企业不排；企业在设置里暂停或放慢“广告报表”就照办；暂停、停用、注销中的企业不扫描；
//   - 每个企业每次最多排 MAX_JOBS_PER_RUN 个任务，剩下的下一轮再排（报告接口限额很低，避免一次堆出几千个任务）；
//   - 任务带 requestId = schedule、没有 requestedBy，列表里能和人工申请的区分；同步任务带时间窗，完成后只重算这段日期的汇总与利润。

export const ADS_REPORT_AUTO_INTERVAL_MS = ADS_REPORT_SCHEDULE_INTERVAL_MS
export const MAX_JOBS_PER_RUN = 400
const LOOKBACK_MS = 48 * 60 * 60 * 1000

export interface AdsReportScheduleDeps {
  systemPrisma: Pick<PrismaClient, 'tenant'>
  prisma: PrismaClient
  queues: Pick<QueueRegistry, 'addSync'>
  now?: () => Date
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10)
const startOfDay = (day: string) => new Date(`${day}T00:00:00Z`)

/** 已经在租户上下文里时调用；返回排出的任务数。 */
export async function scheduleTenantAdsReports(prisma: PrismaClient, queues: AdsReportScheduleDeps['queues'], tenantId: string, now: Date): Promise<number> {
  const connection = await prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null } }, select: { id: true } })
  if (!connection) return 0
  if (!(await refreshAllowed(prisma, await loadRefreshPolicy(prisma, tenantId), connection.id, ADS_REPORT_V1_JOB, now))) return 0
  const profiles = await prisma.adsProfile.findMany({
    where: { tenantId, adsAccountId: { not: null }, status: 'ACTIVE' },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: ADS_SCHEDULE_PROFILE_LIMIT,
  })
  if (profiles.length === 0) return 0
  const profileIds = profiles.map(profile => profile.id)
  const scheduled = { tenantId, adsProfileId: { in: profileIds }, source: 'V1', requestId: 'schedule' }
  const [products, recent, ready] = await Promise.all([
    prisma.adsCampaign.groupBy({ by: ['adsProfileId', 'adProduct'], where: { tenantId, adsProfileId: { in: profileIds }, state: { not: 'ARCHIVED' } } }),
    prisma.adsReportJob.findMany({
      where: { ...scheduled, OR: [{ createdAt: { gte: new Date(now.getTime() - LOOKBACK_MS) } }, { status: { in: ['PENDING', 'GENERATING'] } }] },
      select: { adsProfileId: true, templateKey: true, adProduct: true, status: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 20_000,
    }),
    prisma.adsReportJob.groupBy({ by: ['adsProfileId', 'templateKey', 'adProduct'], where: { ...scheduled, status: 'READY' } }),
  ])
  const productsOf = new Map<string, string[]>()
  for (const row of products) productsOf.set(row.adsProfileId, [...(productsOf.get(row.adsProfileId) ?? []), row.adProduct])
  const latest = new Map<string, { status: string; createdAt: Date }>()
  for (const row of recent) {
    const key = `${row.adsProfileId}|${row.templateKey}|${row.adProduct}`
    if (!latest.has(key)) latest.set(key, row) // 按时间倒序，第一条就是最近的
  }
  const filled = new Set(ready.map(row => `${row.adsProfileId}|${row.templateKey}|${row.adProduct}`))
  const today = dayOf(localDay(await tenantTimeZone(prisma, tenantId)))
  let queued = 0
  for (const profile of profiles) {
    for (const adProduct of adsScheduledProducts(productsOf.get(profile.id) ?? [])) {
      for (const templateKey of adsScheduledTemplates(adProduct)) {
        if (queued >= MAX_JOBS_PER_RUN) return queued
        const key = `${profile.id}|${templateKey}|${adProduct}`
        const template = adsReportTemplateOf(templateKey)
        if (!template || !adsReportDue(latest.get(key) ?? null, now)) continue
        const span = adsScheduledWindow(template.granularity, today, filled.has(key))
        if (!span || adsReportWindowIssue({ granularity: template.granularity, ...span, today })) continue
        const report = await prisma.adsReportJob.create({
          data: {
            tenantId,
            adsProfileId: profile.id,
            reportType: template.key,
            adProduct,
            source: 'V1',
            templateKey: template.key,
            granularity: template.granularity,
            dimensions: [...template.dimensions],
            metricKeys: [...template.metrics],
            fromDate: startOfDay(span.from),
            toDate: startOfDay(span.to),
            status: 'PENDING',
            requestId: 'schedule',
          },
          select: { id: true },
        })
        const job = await prisma.syncJob.create({
          data: {
            tenantId,
            connectionId: connection.id,
            type: ADS_REPORT_V1_JOB,
            status: 'PENDING',
            requestId: 'schedule',
            domain: syncDomainOf(ADS_REPORT_V1_JOB),
            priority: PRIORITY.SCHEDULED,
            sourceKey: syncSourceKey(connection.id, ADS_REPORT_V1_JOB, report.id),
            context: { reportJobId: report.id, adsProfileId: profile.id, templateKey: template.key, window: { after: `${span.from}T00:00:00.000Z`, before: `${span.to}T00:00:00.000Z` } },
          },
        })
        await queues.addSync(
          ADS_REPORT_V1_JOB,
          { tenantId, syncJobId: job.id, requestId: 'schedule', reportJobId: report.id, adsProfileId: profile.id },
          { jobId: job.id, priority: PRIORITY.SCHEDULED },
        )
        queued += 1
      }
    }
  }
  return queued
}

export async function scheduleAdsReports(deps: AdsReportScheduleDeps): Promise<{ tenants: number; queued: number }> {
  const now = deps.now?.() ?? new Date()
  const tenants = await deps.systemPrisma.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let queued = 0
  for (const tenant of tenants) queued += await runWithTenant(tenant.id, () => scheduleTenantAdsReports(deps.prisma, deps.queues, tenant.id, now))
  return { tenants: tenants.length, queued }
}
