// 小时推送解析器（P2a-03，importers.md N-01/N-02/N-03）：只认官方字段名；结构不对抛 NTF_SCHEMA，原文由重放层保留在对象存储。

export class NtfSchemaError extends Error {
  readonly code = 'NTF_SCHEMA'
  constructor(message: string) {
    super(message)
    this.name = 'NtfSchemaError'
  }
}

const US = 'ATVPDKIKX0DER'
const HOUR_MS = 3_600_000
const LATE_MS = 90 * 60_000 // 事件时间晚于小时结束超过 90 分钟视为延迟补发（官方最长 24 小时）

export type HourlySalesRow = {
  accountId: string
  marketplaceId: string
  asin: string
  hourStart: Date
  units: number
  salesAmount: number
  currency: string
  isLateArrival: boolean
  sourceUpdatedAt: Date
}

export type HourlyTrafficRow = {
  accountId: string
  marketplaceId: string
  asin: string
  hourStart: Date
  pageViews: number
  isLateArrival: boolean
  sourceUpdatedAt: Date
}

export type HourlyInventoryRow = {
  accountId: string
  marketplaceId: string
  asin: string
  hourStart: Date
  availableQty: number
  isLateArrival: boolean
  sourceUpdatedAt: Date
}

const asObject = (value: unknown, label: string): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NtfSchemaError(`${label} 必须是对象`)
  return value as Record<string, unknown>
}

const asArray = (value: unknown, label: string): unknown[] => {
  if (!Array.isArray(value)) throw new NtfSchemaError(`${label} 必须是数组`)
  return value
}

const asString = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new NtfSchemaError(`${label} 必须是非空字符串`)
  return value.trim()
}

const asNumber = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new NtfSchemaError(`${label} 必须是数字`)
  return value
}

const asInt = (value: unknown, label: string): number => {
  const n = asNumber(value, label)
  if (!Number.isInteger(n)) throw new NtfSchemaError(`${label} 必须是整数`)
  return n
}

const asDate = (value: unknown, label: string): Date => {
  const text = asString(value, label)
  const date = new Date(text)
  if (Number.isNaN(date.getTime())) throw new NtfSchemaError(`${label} 不是合法时间`)
  return date
}

const envelope = (raw: unknown) => {
  const root = asObject(raw, '通知根对象')
  const notificationType = asString(root.notificationType, 'notificationType')
  const eventTime = asDate(root.eventTime, 'eventTime')
  const payload = asObject(root.payload, 'payload')
  return { notificationType, eventTime, payload }
}

const lateOf = (hourStart: Date, eventTime: Date) => eventTime.getTime() - (hourStart.getTime() + HOUR_MS) > LATE_MS

/** 只保留美国站；其他站点跳过（站点白名单，不报错）。 */
const usOnly = <T extends { marketplaceId: string }>(rows: T[]) => rows.filter(row => row.marketplaceId === US)

export function parseItemSalesEvent(raw: unknown): HourlySalesRow[] {
  const { notificationType, eventTime, payload } = envelope(raw)
  if (notificationType !== 'ITEM_SALES_EVENT_CHANGE') throw new NtfSchemaError(`期望 ITEM_SALES_EVENT_CHANGE，收到 ${notificationType}`)
  const list = asArray(payload.itemSalesEventChanges ?? payload.itemSalesEventChangeNotifications, 'itemSalesEventChanges')
  const rows: HourlySalesRow[] = []
  for (const item of list) {
    const row = asObject(item, '销售行')
    const hourStart = asDate(row.startTime, 'startTime')
    rows.push({
      accountId: asString(row.accountId, 'accountId'),
      marketplaceId: asString(row.marketplaceId, 'marketplaceId'),
      asin: asString(row.asin, 'asin'),
      hourStart,
      units: asInt(row.orderedUnits, 'orderedUnits'),
      salesAmount: asNumber(row.orderedRevenue, 'orderedRevenue'),
      currency: asString(row.currencyCode, 'currencyCode'),
      isLateArrival: lateOf(hourStart, eventTime),
      sourceUpdatedAt: eventTime,
    })
  }
  return usOnly(rows)
}

export function parsePageTrafficEvent(raw: unknown): HourlyTrafficRow[] {
  const { notificationType, eventTime, payload } = envelope(raw)
  if (notificationType !== 'DETAIL_PAGE_TRAFFIC_EVENT') throw new NtfSchemaError(`期望 DETAIL_PAGE_TRAFFIC_EVENT，收到 ${notificationType}`)
  const list = asArray(payload.detailPageTrafficEventNotifications, 'detailPageTrafficEventNotifications')
  const rows: HourlyTrafficRow[] = []
  for (const item of list) {
    const row = asObject(item, '流量行')
    const hourStart = asDate(row.startTime, 'startTime')
    rows.push({
      accountId: asString(row.accountId, 'accountId'),
      marketplaceId: asString(row.marketplaceId, 'marketplaceId'),
      asin: asString(row.asin, 'asin'),
      hourStart,
      pageViews: asInt(row.glanceViews, 'glanceViews'),
      isLateArrival: lateOf(hourStart, eventTime),
      sourceUpdatedAt: eventTime,
    })
  }
  return usOnly(rows)
}

export function parseItemInventoryEvent(raw: unknown): HourlyInventoryRow[] {
  const { notificationType, eventTime, payload } = envelope(raw)
  if (notificationType !== 'ITEM_INVENTORY_EVENT_CHANGE') throw new NtfSchemaError(`期望 ITEM_INVENTORY_EVENT_CHANGE，收到 ${notificationType}`)
  const list = asArray(payload.itemInventoryEventChanges ?? payload.itemInventoryEventChangeNotifications, 'itemInventoryEventChanges')
  const rows: HourlyInventoryRow[] = []
  for (const item of list) {
    const row = asObject(item, '库存行')
    const hourStart = asDate(row.startTime, 'startTime')
    rows.push({
      accountId: asString(row.accountId, 'accountId'),
      marketplaceId: asString(row.marketplaceId, 'marketplaceId'),
      asin: asString(row.asin, 'asin'),
      hourStart,
      availableQty: asInt(row.highlyAvailableInventory, 'highlyAvailableInventory'),
      isLateArrival: lateOf(hourStart, eventTime),
      sourceUpdatedAt: eventTime,
    })
  }
  return usOnly(rows)
}
