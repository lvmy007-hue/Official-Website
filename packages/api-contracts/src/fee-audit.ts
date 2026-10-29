import type { InventoryFreshness } from './inventory.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'

// 费用核查（P2b-06，07 章 7.6，importers.md R-23、R-24）：把亚马逊实际收的配送费、佣金、仓储费、入仓配置费，与“应该收多少”的基准比较，
// 找出疑似多收，并可一键转为赔付机会。本文件只放常量、纯函数（worker 核查与 API 展示共用）、请求校验与响应类型。
// 基准的来源：R-23 预估配送费报告（含亚马逊测量尺寸与尺寸分段）、R-24 佣金预览报告、我方登记的商品尺寸、已确认的分仓方案费用。
// 重要口径：这是“疑似”，不是亚马逊认可的结论——预估报告与实际结算的口径不可能逐分一致，页面与赔付案件里都要写明。

export const FEE_AUDIT_READ = 'finance.read'
/** 一键转为赔付机会要写赔付中心的数据，权限按赔付写入。 */
export const FEE_AUDIT_CONVERT = 'reimbursements.write'

export const FEE_AUDIT_KINDS = ['FULFILLMENT', 'COMMISSION', 'STORAGE', 'INBOUND_PLACEMENT'] as const
export type FeeAuditKind = (typeof FEE_AUDIT_KINDS)[number]
export const FEE_AUDIT_KIND_LABEL: Readonly<Record<FeeAuditKind, string>> = { FULFILLMENT: '配送费', COMMISSION: '佣金', STORAGE: '仓储费', INBOUND_PLACEMENT: '入仓配置费' }
/** 每类核查的口径原文（页签说明与赔付案件证据都用它）。 */
export const FEE_AUDIT_KIND_BASIS: Readonly<Record<FeeAuditKind, string>> = {
  FULFILLMENT: '把每个订单行实际收的配送费，与预估配送费报告（R-23）里该 SKU 的“单件预期配送费”乘以订单数量比较；同时对比我方登记的包装尺寸与亚马逊测量尺寸、尺寸分段。',
  COMMISSION: '用佣金预览报告（R-24）里该 SKU 的预估佣金占售价的比例，乘以订单行的商品金额得到应收佣金，与实际收的佣金比较。分档费率、最低佣金与可变关闭费会造成正常误差，所以只标“疑似”。',
  STORAGE: '月度仓储费按体积收：亚马逊测量体积（R-23 的测量尺寸）比我方登记体积大得多时，按我方体积折算应收仓储费，与月度仓储费报告（R-20）的预估费用比较。',
  INBOUND_PLACEMENT: '把入仓配置费与已确认分仓方案的费用（分仓方案费用减折扣）比较；收费货件要能通过交易的货件标识对上入仓计划。',
}
export const FEE_AUDIT_STATUSES = ['NORMAL', 'SUSPECTED', 'APPEALED'] as const
export type FeeAuditStatus = (typeof FEE_AUDIT_STATUSES)[number]
export const FEE_AUDIT_STATUS_LABEL: Readonly<Record<FeeAuditStatus, string>> = { NORMAL: '正常', SUSPECTED: '疑似多收', APPEALED: '已转赔付机会' }

/** 基准报告（importers.md R-23、R-24）与它们的新鲜度来源。 */
export const FBA_FEE_ESTIMATE_REPORT_TYPE = 'GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA'
export const REFERRAL_FEE_PREVIEW_REPORT_TYPE = 'GET_REFERRAL_FEE_PREVIEW_REPORT'
export const FBA_FEE_ESTIMATE_FRESHNESS_KEY = 'rpt.estimated-fba-fees'
export const REFERRAL_FEE_PREVIEW_FRESHNESS_KEY = 'rpt.referral-fee-preview'
export const FEE_AUDIT_FRESHNESS_KEYS = ['finance.transactions', FBA_FEE_ESTIMATE_FRESHNESS_KEY, REFERRAL_FEE_PREVIEW_FRESHNESS_KEY, 'rpt.storage-fee', 'inbound.plan'] as const

/** 核查窗口：配送费、佣金、入仓配置费看最近多少天的费用事件。 */
export const FEE_AUDIT_WINDOW_DAYS = 30
/** 仓储费看最近几个收费月。 */
export const FEE_AUDIT_STORAGE_MONTHS = 3
/** 核查结果与基准快照各保留多少天。 */
export const FEE_AUDIT_RETENTION_DAYS = 60
export const FEE_BASELINE_RETENTION_DAYS = 90
/** 一行结果里最多保存多少条多收明细证据。 */
export const FEE_AUDIT_EVIDENCE_LIMIT = 20
/** 尺寸分段变化预警的预置规则代码（api-contracts 的 ALERT_RULE_DEFS）。 */
export const SIZE_TIER_ALERT_CODE = 'FEE_SIZE_TIER_CHANGE'
/** 费用核查转出的赔付机会：规则代码、证据类型。 */
export const FEE_AUDIT_OPPORTUNITY_RULE = 'FEE_OVERCHARGE'
export const FEE_AUDIT_EVIDENCE_KIND = 'FEE_AUDIT'

/**
 * 容差：实收比应收多出的金额超过 max(绝对容差, 相对容差 × 应收) 才算多收。
 * 数字是我们定的，不是亚马逊公布的：预估与实际结算有取整、促销与汇率时点差异，容差太小会满屏误报。
 */
export const FEE_AUDIT_TOLERANCE = { absolute: 0.05, relative: 0.02 } as const
/** 仓储费：亚马逊测量体积比我方登记体积大多少（比例）以上才核查为多收。 */
export const FEE_AUDIT_VOLUME_TOLERANCE = 0.05
/** 尺寸对比：任一边相差超过这个比例，就在依据里标出“尺寸不一致”。 */
export const FEE_AUDIT_DIMENSION_TOLERANCE = 0.1

// ---- 纯函数 ----

export const roundMoney = (value: number) => Math.round(value * 100) / 100

/** 多收金额：实收与应收都是正数（费用的绝对值）；只有超过容差才算多收，少收与容差内的差额返回 0。 */
export function overchargeOf(expected: number, actual: number, tolerance: { absolute: number; relative: number } = FEE_AUDIT_TOLERANCE): number {
  if (!Number.isFinite(expected) || !Number.isFinite(actual) || expected < 0 || actual < 0) return 0
  const diff = actual - expected
  return diff > Math.max(tolerance.absolute, tolerance.relative * expected) ? roundMoney(diff) : 0
}

const LENGTH_TO_CM: Readonly<Record<string, number>> = { centimeters: 1, centimeter: 1, cm: 1, millimeters: 0.1, millimeter: 0.1, mm: 0.1, inches: 2.54, inch: 2.54, in: 2.54, feet: 30.48, ft: 30.48 }
const WEIGHT_TO_KG: Readonly<Record<string, number>> = {
  kilograms: 1,
  kilogram: 1,
  kg: 1,
  grams: 0.001,
  gram: 0.001,
  g: 0.001,
  pounds: 0.45359237,
  pound: 0.45359237,
  lb: 0.45359237,
  lbs: 0.45359237,
  ounces: 0.028349523,
  ounce: 0.028349523,
  oz: 0.028349523,
}

/** 报告里的长度换算成厘米；单位缺失按英寸（美国站报告的惯例，也是我们的假设）；单位认不出返回 null。 */
export function lengthToCm(value: number | null | undefined, unit: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null
  const factor = LENGTH_TO_CM[(unit ?? 'inches').trim().toLowerCase()]
  return factor === undefined ? null : Math.round(value * factor * 10_000) / 10_000
}

/** 报告里的重量换算成千克；单位缺失按磅；单位认不出返回 null。 */
export function weightToKg(value: number | null | undefined, unit: string | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null
  const factor = WEIGHT_TO_KG[(unit ?? 'pounds').trim().toLowerCase()]
  return factor === undefined ? null : Math.round(value * factor * 10_000) / 10_000
}

export interface SizeCm {
  longestCm: number
  medianCm: number
  shortestCm: number
}

/** 三条边从长到短排好；任何一条缺失返回 null。 */
export function sortedSides(a: number | null | undefined, b: number | null | undefined, c: number | null | undefined): SizeCm | null {
  const sides = [a, b, c]
  if (sides.some(side => side === null || side === undefined || !Number.isFinite(side) || (side as number) <= 0)) return null
  const [longestCm, medianCm, shortestCm] = (sides as number[]).sort((x, y) => y - x)
  return { longestCm, medianCm, shortestCm }
}

const CM3_PER_FT3 = 28_316.846592
/** 单件体积（立方英尺）。 */
export const volumeCubicFeet = (size: SizeCm): number => Math.round(((size.longestCm * size.medianCm * size.shortestCm) / CM3_PER_FT3) * 1_000_000) / 1_000_000

/** 亚马逊测量体积 ÷ 我方登记体积；任一边没有体积返回 null。 */
export function volumeRatio(amazon: SizeCm | null, ours: SizeCm | null): number | null {
  if (!amazon || !ours) return null
  // 用未取整的立方厘米相除：先把体积取整到立方英尺再相除会有万分之几的误差（体积相同的两个尺寸会得到 7.9999 而不是 8）
  const cube = (size: SizeCm) => size.longestCm * size.medianCm * size.shortestCm
  const base = cube(ours)
  return base > 0 ? Math.round((cube(amazon) / base) * 10_000) / 10_000 : null
}

/** 三条边里相差最大的一条的相对差（亚马逊测量值相对我方登记值）；没有可比的数据返回 null。 */
export function maxSideDelta(amazon: SizeCm | null, ours: SizeCm | null): number | null {
  if (!amazon || !ours) return null
  const pairs: Array<[number, number]> = [
    [amazon.longestCm, ours.longestCm],
    [amazon.medianCm, ours.medianCm],
    [amazon.shortestCm, ours.shortestCm],
  ]
  return Math.max(...pairs.map(([measured, mine]) => (mine > 0 ? Math.abs(measured - mine) / mine : 0)))
}

const tierKey = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
/** 尺寸分段是否变了：两边都有值且忽略大小写与标点后不同；任何一边没有值不算变化。 */
export const sizeTierChanged = (previous: string | null | undefined, current: string | null | undefined): boolean =>
  Boolean(tierKey(previous) && tierKey(current) && tierKey(previous) !== tierKey(current))

/** 赔付机会的去重键：同一个核查对象在不同核查日只对应一个机会。 */
export const feeAuditOpportunityKey = (kind: FeeAuditKind, subjectKey: string) => `fee-audit:${kind}:${subjectKey}`.slice(0, 200)

export function feeAuditStatusOf(occurrences: number, hasOpportunity: boolean): FeeAuditStatus {
  if (occurrences <= 0) return 'NORMAL'
  return hasOpportunity ? 'APPEALED' : 'SUSPECTED'
}

// ---- 请求 ----

export const FeeAuditQuerySchema = cursorListQuery({
  sortable: ['overchargeAmount', 'occurrences'],
  defaultSort: { field: 'overchargeAmount', dir: 'desc' },
  filters: {
    kind: { type: 'enum', values: FEE_AUDIT_KINDS },
    status: { type: 'enum', values: FEE_AUDIT_STATUSES },
  },
})
export type FeeAuditQuery = ReturnType<typeof FeeAuditQuerySchema.parse>

// ---- 响应 ----

/** 一条多收明细：订单行、收费交易或货件，应收与实收。金额都是正数（费用的绝对值）。 */
export interface FeeAuditEvidenceLine {
  at: string | null
  /** 订单号、收费月或货件号。 */
  ref: string | null
  label: string
  quantity: number | null
  expected: number
  actual: number
  diff: number
}

export interface FeeAuditDims {
  amazon: (SizeCm & { weightKg: number | null }) | null
  ours: (SizeCm & { weightKg: number | null }) | null
  /** 亚马逊测量体积 ÷ 我方登记体积。 */
  volumeRatio: number | null
  /** 三条边里相差最大的相对差。 */
  maxSideDelta: number | null
  tierAmazon: string | null
  tierOurs: string | null
  tierPrevious: string | null
}

export interface FeeAuditBasis {
  summary: string
  lines: FeeAuditEvidenceLine[]
  dims: FeeAuditDims | null
  /** 核对时遇到的限制：缺数量、缺基准、读取到上限等，如实写出。 */
  notes: string[]
}

export interface FeeAuditRow {
  id: string
  sellerAccountId: string
  storeName: string
  feeKind: FeeAuditKind
  feeKindLabel: string
  subjectKey: string
  sku: string | null
  asin: string | null
  shipmentRef: string | null
  snapshotDate: string
  currency: string
  expectedAmount: number
  actualAmount: number
  diffAmount: number
  /** 累计差额：多收行的差额合计。 */
  overchargeAmount: number
  /** 发生次数：多收的行数。 */
  occurrences: number
  checkedCount: number
  firstSeenAt: string | null
  lastSeenAt: string | null
  status: FeeAuditStatus
  statusLabel: string
  basis: FeeAuditBasis
  opportunityId: string | null
}

export interface FeeAuditKindSummary {
  kind: FeeAuditKind
  label: string
  note: string
  /** 参与核查的对象数与疑似多收的对象数。 */
  subjects: number
  suspected: number
  occurrences: number
  /** 按币种分别合计的累计差额，不跨币种相加。 */
  overcharge: Array<{ currency: string; amount: number }>
}

export interface SizeTierChangeRow {
  sellerAccountId: string
  storeName: string
  sku: string
  asin: string | null
  previousTier: string
  currentTier: string
  changedOn: string
}

export interface FeeAuditListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: FeeAuditRow[]
  pageInfo: CursorPageInfo
  summary: FeeAuditKindSummary[]
  /** 最近尺寸分段变化（最近 14 天，最多 50 条）。 */
  sizeTierChanges: SizeTierChangeRow[]
  /** 当前页展示的核查日（每个店铺最近一个核查日里最晚的）；没有结果为 null。 */
  snapshotDate: string | null
  canConvert: boolean
  freshness: InventoryFreshness
}

export interface FeeAuditConvertResult {
  id: string
  status: FeeAuditStatus
  opportunityId: string
  /** 这次新建了机会；false 表示之前已经转过，返回已有的。 */
  created: boolean
}

export const SIZE_TIER_CHANGE_DAYS = 14
