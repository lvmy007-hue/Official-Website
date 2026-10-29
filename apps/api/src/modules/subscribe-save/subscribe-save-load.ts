import { SNS_MONTHS_SHOWN, SNS_READ_LIMIT } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import type { MetricRow, OfferRecord } from './subscribe-save-math'

// 订阅省的取数（P4-06）：全部显式带企业与范围条件（storeWhere），读取量都有上限，多读一行用来判断是否被截断。

const dateText = (value: Date) => value.toISOString().slice(0, 10)
const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))

/** 日级指标（[from, to] 内）与近几个自然月的月度指标，一次读出。 */
export async function loadMetricRows(prisma: PrismaService, tenantId: string, scope: ResolvedScope, from: string, to: string): Promise<{ rows: MetricRow[]; truncated: boolean }> {
  const monthFrom = new Date(Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1 - SNS_MONTHS_SHOWN, 1))
  const where: Prisma.SubscribeSaveMetricWhereInput = {
    tenantId,
    ...storeWhere(scope),
    OR: [
      { granularity: 'DAY', metricDate: { gte: new Date(`${from}T00:00:00Z`), lte: new Date(`${to}T00:00:00Z`) } },
      { granularity: 'MONTH', metricDate: { gte: monthFrom } },
    ],
  }
  const found = await prisma.subscribeSaveMetric.findMany({
    where,
    select: { sellerAccountId: true, granularity: true, metricDate: true, activeSubscribers: true, shippedUnits: true, revenue: true, currency: true },
    orderBy: [{ metricDate: 'asc' }, { sellerAccountId: 'asc' }, { granularity: 'asc' }],
    take: SNS_READ_LIMIT + 1,
  })
  const truncated = found.length > SNS_READ_LIMIT
  const rows = (truncated ? found.slice(0, SNS_READ_LIMIT) : found).map<MetricRow>(row => ({
    sellerAccountId: row.sellerAccountId,
    granularity: row.granularity,
    metricDate: dateText(row.metricDate),
    activeSubscribers: row.activeSubscribers,
    shippedUnits: row.shippedUnits,
    revenue: num(row.revenue),
    currency: row.currency,
  }))
  return { rows, truncated }
}

/** 每个店铺最近一次报价快照里的全部报价（旧快照里已不在的报价不沿用）。 */
export async function loadLatestOffers(prisma: PrismaService, tenantId: string, scope: ResolvedScope): Promise<{ offers: OfferRecord[]; truncated: boolean }> {
  const latest = await prisma.subscribeSaveOffer.groupBy({ by: ['sellerAccountId'], where: { tenantId, ...storeWhere(scope) }, _max: { snapshotDate: true } })
  const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
  if (pairs.length === 0) return { offers: [], truncated: false }
  const found = await prisma.subscribeSaveOffer.findMany({
    where: { tenantId, OR: pairs },
    select: {
      id: true,
      sellerAccountId: true,
      snapshotDate: true,
      sku: true,
      asin: true,
      eligibility: true,
      fulfillment: true,
      sellerFundedBasePct: true,
      price: true,
      currency: true,
      inventory: true,
      stockRisk: true,
      subscriptions: true,
      forecastNext30: true,
      forecastNext60: true,
      forecastNext90: true,
      shippedUnitsPrevMonth: true,
      prevMonthDays: true,
      sellerAccount: { select: { displayName: true } },
    },
    orderBy: [{ sku: 'asc' }, { id: 'asc' }],
    take: SNS_READ_LIMIT + 1,
  })
  const truncated = found.length > SNS_READ_LIMIT
  const offers = (truncated ? found.slice(0, SNS_READ_LIMIT) : found).map<OfferRecord>(row => ({
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    snapshotDate: dateText(row.snapshotDate),
    sku: row.sku,
    asin: row.asin,
    eligibility: row.eligibility,
    fulfillment: row.fulfillment,
    sellerFundedBasePct: num(row.sellerFundedBasePct),
    price: num(row.price),
    currency: row.currency,
    inventory: row.inventory,
    stockRisk: row.stockRisk,
    subscriptions: row.subscriptions,
    forecastNext30: row.forecastNext30,
    forecastNext60: row.forecastNext60,
    forecastNext90: row.forecastNext90,
    shippedUnitsPrevMonth: row.shippedUnitsPrevMonth,
    prevMonthDays: row.prevMonthDays,
  }))
  return { offers, truncated }
}

/** 当前页的 ASIN 对应的商品（用于跳转 ASIN 360）：同店铺同 ASIN 取编号最小的一条。 */
export async function loadProductIds(prisma: PrismaService, tenantId: string, scope: ResolvedScope, pairs: ReadonlyArray<{ sellerAccountId: string; asin: string }>): Promise<Map<string, string>> {
  const asins = [...new Set(pairs.map(pair => pair.asin).filter(Boolean))]
  if (asins.length === 0) return new Map()
  const found = await prisma.fbaProduct.findMany({
    where: { tenantId, ...storeWhere(scope), asin: { in: asins } },
    select: { id: true, sellerAccountId: true, asin: true },
    orderBy: { id: 'asc' },
    take: SNS_READ_LIMIT,
  })
  const map = new Map<string, string>()
  for (const product of found) {
    const key = `${product.sellerAccountId}|${product.asin}`
    if (!map.has(key)) map.set(key, product.id)
  }
  return map
}
