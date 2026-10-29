import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { ADS_ALERT_CURRENCY, DAY_MS, dayText, loadProfileStores, money, num, profileScope, utcDay } from './ads-common'
import { numberParam, scopeFilter } from './params'

// 断货商品仍在投放预警评估器（P3-18，09 章 9.1 广告类）：被推广商品日报表（美元）里，回看期内（含今天）仍有花费的 ASIN，
// 在它所属店铺最近一次库存快照（接口来源）里可售数量合计为 0。判断口径与今日广告页的“断货商品仍在投放”一致（同样的 3 天、同样的快照来源），
// 多一道保护：快照比“快照最长天数”还旧就不判断（库存早已变化的旧快照会让预警一直挂着）。
// 广告档案没有绑定店铺、或花费行没有 ASIN 的，对不上库存，不判断；可售数量没给（空）的快照行不参与，不当作 0。
// 影响金额 = 回看期日均花费（有花费的天数平均），与今日广告页的“日均浪费”同一算法；库存是日级快照，不是实时库存。

const READ_LIMIT = 20_000
const PRODUCT_LIMIT = 5000

export interface AdvertisedSpendRow {
  adsProfileId: string
  asin: string
  date: string
  spend: number
}
export interface StockSnapshot {
  sellerAccountId: string
  asin: string
  sellable: number | null
  snapshotDate: string
}
export interface StockoutAsin {
  sellerAccountId: string
  asin: string
  spend: number
  days: number
  dailyWaste: number
  sellable: number
  snapshotDate: string
}

/**
 * 按 店铺 × ASIN 合并花费，与最近一次库存快照对照（纯函数）。
 * 花费不到 minSpend 的、没有快照可对照的、快照早于 oldestSnapshot（YYYY-MM-DD）的、可售大于 0 的都不算；日均花费高的排前面。
 */
export function stockoutAsins(input: {
  spend: readonly AdvertisedSpendRow[]
  storeOf: ReadonlyMap<string, string | null>
  snapshots: readonly StockSnapshot[]
  minSpend: number
  oldestSnapshot: string
}): StockoutAsin[] {
  const groups = new Map<string, { sellerAccountId: string; asin: string; spend: number; days: Set<string> }>()
  for (const row of input.spend) {
    const store = input.storeOf.get(row.adsProfileId) ?? null
    if (!store || !row.asin) continue
    const key = `${store}|${row.asin}`
    const group = groups.get(key) ?? { sellerAccountId: store, asin: row.asin, spend: 0, days: new Set<string>() }
    group.spend += row.spend
    group.days.add(row.date)
    groups.set(key, group)
  }
  const stock = new Map<string, { sellable: number; snapshotDate: string }>()
  for (const snapshot of input.snapshots) {
    if (snapshot.sellable === null) continue
    const key = `${snapshot.sellerAccountId}|${snapshot.asin}`
    stock.set(key, { sellable: (stock.get(key)?.sellable ?? 0) + snapshot.sellable, snapshotDate: snapshot.snapshotDate })
  }
  const out: StockoutAsin[] = []
  for (const [key, group] of groups) {
    const level = stock.get(key)
    if (!level || level.sellable > 0 || level.snapshotDate < input.oldestSnapshot || group.spend < input.minSpend) continue
    out.push({
      sellerAccountId: group.sellerAccountId,
      asin: group.asin,
      spend: group.spend,
      days: group.days.size,
      dailyWaste: group.spend / group.days.size,
      sellable: level.sellable,
      snapshotDate: level.snapshotDate,
    })
  }
  return out.sort((a, b) => b.dailyWaste - a.dailyWaste || (a.sellerAccountId + a.asin < b.sellerAccountId + b.asin ? -1 : 1))
}

export const adsStockoutEvaluator: AlertEvaluator = {
  type: 'ads.stockout-advertising',
  async evaluate({ db, tenantId, rule, now }) {
    const lookbackDays = numberParam(rule, 'lookbackDays', 3, { min: 1, max: 14 })
    const minSpend = numberParam(rule, 'minSpend', 5, { min: 0.01, max: 1_000_000 })
    const maxSnapshotAgeDays = numberParam(rule, 'maxSnapshotAgeDays', 3, { min: 1, max: 30 })
    const scope = scopeFilter(rule)
    const today = utcDay(now)
    const storeWhere = scope.stores ? { sellerAccountId: { in: scope.stores } } : {}
    // 被推广商品按 ASIN 记，SKU 范围换成这些 SKU 对应的 ASIN
    let asinWhere: { advertisedAsin?: { in: string[] } } = {}
    if (scope.skus) {
      const scoped = await db.fbaProduct.findMany({ where: { tenantId, ...storeWhere, sellerSku: { in: scope.skus } }, select: { asin: true }, take: PRODUCT_LIMIT })
      asinWhere = { advertisedAsin: { in: [...new Set(scoped.map(product => product.asin))] } }
    }
    const groups = await db.adsAdvertisedProductMetric.groupBy({
      by: ['adsProfileId', 'advertisedAsin', 'reportDate'],
      where: {
        tenantId,
        currency: ADS_ALERT_CURRENCY,
        spend: { gt: 0 },
        reportDate: { gte: new Date(today - (lookbackDays - 1) * DAY_MS), lte: new Date(today) },
        ...profileScope(scope),
        ...asinWhere,
      },
      _sum: { spend: true },
      orderBy: [{ reportDate: 'asc' }, { adsProfileId: 'asc' }, { advertisedAsin: 'asc' }],
      take: READ_LIMIT,
    })
    if (groups.length === 0) return []
    const spend = groups.map(group => ({ adsProfileId: group.adsProfileId, asin: group.advertisedAsin, date: dayText(group.reportDate.getTime()), spend: num(group._sum.spend) ?? 0 }))
    const { storeOf, storeName } = await loadProfileStores(
      db,
      tenantId,
      spend.map(row => row.adsProfileId),
    )
    const storeIds = [...new Set([...storeOf.values()].flatMap(store => (store ? [store] : [])))]
    if (storeIds.length === 0) return []

    // 每个店铺最近一次库存快照（接口来源）
    const latest = await db.inventoryDailySnapshot.groupBy({
      by: ['sellerAccountId'],
      where: { tenantId, source: 'API', sellerAccountId: { in: storeIds } },
      _max: { snapshotDate: true },
      orderBy: { sellerAccountId: 'asc' },
      take: 500,
    })
    const pairs = latest.flatMap(row => (row._max.snapshotDate ? [{ sellerAccountId: row.sellerAccountId, snapshotDate: row._max.snapshotDate }] : []))
    if (pairs.length === 0) return []
    const asins = [...new Set(spend.map(row => row.asin))]
    const rows = await db.inventoryDailySnapshot.findMany({
      where: { tenantId, source: 'API', asin: { in: asins }, OR: pairs },
      select: { sellerAccountId: true, asin: true, sellable: true, snapshotDate: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { sku: 'asc' }],
      take: READ_LIMIT,
    })
    const snapshots = rows.map(row => ({ sellerAccountId: row.sellerAccountId, asin: row.asin, sellable: row.sellable, snapshotDate: dayText(row.snapshotDate.getTime()) }))
    const stockouts = stockoutAsins({ spend, storeOf, snapshots, minSpend, oldestSnapshot: dayText(today - maxSnapshotAgeDays * DAY_MS) })
    if (stockouts.length === 0) return []

    const products = await db.fbaProduct.findMany({
      where: { tenantId, asin: { in: [...new Set(stockouts.map(item => item.asin))] }, sellerAccountId: { in: [...new Set(stockouts.map(item => item.sellerAccountId))] } },
      select: { id: true, sellerAccountId: true, asin: true, title: true },
      orderBy: { updatedAt: 'desc' },
      take: PRODUCT_LIMIT,
    })
    const productOf = new Map<string, { id: string; title: string | null }>()
    for (const product of products) if (!productOf.has(`${product.sellerAccountId}|${product.asin}`)) productOf.set(`${product.sellerAccountId}|${product.asin}`, product)

    return stockouts.map((item): AlertHit => {
      const key = `${item.sellerAccountId}|${item.asin}`
      const product = productOf.get(key)
      const store = storeName.get(item.sellerAccountId) ?? '店铺'
      const waste = money(item.dailyWaste)
      return {
        // 有商品记录的点进去是商品全景；没有的按店铺 × ASIN 登记
        entityType: product ? 'ASIN' : 'ADS_ASIN',
        entityId: product?.id ?? key,
        sellerAccountId: item.sellerAccountId,
        entityLabel: `${item.asin}（${store}）`,
        title: `ASIN ${item.asin} 可售库存为 0，近 ${lookbackDays} 天广告仍在花钱（日均 ${ADS_ALERT_CURRENCY} ${waste}）`,
        suggestedAction: '到广告活动里暂停这个商品的广告（或把该商品的广告组暂停），补货到仓后再恢复；断货期间花的钱既没有转化，也会拉低广告排名与转化率历史',
        evidence: {
          asin: item.asin,
          title: product?.title ?? null,
          storeName: store,
          currency: ADS_ALERT_CURRENCY,
          lookbackDays,
          spend: money(item.spend),
          spendDays: item.days,
          dailyWaste: waste,
          sellable: item.sellable,
          snapshotDate: item.snapshotDate,
        },
        impact: { min: waste, max: waste, currency: ADS_ALERT_CURRENCY },
      }
    })
  },
}
