import type { ImportContext } from '../../types'
import type { SummaryOffer, SummaryRow } from './parse'
import type { PricingScope } from './store'

// 跟卖观察的落库（P6-17，importers.md I-13 的补充）：每次读到竞争摘要，就把“我方 Listing 上的其他报价方”刷新进 OfferCompetitor。
// 数据只来自官方竞争摘要（不抓前台）；卖家编号只存哈希（与 CompetitiveOffer.offerKey 同一个 sellerKeyOf）。
// 规则：
//   - 摘要的粒度是 ASIN，观察的粒度是 店铺 × SKU：一个 ASIN 下的每个 SKU 都记一份（我方同一 ASIN 的多个 SKU 共用同一批对方报价方）；
//   - 同一卖家在摘要里可能有几条报价（购物车报价、最低价报价），取价格最低的一条，只要有一条是购物车报价就算“拿到购物车”；
//   - 对方在这次摘要里：已有观察则刷新最近看到、价格与标记（最近看到距上次不到 12 小时且没有变化就不写，免得每 2 小时改一次所有行）；
//     已消失的重新出现，算新的一次出现（首次出现时间重置、清掉消失标记）；没有观察则新建；
//   - 已有观察、这次摘要里已经没有的：标记消失（goneAt = 这次观察时间）；摘要整体读取失败的 ASIN 不在 rows 里，不会被误标消失；
//   - 摘要只保留价格最低的 30 个报价，所以“消失”也可能是价格被抬高排到了 30 名之外，页面写明。
// 调用方保证“我方卖家编号”已知（否则分不出我方与对方，宁可不写）。

const REFRESH_AFTER_MS = 12 * 3_600_000
const num = (value: { toString(): string }): number => Number(value.toString())
const differs = (a: number, b: number) => Math.abs(a - b) >= 0.005

interface Seen {
  sellerId: string
  price: number
  currency: string
  isFba: boolean
  hasBuybox: boolean
}

/** 一个 ASIN 的摘要里，对方每个卖家取价格最低的一条（输入的 offers 已按价格升序）；购物车标记取并集。 */
export function competitorsOf(offers: readonly SummaryOffer[], currency: string): Seen[] {
  const byKey = new Map<string, Seen>()
  for (const offer of offers) {
    if (offer.isOwn) continue
    const before = byKey.get(offer.offerKey)
    if (!before) byKey.set(offer.offerKey, { sellerId: offer.offerKey, price: offer.price, currency, isFba: offer.fulfillment === 'FBA', hasBuybox: offer.isFeatured })
    else if (offer.isFeatured) before.hasBuybox = true
  }
  return [...byKey.values()]
}

export interface CompetitorResult {
  appeared: number
  refreshed: number
  gone: number
}

export async function storeCompetitors(ctx: ImportContext, scope: PricingScope, rows: readonly SummaryRow[], skusOfAsin: ReadonlyMap<string, readonly string[]>, now: Date): Promise<CompetitorResult> {
  const result: CompetitorResult = { appeared: 0, refreshed: 0, gone: 0 }
  const targets = rows.flatMap(row => (skusOfAsin.get(row.asin) ?? []).map(sku => ({ row, sku })))
  if (targets.length === 0) return result
  const existing = await ctx.prisma.offerCompetitor.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, sku: { in: [...new Set(targets.map(item => item.sku))] } },
    orderBy: [{ id: 'asc' }],
    take: 100_000,
  })
  const bySku = new Map<string, typeof existing>()
  for (const row of existing) bySku.set(row.sku, [...(bySku.get(row.sku) ?? []), row])
  for (const { row, sku } of targets) {
    const seen = competitorsOf(row.offers, row.currency)
    const current = new Map((bySku.get(sku) ?? []).map(item => [item.sellerId, item]))
    const present = new Set(seen.map(item => item.sellerId))
    for (const offer of seen) {
      const before = current.get(offer.sellerId)
      if (!before) {
        await ctx.prisma.offerCompetitor.create({
          data: {
            ...scope,
            sku,
            asin: row.asin,
            sellerId: offer.sellerId,
            firstSeenAt: now,
            lastSeenAt: now,
            price: offer.price,
            currency: offer.currency,
            isFba: offer.isFba,
            hasBuybox: offer.hasBuybox,
          },
        })
        result.appeared += 1
      } else if (before.goneAt !== null) {
        // 消失后重新出现：算新的一次出现
        await ctx.prisma.offerCompetitor.updateMany({
          where: { id: before.id, tenantId: scope.tenantId },
          data: { asin: row.asin, firstSeenAt: now, lastSeenAt: now, goneAt: null, price: offer.price, currency: offer.currency, isFba: offer.isFba, hasBuybox: offer.hasBuybox },
        })
        result.appeared += 1
      } else if (
        differs(num(before.price), offer.price) ||
        before.isFba !== offer.isFba ||
        before.hasBuybox !== offer.hasBuybox ||
        before.currency !== offer.currency ||
        before.asin !== row.asin ||
        now.getTime() - before.lastSeenAt.getTime() >= REFRESH_AFTER_MS
      ) {
        await ctx.prisma.offerCompetitor.updateMany({
          where: { id: before.id, tenantId: scope.tenantId },
          data: { asin: row.asin, lastSeenAt: now, price: offer.price, currency: offer.currency, isFba: offer.isFba, hasBuybox: offer.hasBuybox },
        })
        result.refreshed += 1
      }
    }
    const missing = [...current.values()].filter(item => item.goneAt === null && !present.has(item.sellerId) && item.asin === row.asin)
    if (missing.length > 0) {
      await ctx.prisma.offerCompetitor.updateMany({ where: { tenantId: scope.tenantId, id: { in: missing.map(item => item.id) } }, data: { goneAt: now } })
      result.gone += missing.length
    }
  }
  return result
}
