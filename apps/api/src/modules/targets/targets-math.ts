import type { TargetForecast, TargetPeriodKind } from '@nova/api-contracts'

// 目标达成进度与预测达成的纯函数（P2a-04，freeze/metrics.md M-013、M-014）。
// 不接触数据库，便于单测；服务层只负责把汇总表的数字喂进来。

/** 期间结束日（不含），即下一期的起始日。 */
export function periodEndExclusive(periodKind: TargetPeriodKind, periodStart: string): Date {
  const [y, m] = periodStart.split('-').map(Number)
  if (periodKind === 'YEAR') return new Date(Date.UTC(y + 1, 0, 1))
  if (periodKind === 'QUARTER') return new Date(Date.UTC(y, m - 1 + 3, 1))
  return new Date(Date.UTC(y, m, 1))
}

/** 期间总天数。 */
export function totalDaysOf(periodKind: TargetPeriodKind, periodStart: string): number {
  const start = new Date(`${periodStart}T00:00:00Z`)
  const end = periodEndExclusive(periodKind, periodStart)
  return Math.round((end.getTime() - start.getTime()) / 86_400_000)
}

/** 已过天数：从期初到 asOf（含当天）的天数，裁剪到 [0, 总天数]；asOf 早于期初为 0，晚于期末为总天数。 */
export function elapsedDaysOf(periodKind: TargetPeriodKind, periodStart: string, asOf: string): number {
  const start = new Date(`${periodStart}T00:00:00Z`)
  const end = periodEndExclusive(periodKind, periodStart)
  const at = new Date(`${asOf}T00:00:00Z`)
  if (at < start) return 0
  const total = Math.round((end.getTime() - start.getTime()) / 86_400_000)
  if (at >= end) return total
  return Math.round((at.getTime() - start.getTime()) / 86_400_000) + 1
}

/** 按天均摊：目标 ÷ 天数 × 已过天数 对应的比例。 */
export function linearRatio(elapsed: number, total: number): number {
  if (total <= 0) return 0
  return Math.min(1, Math.max(0, elapsed / total))
}

/**
 * 历史季节曲线的累计占比：取与当月天数一致的历史月份（近 2 年同月），
 * 对每个历史月份算“日销售占全月的比例”，逐日取平均，再累计到 elapsed 天。
 * 历史月份不足（没有任何一个月天数匹配且总额大于 0）时返回 null，调用方应退化为按天均摊。
 */
export function seasonalRatio(historicalMonths: readonly (readonly number[])[], elapsed: number, totalDays: number): number | null {
  const usable = historicalMonths.filter(month => month.length === totalDays && month.some(v => v > 0))
  if (usable.length === 0) return null
  const dailyShares = usable.map(month => {
    const total = month.reduce((sum, v) => sum + v, 0)
    return month.map(v => v / total)
  })
  const avgShare = Array.from({ length: totalDays }, (_, day) => dailyShares.reduce((sum, shares) => sum + shares[day], 0) / dailyShares.length)
  const clamped = Math.min(totalDays, Math.max(0, elapsed))
  let cumulative = 0
  for (let i = 0; i < clamped; i += 1) cumulative += avgShare[i]
  return Math.min(1, Math.max(0, cumulative))
}

/** 达成率：本期实际 ÷ 目标；目标为 0 或负数时无法计算。 */
export function achievementRatioOf(actual: number, target: number): number | null {
  if (target <= 0) return null
  return actual / target
}

/**
 * 预测达成（模型估算）：本期已实际 + 剩余天数的预测（取最近若干天的日均、最低、最高值 × 剩余天数）。
 * recentDaily 为已发生天数中最近若干天的每日实际值；为空（尚未开始或没有数据）时返回 null。
 */
export function forecastOf(actualToDate: number, remainingDays: number, recentDaily: readonly number[], targetValue: number): TargetForecast | null {
  if (recentDaily.length === 0) return null
  if (remainingDays <= 0) return { median: actualToDate, low: actualToDate, high: actualToDate, gap: targetValue - actualToDate }
  const avg = recentDaily.reduce((sum, v) => sum + v, 0) / recentDaily.length
  const min = Math.min(...recentDaily)
  const max = Math.max(...recentDaily)
  const median = actualToDate + avg * remainingDays
  const low = actualToDate + Math.min(min, max) * remainingDays
  const high = actualToDate + Math.max(min, max) * remainingDays
  return { median, low, high, gap: targetValue - median }
}
