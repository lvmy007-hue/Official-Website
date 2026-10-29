import { sizeTierChanged } from '@nova/api-contracts'
import type { AlertEvaluator, AlertHit } from '../platform/alert-evaluate'
import { numberParam, scopeFilter } from './params'

// 尺寸分段变化预警评估器（P2b-06，07 章 7.6“先进能力”）：预估配送费报告（R-23）里某个 SKU 的亚马逊测量尺寸分段与前一次快照不同。
// 报告每天一份，导入时把前一次快照的分段写进 prevSizeTier；本评估器看最近 windowDays 天的快照，变化过的 SKU 在这段时间内保持命中，之后自动恢复。
// “变化当天预警”的精度取决于报告每天的导入时间与预警评估间隔（每 15 分钟），不是实时。

const READ_LIMIT = 20_000
const CHUNK = 500
const DAY_MS = 86_400_000

export interface TierChangeRow {
  sellerAccountId: string
  sku: string
  asin: string
  snapshotDate: Date
  sizeTier: string | null
  prevSizeTier: string | null
  lengthCm: { toString(): string } | null
  widthCm: { toString(): string } | null
  heightCm: { toString(): string } | null
}

/** 每个店铺每个 SKU 只留最近一次变化（纯函数）。 */
export function latestChanges(rows: readonly TierChangeRow[]): TierChangeRow[] {
  const latest = new Map<string, TierChangeRow>()
  for (const row of rows) {
    if (!sizeTierChanged(row.prevSizeTier, row.sizeTier)) continue
    const key = `${row.sellerAccountId}|${row.sku}`
    const hit = latest.get(key)
    if (!hit || row.snapshotDate > hit.snapshotDate) latest.set(key, row)
  }
  return [...latest.values()].sort((a, b) => b.snapshotDate.getTime() - a.snapshotDate.getTime())
}

export const sizeTierChangeEvaluator: AlertEvaluator = {
  type: 'fee.size-tier-change',
  async evaluate({ db, tenantId, rule, now }) {
    const windowDays = numberParam(rule, 'windowDays', 7, { min: 1, max: 30 })
    const scope = scopeFilter(rule)
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    const rows = await db.feeBaseline.findMany({
      where: {
        tenantId,
        snapshotDate: { gte: new Date(today - windowDays * DAY_MS) },
        sizeTier: { not: null },
        prevSizeTier: { not: null },
        ...(scope.stores ? { sellerAccountId: { in: scope.stores } } : {}),
        ...(scope.skus ? { sku: { in: scope.skus } } : {}),
      },
      select: { sellerAccountId: true, sku: true, asin: true, snapshotDate: true, sizeTier: true, prevSizeTier: true, lengthCm: true, widthCm: true, heightCm: true },
      orderBy: { snapshotDate: 'desc' },
      take: READ_LIMIT,
    })
    const changes = latestChanges(rows)
    if (changes.length === 0) return []
    const stores = await db.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(changes.map(row => row.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 1000 })
    const storeName = new Map(stores.map(store => [store.id, store.displayName]))
    // 点进去是商品全景（ASIN 360）：按店铺 + SKU 找商品记录；找不到商品的按 SKU 登记
    const productId = new Map<string, string>()
    for (let at = 0; at < changes.length; at += CHUNK) {
      const products = await db.fbaProduct.findMany({
        where: { tenantId, sellerSku: { in: changes.slice(at, at + CHUNK).map(row => row.sku) } },
        select: { id: true, sellerAccountId: true, sellerSku: true },
        take: 5000,
      })
      for (const product of products) productId.set(`${product.sellerAccountId}|${product.sellerSku}`, product.id)
    }
    return changes.map((row): AlertHit => {
      const id = productId.get(`${row.sellerAccountId}|${row.sku}`)
      const store = storeName.get(row.sellerAccountId) ?? '店铺'
      return {
        entityType: id ? 'ASIN' : 'SKU',
        entityId: id ?? row.sku,
        sellerAccountId: row.sellerAccountId,
        entityLabel: `${row.sku}（${store}）`,
        title: `SKU ${row.sku} 尺寸分段变化：${row.prevSizeTier} → ${row.sizeTier}`,
        suggestedAction: '核对亚马逊重新测量后的尺寸与重量；与实物不符可在卖家后台申请重新测量，并到费用核查页查看配送费与仓储费是否多收',
        evidence: {
          sku: row.sku,
          asin: row.asin || null,
          storeName: store,
          previousTier: row.prevSizeTier,
          currentTier: row.sizeTier,
          changedOn: row.snapshotDate.toISOString().slice(0, 10),
          measuredCm: row.lengthCm && row.widthCm && row.heightCm ? [Number(row.lengthCm.toString()), Number(row.widthCm.toString()), Number(row.heightCm.toString())] : null,
        },
      }
    })
  },
}
