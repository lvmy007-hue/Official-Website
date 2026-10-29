import { z } from 'zod'
import { BATCH_MAX_CHARS, batchTermsIssue } from './batch-terms.js'
import { pageListQuery } from './query.js'
import type { DashState } from './dashboard.js'
import type { MetricVersionRef } from './metric-versions-view.js'

// 库存健康契约（P2a-06，06 章 6.1；freeze/metrics.md M-009、M-020、M-023、M-210）。
// 规则引擎不使用固定阈值：风险等级由“当前生效的补货策略版本”（ReplenishmentPolicy）与近期销量算出；
// 没有配置策略时一律返回“尚未配置规则”（NOT_CONNECTED），不返回任何风险等级，也不拿默认值凑数。

export const INVENTORY_TABS = ['all', 'low', 'excess', 'aging', 'stranded', 'unsellable', 'inbound'] as const
export type InventoryTab = (typeof INVENTORY_TABS)[number]
export const INVENTORY_TAB_LABEL: Record<InventoryTab, string> = {
  all: '全部库存',
  low: '低库存',
  excess: '冗余',
  aging: '库龄风险',
  stranded: '滞留',
  unsellable: '不可售',
  inbound: '在途',
}

export const INVENTORY_RISK_LEVELS = ['HIGH', 'MEDIUM', 'NORMAL', 'EXCESS'] as const
export type InventoryRiskLevel = (typeof INVENTORY_RISK_LEVELS)[number]
export const INVENTORY_RISK_LABEL: Record<InventoryRiskLevel, string> = { HIGH: '高风险（将断货）', MEDIUM: '中风险（安全库存内）', NORMAL: '正常', EXCESS: '冗余' }

export const INBOUND_KINDS = ['WORKING', 'SHIPPED', 'RECEIVING'] as const
export type InboundKind = (typeof INBOUND_KINDS)[number]
export const INBOUND_KIND_LABEL: Record<InboundKind, string> = { WORKING: '处理中', SHIPPED: '已发货', RECEIVING: '接收中' }

export const AGING_FROM_DAYS = [181, 271, 366] as const

export const INVENTORY_SORT_FIELDS = ['risk', 'sellerSku', 'asin', 'sellable', 'inbound', 'unsellable', 'daysOfCover', 'units30', 'storageFee', 'ageSurcharge'] as const
export type InventorySortField = (typeof INVENTORY_SORT_FIELDS)[number]

export const InventoryListQuerySchema = pageListQuery({
  sortable: INVENTORY_SORT_FIELDS,
  defaultSort: { field: 'risk', dir: 'asc' },
  filters: {
    tab: { type: 'enum', values: INVENTORY_TABS },
    risk: { type: 'enum', values: INVENTORY_RISK_LEVELS },
    // 批量搜索（P6-04）：SKU、ASIN 或 FNSKU 精确匹配（不区分大小写），最多 500 个，逗号连接；与 q（包含匹配）同时给出时两者都要满足
    qs: { type: 'text', max: BATCH_MAX_CHARS },
  },
}).refine(value => batchTermsIssue(value.qs) === null, { message: '批量搜索最多 500 个词，每个词不超过 80 个字符', path: ['qs'] })
export type InventoryListQuery = z.infer<typeof InventoryListQuerySchema>

// ---- 补货策略（规则版本）----

export interface InventoryPolicy {
  versionNo: number
  level: 'TENANT'
  leadTimeDays: number
  awdLeadTimeDays: number | null
  safetyDays: number
  coverageDays: number
  redundancyMultiplier: number
  inboundCounted: InboundKind[]
  agingFromDays: (typeof AGING_FROM_DAYS)[number]
  effectiveFrom: string
  changeReason: string
  createdBy: string
  createdAt: string
}

export interface InventoryPolicyResponse {
  state: 'OK' | 'NOT_CONNECTED'
  note: string | null
  /** 今天起生效的版本；没有则 null（页面显示“尚未配置规则”）。 */
  current: InventoryPolicy | null
  /** 版本历史，新的在前（含尚未到生效日的版本）。 */
  history: InventoryPolicy[]
}

export const POLICY_NOT_CONFIGURED_NOTE = '尚未配置库存规则：请在“库存规则”里设置提前期、安全库存天数、目标覆盖天数与冗余倍数，风险等级才会计算（规则不使用固定阈值）'

/** 规则版本共用的字段（库存规则与补货策略相同）；补货策略在此基础上再加补货计算链参数（replenishment.ts）。 */
export const policyBaseFields = {
  /** 提交时看到的当前版本号（没有版本时为 0）；与最新版本不一致返回 409。 */
  expectedVersionNo: z.number().int().min(0),
  leadTimeDays: z.number().int().min(1).max(365),
  awdLeadTimeDays: z.number().int().min(1).max(365).nullable(),
  safetyDays: z.number().int().min(0).max(365),
  coverageDays: z.number().int().min(1).max(730),
  redundancyMultiplier: z.number().min(1).max(10),
  inboundCounted: z.array(z.enum(INBOUND_KINDS)).max(3),
  agingFromDays: z.union([z.literal(181), z.literal(271), z.literal(366)]),
  effectiveFrom: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
    .optional(),
  changeReason: z.string().trim().min(2, '请写明调整原因').max(200),
}

/** 规则版本共用的组合校验（库存规则与补货策略相同）。 */
export function refinePolicyBase(value: { inboundCounted: readonly string[]; coverageDays: number; redundancyMultiplier: number; leadTimeDays: number; safetyDays: number }, ctx: z.RefinementCtx) {
  if (new Set(value.inboundCounted).size !== value.inboundCounted.length) ctx.addIssue({ code: 'custom', path: ['inboundCounted'], message: '在途类别不能重复' })
  if (value.coverageDays * value.redundancyMultiplier <= value.leadTimeDays + value.safetyDays) {
    ctx.addIssue({ code: 'custom', path: ['coverageDays'], message: '目标覆盖天数 × 冗余倍数必须大于提前期 + 安全库存天数，否则“正常”区间为空' })
  }
}

export const InventoryPolicyWriteSchema = z.object(policyBaseFields).superRefine(refinePolicyBase)
export type InventoryPolicyWrite = z.infer<typeof InventoryPolicyWriteSchema>

// ---- 库龄分段（冻结 8 段；报告没给细分段时退化为 5 段）----

export interface AgeBucketDef {
  key: string
  label: string
  from: number
  /** 上界（含）；最后一段为 null。 */
  to: number | null
}
export const AGE_BUCKETS_FINE: readonly AgeBucketDef[] = [
  { key: 'age0to30', label: '0-30 天', from: 0, to: 30 },
  { key: 'age31to60', label: '31-60 天', from: 31, to: 60 },
  { key: 'age61to90', label: '61-90 天', from: 61, to: 90 },
  { key: 'age91to180', label: '91-180 天', from: 91, to: 180 },
  { key: 'age181to270', label: '181-270 天', from: 181, to: 270 },
  { key: 'age271to365', label: '271-365 天', from: 271, to: 365 },
  { key: 'age366to455', label: '366-455 天', from: 366, to: 455 },
  { key: 'age456plus', label: '456 天以上', from: 456, to: null },
]
export const AGE_BUCKETS_COARSE: readonly AgeBucketDef[] = [
  { key: 'age0to90', label: '0-90 天', from: 0, to: 90 },
  { key: 'age91to180', label: '91-180 天', from: 91, to: 180 },
  { key: 'age181to270', label: '181-270 天', from: 181, to: 270 },
  { key: 'age271to365', label: '271-365 天', from: 271, to: 365 },
  { key: 'age365plus', label: '365 天以上', from: 366, to: null },
]

// ---- 判定结果 ----

export type InventoryRiskReason = 'NO_POLICY' | 'NO_QUANTITY' | 'NO_DEMAND_DATA'
export const INVENTORY_RISK_REASON_LABEL: Record<InventoryRiskReason, string> = {
  NO_POLICY: '尚未配置库存规则',
  NO_QUANTITY: '尚无库存数量',
  NO_DEMAND_DATA: '没有销量记录，无法计算可售天数',
}

export interface InventoryAssessment {
  state: DashState
  reason: InventoryRiskReason | null
  risk: InventoryRiskLevel | null
  /** 可售天数 =（可售 + 计入的在途）÷ 预测日销（中）；预测日销为 0 时为 null 并标 noDemand。 */
  daysOfCover: number | null
  noDemand: boolean
  /** 预计断货日 = 今天 + 可售天数（企业时区日历日）。 */
  stockoutDate: string | null
  fastestLeadDays: number | null
  fastestReplenishDate: string | null
  targetDays: number | null
  policyVersion: number | null
}

export const DEMAND_METHOD = 'inventory-demand@1'
export interface InventoryDemand {
  source: 'ORDERS' | 'AMAZON_REPORT' | null
  /** 预测日销（件/天）：低 = 7/30/90 天日均的最小值，中 = 近 30 天日均，高 = 最大值；剔除已知断货日。 */
  low: number | null
  mid: number | null
  high: number | null
  units7: number | null
  units30: number | null
  units60: number | null
  units90: number | null
  stockoutDaysExcluded: number
  /** 订单汇总里该 ASIN 最早销量记录到昨天的天数（报告来源为 null）：补货计算用它判断四个时段的日均能否算波动、趋势能否用。 */
  historyDays: number | null
  method: typeof DEMAND_METHOD
}

export type InventoryAction = 'REPLENISH_URGENT' | 'REPLENISH' | 'FIX_STRANDED' | 'CLEAR_AGED' | 'REDUCE_EXCESS' | 'CHECK_UNSELLABLE'
export const INVENTORY_ACTION_LABEL: Record<InventoryAction, string> = {
  REPLENISH_URGENT: '立即补货',
  REPLENISH: '安排补货',
  FIX_STRANDED: '处理滞留商品',
  CLEAR_AGED: '清理高龄库存',
  REDUCE_EXCESS: '降价或移除冗余库存',
  CHECK_UNSELLABLE: '核对不可售库存',
}

export interface InventoryRow {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sku: string
  fnsku: string | null
  title: string | null
  brand: string | null
  quantity: {
    sellable: number
    reserved: number
    reservedCustomerOrder: number | null
    reservedProcessing: number | null
    reservedTransfer: number | null
    inboundWorking: number
    inboundShipped: number
    inboundReceiving: number
    inboundTotal: number
    inboundCounted: number
    /** 可用库存（P6-31）：按企业业务口径里勾选的组成项相加；列表接口才给。 */
    available?: number | null
    unsellable: number
    researching: number
    strandedQty: number | null
  }
  demand: InventoryDemand
  assessment: InventoryAssessment
  cover: {
    amazonDaysOfSupply: number | null
    amazonShortTermDays: number | null
    amazonLongTermDays: number | null
    weeksOfCover: { t7: number | null; t30: number | null; t60: number | null; t90: number | null }
    sellThrough: number | null
  }
  age: {
    granularity: 'FINE' | 'COARSE' | null
    buckets: Array<{ key: string; label: string; qty: number | null }>
    snapshotDate: string | null
    surchargeEstimate: number | null
    atRisk: boolean | null
  }
  fees: {
    nextMonthStorage: number | null
    ageSurchargeBands: Array<{ label: string; amount: number | null }>
    longTerm6Month: number | null
    longTerm12Month: number | null
    lowInventoryLevelApplied: string | null
    lowInventoryLevelFee: number | null
    amazonMinimumLevel: number | null
    lowFeeAtRisk: boolean | null
  }
  seasonality: string | null
  status: { amazonHealth: string | null; strandedReason: string | null }
  advice: {
    ourAction: InventoryAction | null
    amazonAction: string | null
    amazonSalePrice: number | null
    amazonSaleDays: number | null
    amazonRemovalQty: number | null
    amazonSavings: number | null
    amazonShipInQty: number | null
    amazonShipInDate: string | null
  }
  dates: { quantityUpdatedAt: string | null; planningDate: string | null }
}

export interface InventoryFreshness {
  lastSuccessAt: string | null
  sources: string[]
  qualityIssues: number
}

export interface InventoryListResponse {
  items: InventoryRow[]
  page: number
  pageSize: number
  total: number
  tab: InventoryTab
  /** 决定风险筛选能否用：没有策略时低库存、冗余页签只含亚马逊低库存水平费风险或为空，并提示原因。 */
  policyState: 'OK' | 'NOT_CONNECTED'
  policyNote: string | null
  /** 范围内 SKU 超过读取上限时为 true（页面提示缩小范围）。 */
  truncated: boolean
  freshness: InventoryFreshness
  /** 可用库存的口径说明与版本（P6-31）：问号里显示。 */
  availableInventory?: MetricVersionRef & { text: string }
}

export interface InventoryCard {
  state: DashState
  value: number | null
  note: string | null
}

export interface InventorySummaryResponse {
  policyState: 'OK' | 'NOT_CONNECTED'
  policyNote: string | null
  policyVersion: number | null
  skuCount: number
  truncated: boolean
  cards: {
    sellableTotal: InventoryCard
    inboundTotal: InventoryCard
    unsellableTotal: InventoryCard
    lowSkuCount: InventoryCard
    excessSkuCount: InventoryCard
    nextMonthStorageFee: InventoryCard
    ageSurchargeEstimate: InventoryCard
    lowFeeRiskSkuCount: InventoryCard
  }
  charts: {
    structure: Array<{ storeId: string; storeName: string; sellable: number; reserved: number; inbound: number; unsellable: number; researching: number }>
    ageDistribution: { granularity: 'FINE' | 'COARSE' | null; buckets: Array<{ key: string; label: string; qty: number }> }
    coverDistribution: Array<{ key: string; label: string; count: number }>
    feeTrend: { currency: 'USD'; months: Array<{ month: string; storage: number; overage: number; longTerm: number }>; projectedNextMonth: number | null }
  }
  freshness: InventoryFreshness
}
