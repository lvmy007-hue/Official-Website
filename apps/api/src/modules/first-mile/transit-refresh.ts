import type { Prisma } from '@prisma/client'
import { dayText, parseDay } from './first-mile-common'
import { monthlyStats } from './transit-math'

// 重算某个货代某种运输方式的月度时效统计（TransitTimeStat）：运单的发货日、实际交付日、货代、运输方式变化后，在同一个事务里调用。
// 整组删掉重建，所以统计永远和运单一致，不会因为改日期留下过期的月份。

type Tx = Pick<Prisma.TransactionClient, 'firstMileShipment' | 'transitTimeStat'>

export async function refreshTransitStats(tx: Tx, tenantId: string, forwarderId: string, mode: string): Promise<void> {
  const rows = await tx.firstMileShipment.findMany({
    where: { tenantId, forwarderId, mode, shipDate: { not: null }, ataDelivery: { not: null } },
    select: { shipDate: true, ataDelivery: true },
    take: 20000,
  })
  const months = monthlyStats(rows.map(row => ({ shipDate: dayText(row.shipDate) as string, ataDelivery: dayText(row.ataDelivery) as string })))
  await tx.transitTimeStat.deleteMany({ where: { tenantId, forwarderId, mode } })
  if (months.length > 0) {
    await tx.transitTimeStat.createMany({
      data: months.map(point => ({ tenantId, forwarderId, mode, periodMonth: parseDay(point.month), sampleCount: point.sampleCount, p50Days: point.p50Days, p90Days: point.p90Days })),
    })
  }
}
