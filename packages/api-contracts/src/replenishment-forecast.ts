// 补货人工预测规则契约（P6-09，16 章第 4 节；freeze/api.md `/replenishment/forecast-overrides*`）。
// 本文件只放常量、标签、纯函数与响应类型，没有 zod（前端首屏路径可以安全引用）；请求体与列表查询的校验在 replenishment-forecast-query.ts。
//
// 规则的含义：在 from 到 to（含首尾）这段日期里，用人工给的日销取代模型预测（含订阅省与趋势调整）：
//   - FIXED：固定日销，value 件/天（0 表示这段时间不卖）；
//   - YOY_FACTOR：去年同期的日均销量 × value（系数，去年同期没有销量记录时规则不生效并说明，不当 0）。
// 作用对象：SKU（卖家 SKU，所有店铺的这个 SKU 都适用）或品类（商品类型）。
// 优先级（P6-09 定稿）：同一天里 SKU 规则优先于品类规则；同一对象的时间段不允许重叠（保存时 409，并指出冲突的那条规则）。

export const FORECAST_READ = 'replenishment.read'
export const FORECAST_WRITE = 'replenishment.policy.write'

export const FORECAST_SCOPE_TYPES = ['SKU', 'CATEGORY'] as const
export type ForecastScopeType = (typeof FORECAST_SCOPE_TYPES)[number]
export const FORECAST_SCOPE_LABEL: Record<ForecastScopeType, string> = { SKU: 'SKU', CATEGORY: '品类' }

export const FORECAST_MODES = ['FIXED', 'YOY_FACTOR'] as const
export type ForecastMode = (typeof FORECAST_MODES)[number]
export const FORECAST_MODE_LABEL: Record<ForecastMode, string> = { FIXED: '固定日销', YOY_FACTOR: '去年同期乘系数' }

export const FORECAST_STATUSES = ['UPCOMING', 'ACTIVE', 'EXPIRED'] as const
export type ForecastStatus = (typeof FORECAST_STATUSES)[number]
export const FORECAST_STATUS_LABEL: Record<ForecastStatus, string> = { UPCOMING: '未开始', ACTIVE: '生效中', EXPIRED: '已结束' }

/** 一条规则的时间段最长 366 天（含首尾）。 */
export const FORECAST_MAX_DAYS = 366
/** 固定日销上限（件/天）与同期系数上限。 */
export const FORECAST_FIXED_MAX = 1_000_000
export const FORECAST_FACTOR_MAX = 20
/** 每个企业最多保存的未结束规则数（防止无限增长；每次重算都要读取这些规则）。 */
export const FORECAST_ACTIVE_LIMIT = 300

export const FORECAST_ACTIONS = {
  created: 'REPLENISHMENT_FORECAST_OVERRIDE_CREATED',
  updated: 'REPLENISHMENT_FORECAST_OVERRIDE_UPDATED',
  deleted: 'REPLENISHMENT_FORECAST_OVERRIDE_DELETED',
} as const

export const FORECAST_BLOCKED_NO_PERMISSION = '没有“补货策略维护”权限（企业所有者、管理员与供应链有）'
/** 写入范围提示：规则按 SKU 或品类生效、不分店铺，所以只有数据范围是“全部店铺”的成员才能改。 */
export const FORECAST_BLOCKED_SCOPE = '人工预测规则对所有店铺的同名 SKU（或同品类）生效，只有数据范围是“全部店铺”的成员才能修改'
export const FORECAST_PRIORITY_NOTE = '同一天里 SKU 规则优先于品类规则，两者都优先于模型预测；同一个 SKU（或品类）的时间段不能重叠。规则只影响之后重新计算的批次，已生成的批次保持当时的结果。'

export interface ForecastOverrideFields {
  scopeType: ForecastScopeType
  /** SKU 规则是卖家 SKU，品类规则是商品类型。 */
  scopeId: string
  /** 起止日期（含首尾，YYYY-MM-DD）。 */
  from: string
  to: string
  mode: ForecastMode
  /** FIXED 是件/天，YOY_FACTOR 是系数。 */
  value: number
  note: string | null
}

export interface ForecastOverrideRow extends ForecastOverrideFields {
  id: string
  /** 乐观锁版本号：修改时原样带回。 */
  version: number
  status: ForecastStatus
  createdBy: string
  createdAt: string
  updatedAt: string
  /** 一句话说明规则的效果（页面与审计共用）。 */
  summary: string
}

export interface ForecastOverrideListResponse {
  items: ForecastOverrideRow[]
  page: number
  pageSize: number
  total: number
  /** 企业时区的今天：状态据此算出。 */
  today: string
  /** 全企业未结束规则的数量与上限。 */
  activeCount: number
  activeLimit: number
  canManage: boolean
  manageBlockedReason: string | null
  priorityNote: string
}

/** 计算链里“这次用到了哪条规则”的记录（冻结在建议的计算链 JSON 里，之后改规则不会改变它）。 */
export interface AppliedOverride {
  id: string
  scopeType: ForecastScopeType
  scopeId: string
  mode: ForecastMode
  value: number
  from: string
  to: string
  /** 规则换算成的日销（件/天）；去年同期没有销量记录时为 null（规则不生效）。 */
  rate: number | null
  /** 规则在本次预测范围内覆盖的天数（范围 = 今天起算 max(目标覆盖天数, 主提前期) 天）。 */
  days: number
  /** 是否真的改变了预测：去年同期缺数据、或整段落在预测范围之外都是 false。 */
  applied: boolean
  /** 没生效或生效方式的说明。 */
  note: string | null
}

export function forecastStatusOf(from: string, to: string, today: string): ForecastStatus {
  if (to < today) return 'EXPIRED'
  if (from > today) return 'UPCOMING'
  return 'ACTIVE'
}

/** 两段日期（含首尾）是否有交集。 */
export function forecastPeriodsOverlap(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  return a.from <= b.to && b.from <= a.to
}

/** 含首尾的天数（2026-11-01 到 2026-11-03 是 3 天）。 */
export function forecastPeriodDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

const trim = (value: number) => String(Number(value.toFixed(4)))

/** 一句话描述一条规则的效果，例如“2026-11-20 至 2026-11-30 固定日销 12 件/天”。 */
export function describeForecastOverride(rule: Pick<ForecastOverrideFields, 'from' | 'to' | 'mode' | 'value'>): string {
  const period = rule.from === rule.to ? rule.from : `${rule.from} 至 ${rule.to}`
  return rule.mode === 'FIXED' ? `${period} 固定日销 ${trim(rule.value)} 件/天` : `${period} 去年同期日均 × ${trim(rule.value)}`
}

/** 去年同一天（2 月 29 日回到 2 月 28 日）；用来取去年同期的销量窗口。 */
export function sameDayLastYear(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const lastDayOfMonth = new Date(Date.UTC(year - 1, month, 0)).getUTCDate()
  return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDayOfMonth)).padStart(2, '0')}`
}
