import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'
import { DAY_MS, READ_LIMIT, asinsOfSkus, keyOf, loadProductLookup } from './product-common'

// 失去推荐报价资格预警评估器（P4-15，09 章 9.1 商品类）：读推荐报价观察（BuyBoxSnapshot，P4-11；同步每 2 小时一次，只在变化时写入）。
// 对每个 店铺 × ASIN，把“我方是否推荐报价获得者”（ownIsFeatured，为空的行不参与，不当 false）按时间排好：
// 最近一次“获得”之后第一次出现的“失去”就是失去时间；带失去原因的行（价格健康通知写入，推送暂缓）本身就算一次失去（没有此前的观察也算）。
// 失去时间在回看天数内、且现在仍是失去状态的才命中；重新获得后自动恢复。同一回看窗口内有“因价格失去资格”标记的 ASIN 归“价格健康异常”预警，这里不重复。
// 注意：数据库检查约束目前只允许失去原因为 PRICE（P4-11 的迁移），而该通知处理器会把其他原因写成 OTHER，真实推送接入前需要对齐（见 CR-090）；
// 所以现在“带失去原因的行”只可能是价格原因（归价格健康预警），本评估器实际读到的失去都来自同步的前后比对。
// 只读最近“回看天数 + 30 天”的观察：更早的获得状态读不到，此时窗口内第一次观察就是“失去”而此前没有观察的，不算（不猜之前是不是获得过）。

const HISTORY_EXTRA_DAYS = 30

export interface BoxRow {
  sellerAccountId: string
  asin: string
  ownIsFeatured: boolean
  lostReason: string | null
  source: string
  observedAt: Date
}

export interface FeaturedLoss {
  sellerAccountId: string
  asin: string
  lostAt: Date
  lostReason: string | null
  source: string
  /** 失去之前最近一次获得的时间（没有观察到获得则为 null） */
  lastFeaturedAt: Date | null
}

/**
 * 找出现在仍处于“失去”状态、且失去时间不早于 since 的 店铺 × ASIN（纯函数，输入顺序无关）。
 * 窗口内有“因价格失去资格”标记的归价格健康预警，不在这里返回。
 */
export function featuredLosses(rows: readonly BoxRow[], since: Date): FeaturedLoss[] {
  const byKey = new Map<string, BoxRow[]>()
  for (const row of rows) {
    const key = keyOf(row.sellerAccountId, row.asin)
    byKey.set(key, [...(byKey.get(key) ?? []), row])
  }
  const out: FeaturedLoss[] = []
  for (const list of byKey.values()) {
    list.sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime() || (a.source < b.source ? -1 : 1))
    let featured: boolean | null = null
    let lastFeaturedAt: Date | null = null
    let loss: FeaturedLoss | null = null
    for (const row of list) {
      if (row.ownIsFeatured) {
        featured = true
        lastFeaturedAt = row.observedAt
        loss = null
      } else {
        if (loss === null && (featured === true || row.lostReason !== null))
          loss = { sellerAccountId: row.sellerAccountId, asin: row.asin, lostAt: row.observedAt, lostReason: row.lostReason, source: row.source, lastFeaturedAt }
        featured = false
      }
    }
    const priceCaused = list.some(row => row.lostReason === 'PRICE' && row.observedAt >= since)
    if (loss && featured === false && loss.lostAt >= since && !priceCaused) out.push(loss)
  }
  return out.sort((a, b) => b.lostAt.getTime() - a.lostAt.getTime() || (keyOf(a.sellerAccountId, a.asin) < keyOf(b.sellerAccountId, b.asin) ? -1 : 1))
}

export const featuredOfferLostEvaluator: AlertEvaluator = {
  type: 'pricing.featured-offer-lost',
  async evaluate({ db, tenantId, rule, now }) {
    const lookbackDays = numberParam(rule, 'lookbackDays', 7, { min: 1, max: 30 })
    const scope = scopeFilter(rule)
    const since = new Date(now.getTime() - lookbackDays * DAY_MS)
    const asins = await asinsOfSkus(db, tenantId, scope.stores, scope.skus)
    if (asins && asins.length === 0) return []
    const found = await db.buyBoxSnapshot.findMany({
      where: {
        tenantId,
        ownIsFeatured: { not: null },
        observedAt: { gte: new Date(since.getTime() - HISTORY_EXTRA_DAYS * DAY_MS), lte: now },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(asins ? { asin: { in: asins } } : {}),
      },
      select: { sellerAccountId: true, asin: true, ownIsFeatured: true, lostReason: true, source: true, observedAt: true },
      // 倒序读：读满上限时丢的是最早的观察，而不是最新的状态
      orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
      take: READ_LIMIT,
    })
    const losses = featuredLosses(
      found.map(row => ({ ...row, ownIsFeatured: row.ownIsFeatured === true })),
      since,
    )
    if (losses.length === 0) return []
    const lookup = await loadProductLookup(db, tenantId, { storeIds: losses.map(loss => loss.sellerAccountId), asins: losses.map(loss => loss.asin) })
    return losses.map((loss): AlertHit => {
      const key = keyOf(loss.sellerAccountId, loss.asin)
      const product = lookup.byAsin.get(key)
      const store = lookup.storeName.get(loss.sellerAccountId) ?? '店铺'
      return {
        // 有商品记录的点进去是商品全景；没有的按 店铺|ASIN 登记
        entityType: product ? 'ASIN' : 'PRICING_ASIN',
        entityId: product?.id ?? key,
        sellerAccountId: loss.sellerAccountId,
        entityLabel: `${loss.asin}（${store}）`,
        title: `ASIN ${loss.asin} 失去推荐报价（购物车），自 ${loss.lostAt.toISOString().slice(0, 10)} 起`,
        suggestedAction: '到定价页查看价格健康：对照推荐报价预期价格与竞争报价，必要时调整价格；也检查库存、履约方式与账户状态是否影响了资格',
        evidence: {
          asin: loss.asin,
          title: product?.title ?? null,
          storeName: store,
          lookbackDays,
          lostAt: loss.lostAt.toISOString(),
          lastFeaturedAt: loss.lastFeaturedAt ? loss.lastFeaturedAt.toISOString() : null,
          lostReason: loss.lostReason,
          source: loss.source,
        },
      }
    })
  },
}
