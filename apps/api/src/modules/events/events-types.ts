import { EVENT_PER_TYPE_LIMIT, type EventItem } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'

// 统一事件接口（P6-06）的内部类型：各来源读出的原始事件，经服务统一补上操作者名称与企业时区日期后才返回。

/** 事件对象：详情页或图表所属的对象，以及各来源用它定位数据所需的关联编号。 */
export interface EventTarget {
  objectType: string
  objectId: string
  /** 对象所属店铺；店铺级以上的对象没有。 */
  storeId: string | null
  asin: string | null
  sku: string | null
  /** 广告活动所属的广告账户与亚马逊侧活动编号。 */
  adsProfileId: string | null
  externalCampaignId: string | null
}

/** 时间窗：[from, to)。 */
export interface EventWindow {
  from: Date
  to: Date
}

export interface RawEvent extends Omit<EventItem, 'actor' | 'day'> {
  /** 操作者成员编号（有就按成员名称显示）。 */
  actorId?: string | null
  /** 没有成员编号时直接显示的来源，如“亚马逊”“系统”。 */
  actorLabel?: string
}

export interface LoadContext {
  prisma: PrismaService
  tenantId: string
  target: EventTarget
  window: EventWindow
}

export interface Loaded {
  items: RawEvent[]
  truncated: boolean
}

export const EMPTY_LOADED: Loaded = { items: [], truncated: false }

/** 每个来源多读一行用来判断是否被截断。 */
export const FETCH_LIMIT = EVENT_PER_TYPE_LIMIT + 1

const byNewest = (a: RawEvent, b: RawEvent) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

/** 同一类型的多个来源合并：按时间倒序只保留最近 200 条；任何来源读满、或合并后超出，都标记截断。 */
export function mergeLoaded(parts: ReadonlyArray<{ rows: readonly RawEvent[]; overflow: boolean }>): Loaded {
  const all = parts.flatMap(part => part.rows).sort(byNewest)
  return { items: all.slice(0, EVENT_PER_TYPE_LIMIT), truncated: parts.some(part => part.overflow) || all.length > EVENT_PER_TYPE_LIMIT }
}

/** 一个来源读出 FETCH_LIMIT 行后的拆分：最多 200 行加是否溢出。 */
export function capRows<T>(rows: readonly T[]): { rows: T[]; overflow: boolean } {
  return { rows: rows.slice(0, EVENT_PER_TYPE_LIMIT), overflow: rows.length > EVENT_PER_TYPE_LIMIT }
}

const SIDE_MAX = 120
const shown = (value: unknown): string | null => {
  if (typeof value === 'string') return value ? value.slice(0, SIDE_MAX) : null
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

/** 变更前后的一句话：“旧值 → 新值”，只认文字、数字与布尔；两边都没有返回 null。 */
export function beforeAfterText(before: unknown, after: unknown): string | null {
  const left = shown(before)
  const right = shown(after)
  return left === null && right === null ? null : `${left ?? '（无）'} → ${right ?? '（无）'}`
}

/** 对象事件的详情里取 before / after。 */
export function detailChange(detail: unknown): string | null {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const record = detail as Record<string, unknown>
  return beforeAfterText(record.before, record.after)
}
