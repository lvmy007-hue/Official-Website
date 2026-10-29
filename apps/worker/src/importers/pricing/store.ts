import { PRICING_LIMITS, shouldStorePrice } from '@nova/api-contracts'
import type { ImportContext } from '../../types'
import type { ExpectedPriceRow, OwnPrice, SummaryRow } from './parse'

// 定价数据的落库（importers.md I-13）：价格类快照只在“变化”或“距上一条超过 24 小时（心跳）”时才写，读取“最近一次”只看 3 天内的行。
// 这样 2 小时一次的同步不会让历史表膨胀，也不需要原生 SQL 去重取最新。写入用 skipDuplicates：同一时刻重复执行是安全的。

export interface PricingScope {
  tenantId: string
  sellerAccountId: string
}
const MARKETPLACE = 'ATVPDKIKX0DER'
const windowStart = (now: Date) => new Date(now.getTime() - PRICING_LIMITS.freshWindowMs)
const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const differs = (a: number | null, b: number | null) => (a === null || b === null ? a !== b : Math.abs(a - b) >= 0.005)
const stale = (last: Date, now: Date) => now.getTime() - last.getTime() >= PRICING_LIMITS.heartbeatMs

/** 每个键只留最近的一行（输入需按时间倒序）。 */
function firstBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) if (!map.has(keyOf(row))) map.set(keyOf(row), row)
  return map
}

export async function storeOwnPrices(ctx: ImportContext, scope: PricingScope, items: readonly OwnPrice[], now: Date): Promise<number> {
  if (items.length === 0) return 0
  const rows = await ctx.prisma.priceSnapshot.findMany({
    where: { sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE, sellerSku: { in: items.map(item => item.sku) }, observedAt: { gte: windowStart(now) } },
    select: { sellerSku: true, price: true, observedAt: true },
    orderBy: { observedAt: 'desc' },
  })
  const last = firstBy(rows, row => row.sellerSku)
  const data = items
    .filter(item => {
      const before = last.get(item.sku)
      return shouldStorePrice(before ? { price: Number(before.price.toString()), observedAt: before.observedAt } : null, item.price, now)
    })
    .map(item => ({ ...scope, marketplaceId: MARKETPLACE, sellerSku: item.sku, asin: item.asin, price: item.price, currency: item.currency, source: 'LISTING_API', observedAt: now }))
  if (data.length === 0) return 0
  return (await ctx.prisma.priceSnapshot.createMany({ data, skipDuplicates: true })).count
}

export async function storeExpected(ctx: ImportContext, scope: PricingScope, items: readonly ExpectedPriceRow[], now: Date): Promise<number> {
  if (items.length === 0) return 0
  const rows = await ctx.prisma.featuredOfferExpectedPrice.findMany({
    where: { sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE, sellerSku: { in: items.map(item => item.sku) }, observedAt: { gte: windowStart(now) } },
    orderBy: { observedAt: 'desc' },
  })
  const last = firstBy(rows, row => row.sellerSku)
  const data = items
    .filter(item => {
      const before = last.get(item.sku)
      return (
        !before ||
        before.resultStatus !== item.resultStatus ||
        differs(num(before.expectedPrice), item.expectedPrice) ||
        differs(num(before.currentFeaturedPrice), item.currentFeaturedPrice) ||
        stale(before.observedAt, now)
      )
    })
    .map(item => ({
      ...scope,
      marketplaceId: MARKETPLACE,
      sellerSku: item.sku,
      asin: item.asin,
      expectedPrice: item.expectedPrice,
      currentFeaturedPrice: item.currentFeaturedPrice,
      currency: item.currency,
      resultStatus: item.resultStatus,
      observedAt: now,
    }))
  if (data.length === 0) return 0
  return (await ctx.prisma.featuredOfferExpectedPrice.createMany({ data, skipDuplicates: true })).count
}

export async function storeSummaries(ctx: ImportContext, scope: PricingScope, items: readonly SummaryRow[], now: Date): Promise<{ summaries: number; offers: number; buyBox: number }> {
  if (items.length === 0) return { summaries: 0, offers: 0, buyBox: 0 }
  const asins = items.map(item => item.asin)
  const since = windowStart(now)
  const [summaryRows, boxRows] = await Promise.all([
    ctx.prisma.competitiveSummarySnapshot.findMany({
      where: { sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE, asin: { in: asins }, observedAt: { gte: since } },
      orderBy: { observedAt: 'desc' },
    }),
    ctx.prisma.buyBoxSnapshot.findMany({
      where: { sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE, asin: { in: asins }, sellerSku: '', source: 'SYNC', observedAt: { gte: since } },
      orderBy: { observedAt: 'desc' },
    }),
  ])
  const lastSummary = firstBy(summaryRows, row => row.asin)
  const lastBox = firstBy(boxRows, row => row.asin)
  const changedSummary = items.filter(item => {
    const before = lastSummary.get(item.asin)
    return (
      !before ||
      differs(num(before.featuredPrice), item.featuredPrice) ||
      differs(num(before.lowestPrice), item.lowestPrice) ||
      differs(num(before.referencePrice), item.referencePrice) ||
      before.featuredIsOwn !== item.featuredIsOwn ||
      differs(num(before.viewWeightMember), item.viewWeightMember) ||
      differs(num(before.viewWeightNonMember), item.viewWeightNonMember) ||
      stale(before.observedAt, now)
    )
  })
  const changedBox = items.filter(item => {
    const before = lastBox.get(item.asin)
    return (
      !before || before.hasFeaturedOffer !== item.hasFeatured || before.ownIsFeatured !== item.featuredIsOwn || differs(num(before.featuredPrice), item.featuredPrice) || stale(before.observedAt, now)
    )
  })
  const base = { ...scope, marketplaceId: MARKETPLACE, observedAt: now }
  const summaries =
    changedSummary.length === 0
      ? 0
      : (
          await ctx.prisma.competitiveSummarySnapshot.createMany({
            data: changedSummary.map(item => ({
              ...base,
              asin: item.asin,
              featuredPrice: item.featuredPrice,
              featuredFulfillment: item.featuredFulfillment,
              featuredIsOwn: item.featuredIsOwn,
              viewWeightMember: item.viewWeightMember,
              viewWeightNonMember: item.viewWeightNonMember,
              referencePrice: item.referencePrice,
              referencePriceType: item.referencePriceType,
              lowestPrice: item.lowestPrice,
              currency: item.currency,
            })),
            skipDuplicates: true,
          })
        ).count
  // 报价明细随摘要一起写（摘要没变就不重复写）；同一卖家同一时刻只留价格最低的一条（offers 已按价格升序）
  const offerRows = changedSummary.flatMap(item => item.offers.map(offer => ({ ...base, asin: item.asin, ...offer })))
  const offers = offerRows.length === 0 ? 0 : (await ctx.prisma.competitiveOffer.createMany({ data: offerRows, skipDuplicates: true })).count
  const buyBox =
    changedBox.length === 0
      ? 0
      : (
          await ctx.prisma.buyBoxSnapshot.createMany({
            data: changedBox.map(item => ({
              ...base,
              asin: item.asin,
              sellerSku: '',
              hasFeaturedOffer: item.hasFeatured,
              ownIsFeatured: item.featuredIsOwn,
              featuredPrice: item.featuredPrice,
              source: 'SYNC',
            })),
            skipDuplicates: true,
          })
        ).count
  return { summaries, offers, buyBox }
}
