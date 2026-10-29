import { PRICING_LIMITS, STACKING_LIMITS, isDeep, isStacked, stackRowsOf, type StackItemInput, type StackPromotionInput } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'
import { READ_LIMIT, clip, firstBy, keyOf, loadProductLookup, num } from './product-common'

// 促销叠加预警评估器（P6-17，16 章第 3.2、9 节）：读已同步的促销清单（Promotion 与 PromotionItem，只看进行中与即将开始的商品清单类促销），
// 用与促销页“叠加”列表同一份计算（api-contracts 的 stackRowsOf）：同一 店铺 × ASIN 同一时段叠加的促销数达到下限，或叠加后的折扣深度达到下限，就命中；促销结束、取消或调整后自动恢复。
// 折扣深度里立减金额与固定价要按该 ASIN 最近一次价格折算（只看 3 天内的价格行），没有价格的算不出深度、只计数；整个目录范围的促销没有商品清单，不计入。
// 读取有上限（促销 2000 个、商品行 2 万行）：读满时证据里写“可能不完整”，不拿不完整的数据冒充完整。

const PROMOTION_LIMIT = 2000
const PRICE_CHUNK = 500

async function loadPrices(db: PrismaClient, tenantId: string, storeIds: readonly string[], asins: readonly string[], now: Date): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  const since = new Date(now.getTime() - PRICING_LIMITS.freshWindowMs)
  for (let index = 0; index < asins.length; index += PRICE_CHUNK) {
    const part = asins.slice(index, index + PRICE_CHUNK)
    const rows = await db.priceSnapshot.findMany({
      where: { tenantId, sellerAccountId: { in: [...storeIds] }, asin: { in: part }, observedAt: { gte: since } },
      select: { sellerAccountId: true, asin: true, price: true, observedAt: true },
      orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    for (const [key, row] of firstBy(rows, item => keyOf(item.sellerAccountId, item.asin))) out.set(key, num(row.price) as number)
  }
  return out
}

export const promoStackingEvaluator: AlertEvaluator = {
  type: 'promotions.stacking',
  async evaluate({ db, tenantId, rule, now }) {
    const minStack = numberParam(rule, 'minStack', 2, { min: 2, max: STACKING_LIMITS.minStackMax })
    const minDepthPct = numberParam(rule, 'minDepthPct', 0.3, { min: 0.05, max: 0.95 })
    const scope = scopeFilter(rule)
    const promotions = await db.promotion.findMany({
      where: { tenantId, status: { in: ['RUNNING', 'UPCOMING'] }, ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}), OR: [{ endAt: null }, { endAt: { gt: now } }] },
      select: { id: true, promotionId: true, title: true, promotionType: true, status: true, startAt: true, endAt: true, sellerAccountId: true },
      orderBy: [{ startAt: 'asc' }, { id: 'asc' }],
      take: PROMOTION_LIMIT,
    })
    if (promotions.length === 0) return []
    const itemRows = await db.promotionItem.findMany({
      where: { tenantId, promotionRowId: { in: promotions.map(item => item.id) } },
      select: { promotionRowId: true, sellerAccountId: true, asin: true, sku: true, benefitType: true, discountType: true, percentOff: true, amountOff: true, fixedPrice: true },
      orderBy: [{ id: 'asc' }],
      take: STACKING_LIMITS.itemRowsMax,
    })
    const incomplete = promotions.length >= PROMOTION_LIMIT || itemRows.length >= STACKING_LIMITS.itemRowsMax
    // 只给了 SKU 没给 ASIN 的清单行，用商品目录补 ASIN；补不出来的不参与
    const bare = itemRows.filter(row => row.asin === '' && row.sku !== '')
    const lookup = await loadProductLookup(db, tenantId, { storeIds: [...new Set(itemRows.map(row => row.sellerAccountId))], skus: bare.map(row => row.sku) })
    const items: StackItemInput[] = itemRows.flatMap(row => {
      const asin = row.asin !== '' ? row.asin : (lookup.bySku.get(keyOf(row.sellerAccountId, row.sku))?.asin ?? '')
      return asin === ''
        ? []
        : [
            {
              promotionRowId: row.promotionRowId,
              sellerAccountId: row.sellerAccountId,
              asin,
              sku: row.sku,
              benefitType: row.benefitType,
              discountType: row.discountType,
              percentOff: num(row.percentOff),
              amountOff: num(row.amountOff),
              fixedPrice: num(row.fixedPrice),
            },
          ]
    })
    const inputs: StackPromotionInput[] = promotions.map(item => ({
      rowId: item.id,
      promotionId: item.promotionId,
      title: item.title,
      type: item.promotionType,
      status: item.status,
      startAt: item.startAt,
      endAt: item.endAt,
      sellerAccountId: item.sellerAccountId,
    }))
    const prices = await loadPrices(db, tenantId, [...new Set(items.map(item => item.sellerAccountId))], [...new Set(items.map(item => item.asin))], now)
    const rows = stackRowsOf(inputs, items, (storeId, asin) => prices.get(keyOf(storeId, asin)) ?? null, now.getTime()).filter(
      row => scope.allows({ sellerAccountId: row.storeId }) && (isStacked(row, minStack) || isDeep(row, minDepthPct)),
    )
    if (rows.length === 0) return []
    const shown = rows.slice(0, 2000)
    const names = await loadProductLookup(db, tenantId, { storeIds: shown.map(row => row.storeId), asins: shown.map(row => row.asin) })
    return shown.map((row): AlertHit => {
      const product = names.byAsin.get(keyOf(row.storeId, row.asin))
      const store = names.storeName.get(row.storeId) ?? '店铺'
      const stacked = isStacked(row, minStack)
      const depthText = row.depth === null ? '折扣深度算不出' : `叠加折扣约 ${Math.round(row.depth * 1000) / 10}%`
      return {
        entityType: product ? 'ASIN' : 'PROMO_ASIN',
        entityId: product?.id ?? keyOf(row.storeId, row.asin),
        sellerAccountId: row.storeId,
        entityLabel: `${row.asin}（${store}）`,
        title: stacked ? `ASIN ${row.asin} 同期叠加 ${row.peakCount} 个促销，${depthText}` : `ASIN ${row.asin} 促销叠加后${depthText}，超过 ${Math.round(minDepthPct * 100)}%`,
        suggestedAction: '到促销页的“叠加情况”查看这些促销的起止与折扣；确认叠加是否在计划内，不在就到卖家后台调整或取消其中一个促销（本系统只读，不能改促销）',
        evidence: {
          asin: row.asin,
          title: product?.title ? clip(product.title, 200) : null,
          storeName: store,
          peakCount: row.peakCount,
          depth: row.depth,
          unknownDepth: row.unknownDepth,
          peakFrom: row.peakFrom,
          peakTo: row.peakTo,
          minStack,
          minDepthPct,
          promotions: row.promotions
            .slice(0, 10)
            .map(item => ({ promotionId: item.promotionId, title: clip(item.title, 100), status: item.status, startAt: item.startAt, endAt: item.endAt, depth: item.depth })),
          ...(incomplete ? { note: '读取已到上限，叠加情况可能不完整' } : {}),
        },
      }
    })
  },
}
