import { forecastPeriodDays, sameDayLastYear, FORECAST_ACTIVE_LIMIT, type ForecastMode, type ForecastScopeType } from '@nova/api-contracts'
import type { ForecastOverride } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'
import type { ResolvedOverride } from './replenishment-override'

// 人工预测规则的装配（P6-09）：读取今天及以后仍有效的规则，按 SKU 与品类分给每个店铺 SKU，并把“去年同期乘系数”换算成日销。
// 去年同期的销量取同店铺同 ASIN 在去年同一段日期的订单汇总（`AsinDailySummary`，没有记录的日子按 0 算，但整段一条记录也没有时规则不生效，不当 0）。
// 查询次数 = 1 次读规则 + 每条“去年同期”规则 1 次汇总（规则总数受 FORECAST_ACTIVE_LIMIT 限制），不随 SKU 数增长。

const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (value: Date) => value.toISOString().slice(0, 10)
const key = (storeId: string, value: string) => `${storeId}|${value}`

export interface OverrideTarget {
  sellerAccountId: string
  sku: string
  asin: string
  category: string | null
}

export type OverrideIndex = (target: OverrideTarget) => ResolvedOverride[]

const NONE: OverrideIndex = () => []

function resolved(row: ForecastOverride, rate: number | null): ResolvedOverride {
  return {
    id: row.id,
    scopeType: row.scopeType as ForecastScopeType,
    scopeId: row.scopeId,
    mode: row.mode as ForecastMode,
    value: Number(row.value.toString()),
    from: dateText(row.fromDate),
    to: dateText(row.toDate),
    rate,
  }
}

/** 为这批店铺 SKU 取适用的规则；没有任何规则时返回恒空的索引（不多做任何查询）。 */
export async function loadOverrideIndex(prisma: PrismaService, tenantId: string, today: string, targets: readonly OverrideTarget[]): Promise<OverrideIndex> {
  if (targets.length === 0) return NONE
  const rows = await prisma.forecastOverride.findMany({
    where: { tenantId, toDate: { gte: asDate(today) } },
    orderBy: [{ fromDate: 'asc' }, { id: 'asc' }],
    take: FORECAST_ACTIVE_LIMIT + 1,
  })
  if (rows.length === 0) return NONE
  const skus = new Set(targets.map(target => target.sku))
  const categories = new Set(targets.flatMap(target => (target.category ? [target.category] : [])))
  const relevant = rows.filter(row => (row.scopeType === 'SKU' ? skus.has(row.scopeId) : categories.has(row.scopeId)))
  if (relevant.length === 0) return NONE

  // 去年同期规则的日销：每条规则一次分组汇总，只查命中该规则的店铺与 ASIN
  const yoyRates = new Map<string, Map<string, number>>()
  for (const row of relevant.filter(item => item.mode === 'YOY_FACTOR')) {
    const matched = targets.filter(target => target.asin && (row.scopeType === 'SKU' ? target.sku === row.scopeId : target.category === row.scopeId))
    if (matched.length === 0) continue
    const from = dateText(row.fromDate)
    const to = dateText(row.toDate)
    const lastFrom = sameDayLastYear(from)
    const lastTo = sameDayLastYear(to)
    const days = forecastPeriodDays(lastFrom, lastTo)
    const factor = Number(row.value.toString())
    const groups = await prisma.asinDailySummary.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: {
        tenantId,
        sellerAccountId: { in: [...new Set(matched.map(target => target.sellerAccountId))] },
        asin: { in: [...new Set(matched.map(target => target.asin))] },
        summaryDate: { gte: asDate(lastFrom), lte: asDate(lastTo) },
      },
      _sum: { units: true },
      _count: { _all: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: 20_000,
    })
    yoyRates.set(row.id, new Map(groups.filter(group => group._count._all > 0).map(group => [key(group.sellerAccountId, group.asin), ((group._sum.units ?? 0) / days) * factor])))
  }

  const bySku = new Map<string, ForecastOverride[]>()
  const byCategory = new Map<string, ForecastOverride[]>()
  for (const row of relevant) {
    const map = row.scopeType === 'SKU' ? bySku : byCategory
    map.set(row.scopeId, [...(map.get(row.scopeId) ?? []), row])
  }
  const rateOf = (row: ForecastOverride, target: OverrideTarget): number | null => {
    if (row.mode === 'FIXED') return Number(row.value.toString())
    const rate = yoyRates.get(row.id)?.get(key(target.sellerAccountId, target.asin))
    return rate === undefined ? null : Math.round(rate * 1000) / 1000
  }
  return target => [...(bySku.get(target.sku) ?? []), ...(target.category ? (byCategory.get(target.category) ?? []) : [])].map(row => resolved(row, rateOf(row, target)))
}
