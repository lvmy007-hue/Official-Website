import type { AlertRuleView } from '../platform/alert-evaluate'

// 评估器读取规则阈值与范围的小工具：规则行里的 params、scope 是人工可改的 JSON，读取时一律按“不合法就用默认值”处理，
// 不因为一条被改坏的规则让整个评估失败。

export function numberParam(rule: AlertRuleView, key: string, fallback: number, bounds: { min?: number; max?: number } = {}): number {
  const value = rule.condition.params?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(bounds.max ?? Number.POSITIVE_INFINITY, Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, value))
}

/** 数字参数允许显式关闭（null 或未设置表示“不启用”）。 */
export function optionalNumberParam(rule: AlertRuleView, key: string, bounds: { min?: number; max?: number } = {}): number | null {
  const value = rule.condition.params?.[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.min(bounds.max ?? Number.POSITIVE_INFINITY, Math.max(bounds.min ?? Number.NEGATIVE_INFINITY, value))
}

/** 取值限定在允许集合内的字符串列表；没有给或全部不合法时用默认值。 */
export function choiceListParam<T extends string>(rule: AlertRuleView, key: string, allowed: readonly T[], fallback: readonly T[]): T[] {
  const value = rule.condition.params?.[key]
  const picked = Array.isArray(value) ? allowed.filter(item => value.includes(item)) : []
  return picked.length > 0 ? picked : [...fallback]
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null
  const items = value.filter((item): item is string => typeof item === 'string' && item.length > 0)
  return items.length > 0 ? items : null
}

/** 规则范围（scopeJson）：sellerAccountIds 限定店铺，skus 限定 SKU；没有设置表示不限制。 */
export function scopeFilter(rule: AlertRuleView) {
  const stores = stringList(rule.scope.sellerAccountIds)
  const skus = stringList(rule.scope.skus)
  return {
    stores,
    skus,
    /** 不带 sku 的对象（店铺级、货件级）不受 SKU 范围限制。 */
    allows: (target: { sellerAccountId: string | null; sku?: string | null }) =>
      (!stores || (target.sellerAccountId !== null && stores.includes(target.sellerAccountId))) && (!skus || target.sku === undefined || (target.sku !== null && skus.includes(target.sku))),
  }
}
