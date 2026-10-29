import {
  SALES_TRAFFIC_ASIN_GRANULARITIES,
  SALES_TRAFFIC_DATASET_ASIN,
  SALES_TRAFFIC_DATASET_DATE,
  SALES_TRAFFIC_DATASET_TRENDS,
  SALES_TRAFFIC_GRANULARITIES,
  salesTrafficAsinDays,
  salesTrafficWindow,
  type SalesTrafficAsinGranularity,
  type SalesTrafficGranularity,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { Prisma } from '@prisma/client'
import { tenantTimeZone } from '../derivers/summary-sql'
import { localDay } from '../importers/shared'
import type { ScheduleDeps } from '../listeners/schedule-jobs'

// 销售与流量（P4-01）的定时查询：每天一次，为每个已授权的店铺建一组数据中心查询任务：
//   D-01 按日、周、月各一个（窗口见 salesTrafficWindow）；D-02 按父体、子体、SKU 与“要查的每一天”各一个；D-03 趋势一个。
// 店铺对某个数据集“有没有数据”按粒度分别判断：没有数据的粒度做第一次回补，有数据的只做近期重拉。
// 没有“品牌分析”角色的店铺会收到 DK_NO_BRAND：任务失败为预期的未授权状态（不告警），下一轮照常重试，授权补上后自动恢复。

export const SALES_TRAFFIC_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000
const MARKETPLACE_ID = 'ATVPDKIKX0DER'

export interface SalesTrafficPlan {
  dataset: string
  /** 区分同一数据集下不同任务的片段，进任务的 sourceKey。 */
  key: string
  params: Record<string, string>
}

export interface SalesTrafficPresence {
  date: Record<SalesTrafficGranularity, boolean>
  asin: Record<SalesTrafficAsinGranularity, boolean>
  trends: boolean
}

/** 今天（企业时区的日期文本）这一轮要提交的全部查询；纯函数。 */
export function planSalesTrafficQueries(today: string, has: SalesTrafficPresence): SalesTrafficPlan[] {
  const plans: SalesTrafficPlan[] = []
  for (const granularity of SALES_TRAFFIC_GRANULARITIES) {
    plans.push({ dataset: SALES_TRAFFIC_DATASET_DATE, key: granularity, params: { granularity, ...salesTrafficWindow(granularity, today, has.date[granularity]) } })
  }
  for (const asinGranularity of SALES_TRAFFIC_ASIN_GRANULARITIES) {
    for (const date of salesTrafficAsinDays(today, has.asin[asinGranularity])) {
      plans.push({ dataset: SALES_TRAFFIC_DATASET_ASIN, key: `${asinGranularity}:${date}`, params: { asinGranularity, date } })
    }
  }
  plans.push({ dataset: SALES_TRAFFIC_DATASET_TRENDS, key: 'DAY', params: { ...salesTrafficWindow('DAY', today, has.trends) } })
  return plans
}

async function presenceOf(prisma: ScheduleDeps['prisma'], sellerAccountId: string): Promise<SalesTrafficPresence> {
  const exists = async (granularity: SalesTrafficGranularity) =>
    (await prisma.salesTrafficDaily.findFirst({ where: { sellerAccountId, granularity, source: 'DATA_KIOSK' }, select: { id: true } })) !== null
  const asinExists = async (asinGranularity: SalesTrafficAsinGranularity) =>
    (await prisma.salesTrafficAsinDaily.findFirst({ where: { sellerAccountId, asinGranularity, source: 'DATA_KIOSK' }, select: { id: true } })) !== null
  return {
    date: { DAY: await exists('DAY'), WEEK: await exists('WEEK'), MONTH: await exists('MONTH') },
    asin: { PARENT: await asinExists('PARENT'), CHILD: await asinExists('CHILD'), SKU: await asinExists('SKU') },
    trends: await asinExists('CHILD'),
  }
}

export async function scheduleSalesTrafficQueries(deps: ScheduleDeps, now: Date = new Date()) {
  const { prisma, systemPrisma } = deps
  if (process.env.APP_MODE !== 'production' || process.env.MOCK_CONNECTOR === 'true') return
  const connections = await systemPrisma.platformConnection.findMany({
    where: { provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, sellerAccountId: { not: null }, tenant: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } } },
    select: { id: true, tenantId: true, sellerAccountId: true },
  })
  for (const connection of connections) {
    if (!connection.sellerAccountId) continue
    const sellerAccountId = connection.sellerAccountId
    await runWithTenant(connection.tenantId, async () => {
      const today = localDay(await tenantTimeZone(prisma, connection.tenantId), now)
        .toISOString()
        .slice(0, 10)
      const plans = planSalesTrafficQueries(today, await presenceOf(prisma, sellerAccountId))
      for (const dataset of new Set(plans.map(plan => plan.dataset))) {
        // 同一数据集在这个连接上还有未结束的任务：本轮整组跳过，不排队堆积（一组任务一起建，下一轮再判断）
        const running = await prisma.syncJob.count({
          where: { connectionId: connection.id, type: 'DATA_KIOSK_QUERY', status: { in: ['PENDING', 'RUNNING'] }, context: { path: ['dataset'], equals: dataset } },
        })
        if (running > 0) continue
        for (const plan of plans.filter(item => item.dataset === dataset)) await createJob(deps, connection, sellerAccountId, plan)
      }
    })
  }
}

async function createJob(deps: ScheduleDeps, connection: { id: string; tenantId: string }, sellerAccountId: string, plan: SalesTrafficPlan) {
  const job = await deps.prisma.syncJob.create({
    data: {
      tenantId: connection.tenantId,
      connectionId: connection.id,
      type: 'DATA_KIOSK_QUERY',
      status: 'PENDING',
      requestId: 'schedule',
      domain: syncDomainOf('DATA_KIOSK_QUERY'),
      priority: PRIORITY.SCHEDULED,
      sourceKey: syncSourceKey(connection.id, 'DATA_KIOSK_QUERY', plan.dataset, plan.key),
      context: { dataset: plan.dataset, params: { ...plan.params, sellerAccountId } } as Prisma.InputJsonValue,
    },
  })
  await deps.queues.addSync(
    'DATA_KIOSK_QUERY',
    { tenantId: connection.tenantId, syncJobId: job.id, requestId: 'schedule', marketplaceId: MARKETPLACE_ID },
    { jobId: job.id, priority: PRIORITY.SCHEDULED },
  )
}
