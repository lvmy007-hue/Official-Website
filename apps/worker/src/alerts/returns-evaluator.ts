import { UNSPECIFIED_REASON, normalizeReason, returnRate, returnReasonLabel } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'

// 异常退货率预警评估器（P2b-16，09 章 9.1 售后与口碑类）：同一店铺的某个 ASIN 在回看窗口内，退货件数（按退货日期，退货明细 R-26）
// ÷ 销售件数（经营日汇总，按下单日）达到阈值，且退货件数与销售件数都不少于最小样本。销售件数没有汇总（没有行或合计为 0）的 ASIN 不判断，不当作 0%。
// 窗口按 UTC 日历日算（评估器没有企业时区），与退货页的企业时区口径最多差一天。退货总是晚于销售，新品或销量骤降的商品短期退货率会偏高；
// 阈值与最小样本是我们自定的默认值，不是行业标准。

const DAY_MS = 86_400_000
const GROUP_LIMIT = 2000
const REASON_LIMIT = 20_000

export interface ReturnRateRow {
  sellerAccountId: string
  asin: string
  returnedUnits: number
  soldUnits: number
  topReason: { code: string; units: number } | null
}

const reasonText = (code: string) => (code === UNSPECIFIED_REASON ? '未提供原因' : (returnReasonLabel(code) ?? code))
const percent = (rate: number) => `${Math.round(rate * 1000) / 10}%`

export interface ReturnRateLimits {
  rateThreshold: number
  minReturnedUnits: number
  minSoldUnits: number
}

/** 筛出异常的：退货率不小于阈值、两个样本都不少于下限；退货率高的排前面（纯函数）。 */
export function abnormalReturnRows(rows: readonly ReturnRateRow[], limits: ReturnRateLimits) {
  return rows
    .flatMap(row => {
      const rate = returnRate(row.returnedUnits, row.soldUnits)
      return rate !== null && rate >= limits.rateThreshold && row.returnedUnits >= limits.minReturnedUnits && row.soldUnits >= limits.minSoldUnits ? [{ row, rate }] : []
    })
    .sort((a, b) => b.rate - a.rate || b.row.returnedUnits - a.row.returnedUnits)
}

/** 每个对象退货件数最多的原因；空原因与“未提供”合并，并列时取代码靠前的，保证结果稳定（纯函数）。 */
export function topReasons(rows: ReadonlyArray<{ key: string; reason: string | null; units: number }>): Map<string, { code: string; units: number }> {
  const totals = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const code = normalizeReason(row.reason)
    const byReason = totals.get(row.key) ?? new Map<string, number>()
    byReason.set(code, (byReason.get(code) ?? 0) + row.units)
    totals.set(row.key, byReason)
  }
  const out = new Map<string, { code: string; units: number }>()
  for (const [key, byReason] of totals) {
    const [code, units] = [...byReason.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]
    out.set(key, { code, units })
  }
  return out
}

export const abnormalReturnRateEvaluator: AlertEvaluator = {
  type: 'returns.abnormal-rate',
  async evaluate({ db, tenantId, rule, now }) {
    const windowDays = numberParam(rule, 'windowDays', 30, { min: 7, max: 180 })
    const limits: ReturnRateLimits = {
      rateThreshold: numberParam(rule, 'rateThreshold', 0.15, { min: 0.01, max: 1 }),
      minReturnedUnits: numberParam(rule, 'minReturnedUnits', 5, { min: 1, max: 100_000 }),
      minSoldUnits: numberParam(rule, 'minSoldUnits', 30, { min: 1, max: 1_000_000 }),
    }
    const scope = scopeFilter(rule)
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const since = new Date(today - (windowDays - 1) * DAY_MS)
    const until = new Date(today + DAY_MS)
    const storeWhere = scope.stores ? { sellerAccountId: { in: scope.stores } } : {}
    // 退货与销售汇总都是 ASIN 级：SKU 范围换成这些 SKU 对应的 ASIN
    let asinWhere: { asin?: { in: string[] } } = {}
    if (scope.skus) {
      const products = await db.fbaProduct.findMany({ where: { tenantId, ...storeWhere, sellerSku: { in: scope.skus } }, select: { asin: true }, take: 5000 })
      asinWhere = { asin: { in: [...new Set(products.map(product => product.asin))] } }
    }
    const returned = await db.fbaReturnCase.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, returnDate: { gte: since, lt: until }, ...storeWhere, ...asinWhere },
      _sum: { quantity: true },
      orderBy: { _sum: { quantity: 'desc' } },
      take: GROUP_LIMIT,
    })
    const candidates = returned.filter(row => (row._sum.quantity ?? 0) >= limits.minReturnedUnits)
    if (candidates.length === 0) return []
    const asins = [...new Set(candidates.map(row => row.asin))]
    const sold = await db.asinDailySummary.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, summaryDate: { gte: since, lte: new Date(today) }, asin: { in: asins }, ...storeWhere },
      _sum: { units: true },
      orderBy: { _sum: { units: 'desc' } },
      take: GROUP_LIMIT,
    })
    const soldOf = new Map(sold.map(row => [`${row.sellerAccountId}|${row.asin}`, row._sum.units ?? 0]))
    const abnormal = abnormalReturnRows(
      candidates.map(row => ({
        sellerAccountId: row.sellerAccountId,
        asin: row.asin,
        returnedUnits: row._sum.quantity ?? 0,
        soldUnits: soldOf.get(`${row.sellerAccountId}|${row.asin}`) ?? 0,
        topReason: null,
      })),
      limits,
    )
    if (abnormal.length === 0) return []

    const hitAsins = [...new Set(abnormal.map(item => item.row.asin))]
    const [reasons, products, stores] = await Promise.all([
      db.fbaReturnCase.groupBy({
        by: ['sellerAccountId', 'asin', 'reason'],
        where: { tenantId, returnDate: { gte: since, lt: until }, asin: { in: hitAsins }, ...storeWhere },
        _sum: { quantity: true },
        orderBy: { _sum: { quantity: 'desc' } },
        take: REASON_LIMIT,
      }),
      db.fbaProduct.findMany({
        where: { tenantId, asin: { in: hitAsins }, ...storeWhere },
        select: { id: true, sellerAccountId: true, asin: true, title: true },
        orderBy: { updatedAt: 'desc' },
        take: 5000,
      }),
      db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(abnormal.map(item => item.row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 }),
    ])
    const topReason = topReasons(reasons.map(row => ({ key: `${row.sellerAccountId}|${row.asin}`, reason: row.reason, units: row._sum.quantity ?? 0 })))
    const productOf = new Map<string, { id: string; title: string | null }>()
    for (const product of products) if (!productOf.has(`${product.sellerAccountId}|${product.asin}`)) productOf.set(`${product.sellerAccountId}|${product.asin}`, product)
    const storeName = new Map(stores.map(store => [store.id, store.displayName]))

    return abnormal.map(({ row, rate }): AlertHit => {
      const key = `${row.sellerAccountId}|${row.asin}`
      const product = productOf.get(key)
      const store = storeName.get(row.sellerAccountId) ?? '店铺'
      const reason = topReason.get(key)
      return {
        // 有商品记录的点进去是商品全景；没有的按店铺 × ASIN 登记
        entityType: product ? 'ASIN' : 'RETURN_ASIN',
        entityId: product?.id ?? key,
        sellerAccountId: row.sellerAccountId,
        entityLabel: `${row.asin}（${store}）`,
        title: `ASIN ${row.asin} 近 ${windowDays} 天退货率 ${percent(rate)}（退 ${row.returnedUnits} 件 ÷ 卖 ${row.soldUnits} 件）`,
        suggestedAction: '到退货页的退货分析查看原因分布与处置；质量或描述问题先处理刊登与供应商，物流损坏、仓内损坏可核对是否可申请赔付',
        evidence: {
          asin: row.asin,
          title: product?.title ?? null,
          storeName: store,
          windowDays,
          returnedUnits: row.returnedUnits,
          soldUnits: row.soldUnits,
          rate,
          threshold: limits.rateThreshold,
          topReason: reason ? { code: reason.code, label: reasonText(reason.code), units: reason.units } : null,
        },
      }
    })
  },
}
