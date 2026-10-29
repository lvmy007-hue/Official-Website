import { PRODUCT_CHANNELS, LISTING_LIVE_ANOMALIES, type GridFilterValue, type ListingLiveAnomaly } from '@nova/api-contracts'

// 刊登表现页的筛选状态（P4-09；P6-28 起保存视图改用表格自带的服务端视图）：视图里存的筛选来自这里；
// 读回来时逐项校验，认不出的字段丢掉并计数，不让坏数据进页面。排序随列头走，不再是页面状态。

export type ListingFilters = {
  q?: string
  brand?: string
  category?: string
  status?: string
  fulfillment?: 'AFN' | 'MFN'
  ownerId?: string
  anomaly?: ListingLiveAnomaly
}
export type ListingView = ListingFilters

export const DEFAULT_VIEW: ListingView = {}

const KEYS = ['q', 'brand', 'category', 'status', 'fulfillment', 'ownerId', 'anomaly'] as const

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 && value.length <= 200 ? value : undefined)

/** 当前筛选交给视图保存：只存有值的项。 */
export function viewValues(view: ListingView): Record<string, GridFilterValue> {
  const values: Record<string, GridFilterValue> = {}
  for (const key of KEYS) {
    const value = view[key]
    if (value) values[key] = value
  }
  return values
}

/** 读回视图里的筛选：逐项校验；返回可用的筛选与被丢掉的条件个数（页面不认识的键、取值不合法的项）。 */
export function parseView(value: unknown): { view: ListingView; ignored: number } {
  const raw = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
  const fulfillment = (PRODUCT_CHANNELS as readonly unknown[]).includes(raw.fulfillment) ? (raw.fulfillment as 'AFN' | 'MFN') : undefined
  const anomaly = (LISTING_LIVE_ANOMALIES as readonly unknown[]).includes(raw.anomaly) ? (raw.anomaly as ListingLiveAnomaly) : undefined
  const view: ListingView = { q: text(raw.q), brand: text(raw.brand), category: text(raw.category), status: text(raw.status), fulfillment, ownerId: text(raw.ownerId), anomaly }
  const ignored =
    Object.keys(raw).filter(key => raw[key] !== undefined && raw[key] !== null && raw[key] !== '' && !(KEYS as readonly string[]).includes(key)).length +
    KEYS.filter(key => raw[key] !== undefined && view[key] === undefined).length
  return { view, ignored }
}
