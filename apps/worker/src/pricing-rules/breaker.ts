import { BREAKER_OBSERVE_DAYS, BREAKER_WINDOW_DAYS, breakerVerdict, compareSideOf, type PriceCompareSide, type PricingBreaker } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 定价规则的熔断核对（P4-11）：每次评估前先看这条规则的执行效果，出现下列任一情况就把规则置为“已熔断”（不再评估与执行，需要人工在页面恢复）：
//   - 连续 N 次执行失败（N 默认 3）；
//   - 某次已执行的改价在观察期（满 3 天、不超过 7 天）后，转化率相对改价前下降超过阈值（调价前后各自会话数不少于 100，样本太小不熔断）；
//   - 某次已执行的改价之后，这个 SKU 实际的利润率低于阈值（只在设置了阈值时核对；有任何一天缺成本算不出利润就不核对）。
// 只核对规则自己执行过的改价；没有数据（销售与流量没同步、没有成本）就不熔断，也不假装没问题——原因不会写成“正常”，只是这一项没有结论。

const DAY_MS = 86_400_000
const dayStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
const shift = (date: Date, days: number) => new Date(date.getTime() + days * DAY_MS)
const dateText = (date: Date) => date.toISOString().slice(0, 10)

export interface BreakerRule {
  id: string
  tenantId: string
  sellerAccountId: string
  breakerFailures: number
  breakerConversionDrop: { toString(): string } | null
  breakerMinMargin: { toString(): string } | null
}
const asNumber = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

export function breakerOf(rule: Pick<BreakerRule, 'breakerFailures' | 'breakerConversionDrop' | 'breakerMinMargin'>): PricingBreaker {
  return { failureStreak: rule.breakerFailures, conversionDropPct: asNumber(rule.breakerConversionDrop), minMarginPct: asNumber(rule.breakerMinMargin) }
}

async function trafficSide(db: PrismaClient, rule: BreakerRule, asin: string, from: Date, to: Date): Promise<PriceCompareSide | null> {
  const rows = await db.salesTrafficAsinDaily.findMany({
    where: { tenantId: rule.tenantId, sellerAccountId: rule.sellerAccountId, asin, asinGranularity: 'CHILD', currency: 'USD', date: { gte: from, lte: to } },
    select: { date: true, source: true, units: true, sessions: true, buyBoxPct: true },
    orderBy: [{ date: 'asc' }, { source: 'asc' }],
    take: 200,
  })
  return compareSideOf(rows.map(row => ({ date: dateText(row.date), source: row.source, units: row.units, sessions: row.sessions, buyBoxPct: asNumber(row.buyBoxPct) })))
}

/** 改价之后这个 SKU 实际的利润率；有任何一行利润为空（缺成本）或没有销售额时为 null。 */
async function realizedMargin(db: PrismaClient, rule: BreakerRule, sku: string, from: Date, to: Date): Promise<number | null> {
  const where = { tenantId: rule.tenantId, sellerAccountId: rule.sellerAccountId, basis: 'ORDERED', sku, profitDate: { gte: from, lte: to } }
  const [sum, missing] = await Promise.all([
    db.profitDaily.aggregate({ where, _sum: { revenue: true, profit: true }, _count: { _all: true } }),
    db.profitDaily.count({ where: { ...where, profit: null } }),
  ])
  const revenue = asNumber(sum._sum.revenue)
  const profit = asNumber(sum._sum.profit)
  return sum._count._all === 0 || missing > 0 || revenue === null || revenue <= 0 || profit === null ? null : profit / revenue
}

export async function evaluateBreaker(db: PrismaClient, rule: BreakerRule, now: Date): Promise<{ trip: boolean; reason: string | null }> {
  const breaker = breakerOf(rule)
  const results = await db.pricingRuleRun.findMany({
    where: { tenantId: rule.tenantId, ruleId: rule.id, outcome: { in: ['APPLIED', 'FAILED'] } },
    select: { outcome: true },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: Math.max(breaker.failureStreak, 1),
  })
  const recent = results.map(row => row.outcome as 'APPLIED' | 'FAILED')
  const streak = breakerVerdict(breaker, { recent, before: null, after: null, realizedMargin: null })
  if (streak.trip) return streak
  if (breaker.conversionDropPct === null && breaker.minMarginPct === null) return { trip: false, reason: null }
  const applied = await db.pricingRuleRun.findMany({
    where: { tenantId: rule.tenantId, ruleId: rule.id, outcome: 'APPLIED', executed: true, runAt: { gte: shift(now, -BREAKER_WINDOW_DAYS), lte: shift(now, -BREAKER_OBSERVE_DAYS) } },
    select: { sku: true, asin: true, runAt: true },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: 20,
  })
  for (const run of applied) {
    const changed = dayStart(run.runAt)
    const [before, after, margin] = await Promise.all([
      run.asin ? trafficSide(db, rule, run.asin, shift(changed, -BREAKER_WINDOW_DAYS), shift(changed, -1)) : null,
      run.asin ? trafficSide(db, rule, run.asin, shift(changed, 1), dayStart(now)) : null,
      breaker.minMarginPct === null ? null : realizedMargin(db, rule, run.sku, shift(changed, 1), dayStart(now)),
    ])
    const verdict = breakerVerdict({ ...breaker, failureStreak: 0 }, { recent: [], before, after, realizedMargin: margin })
    if (verdict.trip) return { trip: true, reason: `${run.sku}：${verdict.reason ?? ''}` }
  }
  return { trip: false, reason: null }
}
