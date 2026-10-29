import type { LineTarget } from './profit-math.js'

// 预估与自定义费用（P6-20，16 章第 7 节；freeze/models.md `EstimatedFee`）。纯类型、常量与纯函数（零 zod，前端与 worker 可引用）；请求校验在 estimated-fees-query.ts。
//
// 口径：
//  - 费用项是利润项目字典（P6-18）里的项目，自定义项目（站外推广、服务费等）挂在字典上；估算金额计入该项目在字典里归到的利润桥项目，所以净利润、利润桥、关账快照自然对得上；
//  - 范围：店铺（scopeId 是店铺编号）、SKU（卖家 SKU）、品类（商品类型或类目路径）；
//  - 方式：固定金额（按日是每天的金额，按月是整月的金额，按当月天数平均到每一天）或销售额比例（按当天销售额乘比例，单位 %）；
//  - 生效区间：from 到 to（含，空 = 一直有效）；同一费用项、同一范围，处于“生效”状态的规则区间不能重叠（重叠 409，相邻不算重叠），停用的规则不参与；
//  - 冲销：同一店铺同一费用项在对应期间已经有实际费用出账（按日的看当天，按月的看当月），这一期的估算自动不再计入，避免重复；
//  - 币种：利润日表目前只算美元，预估费用只接受美元；估算只计到今天为止的日子，不预支未来。

export const ESTIMATED_FEE_READ = 'finance.read'
export const ESTIMATED_FEE_WRITE = 'finance.estimatedfee.write'
export const ESTIMATED_FEE_ACTIONS = {
  created: 'ESTIMATED_FEE_CREATED',
  updated: 'ESTIMATED_FEE_UPDATED',
  deleted: 'ESTIMATED_FEE_DELETED',
  imported: 'ESTIMATED_FEE_IMPORTED',
} as const
export const ESTIMATED_FEE_LIMITS = { pageSizeMax: 200, importMaxRows: 2000, importMaxChars: 400_000, valueMax: 1_000_000_000, tenantMax: 5000, scopeIdMax: 120, noteMax: 200, problemMax: 50 } as const
export const ESTIMATED_FEE_CURRENCY = 'USD'
export const ESTIMATED_FEE_FLAG_NOTE = '含估算'

export const ESTIMATED_SCOPE_TYPES = ['STORE', 'SKU', 'CATEGORY'] as const
export type EstimatedScopeType = (typeof ESTIMATED_SCOPE_TYPES)[number]
export const ESTIMATED_SCOPE_LABEL: Readonly<Record<EstimatedScopeType, string>> = { STORE: '店铺', SKU: 'SKU', CATEGORY: '品类' }

export const isEstimatedScopeType = (value: string): value is EstimatedScopeType => (ESTIMATED_SCOPE_TYPES as readonly string[]).includes(value)

export const ESTIMATED_MODES = ['FIXED', 'PERCENT_OF_SALES'] as const
export type EstimatedMode = (typeof ESTIMATED_MODES)[number]
export const ESTIMATED_MODE_LABEL: Readonly<Record<EstimatedMode, string>> = { FIXED: '固定金额', PERCENT_OF_SALES: '销售额比例' }

export const ESTIMATED_PERIODS = ['DAILY', 'MONTHLY'] as const
export type EstimatedPeriod = (typeof ESTIMATED_PERIODS)[number]
export const ESTIMATED_PERIOD_LABEL: Readonly<Record<EstimatedPeriod, string>> = { DAILY: '按日', MONTHLY: '按月' }

export const ESTIMATED_STATUSES = ['ACTIVE', 'INACTIVE'] as const
export type EstimatedStatus = (typeof ESTIMATED_STATUSES)[number]
export const ESTIMATED_STATUS_LABEL: Readonly<Record<EstimatedStatus, string>> = { ACTIVE: '生效', INACTIVE: '停用' }

/** 预估费用只能挂在“花费类”的利润桥项目上（收入、赔付、代收代缴税不是预估费用）。 */
export const ESTIMATED_FEE_TARGETS: readonly LineTarget[] = ['REFUNDS', 'COMMISSION', 'FULFILLMENT', 'STORAGE', 'AGED_SURCHARGE', 'INBOUND_PLACEMENT', 'OTHER_FEES', 'PROMOTION']
export const isEstimatedFeeTarget = (target: string | null | undefined): target is LineTarget =>
  target !== null && target !== undefined && (ESTIMATED_FEE_TARGETS as readonly string[]).includes(target)

export const ESTIMATED_FEE_NOTES: readonly string[] = [
  '预估费用以“估算”计入利润：计入费用项在利润项目字典里归到的利润桥项目，利润日表那一行标“含估算”；净利润、利润桥与关账快照因此保持一致。',
  '冲销：同一店铺、同一费用项在对应期间已经有实际费用出账（按日的看当天，按月的看当月），这一期的预估自动不再计入，避免重复；实际费用以后被撤销，下次重算会重新计入。',
  '固定金额按月的，按当月天数平均到每一天；销售额比例按每天的销售额计算；只估算到今天为止的日子。',
  '同一费用项、同一范围，处于“生效”状态的规则生效区间不能重叠（相邻的两天不算重叠）；停用的规则不参与计算。',
  '新规则在利润日表下一次重算（每 6 小时近 45 天）后生效；已关账的期间不重算，不受影响。利润日表目前只算美元，所以预估费用只接受美元。',
  '品类按商品目录里的“商品类型”或“类目路径”匹配；品类下的固定金额按当天各 SKU 的销售额分摊，当天没有销售就不计入。',
]

/** 规则在计算里的形状（日期是 YYYY-MM-DD）。 */
export interface EstimatedFeeLite {
  id: string
  itemId: string
  scopeType: EstimatedScopeType
  scopeId: string
  mode: EstimatedMode
  value: number
  period: EstimatedPeriod
  from: string
  to: string | null
  status: EstimatedStatus
}

// ---- 日期与区间（纯函数，日期一律是 YYYY-MM-DD 文本）----

export const isDayText = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const time = Date.parse(`${value}T00:00:00Z`)
  return !Number.isNaN(time) && new Date(time).toISOString().startsWith(value)
}

/** 某天所在月份的天数。 */
export function daysInMonthOf(day: string): number {
  const year = Number(day.slice(0, 4))
  const month = Number(day.slice(5, 7))
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** 规则在某天是否有效：处于生效状态，且 from ≤ 天 ≤ to（to 为空 = 一直有效）。 */
export const feeCoversDay = (fee: Pick<EstimatedFeeLite, 'from' | 'to' | 'status'>, day: string): boolean => fee.status === 'ACTIVE' && day >= fee.from && (fee.to === null || day <= fee.to)

/** 两个闭区间是否有公共的日子（to 为空 = 无限期）。 */
export const dayRangesOverlap = (a: { from: string; to: string | null }, b: { from: string; to: string | null }): boolean => (a.to === null || a.to >= b.from) && (b.to === null || b.to >= a.from)

/** 固定金额规则在某天的估算金额（美元，正数）：按日是 value，按月是 value ÷ 当月天数；比例规则返回 null（要看销售额）。 */
export function fixedAmountOnDay(fee: Pick<EstimatedFeeLite, 'mode' | 'value' | 'period'>, day: string): number | null {
  if (fee.mode !== 'FIXED') return null
  return fee.period === 'DAILY' ? fee.value : fee.value / daysInMonthOf(day)
}

/** 销售额比例规则对某个销售额的估算金额（比例单位是 %）。 */
export const percentAmount = (fee: Pick<EstimatedFeeLite, 'value'>, revenue: number): number => (revenue > 0 ? (revenue * fee.value) / 100 : 0)

/** 一条规则的范围文字（页面与导出用）。 */
export const scopeText = (scopeType: EstimatedScopeType, scopeId: string, storeName?: string): string => `${ESTIMATED_SCOPE_LABEL[scopeType]}：${storeName ?? scopeId}`

/** 规则金额的显示：固定金额带美元符号，比例带百分号。 */
export const valueText = (mode: EstimatedMode, value: number, period: EstimatedPeriod): string =>
  mode === 'PERCENT_OF_SALES' ? `销售额的 ${value}%` : `$${value.toFixed(2)} / ${period === 'DAILY' ? '日' : '月'}`

// ---- 接口形状 ----

export interface EstimatedFeeRow {
  id: string
  itemId: string
  itemName: string
  itemPath: string
  scopeType: EstimatedScopeType
  scopeId: string
  /** 店铺范围时是店铺名称；其余同 scopeId。 */
  scopeName: string
  mode: EstimatedMode
  value: number
  currency: string
  period: EstimatedPeriod
  from: string
  to: string | null
  status: EstimatedStatus
  note: string | null
  version: number
  createdBy: string | null
  updatedAt: string
}

export interface EstimatedFeeItemOption {
  id: string
  name: string
  path: string
}
export interface EstimatedFeeStoreOption {
  id: string
  name: string
}

export interface EstimatedFeesResponse {
  rows: EstimatedFeeRow[]
  total: number
  summary: { active: number; inactive: number }
  /** 只在第一页带，减少重复。 */
  items: EstimatedFeeItemOption[]
  stores: EstimatedFeeStoreOption[]
  notes: string[]
  canWrite: boolean
  writeBlockedReason: string | null
}

export interface EstimatedFeeMutationResult {
  row: EstimatedFeeRow
  recomputeNote: string
}
export interface EstimatedFeeDeleteResult {
  id: string
  recomputeNote: string
}
export interface EstimatedFeeImportResponse {
  total: number
  created: number
  recomputeNote: string
}

export const ESTIMATED_FEE_RECOMPUTE_NOTE = '新规则在利润日表下一次重算（每 6 小时近 45 天）后计入利润；已关账的期间不重算。'
export const ESTIMATED_FEE_NO_WRITE_REASON = '录入、修改与导入预估费用需要 finance.estimatedfee.write 权限，并且数据范围为全部店铺'

// ---- 利润页的“估算”标注 ----

/** 利润日表一行里的估算金额占这一行全部费用的比例（0 到 1）；没有估算返回 null。 */
export function estimateShare(estimated: number | null | undefined, totalCosts: number): number | null {
  if (estimated === null || estimated === undefined || estimated <= 0 || totalCosts <= 0) return null
  return Math.min(1, estimated / totalCosts)
}
