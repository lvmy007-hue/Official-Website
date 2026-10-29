// 统一事件（P6-06，15 章第 9 节）：趋势图下方的事件带、对象详情里的事件列表共用。
// 本文件只放类型、常量与纯函数，不引入 zod，前端首屏路径可以放心取值；带 zod 的查询校验在 events-query.ts。

/** 事件类型：对应图表事件带里的七条泳道，顺序即显示顺序。 */
export const EVENT_TYPES = ['OPERATION', 'PRICE', 'ADS', 'ALERT', 'LISTING', 'AUDIT', 'OTHER'] as const
export type EventType = (typeof EVENT_TYPES)[number]

export const EVENT_TYPE_LABEL: Readonly<Record<EventType, string>> = {
  OPERATION: '运营日志',
  PRICE: '价格',
  ADS: '广告变更',
  ALERT: '预警',
  LISTING: 'Listing 变更',
  AUDIT: '系统操作',
  OTHER: '其他',
}

/** 读取某类事件除“对象读权限”以外还需要的权限点；null 表示只要能看对象就能看（permissions.md 10.2）。 */
export const EVENT_TYPE_PERMISSION: Readonly<Record<EventType, string | null>> = {
  OPERATION: null,
  PRICE: 'pricing.read',
  ADS: 'ads.read',
  ALERT: 'alerts.read',
  LISTING: 'listing.read',
  AUDIT: 'audit.read',
  OTHER: null,
}

/** 有专门的来源与取法的对象类型；别的对象类型（见 ENTITY_TYPES）只读对象事件表，类型按事件种类归并。 */
export const EVENT_SCOPED_OBJECT_TYPES = ['STORE', 'ASIN', 'CAMPAIGN', 'INVENTORY'] as const
export type EventScopedObjectType = (typeof EVENT_SCOPED_OBJECT_TYPES)[number]

/** 每种类型最多返回的条数；超出时响应标记截断，不静默丢弃。 */
export const EVENT_PER_TYPE_LIMIT = 200
/** 查询时间跨度上限（天）。 */
export const EVENT_MAX_SPAN_DAYS = 400
/** 没给时间范围时往前看多少天。 */
export const EVENT_DEFAULT_SPAN_DAYS = 90

/** 对象事件表（EntityEvent）的事件种类归到哪一类；没登记的种类一律归“其他”。 */
export const EVENT_KIND_TYPE: Readonly<Record<string, EventType>> = {
  'price.change': 'PRICE',
  'budget.change': 'ADS',
  'listing.change': 'LISTING',
  'content.change': 'LISTING',
  'variation.attribute_change': 'LISTING',
  alert: 'ALERT',
}

export const eventTypeOfKind = (kind: string): EventType => EVENT_KIND_TYPE[kind] ?? 'OTHER'

/** 某一类事件在对象事件表里对应哪些种类；“其他”是除已登记种类之外的全部。 */
export const eventKindsOf = (type: EventType): string[] => Object.keys(EVENT_KIND_TYPE).filter(kind => EVENT_KIND_TYPE[kind] === type)

export interface EventItem {
  id: string
  type: EventType
  occurredAt: string
  /** 企业时区下的日历日（YYYY-MM-DD），图表按它落到横轴类目上。 */
  day: string
  title: string
  summary: string | null
  /** 站内详情路径（`/app/...`）；没有独立详情页的事件为 null。 */
  link: string | null
  actor: string
}

export interface EventsResponse {
  items: EventItem[]
  /** 任何一类超过上限都为 true。 */
  truncated: boolean
  /** 哪些类型被截断（每类只保留最近 200 条）。 */
  truncatedTypes: EventType[]
  /** 本次请求的类型里，当前成员没有读权限而被略去的类型。 */
  unavailableTypes: EventType[]
}

/** 同一天同一类的事件合并成一个点：数量大于 1 时显示“N 个事件”。 */
export interface EventDayGroup {
  day: string
  type: EventType
  items: EventItem[]
}

export function groupEventsByDay(events: readonly EventItem[]): EventDayGroup[] {
  const groups = new Map<string, EventDayGroup>()
  for (const event of events) {
    const key = `${event.type}|${event.day}`
    const group = groups.get(key)
    if (group) group.items.push(event)
    else groups.set(key, { day: event.day, type: event.type, items: [event] })
  }
  return [...groups.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : EVENT_TYPES.indexOf(a.type) - EVENT_TYPES.indexOf(b.type)))
}

export const eventGroupLabel = (group: Pick<EventDayGroup, 'items'>): string => (group.items.length > 1 ? `${group.items.length} 个事件` : (group.items[0]?.title ?? ''))
