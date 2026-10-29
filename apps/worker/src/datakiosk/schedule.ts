import { ECONOMICS_BACKFILL_DAYS, ECONOMICS_DATASET_DAILY, ECONOMICS_DATASET_PREVIEW, ECONOMICS_PREVIEW_PURGE_DAYS, ECONOMICS_PREVIEW_QUERY_DAYS, ECONOMICS_REFRESH_DAYS } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { Prisma } from '@prisma/client'
import { tenantTimeZone } from '../derivers/summary-sql'
import { localDay } from '../importers/shared'
import type { ScheduleDeps } from '../listeners/schedule-jobs'

// 官方经济数据（P2b-11）的定时查询：每天一次，为每个已授权的店铺各建一个数据中心查询任务（官方单品经济、费用预览）。
// 数据中心查询是排队式的（提交后轮询，可能几十分钟到几小时才完成），所以按“数据集”各自判断有没有进行中的任务，不与其他同步互相等待。

export const ECONOMICS_SCHEDULE_INTERVAL_MS = 24 * 60 * 60 * 1000
const MARKETPLACE_ID = 'ATVPDKIKX0DER'
const DAY_MS = 86_400_000
const dayText = (date: Date) => date.toISOString().slice(0, 10)
const addDays = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS)

/** 官方单品经济的查询窗口：店铺有数据时重拉最近 14 天（官方会修正近期数据），第一次回补 90 天；结束日取昨天（今天的数据还不完整）。 */
export function economicsDailyWindow(today: Date, hasData: boolean) {
  const end = addDays(today, -1)
  return { startDate: dayText(addDays(end, -((hasData ? ECONOMICS_REFRESH_DAYS : ECONOMICS_BACKFILL_DAYS) - 1))), endDate: dayText(end) }
}

/** 费用预览的查询窗口：从今天起 119 天（官方上限 120 天，两边时区可能差一天，留一天余量）。 */
export function economicsPreviewWindow(today: Date) {
  return { startDate: dayText(today), endDate: dayText(addDays(today, ECONOMICS_PREVIEW_QUERY_DAYS - 1)) }
}

export async function scheduleEconomicsQueries(deps: ScheduleDeps, now: Date = new Date()) {
  const { prisma, systemPrisma, queues } = deps
  if (process.env.APP_MODE !== 'production' || process.env.MOCK_CONNECTOR === 'true') return
  const connections = await systemPrisma.platformConnection.findMany({
    where: { provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: { not: null }, sellerAccountId: { not: null }, tenant: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } } },
    select: { id: true, tenantId: true, sellerAccountId: true },
  })
  const purged = new Set<string>()
  for (const connection of connections) {
    if (!connection.sellerAccountId) continue
    const sellerAccountId = connection.sellerAccountId
    await runWithTenant(connection.tenantId, async () => {
      const today = localDay(await tenantTimeZone(prisma, connection.tenantId), now)
      if (!purged.has(connection.tenantId)) {
        purged.add(connection.tenantId)
        await prisma.economicsPreview.deleteMany({ where: { queriedAt: { lt: addDays(now, -ECONOMICS_PREVIEW_PURGE_DAYS) } } }) // 过期的预览行（RLS 限定本企业）
      }
      const hasData = (await prisma.economicsDaily.findFirst({ where: { sellerAccountId }, select: { id: true } })) !== null
      const plans = [
        { dataset: ECONOMICS_DATASET_DAILY, params: economicsDailyWindow(today, hasData) },
        { dataset: ECONOMICS_DATASET_PREVIEW, params: { ...economicsPreviewWindow(today), queriedAt: now.toISOString() } },
      ]
      for (const plan of plans) {
        // 同一数据集在这个连接上还有未结束的任务：本轮跳过，不排队堆积
        const running = await prisma.syncJob.count({
          where: { connectionId: connection.id, type: 'DATA_KIOSK_QUERY', status: { in: ['PENDING', 'RUNNING'] }, context: { path: ['dataset'], equals: plan.dataset } },
        })
        if (running > 0) continue
        const job = await prisma.syncJob.create({
          data: {
            tenantId: connection.tenantId,
            connectionId: connection.id,
            type: 'DATA_KIOSK_QUERY',
            status: 'PENDING',
            requestId: 'schedule',
            domain: syncDomainOf('DATA_KIOSK_QUERY'),
            priority: PRIORITY.SCHEDULED,
            sourceKey: syncSourceKey(connection.id, 'DATA_KIOSK_QUERY', plan.dataset),
            context: { dataset: plan.dataset, params: { ...plan.params, sellerAccountId } } as Prisma.InputJsonValue,
          },
        })
        await queues.addSync(
          'DATA_KIOSK_QUERY',
          { tenantId: connection.tenantId, syncJobId: job.id, requestId: 'schedule', marketplaceId: MARKETPLACE_ID },
          { jobId: job.id, priority: PRIORITY.SCHEDULED },
        )
      }
    })
  }
}
