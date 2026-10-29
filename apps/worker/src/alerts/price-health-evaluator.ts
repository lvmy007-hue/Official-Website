import { PRICING_LIMITS, priceHealthLabel, priceHealthOf, round2, type PriceHealth } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { choiceListParam, numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, firstBy, keyOf, loadProductLookup, num } from './product-common'

// 价格健康异常预警评估器（P4-15，09 章 9.1 商品类）：与定价页同一个判断函数（priceHealthOf，P4-11），只报两种状态：
// - ABOVE_EXPECTED“价格高于预期”：我方价格（刊登接口报价）比推荐报价预期价格高出阈值比例，且我方没有获得推荐报价；价格、预期价格、竞争摘要都只取最近 3 天内的最新一行
//   （与定价页一致），币种不一致的不判断；预期价格没给（空）的不判断，不当 0；
// - LOST_ELIGIBILITY“因价格失去资格”：价格健康通知（推送暂缓，处理器已注册）标明因价格失去推荐报价资格，且之后没有重新获得。目前没有事件进来，接入前不会命中。
// 定价页本身目前也不读这条通知（eligibilityLost 固定为 false），这里是第一处读它的地方。比例阈值是我们自定的默认值。

const STATES = ['ABOVE_EXPECTED', 'LOST_ELIGIBILITY'] as const satisfies readonly PriceHealth[]

export interface HealthTarget {
  sellerAccountId: string
  sku: string
  asin: string
  ownPrice: number
  expectedPrice: number | null
  expectedCurrency: string | null
  currency: string
  resultStatus: string | null
  featuredIsOwn: boolean | null
  featuredPrice: number | null
  hasObservation: boolean
  eligibilityLost: boolean
}

export interface HealthHit {
  target: HealthTarget
  state: Extract<PriceHealth, 'ABOVE_EXPECTED' | 'LOST_ELIGIBILITY'>
  gap: number | null
  gapRatio: number | null
}

/** 判断每个 SKU 的价格健康，只留命中的状态；价格高于预期的要求高出比例不小于 minGapRatio；差距大的排前面（纯函数）。 */
export function healthHits(targets: readonly HealthTarget[], states: readonly string[], minGapRatio: number): HealthHit[] {
  const out: HealthHit[] = []
  for (const target of targets) {
    if (target.expectedCurrency !== null && target.expectedCurrency !== target.currency) continue
    const state = priceHealthOf({
      ownPrice: target.ownPrice,
      expectedPrice: target.expectedPrice,
      resultStatus: target.resultStatus,
      ownIsFeatured: target.featuredIsOwn,
      eligibilityLost: target.eligibilityLost,
      hasObservation: target.hasObservation,
    })
    if (state !== 'ABOVE_EXPECTED' && state !== 'LOST_ELIGIBILITY') continue
    if (!states.includes(state)) continue
    const gap = target.expectedPrice === null ? null : target.ownPrice - target.expectedPrice
    // 比例先取六位小数再与阈值比较，避免 0.54 ÷ 18 这类浮点误差让“刚好等于阈值”的价差被漏掉
    const gapRatio = gap !== null && target.expectedPrice !== null && target.expectedPrice > 0 ? Math.round((gap / target.expectedPrice) * 1_000_000) / 1_000_000 : null
    if (state === 'ABOVE_EXPECTED' && (gapRatio === null || gapRatio < minGapRatio)) continue
    out.push({ target, state, gap, gapRatio })
  }
  return out.sort((a, b) => (b.gapRatio ?? -1) - (a.gapRatio ?? -1) || (keyOf(a.target.sellerAccountId, a.target.sku) < keyOf(b.target.sellerAccountId, b.target.sku) ? -1 : 1))
}

const percentText = (ratio: number) => `${Math.round(ratio * 1000) / 10}%`

export const priceHealthEvaluator: AlertEvaluator = {
  type: 'pricing.price-health',
  async evaluate({ db, tenantId, rule, now }) {
    const states = choiceListParam(rule, 'states', STATES, STATES)
    const minGapRatio = numberParam(rule, 'minGapRatio', 0.03, { min: 0, max: 5 })
    const lostLookbackDays = numberParam(rule, 'lostLookbackDays', 7, { min: 1, max: 30 })
    const scope = scopeFilter(rule)
    const fresh = { gte: new Date(now.getTime() - PRICING_LIMITS.freshWindowMs), lte: now }
    const storeWhere = scope.stores ? { sellerAccountId: { in: scope.stores } } : {}
    const skuWhere = scope.skus ? { sellerSku: { in: scope.skus } } : {}
    const prices = await db.priceSnapshot.findMany({
      where: { tenantId, observedAt: fresh, ...storeWhere, ...skuWhere },
      orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const latestPrice = firstBy(prices, row => keyOf(row.sellerAccountId, row.sellerSku))
    if (latestPrice.size === 0) return []
    const storeIds = [...new Set([...latestPrice.values()].map(row => row.sellerAccountId))]
    const skus = [...new Set([...latestPrice.values()].map(row => row.sellerSku))]
    const [expectedRows, summaryRows, lostRows, lookup] = await Promise.all([
      db.featuredOfferExpectedPrice.findMany({
        where: { tenantId, observedAt: fresh, sellerAccountId: { in: storeIds }, sellerSku: { in: skus } },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: READ_LIMIT,
      }),
      db.competitiveSummarySnapshot.findMany({
        where: { tenantId, observedAt: fresh, sellerAccountId: { in: storeIds } },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: READ_LIMIT,
      }),
      // 窗口内“因价格失去资格”的标记，与之后重新获得推荐报价的观察，用来判断现在是不是仍处于失去状态
      db.buyBoxSnapshot.findMany({
        where: {
          tenantId,
          sellerAccountId: { in: storeIds },
          observedAt: { gte: new Date(now.getTime() - lostLookbackDays * DAY_MS), lte: now },
          OR: [{ lostReason: 'PRICE' }, { ownIsFeatured: true }],
        },
        select: { sellerAccountId: true, asin: true, ownIsFeatured: true, lostReason: true, observedAt: true },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: READ_LIMIT,
      }),
      loadProductLookup(db, tenantId, { storeIds, skus }),
    ])
    const expectedOf = firstBy(expectedRows, row => keyOf(row.sellerAccountId, row.sellerSku))
    const summaryOf = firstBy(summaryRows, row => keyOf(row.sellerAccountId, row.asin))
    const lostAt = new Map<string, number>()
    const gainedAt = new Map<string, number>()
    for (const row of lostRows) {
      const key = keyOf(row.sellerAccountId, row.asin)
      const map = row.lostReason === 'PRICE' ? lostAt : row.ownIsFeatured === true ? gainedAt : null
      map?.set(key, Math.max(map.get(key) ?? 0, row.observedAt.getTime()))
    }

    const targets: HealthTarget[] = []
    for (const price of latestPrice.values()) {
      if (!scope.allows({ sellerAccountId: price.sellerAccountId, sku: price.sellerSku })) continue
      const product = lookup.bySku.get(keyOf(price.sellerAccountId, price.sellerSku))
      const asin = price.asin || product?.asin || ''
      const expected = expectedOf.get(keyOf(price.sellerAccountId, price.sellerSku))
      const summary = asin ? summaryOf.get(keyOf(price.sellerAccountId, asin)) : undefined
      const lostTime = asin ? lostAt.get(keyOf(price.sellerAccountId, asin)) : undefined
      targets.push({
        sellerAccountId: price.sellerAccountId,
        sku: price.sellerSku,
        asin,
        ownPrice: num(price.price) as number,
        expectedPrice: expected ? num(expected.expectedPrice) : null,
        expectedCurrency: expected ? expected.currency : null,
        currency: price.currency,
        resultStatus: expected?.resultStatus ?? null,
        featuredIsOwn: summary?.featuredIsOwn ?? null,
        featuredPrice: summary ? num(summary.featuredPrice) : null,
        hasObservation: expected !== undefined || summary !== undefined,
        eligibilityLost: lostTime !== undefined && lostTime > (gainedAt.get(keyOf(price.sellerAccountId, asin)) ?? 0),
      })
    }

    return healthHits(targets, states, minGapRatio).map(({ target, state, gap, gapRatio }): AlertHit => {
      const product = lookup.bySku.get(keyOf(target.sellerAccountId, target.sku))
      const store = lookup.storeName.get(target.sellerAccountId) ?? '店铺'
      const key = keyOf(target.sellerAccountId, target.sku)
      return {
        // 有商品记录的点进去是定价详情；没有的按 店铺|SKU 登记
        entityType: product ? 'SKU' : 'PRICING_SKU',
        entityId: product?.id ?? key,
        sellerAccountId: target.sellerAccountId,
        entityLabel: `${target.sku}（${store}）`,
        title:
          state === 'LOST_ELIGIBILITY'
            ? `SKU ${target.sku} 因价格失去推荐报价资格`
            : `SKU ${target.sku} 价格高于推荐报价预期价格 ${percentText(gapRatio ?? 0)}（${target.currency} ${round2(target.ownPrice)} 对 ${round2(target.expectedPrice ?? 0)}）`,
        suggestedAction: '到定价页查看这个 SKU 的价格健康与利润率：预期价格下利润仍可接受就调价，不可接受就确认是否保留当前价格；调价受价格护栏约束',
        evidence: {
          sku: target.sku,
          asin: target.asin || null,
          title: product?.title ?? null,
          storeName: store,
          state,
          stateLabel: priceHealthLabel(state),
          currency: target.currency,
          ownPrice: round2(target.ownPrice),
          expectedPrice: target.expectedPrice === null ? null : round2(target.expectedPrice),
          gap: gap === null ? null : round2(gap),
          gapRatio: gapRatio === null ? null : Math.round(gapRatio * 10_000) / 10_000,
          threshold: minGapRatio,
          featuredPrice: target.featuredPrice,
          resultStatus: target.resultStatus,
        },
      }
    })
  },
}
