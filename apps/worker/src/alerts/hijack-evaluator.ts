import { sellerRefOf } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, clip, keyOf, loadProductLookup, num } from './product-common'

// 跟卖预警评估器（P6-17，16 章第 9 节“新增预警来源：跟卖提醒”）：读跟卖观察表（OfferCompetitor，定价同步器按官方竞争摘要写入；不抓前台）。
// 对每个 店铺 × SKU：仍在报价（没有消失标记）、回看天数内才出现、卖家不在跟卖白名单里的其他报价方，数量达到下限就命中；报价方消失、超过回看天数或进了白名单都会自动恢复。
// 竞争摘要有延迟（同步每 2 小时一次，商品多时按轮转更晚），摘要也只保留价格最低的 30 个报价，证据里写明；卖家只给哈希，证据里的卖家引用不是编号原文。

const EVIDENCE_SELLERS = 5

export interface HijackOffer {
  sellerAccountId: string
  sku: string
  asin: string
  sellerId: string
  firstSeenAt: Date
  price: number
  currency: string
  isFba: boolean
  hasBuybox: boolean
}

export interface HijackTarget {
  sellerAccountId: string
  sku: string
  asin: string
  offers: HijackOffer[]
}

/** 纯函数：把观察行按 店铺 × SKU 归并，去掉白名单里的卖家，只留回看窗口内新出现的，数量达到下限的才返回；报价按价格从低到高。 */
export function hijackTargets(rows: readonly HijackOffer[], whitelist: ReadonlySet<string>, since: Date, minOffers: number): HijackTarget[] {
  const byKey = new Map<string, HijackTarget>()
  for (const row of rows) {
    if (whitelist.has(row.sellerId) || row.firstSeenAt < since) continue
    const key = keyOf(row.sellerAccountId, row.sku)
    const target = byKey.get(key) ?? { sellerAccountId: row.sellerAccountId, sku: row.sku, asin: row.asin, offers: [] }
    target.offers.push(row)
    byKey.set(key, target)
  }
  return [...byKey.values()]
    .filter(target => target.offers.length >= minOffers)
    .map(target => ({ ...target, offers: [...target.offers].sort((a, b) => a.price - b.price || (a.sellerId < b.sellerId ? -1 : 1)) }))
    .sort((a, b) => b.offers.length - a.offers.length || (keyOf(a.sellerAccountId, a.sku) < keyOf(b.sellerAccountId, b.sku) ? -1 : 1))
}

export const hijackOfferEvaluator: AlertEvaluator = {
  type: 'pricing.hijack-offer',
  async evaluate({ db, tenantId, rule, now }) {
    const lookbackDays = numberParam(rule, 'lookbackDays', 7, { min: 1, max: 30 })
    const minOffers = numberParam(rule, 'minOffers', 1, { min: 1, max: 20 })
    const scope = scopeFilter(rule)
    const since = new Date(now.getTime() - lookbackDays * DAY_MS)
    const [found, whitelisted] = await Promise.all([
      db.offerCompetitor.findMany({
        where: {
          tenantId,
          goneAt: null,
          firstSeenAt: { gte: since, lte: now },
          ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
          ...(scope.skus ? { sku: { in: scope.skus } } : {}),
        },
        select: { sellerAccountId: true, sku: true, asin: true, sellerId: true, firstSeenAt: true, price: true, currency: true, isFba: true, hasBuybox: true },
        orderBy: [{ firstSeenAt: 'desc' }, { id: 'asc' }],
        take: READ_LIMIT,
      }),
      db.hijackWhitelist.findMany({ where: { tenantId }, select: { sellerId: true }, take: 1000 }),
    ])
    const targets = hijackTargets(
      found.filter(row => scope.allows({ sellerAccountId: row.sellerAccountId, sku: row.sku })).map(row => ({ ...row, price: num(row.price) as number })),
      new Set(whitelisted.map(row => row.sellerId)),
      since,
      minOffers,
    )
    if (targets.length === 0) return []
    const lookup = await loadProductLookup(db, tenantId, { storeIds: targets.map(target => target.sellerAccountId), skus: targets.map(target => target.sku) })
    return targets.map((target): AlertHit => {
      const product = lookup.bySku.get(keyOf(target.sellerAccountId, target.sku))
      const store = lookup.storeName.get(target.sellerAccountId) ?? '店铺'
      const key = keyOf(target.sellerAccountId, target.sku)
      const lowest = target.offers[0]!
      return {
        // 有商品记录的点进去是定价详情；没有的按 店铺|SKU 登记
        entityType: product ? 'SKU' : 'HIJACK_SKU',
        entityId: product?.id ?? key,
        sellerAccountId: target.sellerAccountId,
        entityLabel: `${target.sku}（${store}）`,
        title: `SKU ${target.sku} 上出现 ${target.offers.length} 个其他报价方（最低 ${lowest.currency} ${lowest.price.toFixed(2)}）`,
        suggestedAction: '到跟卖监控页查看这些报价方的价格、履约方式与是否拿到购物车；是自己的其他店铺就加入白名单，确认是跟卖就按平台流程投诉或调整定价；数据来自官方竞争摘要，有同步延迟',
        evidence: {
          sku: target.sku,
          asin: target.asin || null,
          title: product?.title ? clip(product.title, 200) : null,
          storeName: store,
          lookbackDays,
          minOffers,
          offerCount: target.offers.length,
          offers: target.offers.slice(0, EVIDENCE_SELLERS).map(offer => ({
            seller: sellerRefOf(offer.sellerId),
            price: offer.price,
            currency: offer.currency,
            isFba: offer.isFba,
            hasBuybox: offer.hasBuybox,
            firstSeenAt: offer.firstSeenAt.toISOString(),
          })),
          note: '数据只来自官方竞争摘要，不抓前台页面；摘要只保留价格最低的 30 个报价，同步每 2 小时一次，商品很多时更晚',
        },
      }
    })
  },
}
