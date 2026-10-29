import type { InventoryCosting } from './profit.js'
import type { CursorPageInfo } from './query.js'

// 商品成本（P2b-14，05 章 5.9）的常量、标签与响应类型。纯类型与常量，不含 zod：请求校验在 costs-query.ts，纯函数在 costs-math.ts。
// 成本版本按 SKU 记录（采购没有店铺归属，所以版本在企业层面）。四项成本——采购单价、头程分摊、关税、其他成本——
// 为空表示“没有这一项”，不是 0。只有生效（ACTIVE）的版本参与利润计价，草稿不参与；已替换的版本只留作历史。

export const COSTS_READ = 'costs.read'
export const COSTS_WRITE = 'costs.write'

export const COST_SOURCES = ['PURCHASE_RECEIPT', 'FIRST_MILE_ALLOCATION', 'MANUAL', 'FILE_IMPORT'] as const
export type CostSource = (typeof COST_SOURCES)[number]
export const COST_SOURCE_LABEL: Readonly<Record<CostSource, string>> = { PURCHASE_RECEIPT: '采购收货', FIRST_MILE_ALLOCATION: '头程分摊', MANUAL: '手工录入', FILE_IMPORT: '文件导入' }

export const COST_STATUSES = ['DRAFT', 'ACTIVE', 'REPLACED'] as const
export type CostStatus = (typeof COST_STATUSES)[number]
export const COST_STATUS_LABEL: Readonly<Record<CostStatus, string>> = { DRAFT: '草稿', ACTIVE: '生效中', REPLACED: '已替换' }

/** 四项成本；顺序即页面与到岸成本合计的顺序。 */
export const COST_COMPONENTS = ['product', 'firstMile', 'duty', 'other'] as const
export type CostComponent = (typeof COST_COMPONENTS)[number]
export const COST_COMPONENT_LABEL: Readonly<Record<CostComponent, string>> = { product: '采购单价', firstMile: '头程分摊', duty: '关税', other: '其他成本' }
/** 成本项对应的数据库列。 */
export const COST_COMPONENT_COLUMN = { product: 'unitProductCost', firstMile: 'unitFirstMileCost', duty: 'unitDutyCost', other: 'unitOtherCost' } as const

/** 成本覆盖状态：有生效的采购单价且不过期、过期（最新生效版本距今超过 COST_STALE_DAYS 天）、只有草稿、没有。 */
export const COST_COVERAGES = ['COVERED', 'STALE', 'DRAFT_ONLY', 'MISSING'] as const
export type CostCoverage = (typeof COST_COVERAGES)[number]
export const COST_COVERAGE_LABEL: Readonly<Record<CostCoverage, string>> = { COVERED: '已覆盖', STALE: '成本过期', DRAFT_ONLY: '只有草稿', MISSING: '缺成本' }
export const COST_COVERAGE_HINT: Readonly<Record<CostCoverage, string>> = {
  COVERED: '有生效的采购单价，利润按它计价',
  STALE: '有生效的采购单价，但最新一条生效已超过半年，请确认价格是否仍然适用',
  DRAFT_ONLY: '只有待确认的草稿，没有生效的采购单价：草稿不参与利润计算，请到详情里确认生效',
  MISSING: '没有任何成本版本：利润里这个 SKU 的净利润不给数',
}

export const COST_NOTE_MAX = 300
export const COST_SKU_MAX = 120
/** 一次导入最多多少行；一次批量生效最多多少个版本。 */
export const COST_IMPORT_MAX_ROWS = 500
export const COST_ACTIVATE_MAX = 100
export const COST_IMPORT_MAX_BYTES = 200_000
/** 列表一次最多汇总多少个 SKU 与版本分组（Prisma 单次读取上限 20000，判断截断要多读一个）。 */
export const COST_LIST_LIMIT = 19_999
/** 详情时间线最多列多少个版本。 */
export const COST_TIMELINE_LIMIT = 200
/** 生效日期最多可以晚于今天多少天（给下一次涨价预先登记）。 */
export const COST_FUTURE_DAYS = 365

/** 导入文件的列（中英文表头都认；SKU、生效日期、币种必填，四项成本至少一项）。第一个别名是页面上展示的名字。 */
export const COST_IMPORT_COLUMNS = {
  sku: ['SKU', 'sku', '商家编码', 'seller-sku', 'seller sku'],
  effectiveFrom: ['生效日期', 'effective-from', 'effective from', 'effectivefrom', 'date', '日期'],
  currency: ['币种', 'currency'],
  product: ['采购单价', '单价', 'unit-cost', 'unit cost', 'unitcost', 'product-cost', 'unitproductcost'],
  firstMile: ['头程分摊', '头程', 'first-mile', 'first mile', 'unitfirstmilecost'],
  duty: ['关税', 'duty', 'unitdutycost'],
  other: ['其他成本', '附加成本', 'other', 'other-cost', 'unitothercost'],
  note: ['备注', 'note', 'notes'],
} as const

/** 单项成本：金额是小数文本（不丢精度），币种是版本的币种，usd 是按最近汇率折合的美元（没有汇率为 null）。 */
export interface CostPart {
  amount: string
  currency: string
  usd: number | null
  versionId: string
  versionNo: number
  effectiveFrom: string
  source: CostSource
}

export type CostParts = Record<CostComponent, CostPart | null>

/** 到岸成本合计的状态：OK；NO_PRODUCT 没有采购单价（合计不完整，不给）；NO_FX 有一项缺汇率；NO_DATA 没有任何生效成本。 */
export type CostLandedState = 'OK' | 'NO_PRODUCT' | 'NO_FX' | 'NO_DATA'

export interface CostRow {
  sku: string
  title: string | null
  asin: string | null
  parts: CostParts
  /** 到岸成本合计（美元）：采购 + 头程 + 关税 + 其他，各项折合美元后相加；不完整时为 null。 */
  landedUsd: number | null
  landedState: CostLandedState
  coverage: CostCoverage
  /** 最新生效的采购单价的生效日（用来判断过期）。 */
  productEffectiveFrom: string | null
  activeCount: number
  draftCount: number
  /** 这个 SKU 最近一次成本版本变动（创建、生效、替换）的时间。 */
  lastChangedAt: string | null
}

export interface CostListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  today: string
  items: CostRow[]
  pageInfo: CursorPageInfo
  /** 各覆盖状态的 SKU 个数（不受筛选影响，范围内全部 SKU）。 */
  summary: Record<CostCoverage, number>
  /** 有待确认的草稿的 SKU 个数。 */
  draftSkus: number
  /** SKU 或版本太多，只汇总了前面一部分。 */
  truncated: boolean
  /** 当前账号能不能录入、导入、确认生效（需要 costs.write 与“全部店铺”范围）。 */
  canWrite: boolean
}

/** 版本时间线上的一条。成本字段是小数文本；没有这一项为 null。 */
export interface CostVersionView {
  id: string
  /** 乐观锁版本号：改草稿、确认生效、丢弃都要带上它。 */
  version: number
  versionNo: number
  status: CostStatus
  statusLabel: string
  source: CostSource
  sourceLabel: string
  /** 来源单据：采购单号或头程运单号；文件导入是“批次:行号”，手工录入没有。 */
  sourceDocId: string | null
  sourceDocNo: string | null
  effectiveFrom: string
  currency: string
  product: string | null
  firstMile: string | null
  duty: string | null
  other: string | null
  /** 入库批次的件数（采购收货取已收数量、头程分摊取分摊件数）；手工与导入没有数量，按价格版本处理。 */
  quantity: number | null
  note: string | null
  createdByName: string | null
  createdAt: string
  activatedByName: string | null
  activatedAt: string | null
  replacedByVersionNo: number | null
  replacedAt: string | null
  /** 生效中的价格版本被入库批次压过：同一成本项只要有入库批次，价格版本就不参与计价。 */
  ignoredComponents: CostComponent[]
  /** 草稿：确认生效时会替换掉的版本号。 */
  willReplace: number[]
  /** 草稿：现在不能确认生效的原因（落在已关账期间、与已生效版本冲突）；可以生效为 null。 */
  blockedReason: string | null
  /** 草稿能改什么：用户录入的草稿可改全部，系统生成的草稿（采购收货、头程分摊）只能改关税、其他成本、生效日与备注。 */
  editable: 'ALL' | 'LIMITED' | null
  canDiscard: boolean
}

export interface CostCompositionSlice {
  component: CostComponent
  label: string
  usd: number
}

/** 成本构成：当前各项折合美元；缺汇率的项目不画并说明。 */
export interface CostComposition {
  slices: CostCompositionSlice[]
  totalUsd: number | null
  note: string | null
}

export interface CostFxInfo {
  currency: string
  /** 1 美元折合多少该币种；没有为 null。 */
  rate: number | null
  rateDate: string | null
  carriedForward: boolean
}

/** 每个成本项的计价依据：有入库批次按批次，只有价格版本按价格版本，没有为 null。 */
export type CostPricingBasis = Record<CostComponent, 'BATCH' | 'PRICE' | null>

export type CostValuationState = 'OK' | 'NO_COST' | 'NO_STOCK_DATA'

export interface CostValuation {
  state: CostValuationState
  method: InventoryCosting
  methodLabel: string
  /** 企业设置的计价方法不合法时按默认的先进先出算。 */
  methodValid: boolean
  /** 数量取各店铺最近一次库存规划报告里的可售数量之和。 */
  onHandUnits: number | null
  /** 估算的库存成本（美元）；没有采购成本或没有库存数据为 null。 */
  valueUsd: number | null
  /** 没有成本可用的件数（入库批次的件数少于库存）。 */
  uncoveredUnits: number
  avgUnitUsd: number | null
  note: string
}

export interface CostDetailResponse {
  sku: string
  title: string | null
  asin: string | null
  today: string
  row: CostRow
  versions: CostVersionView[]
  versionsTruncated: boolean
  composition: CostComposition
  pricing: CostPricingBasis
  valuation: CostValuation
  fx: CostFxInfo[]
  canWrite: boolean
  /** 页面要原样显示的口径说明。 */
  notes: string[]
}

export interface CostCompareRow {
  component: CostComponent
  label: string
  a: string | null
  b: string | null
  /** 币种相同才给差额（b 减 a）与百分比；币种不同只给折合美元的差额（两边都有汇率时）。 */
  delta: number | null
  deltaPct: number | null
  usdDelta: number | null
}

export interface CostCompareResponse {
  sku: string
  a: CostVersionView
  b: CostVersionView
  rows: CostCompareRow[]
  sameCurrency: boolean
  effectiveDays: number
}

export interface CostWriteResult {
  id: string
  version: number
  versionNo: number
  status: CostStatus
  message: string
}

export interface CostActivateResult {
  activated: number
  replaced: number
  versions: Array<{ id: string; sku: string; versionNo: number; replacedVersionNos: number[] }>
  message: string
}

export interface CostImportResult {
  batchId: string
  imported: number
  skus: number
  fileName: string
  message: string
}
