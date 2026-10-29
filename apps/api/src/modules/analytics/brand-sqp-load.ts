import { BA_ROW_LIMIT, type BaPeriod } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDay, num, usd } from './brand-load'
import type { PricePair, SqpGroup } from './brand-sqp-math'

// 搜索查询表现的取数（P4-04）：数据库先按“搜索词”（趋势再加周期）汇总，内存里算份额。
// 我方次数在所选 ASIN 间求和；市场总次数、搜索量、价格中位数取各 ASIN 里的最大值（同一个搜索词的市场总量对每个 ASIN 是同一个数）；我方价格取各 ASIN 的平均。
// 读取上限 19,999 个搜索词，多读一个判断是否被截断。

const OWN_SUM = {
  impressionsOwn: true,
  clicksOwn: true,
  cartAddsOwn: true,
  purchasesOwn: true,
  purchasesSameDayOwn: true,
  purchasesOneDayOwn: true,
  purchasesTwoDayOwn: true,
} as const
const TOTAL_MAX = {
  searchVolume: true,
  searchQueryScore: true,
  impressionsTotal: true,
  clicksTotal: true,
  cartAddsTotal: true,
  purchasesTotal: true,
  purchasesSameDayTotal: true,
  purchasesOneDayTotal: true,
  purchasesTwoDayTotal: true,
  impressionShare: true,
  clickShare: true,
  cartAddShare: true,
  purchaseShare: true,
  clickPriceTotal: true,
  cartAddPriceTotal: true,
  purchasePriceTotal: true,
  currency: true,
} as const
const OWN_AVG = { clickPriceOwn: true, cartAddPriceOwn: true, purchasePriceOwn: true } as const

type Sum = { [K in keyof typeof OWN_SUM]: number | null }

export interface SqpFilter {
  tenantId: string
  scope: ResolvedScope
  kind: BaPeriod
  /** 为空表示范围内全部 ASIN。 */
  asins: readonly string[] | null
}

const pair = (own: number | null, total: number | null): PricePair => ({ own, total })

function groupOf(searchQuery: string, asinCount: number, row: Record<string, unknown>): SqpGroup {
  const sum = (row._sum ?? {}) as Sum
  const max = (row._max ?? {}) as Record<string, unknown> & { currency?: string | null }
  const avg = (row._avg ?? {}) as Record<string, { toString(): string } | null>
  const currency = (max.currency as string | null | undefined) ?? null
  const count = (key: string) => (typeof max[key] === 'number' ? (max[key] as number) : null)
  const dec = (key: string) => num(max[key] as { toString(): string } | null)
  const price = (key: string, source: Record<string, unknown>) => usd(source[key] as { toString(): string } | null, currency)
  return {
    searchQuery,
    volume: count('searchVolume'),
    score: count('searchQueryScore'),
    own: { impressions: sum.impressionsOwn, clicks: sum.clicksOwn, cartAdds: sum.cartAddsOwn, purchases: sum.purchasesOwn },
    total: { impressions: count('impressionsTotal'), clicks: count('clicksTotal'), cartAdds: count('cartAddsTotal'), purchases: count('purchasesTotal') },
    official: { impression: dec('impressionShare'), click: dec('clickShare'), cartAdd: dec('cartAddShare'), purchase: dec('purchaseShare') },
    prices: {
      click: pair(price('clickPriceOwn', avg), price('clickPriceTotal', max)),
      cartAdd: pair(price('cartAddPriceOwn', avg), price('cartAddPriceTotal', max)),
      purchase: pair(price('purchasePriceOwn', avg), price('purchasePriceTotal', max)),
    },
    ship: {
      SAME_DAY: pair(sum.purchasesSameDayOwn, count('purchasesSameDayTotal')),
      ONE_DAY: pair(sum.purchasesOneDayOwn, count('purchasesOneDayTotal')),
      TWO_DAY: pair(sum.purchasesTwoDayOwn, count('purchasesTwoDayTotal')),
    },
    asinCount,
  }
}

const where = (filter: SqpFilter, extra: Record<string, unknown>) => ({
  tenantId: filter.tenantId,
  ...storeWhere(filter.scope),
  reportPeriod: filter.kind,
  ...(filter.asins ? { asin: { in: [...filter.asins] } } : {}),
  ...extra,
})

/** 一个周期里每个搜索词的汇总，按搜索量从高到低。 */
export async function loadSqpGroups(prisma: PrismaService, filter: SqpFilter, start: string): Promise<{ groups: SqpGroup[]; truncated: boolean }> {
  const found = await prisma.brandSearchQueryPerformance.groupBy({
    by: ['searchQuery'],
    where: where(filter, { periodStart: asDay(start) }),
    _sum: OWN_SUM,
    _max: TOTAL_MAX,
    _avg: OWN_AVG,
    _count: { _all: true },
    orderBy: [{ _max: { searchVolume: 'desc' } }, { searchQuery: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const asinCount = filter.asins?.length ?? 2
  return { groups: found.slice(0, BA_ROW_LIMIT).map(row => groupOf(row.searchQuery, asinCount, row as unknown as Record<string, unknown>)), truncated: found.length > BA_ROW_LIMIT }
}

/** 同一批搜索词在若干周期里的汇总（趋势用）：返回 周期起始日 → 该批词的汇总。 */
export async function loadSqpTrend(prisma: PrismaService, filter: SqpFilter, starts: readonly string[], queries: readonly string[]): Promise<Map<string, SqpGroup[]>> {
  const result = new Map<string, SqpGroup[]>()
  if (starts.length === 0 || queries.length === 0) return result
  const found = await prisma.brandSearchQueryPerformance.groupBy({
    by: ['periodStart', 'searchQuery'],
    where: where(filter, { periodStart: { in: starts.map(asDay) }, searchQuery: { in: [...queries] } }),
    _sum: OWN_SUM,
    _max: TOTAL_MAX,
    _avg: OWN_AVG,
    orderBy: [{ periodStart: 'asc' }, { searchQuery: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const asinCount = filter.asins?.length ?? 2
  for (const row of found.slice(0, BA_ROW_LIMIT)) {
    const key = row.periodStart.toISOString().slice(0, 10)
    const list = result.get(key) ?? []
    list.push(groupOf(row.searchQuery, asinCount, row as unknown as Record<string, unknown>))
    result.set(key, list)
  }
  return result
}

/** 选择器里的 ASIN：所选周期里有搜索词数据的 ASIN，按词数从多到少。 */
export async function loadSqpAsinCounts(prisma: PrismaService, filter: SqpFilter, start: string, limit: number): Promise<Array<{ asin: string; terms: number }>> {
  const found = await prisma.brandSearchQueryPerformance.groupBy({
    by: ['asin'],
    where: { tenantId: filter.tenantId, ...storeWhere(filter.scope), reportPeriod: filter.kind, periodStart: asDay(start) },
    _count: { _all: true },
    orderBy: [{ _count: { asin: 'desc' } }, { asin: 'asc' }],
    take: limit,
  })
  return found.map(row => ({ asin: row.asin, terms: row._count._all }))
}
