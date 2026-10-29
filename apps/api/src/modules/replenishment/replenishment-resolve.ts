import type { InventoryPolicy, ReplenishLevel, ReplenishPolicy } from '@nova/api-contracts'

// 三级策略解析（06 章 6.2）：SKU 级 > 品类级 > 企业级，下级整行覆盖上级（不逐字段合并，避免出现“半套继承”的难解释组合）。
// 每个对象（level + levelRef）只看“生效日期不晚于今天的最大版本”。

/** 列表显示顺序：企业、品类、SKU。 */
const LEVEL_ORDER: Record<ReplenishLevel, number> = { TENANT: 0, CATEGORY: 1, SKU: 2 }
export const levelOrder = (level: ReplenishLevel) => LEVEL_ORDER[level]

export function latestEffective(versions: readonly ReplenishPolicy[], today: string): ReplenishPolicy[] {
  const best = new Map<string, ReplenishPolicy>()
  for (const version of versions) {
    if (version.effectiveFrom > today) continue
    const key = `${version.level}|${version.levelRef}`
    const held = best.get(key)
    if (!held || version.versionNo > held.versionNo) best.set(key, version)
  }
  return [...best.values()]
}

export interface PolicyIndex {
  tenant: ReplenishPolicy | null
  category: Map<string, ReplenishPolicy>
  sku: Map<string, ReplenishPolicy>
}

export function indexPolicies(effective: readonly ReplenishPolicy[]): PolicyIndex {
  const index: PolicyIndex = { tenant: null, category: new Map(), sku: new Map() }
  for (const policy of effective) {
    if (policy.level === 'TENANT') index.tenant = policy
    else if (policy.level === 'CATEGORY') index.category.set(policy.levelRef, policy)
    else index.sku.set(policy.levelRef, policy)
  }
  return index
}

export function pickPolicy(index: PolicyIndex, sku: string, category: string | null): ReplenishPolicy | null {
  return index.sku.get(sku) ?? (category ? index.category.get(category) : undefined) ?? index.tenant
}

/** 库存规则引擎（assess、差异解释）只认企业级形态的策略：补货策略的公共字段与它一致，直接复用。 */
export const asInventoryPolicy = (policy: ReplenishPolicy): InventoryPolicy => ({ ...policy, level: 'TENANT' })
