import type { InventoryFreshness } from './inventory.js'

// 销售税（P2b-12，07 章 7.11，importers.md R-33，freeze/api.md GET /finance/sales-tax）。
// 本文件只放常量、标签与响应类型（没有 zod，请求参数就是全局范围参数）；纯函数在 sales-tax-math.ts（worker 与 API 共用）。
// 数据来源与口径：
//   - 税务文档库报告 GET_FLAT_FILE_SALES_TAX_DATA（R-33）：不能 createReport，也不能排程，只能卖家先在卖家后台“税务文档库”生成，
//     同步任务每天检索一次已生成的报告（最近 90 天），按（店铺、日期、州、辖区、税种）汇总写入 SalesTaxSummary。需要受限角色“税务汇缴”。
//   - 订单接口的税（OrderCharge.chargeKind = TAX）：订单接口不给收货州（收货地址属于买家个人信息，加密保存、不用于汇总），
//     所以只能按月给总额，用来和报告对账，不分州。
//   - 发货报告（R-04、R-07）：本包没有接入（受限角色报告，且冻结文档对它们的落点前后矛盾），页面如实写“尚未接入”。

export const SALES_TAX_READ = 'finance.tax.read'
export const SALES_TAX_REPORT_TYPE = 'GET_FLAT_FILE_SALES_TAX_DATA'
export const SALES_TAX_SYNC_JOB = 'TAX_SYNC'
export const SALES_TAX_FRESHNESS_KEY = 'rpt.sales-tax'
export const SALES_TAX_FRESHNESS_KEYS = [SALES_TAX_FRESHNESS_KEY, 'orders.api'] as const
/** 同步任务的失败码：卖家后台还没生成报告；受限角色“税务汇缴”未获批。 */
export const TAX_NOT_GENERATED = 'TAX_NOT_GENERATED'
export const TAX_ROLE_PENDING = 'TAX_ROLE_PENDING'
/** 检索报告时往回看多少天（亚马逊保留销售税报告最长 90 天）。 */
export const SALES_TAX_LOOKBACK_DAYS = 90
/** 单份报告最多汇总多少个（日期、州、辖区、税种）分组，超过就失败：防止异常大文件撑爆 worker 内存。 */
export const SALES_TAX_GROUP_LIMIT = 200_000
/** 未选日期时默认看最近多少天；对账与趋势最多按多少个月显示。 */
export const SALES_TAX_DEFAULT_DAYS = 90
export const SALES_TAX_MONTHS_MAX = 14
/** 辖区明细最多读多少行（多读 1 行判断是否被截断）。 */
export const SALES_TAX_JURISDICTION_LIMIT = 3000
/** 报告与订单接口的月度合计相差不超过 max(绝对容差, 比例容差 × 较大者) 算一致；这两个数是我们定的，不是亚马逊公布的。 */
export const SALES_TAX_TOLERANCE_ABS = 0.05
export const SALES_TAX_TOLERANCE_RATIO = 0.001
/** 目前只有美国站，金额一律是美元。 */
export const SALES_TAX_CURRENCY = 'USD'

export const SALES_TAX_SOURCES = ['TAX_LIBRARY', 'ORDER_API', 'SHIPMENT_REPORT'] as const
export type SalesTaxSource = (typeof SALES_TAX_SOURCES)[number]
export const SALES_TAX_SOURCE_LABEL: Readonly<Record<SalesTaxSource, string>> = {
  TAX_LIBRARY: '税务文档库报告',
  ORDER_API: '订单接口',
  SHIPMENT_REPORT: '发货报告',
}

/** 同步状态：这家店的税务文档库报告能不能取到。 */
export const SALES_TAX_AVAILABILITY = ['AVAILABLE', 'NOT_GENERATED', 'ROLE_PENDING', 'FAILED', 'NO_RECORD'] as const
export type SalesTaxAvailability = (typeof SALES_TAX_AVAILABILITY)[number]
export const SALES_TAX_AVAILABILITY_LABEL: Readonly<Record<SalesTaxAvailability, string>> = {
  AVAILABLE: '已取得',
  NOT_GENERATED: '待生成',
  ROLE_PENDING: '未授权',
  FAILED: '同步失败',
  NO_RECORD: '尚无记录',
}
export const SALES_TAX_AVAILABILITY_NOTE: Readonly<Record<Exclude<SalesTaxAvailability, 'FAILED'>, string>> = {
  AVAILABLE: '已取得税务文档库报告，每天检索一次新生成的报告',
  NOT_GENERATED: '需在卖家后台“税务文档库”先生成销售税报告，生成后每天检索一次，本系统不能代为生成',
  ROLE_PENDING: '未授权：需申请亚马逊受限角色“税务汇缴”，获批并重新授权后才能取得报告',
  NO_RECORD: '这家店还没有检索过税务文档库报告，授权后每天检索一次',
}

export const SALES_TAX_RECON_STATES = ['MATCHED', 'DIFFERENT', 'NO_REPORT', 'NO_ORDERS'] as const
export type SalesTaxReconState = (typeof SALES_TAX_RECON_STATES)[number]
export const SALES_TAX_RECON_LABEL: Readonly<Record<SalesTaxReconState, string>> = {
  MATCHED: '一致',
  DIFFERENT: '有差异',
  NO_REPORT: '报告里没有这段时间',
  NO_ORDERS: '订单里没有税额记录',
}
export const SALES_TAX_RECON_HINT: Readonly<Record<SalesTaxReconState, string>> = {
  MATCHED: '报告合计与订单接口合计在容差内',
  DIFFERENT: '两边合计对不上：报告按报告日期汇总、订单按下单时间汇总，月初月末的订单可能落在不同月份；其余需到卖家后台核对',
  NO_REPORT: '订单接口有税额但税务文档库报告没有覆盖这段时间：报告可能没生成，或生成时的时间范围不含这一段',
  NO_ORDERS: '报告有税额但订单接口没有税额记录：订单同步可能还没覆盖这段时间',
}

/** 税种：报告里的税种列原样保存（大写、下划线），只给最常见的取值配中文，其余原样显示。 */
export const DEFAULT_TAX_KIND = 'SALES_TAX'
const TAX_KIND_LABEL: Readonly<Record<string, string>> = { SALES_TAX: '销售税' }
export const taxKindLabel = (kind: string) => TAX_KIND_LABEL[kind] ?? kind

// ---- 响应 ----

export interface SalesTaxRange {
  from: string
  to: string
  /** 没选日期，用了默认范围。 */
  defaulted: boolean
  /** 范围超过 SALES_TAX_MONTHS_MAX 个月，起点被收窄。 */
  clamped: boolean
}

export interface SalesTaxStoreStatus {
  sellerAccountId: string
  storeName: string
  state: SalesTaxAvailability
  stateLabel: string
  note: string
  lastSuccessAt: string | null
}

export interface SalesTaxSourceView {
  source: SalesTaxSource
  label: string
  /** OK：有数据；NO_DATA：已接入但所选范围没有数据；NOT_CONNECTED：本系统尚未接入。 */
  state: 'OK' | 'NO_DATA' | 'NOT_CONNECTED'
  note: string
  /** 所选范围内的税额合计；没有数据为 null，不写 0。 */
  total: number | null
}

export interface SalesTaxJurisdictionRow {
  jurisdictionKey: string
  taxKind: string
  taxKindLabel: string
  /** 报告没给应税销售额列时为 null。 */
  taxableSales: number | null
  taxCollected: number
  lineCount: number
}

export interface SalesTaxStateRow {
  state: string
  taxableSales: number | null
  taxCollected: number
  lineCount: number
  /** 占代收税额合计的比例；合计为 0 时为 null。 */
  share: number | null
  jurisdictions: SalesTaxJurisdictionRow[]
}

export interface SalesTaxTrendPoint {
  /** YYYY-MM（日期按报告日期与订单下单时间的 UTC 日历日分月）。 */
  month: string
  /** 这个月在所选范围内的起止日（首尾月可能不满月）。 */
  from: string
  to: string
  reportTax: number | null
  ordersTax: number | null
}

export interface SalesTaxReconRow {
  sellerAccountId: string
  storeName: string
  month: string
  from: string
  to: string
  reportTax: number | null
  ordersTax: number | null
  /** 报告 − 订单；任一边没有数据为 null。 */
  diff: number | null
  state: SalesTaxReconState
  stateLabel: string
}

export interface SalesTaxResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  range: SalesTaxRange
  currency: typeof SALES_TAX_CURRENCY
  stores: SalesTaxStoreStatus[]
  sources: SalesTaxSourceView[]
  totals: { taxCollected: number | null; taxableSales: number | null; ordersTax: number | null }
  states: SalesTaxStateRow[]
  /** 辖区明细超过读取上限被截断（各州合计不受影响）。 */
  jurisdictionsTruncated: boolean
  trend: SalesTaxTrendPoint[]
  reconciliation: SalesTaxReconRow[]
  /** 订单接口按下单时间、报告按报告日期的说明与容差。 */
  basis: string
  freshness: InventoryFreshness
}
