import type { Prisma } from '@prisma/client'
import type { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { asDate, dateText } from './period'
import { ZERO_DAY, type DayValues } from './aggregate'

// 经营日汇总与 ASIN 日汇总的读取（P2a-01 的两张表）。全部在数据库里聚合，只取聚合结果；
// 范围（店铺）条件与租户条件显式带上，行级安全同时生效。

export interface SummaryContext {
  tenantId: string
  scope: ResolvedScope
}

type Dec = { toString(): string } | null | undefined
const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

type StoreSums = {
  _sum: {
    orders: number | null
    units: number | null
    salesAmount: Dec
    refundAmount: Dec
    feeAmount: Dec
    adsSpend: Dec
    adsSales: Dec
    profit: Dec
    sessions: number | null
  }
}

function toValues(group: StoreSums): DayValues {
  const sum = group._sum
  return {
    orders: sum.orders ?? 0,
    units: sum.units ?? 0,
    sales: num(sum.salesAmount) ?? 0,
    refund: num(sum.refundAmount) ?? 0,
    fee: num(sum.feeAmount) ?? 0,
    adsSpend: num(sum.adsSpend),
    adsSales: num(sum.adsSales),
    profit: num(sum.profit),
    sessions: sum.sessions ?? null,
  }
}

const STORE_SUM = { orders: true, units: true, salesAmount: true, refundAmount: true, feeAmount: true, adsSpend: true, adsSales: true, profit: true, sessions: true } as const

const storeScope = (ctx: SummaryContext, from: string, to: string): Prisma.StoreDailySummaryWhereInput => ({
  tenantId: ctx.tenantId,
  ...storeWhere(ctx.scope),
  summaryDate: { gte: asDate(from), lte: asDate(to) },
})

/** 逐日合计（范围内全部店铺）；没有行的日子不在结果里。 */
export async function dailyValues(prisma: PrismaService, ctx: SummaryContext, from: string, to: string): Promise<Map<string, DayValues>> {
  const groups = await prisma.storeDailySummary.groupBy({ by: ['summaryDate'], where: storeScope(ctx, from, to), _sum: STORE_SUM })
  return new Map(groups.map(group => [dateText(group.summaryDate), toValues(group)]))
}

/** 按店铺合计。 */
export async function storeValues(prisma: PrismaService, ctx: SummaryContext, from: string, to: string): Promise<Map<string, DayValues>> {
  const groups = await prisma.storeDailySummary.groupBy({ by: ['sellerAccountId'], where: storeScope(ctx, from, to), _sum: STORE_SUM })
  return new Map(groups.map(group => [group.sellerAccountId, toValues(group)]))
}

/** 范围内的合计，没有行时返回全空的一天（可空列为 null）。 */
export async function totalValues(prisma: PrismaService, ctx: SummaryContext, from: string, to: string): Promise<{ values: DayValues; hasRows: boolean }> {
  const aggregate = await prisma.storeDailySummary.aggregate({ where: storeScope(ctx, from, to), _sum: STORE_SUM, _count: { _all: true } })
  const hasRows = aggregate._count._all > 0
  return { values: hasRows ? toValues(aggregate as unknown as StoreSums) : { ...ZERO_DAY }, hasRows }
}

/** 最近一次刷新时间、口径版本与销售额来源（取范围内最新的一行）。 */
export async function refreshInfo(prisma: PrismaService, ctx: SummaryContext, from: string, to: string) {
  const row = await prisma.storeDailySummary.findFirst({ where: storeScope(ctx, from, to), orderBy: { refreshedAt: 'desc' }, select: { refreshedAt: true, metricVersion: true, salesSource: true } })
  return row ? { refreshedAt: row.refreshedAt.toISOString(), metricVersion: row.metricVersion, salesSource: row.salesSource } : null
}

const asinScope = (ctx: SummaryContext, from: string, to: string, extra: Prisma.AsinDailySummaryWhereInput = {}): Prisma.AsinDailySummaryWhereInput => ({
  tenantId: ctx.tenantId,
  ...storeWhere(ctx.scope),
  summaryDate: { gte: asDate(from), lte: asDate(to) },
  ...extra,
})

export interface AsinTotals {
  asin: string
  sku: string | null
  units: number
  sales: number
  profit: number | null
}

const ASIN_SUM = { units: true, salesAmount: true, profit: true } as const
type AsinGroup = { asin: string; _max: { sku: string | null }; _sum: { units: number | null; salesAmount: Dec; profit: Dec } }
const toAsin = (group: AsinGroup): AsinTotals => ({ asin: group.asin, sku: group._max.sku, units: group._sum.units ?? 0, sales: num(group._sum.salesAmount) ?? 0, profit: num(group._sum.profit) })

export type AsinOrder = 'sales' | 'profit'

/** 按 ASIN 合计，按销售额或利润排序取前 N（direction 为 asc 时取最少的 N）。 */
export async function asinTotals(prisma: PrismaService, ctx: SummaryContext, from: string, to: string, options: { order: AsinOrder; direction: 'asc' | 'desc'; take: number }): Promise<AsinTotals[]> {
  const orderField = options.order === 'sales' ? 'salesAmount' : 'profit'
  const groups = await prisma.asinDailySummary.groupBy({
    by: ['asin'],
    where: asinScope(ctx, from, to, options.order === 'profit' ? { profit: { not: null } } : {}),
    _sum: ASIN_SUM,
    _max: { sku: true },
    having: options.order === 'sales' ? { salesAmount: { _sum: { gt: 0 } } } : undefined,
    orderBy: [{ _sum: { [orderField]: options.direction } }, { asin: 'asc' }],
    take: options.take,
  })
  return groups.map(group => toAsin(group as unknown as AsinGroup))
}

/** 指定 ASIN 在某期间的合计。 */
export async function asinTotalsFor(prisma: PrismaService, ctx: SummaryContext, from: string, to: string, asins: readonly string[]): Promise<Map<string, AsinTotals>> {
  if (asins.length === 0) return new Map()
  const groups = await prisma.asinDailySummary.groupBy({ by: ['asin'], where: asinScope(ctx, from, to, { asin: { in: [...asins] } }), _sum: ASIN_SUM, _max: { sku: true } })
  return new Map(groups.map(group => [group.asin, toAsin(group as unknown as AsinGroup)]))
}

/** 范围内 ASIN 汇总的销售额总计（不受候选数量限制）。 */
export async function asinSalesTotal(prisma: PrismaService, ctx: SummaryContext, from: string, to: string): Promise<number> {
  const result = await prisma.asinDailySummary.aggregate({ where: asinScope(ctx, from, to), _sum: { salesAmount: true } })
  return num(result._sum.salesAmount) ?? 0
}

/** 此前（日期早于 before）已经出现过的 ASIN。 */
export async function asinsSeenBefore(prisma: PrismaService, ctx: SummaryContext, before: string, asins: readonly string[]): Promise<Set<string>> {
  if (asins.length === 0) return new Set()
  const groups = await prisma.asinDailySummary.groupBy({ by: ['asin'], where: { tenantId: ctx.tenantId, ...storeWhere(ctx.scope), asin: { in: [...asins] }, summaryDate: { lt: asDate(before) } } })
  return new Set(groups.map(group => group.asin))
}
