import { z } from 'zod'
import type { InventoryFreshness } from './inventory.js'
import { transactionStatusLabel } from './orders.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'

// 费用事件（P2b-05，07 章 7.5，importers.md I-02）：财务交易拆出来的每一条费用明细、两份费用报告（仓储费、入仓不合规）落成的费用事件，
// 按 9 类归类，每条有交易状态与对账状态。本文件只放常量、分类器（worker 写入时用、迁移回填的 SQL 与它同一套关键字）、请求校验与响应类型。

export const FEE_EVENTS_READ = 'finance.read'
export const FEE_EVENTS_RECONCILE = 'finance.reconcile'
/** 没有选日期范围时默认只看最近多少天（费用事件很多，避免扫全表）。 */
export const FEE_DEFAULT_DAYS = 30
/** 费用事件导出（导出中心）的数据类型。 */
export const FEE_EXPORT_KIND = 'fee-events'
export const FEE_NOTE_MAX = 500
/** 亚马逊交易更新推送（importers.md N-14）的通知类型与新鲜度来源。 */
export const TRANSACTION_UPDATE_TYPE = 'TRANSACTION_UPDATE'
export const TRANSACTION_UPDATE_FRESHNESS_KEY = 'ntf.transaction-update'

export const FEE_CATEGORIES = ['FULFILLMENT', 'COMMISSION', 'STORAGE', 'AGED_SURCHARGE', 'INBOUND_PLACEMENT', 'REMOVAL_DISPOSAL', 'REFUND', 'REIMBURSEMENT', 'OTHER'] as const
export type FeeCategory = (typeof FEE_CATEGORIES)[number]
/** 销售收入、税、运费收入、促销折扣这类“不是费用”的明细：同样落在费用事件表里（财务汇总要用），但不属于 9 个页签。 */
export const NON_FEE_CATEGORY = 'NON_FEE'
export type StoredFeeCategory = FeeCategory | typeof NON_FEE_CATEGORY
export const STORED_FEE_CATEGORIES = [...FEE_CATEGORIES, NON_FEE_CATEGORY] as const

export const FEE_CATEGORY_LABEL: Readonly<Record<FeeCategory, string>> = {
  FULFILLMENT: '配送费',
  COMMISSION: '佣金',
  STORAGE: '仓储费',
  AGED_SURCHARGE: '库龄附加费',
  INBOUND_PLACEMENT: '入仓配置费',
  REMOVAL_DISPOSAL: '移除与弃置费',
  REFUND: '退款',
  REIMBURSEMENT: '赔付',
  OTHER: '其他调整',
}
/** 每个页签下的说明：写清楚这一类实际包含什么（分类是按名称关键字判断的，不是亚马逊的官方分类）。 */
export const FEE_CATEGORY_NOTE: Readonly<Record<FeeCategory, string>> = {
  FULFILLMENT: '亚马逊物流订单配送费（按件、按单、按重量的配送与拣货打包费）。',
  COMMISSION: '销售佣金（推荐费）与可变关闭费。',
  STORAGE: '月度仓储费、超限费、低库存水平费等仓储类费用（含月度仓储费报告落下的月度估算）。',
  AGED_SURCHARGE: '库龄附加费与长期仓储费。',
  INBOUND_PLACEMENT: '入仓配置费、入仓运输与便利费、入仓不合规费（含入仓不合规报告落下的行）。',
  REMOVAL_DISPOSAL: '移除订单费与弃置费。',
  REFUND: '退款类交易下的全部明细：退给买家的商品款与税、退还的佣金与费用、拒付。',
  REIMBURSEMENT: '亚马逊赔付与库存调整（仓库丢失与损坏、入仓差异赔付）。',
  OTHER: '订阅费、服务费、调整、债务回收等不属于以上 8 类的费用明细；名称无法归类的明细也先落在这里，不会被丢掉。',
}

/** 费用明细的交易状态中文名；报告类明细没有交易状态时为 null（订单页的同名函数会写“状态未知”，这里不能混用）。 */
export const feeTransactionStatusLabel = (status: string | null | undefined): string | null => (status ? transactionStatusLabel(status) : null)
export const FEE_TRANSACTION_STATUSES = ['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED'] as const

export const RECONCILIATION_STATUSES = ['UNRECONCILED', 'DISCREPANCY', 'RECONCILED'] as const
export type ReconciliationStatus = (typeof RECONCILIATION_STATUSES)[number]
export const RECONCILIATION_LABEL: Readonly<Record<ReconciliationStatus, string>> = { UNRECONCILED: '未对账', DISCREPANCY: '有差异', RECONCILED: '已对账' }
/** 页面上人工可以设置的两个状态；“已对账”由结算交易（P2b-07）的三方核对写入，这里不提供手工入口。 */
export const MANUAL_RECONCILIATION_STATUSES = ['UNRECONCILED', 'DISCREPANCY'] as const

export const FEE_SOURCES = ['FINANCE_API', 'STORAGE_REPORT', 'NONCOMPLIANCE_REPORT'] as const
export type FeeSource = (typeof FEE_SOURCES)[number]
export const FEE_SOURCE_LABEL: Readonly<Record<FeeSource, string>> = { FINANCE_API: '财务接口交易流水', STORAGE_REPORT: '月度仓储费报告', NONCOMPLIANCE_REPORT: '入仓不合规报告' }
/** 来源由费用事件的来源编号前缀判断（报告类的编号以 storage:、noncompliance: 开头，其余来自财务接口）。 */
export function feeSourceOf(sourceEventId: string | null | undefined): FeeSource {
  if (sourceEventId?.startsWith('storage:')) return 'STORAGE_REPORT'
  if (sourceEventId?.startsWith('noncompliance:')) return 'NONCOMPLIANCE_REPORT'
  return 'FINANCE_API'
}

// ---- 分类器 ----

const letters = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z]/g, '')

/**
 * 分类规则（按顺序，先命中先归类）。关键字写在这里一份，迁移 20261030010000_fee_events 回填历史数据用的是同一串关键字（真实库测试核对两边一致）。
 * 这是按名称关键字的启发式，不是亚马逊的官方分类；没有拿真实交易样本逐条核对。
 */
export const FEE_RULES: ReadonlyArray<{ category: StoredFeeCategory; pattern: string }> = [
  { category: 'REIMBURSEMENT', pattern: 'reimburs|safet|warehousedamage|warehouselost|carrierdamage|damagedinbound|lostinbound' },
  { category: 'REFUND', pattern: 'refund|chargeback|atoz|guarantee' },
  { category: 'REMOVAL_DISPOSAL', pattern: 'removal|disposal|dispose' },
  { category: 'AGED_SURCHARGE', pattern: 'agedinventory|agedsurcharge|longterm|ltsf|inventorysurcharge' },
  { category: 'INBOUND_PLACEMENT', pattern: 'inbound|placement|noncompliance|prepservice|labeling' },
  { category: 'STORAGE', pattern: 'storage|lowinventory|overage' },
  { category: 'COMMISSION', pattern: 'commission|referral|variableclosing|closingfee' },
  { category: 'FULFILLMENT', pattern: 'fulfil|fbaper|fbaweight|pickandpack|weighthandling|fbafee|shippinghb' },
  { category: NON_FEE_CATEGORY, pattern: 'principal|principle|productcharge|giftwrap|promotion|discount|proceeds|itemprice|ordercharge|shipping|tax|coupon' },
]
const COMPILED = FEE_RULES.map(rule => ({ category: rule.category, regex: new RegExp(rule.pattern) }))

export type FeeLineInput = { path?: string | null; eventType?: string | null; transactionType?: string | null }

/** 子类型：路径的最后一段（没有路径用类型），保留亚马逊原名，页面再按驼峰拆成易读文字。 */
export function feeSubtypeOf(input: FeeLineInput): string | null {
  const raw =
    (input.path ?? '')
      .split('/')
      .filter(part => part.trim())
      .pop() ??
    input.eventType ??
    ''
  const text = raw.trim().slice(0, 120)
  return text || null
}

/** 两份费用报告落下的行类型固定归类，不按文字猜（描述里是报告里的问题类型文字，可能碰巧含别的类别的关键字）。 */
export const FIXED_EVENT_TYPES: Readonly<Record<string, FeeCategory>> = { STORAGE_FEE: 'STORAGE', INBOUND_NONCOMPLIANCE: 'INBOUND_PLACEMENT' }

export function classifyFeeLine(input: FeeLineInput): { category: StoredFeeCategory; subtype: string | null } {
  const fixed = input.eventType ? FIXED_EVENT_TYPES[input.eventType] : undefined
  if (fixed) return { category: fixed, subtype: feeSubtypeOf(input) }
  const haystack = letters(input.transactionType) + letters(input.path) + letters(input.eventType)
  const hit = COMPILED.find(rule => rule.regex.test(haystack))
  return { category: hit?.category ?? 'OTHER', subtype: feeSubtypeOf(input) }
}

/** 子类型转易读文字：驼峰与下划线拆成单词（FBAPerUnitFulfillmentFee → FBA Per Unit Fulfillment Fee）。 */
export const feeSubtypeLabel = (subtype: string | null | undefined): string | null =>
  subtype
    ? subtype
        .replace(/_/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
        .trim()
    : null

// ---- 请求 ----

export const FeeEventListQuerySchema = cursorListQuery({
  sortable: ['postedAt'],
  defaultSort: { field: 'postedAt', dir: 'desc' },
  filters: {
    category: { type: 'enum', values: FEE_CATEGORIES },
    status: { type: 'enum', values: FEE_TRANSACTION_STATUSES },
    reconciliation: { type: 'enum', values: RECONCILIATION_STATUSES },
  },
})
export type FeeEventListQuery = ReturnType<typeof FeeEventListQuerySchema.parse>

/** 标记差异与对账备注：标记“有差异”必须写备注（说明差在哪里）；改回“未对账”可以不写。 */
export const FeeReconcileBodySchema = z
  .object({
    version: z.number().int().min(1),
    status: z.enum(MANUAL_RECONCILIATION_STATUSES).optional(),
    note: z.string().trim().max(FEE_NOTE_MAX, `备注最多 ${FEE_NOTE_MAX} 个字`).nullable().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.status === undefined && value.note === undefined) ctx.addIssue({ code: 'custom', path: ['status'], message: '请选择对账状态或填写备注' })
    if (value.status === 'DISCREPANCY' && !value.note) ctx.addIssue({ code: 'custom', path: ['note'], message: '标记有差异时请写明差在哪里' })
  })
export type FeeReconcileBody = z.infer<typeof FeeReconcileBodySchema>

// ---- 响应 ----

export interface FeeEventRow {
  id: string
  sellerAccountId: string
  storeName: string
  category: FeeCategory
  categoryLabel: string
  subtype: string | null
  subtypeLabel: string | null
  /** 带符号：扣费为负，退还与赔付为正。 */
  amount: number
  currency: string
  postedAt: string
  /** 交易状态；报告类费用事件没有交易，为 null（页面写“无交易状态”）。 */
  transactionStatus: string | null
  transactionStatusLabel: string | null
  amazonOrderId: string | null
  asin: string | null
  sellerSku: string | null
  /** 亚马逊的结算单编号。 */
  settlementId: string | null
  /** 来自交易的关联标识（SHIPMENT_ID）；没有交易或交易没带时为 null。 */
  shipmentId: string | null
  source: FeeSource
  sourceLabel: string
  reconciliationStatus: ReconciliationStatus
  reconciliationLabel: string
  reconciliationNote: string | null
  reconciledAt: string | null
  version: number
}

export interface FeeRange {
  from: string
  to: string
  defaulted: boolean
  /** 实际查询的时间范围（按企业口径时区换算后的起止时刻，toAt 不含）；导出任务原样带上，保证导出与页面一致。 */
  fromAt: string
  toAt: string
}

export interface FeeEventListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: FeeEventRow[]
  pageInfo: CursorPageInfo
  range: FeeRange
  freshness: InventoryFreshness
}

export interface FeeCategorySummary {
  category: FeeCategory
  label: string
  count: number
  /** 按币种分别合计，不跨币种相加。 */
  totals: Array<{ currency: string; amount: number }>
  discrepancyCount: number
}

export interface FeeEventSummaryResponse {
  range: FeeRange
  categories: FeeCategorySummary[]
  freshness: InventoryFreshness
}

export interface FeeEventTransaction {
  transactionId: string
  transactionType: string | null
  transactionStatus: string | null
  transactionStatusLabel: string | null
  amount: number
  currency: string
  postedAt: string
  description: string | null
  relatedIdentifiers: Array<{ name: string; value: string }>
}

export interface FeeEventHistoryRow {
  at: string
  title: string
  actorName: string | null
}

export interface FeeEventDetailResponse {
  event: FeeEventRow
  /** 来源交易；报告类费用事件、或交易记录已不在时为 null。 */
  transaction: FeeEventTransaction | null
  /** 同一笔交易里的其他费用明细（最多 50 条）。 */
  siblings: Array<{ id: string; categoryLabel: string; subtypeLabel: string | null; amount: number; currency: string }>
  siblingsTruncated: boolean
  /** 对账状态与备注的变更记录（最近 20 条）。 */
  history: FeeEventHistoryRow[]
  /** 订单页是否能链到：订单已同步才有，否则为 null。 */
  orderId: string | null
}

export interface FeeReconcileResult {
  id: string
  version: number
  reconciliationStatus: ReconciliationStatus
}
