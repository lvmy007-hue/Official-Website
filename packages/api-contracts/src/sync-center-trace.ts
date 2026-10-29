import { SYNC_RESULT_MAX, SYNC_TIMELINE_MAX, syncFailureText } from './sync-center'

// 同步任务的过程记录与写入统计（P5-06）：时间线事件的读写、失败码翻译、统计只留数字。接口与后台任务共用。

// ---- 过程时间线 ----

export const SYNC_TIMELINE_STAGES = ['STARTED', 'POLL_WAIT', 'RETRY_WAIT', 'RETRY_REQUESTED', 'SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export type SyncTimelineStage = (typeof SYNC_TIMELINE_STAGES)[number]
export const SYNC_TIMELINE_LABEL: Readonly<Record<SyncTimelineStage, string>> = {
  STARTED: '开始执行',
  POLL_WAIT: '报告还在生成，等待下次查询',
  RETRY_WAIT: '尝试失败，等待重试',
  RETRY_REQUESTED: '已人工重试',
  SUCCEEDED: '执行完成',
  FAILED: '任务失败',
  CANCELLED: '已取消',
}
export interface SyncTimelineEvent {
  at: string
  stage: SyncTimelineStage
  text?: string
}
const STAGE_SET = new Set<string>(SYNC_TIMELINE_STAGES)

/** 从 JSON 列读出时间线；格式不对的条目丢弃。接口与后台任务共用这一份读法。 */
export function syncEventsOf(value: unknown): SyncTimelineEvent[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object') return []
    const { at, stage, text } = item as { at?: unknown; stage?: unknown; text?: unknown }
    if (typeof at !== 'string' || typeof stage !== 'string' || !STAGE_SET.has(stage)) return []
    return [{ at, stage: stage as SyncTimelineStage, ...(typeof text === 'string' && text ? { text } : {}) }]
  })
}

/** 追加一个事件：和最后一个事件的阶段与文字都相同就不重复记，超过上限丢最早的。 */
export function appendSyncEvent(current: unknown, stage: SyncTimelineStage, text?: string, now: Date = new Date()): SyncTimelineEvent[] {
  const events = syncEventsOf(current)
  const last = events[events.length - 1]
  if (last && last.stage === stage && (last.text ?? '') === (text ?? '')) return events
  return [...events, { at: now.toISOString(), stage, ...(text ? { text: text.slice(0, 300) } : {}) }].slice(-SYNC_TIMELINE_MAX)
}

const CODE_ONLY = /^[A-Z][A-Z0-9_]*$/

/** 事件文字给人看的写法：失败与等待重试的事件里存的是失败码（可能带“（第 n/5 次尝试失败）”后缀），翻译成中文说明；其余原样。 */
export function syncEventText(stage: SyncTimelineStage, text: string | undefined): string | null {
  if (!text) return null
  if (stage !== 'FAILED' && stage !== 'RETRY_WAIT') return text
  const split = text.indexOf('（')
  const code = split < 0 ? text : text.slice(0, split)
  if (!CODE_ONLY.test(code)) return text
  return `${syncFailureText(code)}${split < 0 ? '' : text.slice(split)}`
}

// ---- 写入统计 ----

const RESULT_LABEL: Readonly<Record<string, string>> = {
  imported: '导入行数',
  read: '读取行数',
  skipped: '跳过行数',
  upserted: '写入行数',
  written: '写入行数',
  inserted: '新增行数',
  updated: '更新行数',
  deleted: '删除行数',
  orders: '订单数',
  items: '商品数',
  rows: '行数',
  pages: '页数',
  count: '数量',
  total: '总数',
}
export const syncResultLabel = (key: string) => RESULT_LABEL[key] ?? key

/** 同步器的返回值只留顶层的有限数字（最多 20 项）：嵌套对象、数组、文字都不进库，避免把业务内容写进任务记录。没有数字返回 null。 */
export function syncResultStatsOf(result: unknown): Record<string, number> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  const entries = Object.entries(result as Record<string, unknown>).flatMap(([key, value]) => (typeof value === 'number' && Number.isFinite(value) ? [[key.slice(0, 40), value] as const] : []))
  return entries.length > 0 ? Object.fromEntries(entries.slice(0, SYNC_RESULT_MAX)) : null
}
export function syncResultItemsOf(value: unknown): Array<{ key: string; label: string; value: number }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (typeof item === 'number' && Number.isFinite(item) ? [{ key, label: syncResultLabel(key), value: item }] : []))
}
