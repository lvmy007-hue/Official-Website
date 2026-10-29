import {
  ADS_CHANGE_CREATED,
  ADS_CHANGE_CREATED_LABEL,
  ADS_CHANGE_FIELDS,
  ADS_CHANGE_LIMITS,
  ADS_CHANGE_STATE_LABEL,
  type AdsChangeEntityType,
  type AdsChangeFieldInfo,
  type AdsChangeFieldKind,
} from './ads-changes'

// 广告变更记录的纯函数（P3-14）：字段值规整、状态对比、排除本系统自己的写入、详情路径。worker 识别外部变更与接口显示对照共用同一套。

export type AdsChangeState = Record<string, string | null>
export interface AdsChangeDiff {
  field: string
  before: string | null
  after: string | null
}

/** 把库里读出来的值规整成可比较的文字：空、空串与全空白都是 null；金额取数值（去掉多余的 0）；状态转大写；日期取年月日。 */
export function normalizeChangeValue(kind: AdsChangeFieldKind, raw: unknown): string | null {
  if (raw === null || raw === undefined) return null
  if (kind === 'date') {
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : raw.toISOString().slice(0, 10)
    const text = String(raw).trim()
    return text === '' ? null : /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : text.slice(0, ADS_CHANGE_LIMITS.valueMax)
  }
  const text = String(raw).trim()
  if (text === '') return null
  if (kind === 'money') {
    const value = Number(text)
    return Number.isFinite(value) ? String(Math.round(value * 1e6) / 1e6) : text.slice(0, ADS_CHANGE_LIMITS.valueMax)
  }
  return (kind === 'state' ? text.toUpperCase() : text).slice(0, ADS_CHANGE_LIMITS.valueMax)
}

export const changeFieldsOf = (entityType: AdsChangeEntityType): readonly AdsChangeFieldInfo[] => ADS_CHANGE_FIELDS[entityType]

/** 一个对象的当前状态：只含要追踪的字段，全部规整成文字或 null。 */
export function changeStateOf(entityType: AdsChangeEntityType, values: Readonly<Record<string, unknown>>): AdsChangeState {
  const state: AdsChangeState = {}
  for (const field of changeFieldsOf(entityType)) state[field.key] = normalizeChangeValue(field.kind, values[field.key])
  return state
}

/** 库里存的状态 JSON 还原成状态（不认识的字段丢掉，缺的字段是 null；值不是文字的按 null）。 */
export function changeStateFromJson(entityType: AdsChangeEntityType, json: unknown): AdsChangeState {
  const record = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const state: AdsChangeState = {}
  for (const field of changeFieldsOf(entityType)) {
    const value = record[field.key]
    state[field.key] = typeof value === 'string' ? value : null
  }
  return state
}

/** 两份状态的差异（按字段定义的顺序）；规整后相同的不算。 */
export function diffChangeStates(entityType: AdsChangeEntityType, before: AdsChangeState, after: AdsChangeState): AdsChangeDiff[] {
  const diffs: AdsChangeDiff[] = []
  for (const field of changeFieldsOf(entityType)) {
    const was = before[field.key] ?? null
    const now = after[field.key] ?? null
    if (was !== now) diffs.push({ field: field.key, before: was, after: now })
  }
  return diffs
}

export interface OwnChange {
  entityId: string
  field: string
  /** 本系统写入的改动后的值（原样，比较前再规整）。 */
  after: string | null
}

/**
 * 这一处差异是不是本系统自己写入的：同一对象、同一字段、改后的值与本系统最近写入的某一条一致。
 * 一致就不算外部变更（本系统写亚马逊后，同步回来的新值会和快照差异里的“改后”相同）。
 * 局限：别人（或别的工具）恰好把同一字段改成了同一个值，也会被当成本系统写入的（宁可漏记，不重复记）。
 */
export function isOwnChange(entityType: AdsChangeEntityType, entityId: string, diff: AdsChangeDiff, own: readonly OwnChange[]): boolean {
  const info = changeFieldsOf(entityType).find(field => field.key === diff.field)
  if (!info) return false
  return own.some(item => item.entityId === entityId && item.field === diff.field && normalizeChangeValue(info.kind, item.after) === diff.after)
}

export function changeFieldLabel(entityType: AdsChangeEntityType, field: string): string {
  if (field === ADS_CHANGE_CREATED) return ADS_CHANGE_CREATED_LABEL
  return changeFieldsOf(entityType).find(item => item.key === field)?.label ?? field
}

/** 把值显示成人看的文字：状态翻成中文；没有为 null（页面写“空”，不写 0）。 */
export function changeValueText(entityType: AdsChangeEntityType, field: string, value: string | null): string | null {
  if (value === null) return null
  const info = changeFieldsOf(entityType).find(item => item.key === field)
  return info?.kind === 'state' ? (ADS_CHANGE_STATE_LABEL[value] ?? value) : value
}

const DETAIL_PATH: Record<AdsChangeEntityType, string> = {
  CAMPAIGN: '/app/advertising/campaigns',
  AD_GROUP: '/app/advertising/ad-groups',
  TARGET: '/app/advertising/targets',
  KEYWORD: '/app/advertising/targets',
  PORTFOLIO: '/app/advertising/portfolios',
}

/** 对象详情页路径（关键词与投放对象共用投放对象详情页）。 */
export const adsChangePath = (entityType: AdsChangeEntityType, entityId: string): string => `${DETAIL_PATH[entityType]}/${encodeURIComponent(entityId)}`

/** 截断到字段上限，空串当 null。 */
export const clipChangeText = (value: string | null | undefined, max: number = ADS_CHANGE_LIMITS.valueMax): string | null => {
  if (value === null || value === undefined) return null
  const text = value.trim()
  return text === '' ? null : text.slice(0, max)
}
