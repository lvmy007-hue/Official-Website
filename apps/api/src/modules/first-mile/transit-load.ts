import { TRANSIT_WINDOW_DAYS, type FirstMileMode, type TransitHint } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { dayText, parseDay } from './first-mile-common'
import { summarizeDays, transitDaysOf, type TransitSample, type TransitSummary } from './transit-math'

// 读取最近一年已交付的运单作为时效样本（按货代与运输方式），详情页的时效提示与统计页共用。

type Reader = { firstMileShipment: Pick<Prisma.TransactionClient['firstMileShipment'], 'findMany'> }

export interface DeliveredSample extends TransitSample {
  forwarderId: string
  mode: FirstMileMode
}

export async function loadDeliveredSamples(reader: Reader, tenantId: string, today: string, filter: { forwarderId?: string; mode?: FirstMileMode } = {}): Promise<DeliveredSample[]> {
  const since = new Date(parseDay(today).getTime() - TRANSIT_WINDOW_DAYS * 86_400_000)
  const rows = await reader.firstMileShipment.findMany({
    where: {
      tenantId,
      shipDate: { not: null },
      ataDelivery: { gte: since, not: null },
      ...(filter.forwarderId ? { forwarderId: filter.forwarderId } : {}),
      ...(filter.mode ? { mode: filter.mode } : {}),
    },
    select: { forwarderId: true, mode: true, shipDate: true, ataDelivery: true },
    take: 20000,
  })
  return rows.map(row => ({ forwarderId: row.forwarderId, mode: row.mode as FirstMileMode, shipDate: dayText(row.shipDate) as string, ataDelivery: dayText(row.ataDelivery) as string }))
}

export function summaryOf(samples: readonly TransitSample[]): TransitSummary {
  return summarizeDays(samples.map(transitDaysOf).filter((days): days is number => days !== null))
}

export async function transitHintFor(reader: Reader, input: { tenantId: string; today: string; forwarderId: string; forwarderName: string; mode: FirstMileMode }): Promise<TransitHint | null> {
  const samples = await loadDeliveredSamples(reader, input.tenantId, input.today, { forwarderId: input.forwarderId, mode: input.mode })
  const summary = summaryOf(samples)
  if (summary.sampleCount === 0) return null
  return { forwarderName: input.forwarderName, mode: input.mode, sampleCount: summary.sampleCount, p50Days: summary.p50Days, p90Days: summary.p90Days }
}
