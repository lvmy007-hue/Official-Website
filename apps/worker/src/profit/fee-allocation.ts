import { PROFIT_CURRENCY, allocateByWeights, allocationWeights, monthOfDay, pickRuleForMonth, type AllocationResult, type AllocationRuleLite } from '@nova/api-contracts'
import type { SalesRow } from './types'

// 店铺级费用分摊（P6-19）：把没有 SKU 的费用明细按企业配置的规则分摊到 SKU（纯函数，不碰数据库）。
// 权重按“店铺 × 月”取；各 SKU 分到的金额加起来恰好等于原始费用，尾差记到占比最大的 SKU（见契约 allocateByWeights）。

export interface AllocationInput {
  rules: readonly AllocationRuleLite[]
  /** 货件签收量权重：键 `店铺|YYYY-MM`，值 SKU → 签收件数。 */
  shipment: ReadonlyMap<string, ReadonlyMap<string, number>>
  /** 移除订单权重：键 `店铺|YYYY-MM`，值 SKU → 申请移除件数。 */
  removal: ReadonlyMap<string, ReadonlyMap<string, number>>
}

export const EMPTY_ALLOCATION: AllocationInput = { rules: [], shipment: new Map(), removal: new Map() }

export type FeeAllocator = (store: string, day: string, feeItemKey: string, amount: number) => AllocationResult | null

/**
 * 生成分摊器：某店铺某天的一笔店铺级费用（feeItemKey 是它在字典里归到的项目编号），找到当月适用的规则，按权重分摊。
 * 没有规则、或这个月没有任何权重（例如当月没有销售）返回 null，调用方把费用留在店铺级行。
 * 销售额依据在结算释放口径下订单销售额为 0（销售额来自费用明细），这时退回按销量，保证仍然能分摊。
 */
export function createFeeAllocator(input: AllocationInput, sales: readonly SalesRow[]): FeeAllocator {
  if (input.rules.length === 0) return () => null
  const monthly = new Map<string, Map<string, { revenue: number; units: number }>>()
  for (const row of sales) {
    if (row.currency !== PROFIT_CURRENCY || !row.sku) continue
    const key = `${row.sellerAccountId}|${monthOfDay(row.day)}`
    const skus = monthly.get(key) ?? new Map<string, { revenue: number; units: number }>()
    const entry = skus.get(row.sku) ?? { revenue: 0, units: 0 }
    entry.revenue += row.revenue
    entry.units += row.units
    skus.set(row.sku, entry)
    monthly.set(key, skus)
  }
  const cache = new Map<string, Array<{ key: string; weight: number }>>()
  const weightsOf = (store: string, month: string, rule: AllocationRuleLite): Array<{ key: string; weight: number }> => {
    const cacheKey = `${store}|${month}|${rule.feeItemId}|${rule.effectiveMonth}|${rule.basis}`
    const hit = cache.get(cacheKey)
    if (hit) return hit
    const slot = `${store}|${month}`
    const weights = allocationWeights(rule, { sales: monthly.get(slot) ?? new Map(), shipment: input.shipment.get(slot) ?? new Map(), removal: input.removal.get(slot) ?? new Map() })
    cache.set(cacheKey, weights)
    return weights
  }
  return (store, day, feeItemKey, amount) => {
    const month = monthOfDay(day)
    const rule = pickRuleForMonth(input.rules, feeItemKey, month)
    if (!rule) return null
    const result = allocateByWeights(amount, weightsOf(store, month, rule))
    return result.parts.length === 0 ? null : result
  }
}
