import { z } from 'zod'
import { pageListQuery } from './query.js'
import type { DashState } from './dashboard.js'
import { INBOUND_KINDS, policyBaseFields, refinePolicyBase, type InventoryRiskLevel } from './inventory.js'
import type { InventoryPolicy } from './inventory.js'
import type { AppliedOverride } from './replenishment-forecast.js'

// 补货建议契约（P2a-07，06 章 6.2；freeze/api.md 第八节“补货”）。
// 计算链 8 步全部由纯函数算出（apps/api/src/modules/replenishment），每一步都带公式与输入，页面逐步展开；没有数据的输入写“尚未接入”，不当 0。

export const REPLENISH_LEVELS = ['TENANT', 'CATEGORY', 'SKU'] as const
export type ReplenishLevel = (typeof REPLENISH_LEVELS)[number]
export const REPLENISH_LEVEL_LABEL: Record<ReplenishLevel, string> = { TENANT: '企业', CATEGORY: '品类', SKU: 'SKU' }

export const TRANSPORT_MODES = ['SEA', 'AIR', 'EXPRESS'] as const
export type TransportMode = (typeof TRANSPORT_MODES)[number]
export const TRANSPORT_LABEL: Record<TransportMode, string> = { SEA: '海运', AIR: '空运', EXPRESS: '快递' }
export const TRANSPORT_PREFERENCES = ['AUTO', ...TRANSPORT_MODES] as const
export type TransportPreference = (typeof TRANSPORT_PREFERENCES)[number]
export const TRANSPORT_PREFERENCE_LABEL: Record<TransportPreference, string> = { AUTO: '按总到仓成本与断货风险自动分配', ...TRANSPORT_LABEL }

/** 一种运输方式：头程时效（天）与每件到仓成本（美元，没有设定为 null，此时无法按成本比较）。 */
export interface TransportOption {
  mode: TransportMode
  transitDays: number
  unitCost: number | null
}

/** 补货策略的一个版本（企业、品类或 SKU 级；下级整行覆盖上级）。 */
export interface ReplenishPolicy extends Omit<InventoryPolicy, 'level'> {
  level: ReplenishLevel
  levelRef: string
  productionDays: number | null
  domesticDays: number | null
  receivingDays: number | null
  serviceLevel: number | null
  transportPreference: TransportPreference | null
  transportOptions: TransportOption[]
  casePackQty: number | null
  moq: number | null
  minOrderValue: number | null
  /** P6-09：是否把“必断货量”（用最快运输方式也补不上的缺口）计入建议量；默认不计入，属于策略版本，旧版本都是 false。 */
  includeUnavoidableShortage: boolean
}

const transportOptionSchema = z.object({
  mode: z.enum(TRANSPORT_MODES),
  transitDays: z.number().int().min(1).max(180),
  unitCost: z.number().min(0).max(100000).nullable(),
})

export const PolicyListQuerySchema = pageListQuery({
  sortable: ['levelRef', 'level'] as const,
  defaultSort: { field: 'level', dir: 'asc' },
  filters: { level: { type: 'enum', values: REPLENISH_LEVELS } },
  scope: false,
})
export type PolicyListQuery = z.infer<typeof PolicyListQuerySchema>

export const PolicyUpsertBodySchema = z
  .object({
    ...policyBaseFields,
    level: z.enum(REPLENISH_LEVELS),
    /** 企业级固定 ALL；品类级是商品类型（FbaProduct.productType）；SKU 级是卖家 SKU。 */
    levelRef: z.string().trim().min(1).max(120),
    inboundCounted: z.array(z.enum(INBOUND_KINDS)).max(3),
    productionDays: z.number().int().min(0).max(365),
    domesticDays: z.number().int().min(0).max(365),
    receivingDays: z.number().int().min(0).max(365),
    serviceLevel: z.number().min(0.5).max(0.9999),
    transportPreference: z.enum(TRANSPORT_PREFERENCES),
    transportOptions: z.array(transportOptionSchema).max(3),
    casePackQty: z.number().int().min(1).max(100000).nullable(),
    moq: z.number().int().min(1).max(10_000_000).nullable(),
    minOrderValue: z.number().min(0).max(100_000_000).nullable(),
    includeUnavoidableShortage: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    refinePolicyBase(value, ctx)
    if (value.level === 'TENANT' && value.levelRef !== 'ALL') ctx.addIssue({ code: 'custom', path: ['levelRef'], message: '企业级的对象固定为 ALL' })
    const modes = value.transportOptions.map(option => option.mode)
    if (new Set(modes).size !== modes.length) ctx.addIssue({ code: 'custom', path: ['transportOptions'], message: '运输方式不能重复' })
    if (value.transportPreference !== 'AUTO' && !modes.includes(value.transportPreference)) {
      ctx.addIssue({ code: 'custom', path: ['transportPreference'], message: '偏好的运输方式必须先在运输选项里设置时效' })
    }
  })
export type PolicyUpsertBody = z.infer<typeof PolicyUpsertBodySchema>

export interface PolicyListResponse {
  items: ReplenishPolicy[]
  page: number
  pageSize: number
  total: number
  /** 企业级当前生效版本（没有则 null，页面提示先配置企业级策略）。 */
  tenantCurrent: ReplenishPolicy | null
  /** 品类可选值（范围内商品的 productType，最多 200 个），供品类级策略选择。 */
  categories: string[]
}

// ---- 计算链 ----

export const CALC_STEP_KEYS = ['DEMAND', 'SUPPLY', 'LEAD_TIME', 'SAFETY', 'TARGET', 'QTY', 'TRANSPORT', 'TIMING'] as const
export type CalcStepKey = (typeof CALC_STEP_KEYS)[number]

export interface CalcStep {
  key: CalcStepKey
  title: string
  /** 一句话结果，例如“日销 10.0 件/天（区间 8.2–12.5）”。 */
  result: string
  formula: string
  details: Array<{ label: string; value: string }>
  notes: string[]
}

export type CalcState = 'OK' | 'NO_NEED' | 'NO_POLICY' | 'POLICY_INCOMPLETE' | 'NO_DEMAND' | 'NO_QUANTITY'
export const CALC_STATE_LABEL: Record<CalcState, string> = {
  OK: '已计算',
  NO_NEED: '无需补货',
  NO_POLICY: '尚未配置补货策略',
  POLICY_INCOMPLETE: '补货参数尚未配置（服务水平、提前期拆分）',
  NO_DEMAND: '没有销量记录，无法预测需求',
  NO_QUANTITY: '尚无库存数量',
}

export interface Shipment {
  mode: TransportMode | 'DEFAULT'
  qty: number
  orderDate: string
  shipDate: string | null
  arriveDate: string
  leadDays: number
  /** 到仓晚于预计断货日的天数（0 表示不断货）。 */
  lateDays: number
  unitCost: number | null
}

export interface ReplenishCalc {
  state: CalcState
  reason: string | null
  risk: InventoryRiskLevel | null
  daysOfCover: number | null
  stockoutDate: string | null
  /** 未按箱规与起订量取整的缺口、取整后的补货量、采购量；区间按预测日销低、高两档算。 */
  rawQty: number | null
  recommendedQty: number
  purchaseQty: number
  qtyLow: number | null
  qtyHigh: number | null
  orderDate: string | null
  shipDate: string | null
  arriveDate: string | null
  shipments: Shipment[]
  /** 按运输选项成本算出的总到仓成本（任一用到的方式没设成本则为 null）。 */
  landedCost: number | null
  confidence: number
  policyVersion: number | null
  policyLevel: ReplenishLevel | null
  /** 第 1 步调整后的中档日销（件/天）；模拟与结果回看用它，无法预测时为 null。 */
  dailyDemand: number | null
  /** 第 1 步是否叠加了订阅省预测（快照过期、不可售或缺少上月出货时为 false）。 */
  subscribeUsed: boolean
  /** P6-09 第 2 步拆开的供给：可售加上“计入且在主提前期内到仓”的在途（参与建议量计算）；计入但到仓晚于主提前期的在途（不参与）；没有算出建议时为 null。 */
  supplyInLeadTime: number | null
  supplyBeyondLeadTime: number | null
  /** 必断货量：用最快运输方式下单也来不及补上的缺口（件）；没有算出建议时为 null。 */
  unavoidableShortage: number | null
  /** 必断货量是否已计入建议量（策略开关“计入必断货量”，默认不计入）。 */
  unavoidableIncluded: boolean
  /** 第 1 步用到的人工预测规则（含因缺数据没生效的，写明原因）；没用到为空数组。 */
  appliedOverride: AppliedOverride[]
  steps: CalcStep[]
}

// ---- 批次与建议 ----

export const BATCH_STATUSES = ['COMPUTING', 'PENDING_REVIEW', 'CONFIRMED', 'DRAFTED', 'CLOSED'] as const
export type BatchStatus = (typeof BATCH_STATUSES)[number]
export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = { COMPUTING: '计算中', PENDING_REVIEW: '待审', CONFIRMED: '已确认', DRAFTED: '已生成草稿', CLOSED: '已结束' }

export const REPLENISH_ACTIONS = ['ADOPT', 'ADJUST', 'IGNORE', 'PURCHASE_DRAFT', 'INBOUND_DRAFT', 'AWD_DRAFT'] as const
export type ReplenishAction = (typeof REPLENISH_ACTIONS)[number]
export const REPLENISH_ACTION_LABEL: Record<ReplenishAction, string> = {
  ADOPT: '采纳',
  ADJUST: '调整',
  IGNORE: '忽略',
  PURCHASE_DRAFT: '生成采购单草稿',
  INBOUND_DRAFT: '生成入仓计划草稿',
  AWD_DRAFT: '生成上游仓储入库订单草稿',
}

export interface BatchSummary {
  id: string
  batchNo: string
  status: BatchStatus
  today: string
  computedAt: string
  computedBy: string
  skuTotal: number
  recommendedCount: number
  policyVersions: Array<{ level: ReplenishLevel; levelRef: string; versionNo: number }>
}

export interface RecomputeResponse {
  batch: BatchSummary
  snapshot: BatchSnapshot
}

export interface BatchSnapshot {
  method: string
  today: string
  storeIds: string[]
  /** 没产出建议的 SKU 按原因计数（没有策略、没有销量、无需补货等），不凭空补默认。 */
  skipped: Record<string, number>
  truncated: boolean
  subscribeSaveUsed: number
  /** P6-09：用到了人工预测规则的 SKU 数、存在必断货量的 SKU 数、其中必断货量已计入建议的 SKU 数（旧批次没有这三项）。 */
  overrideUsed?: number
  unavoidableSkus?: number
  unavoidableIncludedSkus?: number
  dataTimes: { inventoryUpdatedAt: string | null; ordersThrough: string | null; restockSnapshotDate: string | null }
}

export interface AmazonCompare {
  qty: number | null
  shipDate: string | null
  diffQty: number | null
  /** 双源核对：我方与亚马逊官方建议量的差异原因（按已知输入逐条解释）。 */
  diffReason: string | null
  snapshotDate: string | null
}

export interface RecommendationRow {
  id: string
  batchId: string
  sellerAccountId: string
  storeName: string
  sku: string
  asin: string
  title: string | null
  risk: InventoryRiskLevel | null
  recommendedQty: number
  purchaseQty: number
  orderDate: string
  shipDate: string | null
  arriveDate: string | null
  stockoutDate: string | null
  /** 建议发货日：有发货日取发货日，没有（没拆运输方式）取下单日；距今天数按企业时区的今天算，负数表示已逾期。 */
  suggestedShipDate: string
  shipInDays: number
  confidence: number
  shipments: Shipment[]
  /** P6-09 冻结在批次里的拆分供给与必断货量；旧批次（P6-09 之前计算）没有这些记录，对应字段为 null。 */
  supplyInLeadTime: number | null
  supplyBeyondLeadTime: number | null
  unavoidableShortage: number | null
  unavoidableIncluded: boolean | null
  appliedOverride: AppliedOverride[]
  capital: { state: DashState; amount: number | null; note: string | null }
  amazon: AmazonCompare
  steps: CalcStep[]
  actions: Array<{ action: ReplenishAction; finalQty: number | null; status: 'DONE' | 'PENDING_TARGET'; targetDocType: string | null; targetDocId: string | null; createdAt: string }>
}

/** 快捷筛选：本周需发货（建议发货日在今天起 7 天内）、已逾期（建议发货日早于今天）。 */
export const SHIP_DUE_FILTERS = ['WEEK', 'OVERDUE'] as const
export type ShipDueFilter = (typeof SHIP_DUE_FILTERS)[number]
export const SHIP_DUE_LABEL: Record<ShipDueFilter, string> = { WEEK: '本周需发货', OVERDUE: '已逾期' }
/** “本周”的含义：今天起连续 7 天（含今天）。 */
export const SHIP_DUE_WEEK_DAYS = 7

export const RecommendationQuerySchema = pageListQuery({
  sortable: ['risk', 'sku', 'recommendedQty', 'orderDate', 'arriveDate', 'shipDate'] as const,
  defaultSort: { field: 'risk', dir: 'asc' },
  filters: {
    batchId: { type: 'text', max: 64 },
    risk: { type: 'enum', values: ['HIGH', 'MEDIUM', 'NORMAL', 'EXCESS'] },
    due: { type: 'enum', values: SHIP_DUE_FILTERS },
  },
})
export type RecommendationQuery = z.infer<typeof RecommendationQuerySchema>

export interface RecommendationListResponse {
  batch: BatchSummary | null
  snapshot: BatchSnapshot | null
  items: RecommendationRow[]
  page: number
  pageSize: number
  total: number
}

export const BatchListQuerySchema = pageListQuery({ sortable: ['computedAt'] as const, defaultSort: { field: 'computedAt', dir: 'desc' }, scope: false })
export interface BatchListResponse {
  items: BatchSummary[]
  page: number
  pageSize: number
  total: number
}

/** 重算：范围收窄到店铺（不传则用户权限范围内全部店铺）。 */
export const RecomputeBodySchema = z
  .object({
    storeIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/))
      .max(100)
      .optional(),
  })
  .strict()
export type RecomputeBody = z.infer<typeof RecomputeBodySchema>

// ---- 动作 ----

const decisionItem = z.object({
  recommendationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  action: z.enum(['ADOPT', 'ADJUST', 'IGNORE']),
  qty: z.number().int().min(0).max(10_000_000).optional(),
  reason: z.string().trim().max(200).optional(),
})
export const DecisionBodySchema = z
  .object({ items: z.array(decisionItem).min(1).max(200) })
  .strict()
  .superRefine((value, ctx) => {
    value.items.forEach((item, index) => {
      if (item.action === 'ADJUST' && item.qty === undefined) ctx.addIssue({ code: 'custom', path: ['items', index, 'qty'], message: '调整必须填写调整后的数量' })
      if (item.action === 'IGNORE' && !item.reason) ctx.addIssue({ code: 'custom', path: ['items', index, 'reason'], message: '忽略请写明原因' })
    })
  })
export type DecisionBody = z.infer<typeof DecisionBodySchema>

export const ToDraftBodySchema = z
  .object({
    batchId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    items: z
      .array(z.object({ recommendationId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), qty: z.number().int().min(1).max(10_000_000).optional() }))
      .min(1)
      .max(200),
    /** 生成采购单草稿时必填：采购单挂在哪个供应商名下。 */
    supplierId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .optional(),
  })
  .strict()
export type ToDraftBody = z.infer<typeof ToDraftBodySchema>

export interface DraftResponse {
  /** DONE：已生成草稿；PENDING_TARGET：目标模块尚未上线，只登记了动作，没有单据。 */
  state: 'DONE' | 'PENDING_TARGET'
  note: string
  documents: Array<{ type: 'PURCHASE_ORDER' | 'AWD_ORDER'; id: string; number: string; lineCount: number }>
  actions: number
}

export interface DecisionResponse {
  updated: number
  batchStatus: BatchStatus
}
