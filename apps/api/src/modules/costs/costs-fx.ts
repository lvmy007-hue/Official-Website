import { FX_BASE_CURRENCY, FX_FALLBACK_MAX_DAYS, pickEffectiveRate, resolveRateOn, type CostFxInfo, type FxRow } from '@nova/api-contracts'
import { asDay, type Db } from './costs-common'

// 成本折合美元用的汇率（P2b-14）：取“今天”适用的汇率——手工覆盖优先，其次当天实际获取的，再其次沿用前值，最多往前 FX_FALLBACK_MAX_DAYS 天，再没有就是缺失。
// 汇率口径是 1 美元折合多少外币；美元恒为 1。页面上的折合美元是“按今天的汇率估算”，不是利润计价用的“销售日汇率”。

const DAY_MS = 86_400_000
const ROW_LIMIT = 5000

export type RateMap = ReadonlyMap<string, CostFxInfo>

export async function loadRates(prisma: Db, tenantId: string, currencies: Iterable<string>, today: string): Promise<Map<string, CostFxInfo>> {
  const quotes = [...new Set([...currencies].filter(code => code !== FX_BASE_CURRENCY))]
  const out = new Map<string, CostFxInfo>([[FX_BASE_CURRENCY, { currency: FX_BASE_CURRENCY, rate: 1, rateDate: today, carriedForward: false }]])
  if (quotes.length === 0) return out
  const rows = await prisma.fxRate.findMany({
    where: {
      tenantId,
      baseCurrency: FX_BASE_CURRENCY,
      quoteCurrency: { in: quotes },
      rateDate: { gte: new Date(asDay(today).getTime() - FX_FALLBACK_MAX_DAYS * DAY_MS), lte: asDay(today) },
    },
    select: { quoteCurrency: true, rateDate: true, rate: true, source: true, isFallback: true, isManualOverride: true },
    take: ROW_LIMIT,
  })
  for (const quote of quotes) {
    const byDay = new Map<string, FxRow[]>()
    for (const row of rows) {
      if (row.quoteCurrency !== quote) continue
      const day = row.rateDate.toISOString().slice(0, 10)
      byDay.set(day, [...(byDay.get(day) ?? []), { rateDate: day, rate: Number(row.rate.toString()), source: row.source, isFallback: row.isFallback, isManualOverride: row.isManualOverride }])
    }
    const chosen = new Map<string, FxRow>()
    for (const [day, list] of byDay) {
      const row = pickEffectiveRate(list)
      if (row) chosen.set(day, row)
    }
    const hit = resolveRateOn(today, chosen)
    out.set(quote, hit ? { currency: quote, rate: hit.row.rate, rateDate: hit.usedDate, carriedForward: hit.carriedForward } : { currency: quote, rate: null, rateDate: null, carriedForward: false })
  }
  return out
}

export const rateOf = (rates: RateMap, currency: string): number | null => rates.get(currency)?.rate ?? null
