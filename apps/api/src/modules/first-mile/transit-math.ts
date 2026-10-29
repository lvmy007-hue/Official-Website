import { percentileOf, type TransitMonthPoint } from '@nova/api-contracts'

// 实际时效统计（06 章 6.10）：发货日到实际交付日的自然日数，按货代与运输方式分组。纯函数；口径见契约 TRANSIT_BASIS。

export interface TransitSample {
  /** YYYY-MM-DD。 */
  shipDate: string
  ataDelivery: string
}

const DAY_MS = 86_400_000
const dayNumber = (text: string) => Math.round(Date.parse(`${text}T00:00:00Z`) / DAY_MS)

/** 一单的实际时效（天）；交付日早于发货日的脏数据返回 null，不进统计。 */
export function transitDaysOf(sample: TransitSample): number | null {
  const days = dayNumber(sample.ataDelivery) - dayNumber(sample.shipDate)
  return days >= 0 ? days : null
}

export interface TransitSummary {
  sampleCount: number
  p50Days: number | null
  p90Days: number | null
  minDays: number | null
  maxDays: number | null
}

export function summarizeDays(days: readonly number[]): TransitSummary {
  if (days.length === 0) return { sampleCount: 0, p50Days: null, p90Days: null, minDays: null, maxDays: null }
  return { sampleCount: days.length, p50Days: percentileOf(days, 0.5), p90Days: percentileOf(days, 0.9), minDays: Math.min(...days), maxDays: Math.max(...days) }
}

/** 按实际交付所在月份分组的统计（升序）。 */
export function monthlyStats(samples: readonly TransitSample[]): TransitMonthPoint[] {
  const groups = new Map<string, number[]>()
  for (const sample of samples) {
    const days = transitDaysOf(sample)
    if (days === null) continue
    const month = `${sample.ataDelivery.slice(0, 7)}-01`
    groups.set(month, [...(groups.get(month) ?? []), days])
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, days]) => ({ month, sampleCount: days.length, p50Days: percentileOf(days, 0.5) as number, p90Days: percentileOf(days, 0.9) as number }))
}
