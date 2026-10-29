import { PP_DIMENSIONS, PP_ID_SEP, PP_METRICS, PP_METRIC_KEYS, type PpDimension, type PpMetricKey, type PpRequirement, type PpRestriction } from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import type { ProductRef } from './product-performance-load'

// 商品表现宽表的维度与权限（P6-22）：行编号、行键、列权限降级。

export type Caps = { profit: boolean; cost: boolean; ads: boolean; inventory: boolean }

/** 利润列要利润读取 + 利润字段；成本列（ROI）再要成本字段；广告、库存各要自己的读取权限。 */
export function capsOf(permissions: readonly string[]): Caps {
  const profit = hasPermission(permissions, 'profit.read') && canSeeField(permissions, 'profit')
  return { profit, cost: profit && canSeeField(permissions, 'cost'), ads: hasPermission(permissions, 'ads.read'), inventory: hasPermission(permissions, 'inventory.read') }
}

const REASON: Record<Exclude<PpRequirement, null>, string> = {
  profit: '需要“利润”读取权限与“利润字段”权限',
  cost: '需要“成本字段”权限（同时需要利润权限）',
  ads: '需要广告读取权限',
  inventory: '需要库存读取权限',
}

export const allowedBy = (caps: Caps, require: PpRequirement) => require === null || caps[require]
export const allowedKeys = (caps: Caps): PpMetricKey[] => PP_METRIC_KEYS.filter(key => allowedBy(caps, PP_METRICS[key].require))

export function restrictionsOf(caps: Caps): PpRestriction[] {
  const byGroup = new Map<string, PpRestriction>()
  for (const key of PP_METRIC_KEYS) {
    const { require, group } = PP_METRICS[key]
    if (require === null || caps[require]) continue
    const held = byGroup.get(`${group}:${require}`)
    if (held) held.metrics.push(key)
    else byGroup.set(`${group}:${require}`, { group, metrics: [key], reason: REASON[require] })
  }
  return [...byGroup.values()]
}

export const rowIdOf = (dimension: PpDimension, key: string) => `${dimension}${PP_ID_SEP}${key}`

/** 行编号 → 维度与键；格式不对返回 null。 */
export function parseRowId(id: string): { dimension: PpDimension; key: string } | null {
  const at = id.indexOf(PP_ID_SEP)
  if (at <= 0) return null
  const dimension = id.slice(0, at)
  return (PP_DIMENSIONS as readonly string[]).includes(dimension) ? { dimension: dimension as PpDimension, key: id.slice(at + 1) } : null
}

/** 一个商品记录在所选维度下的行键；没有负责人、品牌、品类的归到空串键（页面显示“未设置”）。 */
export function keyOf(dimension: PpDimension, ref: ProductRef): string {
  switch (dimension) {
    case 'asin':
      return ref.asin
    case 'parentAsin':
      return ref.parentAsin ?? ref.asin
    case 'sku':
      return `${ref.storeId}${PP_ID_SEP}${ref.sku}`
    case 'store':
      return ref.storeId
    case 'owner':
      return ref.ownerUserId ?? ''
    case 'brand':
      return ref.brand ?? ''
    case 'category':
      return ref.category ?? ''
  }
}

/** 商品目录里没有记录的 店铺 × ASIN（只在销售、流量或利润里出现）：用一条只有编号的占位记录。 */
export const bareRef = (storeId: string, storeName: string, asin: string): ProductRef => ({
  id: '',
  storeId,
  storeName,
  asin,
  sku: '',
  title: '',
  imageUrl: null,
  parentAsin: null,
  brand: null,
  category: null,
  ownerUserId: null,
})
