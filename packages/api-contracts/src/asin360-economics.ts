import type { EconomicsCompareRow, EconomicsCompareSummary, EconomicsPreviewResponse, EconomicsRange } from './economics.js'
import type { InventoryFreshness } from './inventory.js'
import type { BridgeKey, ProfitBasis } from './profit.js'
import type { ProfitBridgeView, ProfitItemState, ProfitRange, ProfitTrendPoint } from './profit-view.js'
import type { CostDetailResponse } from './costs.js'
import type { OpportunityRule } from './receiving.js'
import type { ReturnBucket, ReturnDispositionGroup, ReturnDispositionView, ReturnReasonRow, ReturnTrendPoint } from './returns.js'

// ASIN 360 的“利润与成本”与“退货”两个页签（P2b-17，05 章 5.2 第 5、6 个页签；freeze/api.md `/products/:id/economics*`、`/products/:id/returns`）。
// 本文件只放常量、纯函数与类型（没有 zod）。数据口径沿用利润分析（P2b-10）、官方经济数据对账（P2b-11）与退货页（P2b-02），这里只是把“一个商品”的那一份取出来。

/** 利润与成本页签需要的权限：商品读 + 利润页读 + 利润字段（缺成本字段权限时成本类项目显示“无权限”）。 */
export const ASIN360_ECONOMICS_PERMISSIONS = ['products.read', 'profit.read', 'field.profit'] as const
/** 成本版本时间线需要的权限。 */
export const ASIN360_COST_PERMISSIONS = ['costs.read', 'field.cost'] as const
/** 退货页签关联赔付（机会与案件）需要的权限；没有这个权限只是不显示赔付，不影响退货数据。 */
export const ASIN360_REIMBURSEMENT_PERMISSION = 'reimbursements.read'

/** 与“退货”直接相关的赔付规则：退款后没收到退货、退货被处置为损坏。 */
export const ASIN360_RETURN_RULES: readonly OpportunityRule[] = ['REFUND_NO_RETURN', 'RETURN_DISPOSITION']
export const ASIN360_RETURN_RECENT_LIMIT = 20
export const ASIN360_REIMBURSEMENT_LIMIT = 50
export const ASIN360_PREVIEW_LIMIT = 500

// ---- 单位经济 ----

/** 随售价的变化方式：PRICE 就是售价本身；PROPORTIONAL 按售价等比例变化（佣金、退款、促销）；FIXED 每件固定不变（其余费用与成本）。 */
export type Asin360PriceLink = 'PRICE' | 'PROPORTIONAL' | 'FIXED'

export interface Asin360UnitLine {
  key: BridgeKey
  label: string
  direction: 'INCOME' | 'COST'
  /** 每件金额（花费与收入都是正数）；没有数据、没有数据来源或没有权限时为 null，不是 0。 */
  perUnit: number | null
  state: ProfitItemState
  link: Asin360PriceLink
  /** 对每件净利润的带符号贡献（收入为正，花费为负）。 */
  contribution: number | null
}

export const ASIN360_PRICE_LINK: Readonly<Partial<Record<BridgeKey, Asin360PriceLink>>> = { REVENUE: 'PRICE', REFUNDS: 'PROPORTIONAL', COMMISSION: 'PROPORTIONAL', PROMOTION: 'PROPORTIONAL' }
export const asin360PriceLink = (key: BridgeKey): Asin360PriceLink => ASIN360_PRICE_LINK[key] ?? 'FIXED'

/**
 * 每件经济：state = OK 才能做价格模拟；NO_UNITS 范围内没有销量；INCOMPLETE 有销量但净利润整体算不出（缺成本），不拿部分数字冒充。
 * proportionalShare = 随售价等比例变化的各项（佣金、退款、促销）每件合计 ÷ 平均售价。
 */
export interface Asin360UnitEconomics {
  state: 'OK' | 'NO_UNITS' | 'INCOMPLETE'
  note: string | null
  units: number
  avgPrice: number | null
  netPerUnit: number | null
  proportionalShare: number | null
  lines: Asin360UnitLine[]
}

export interface Asin360EconomicsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  recognition: ProfitBasis
  basisLabel: string
  basisNote: string
  currency: string
  range: ProfitRange
  /** 这个商品（店铺 × SKU）在范围内的利润桥合计，口径与利润分析页一致；店铺级费用与账户级广告不含在内。 */
  bridge: ProfitBridgeView
  unit: Asin360UnitEconomics
  trend: ProfitTrendPoint[]
  /** 我方上架价（商品目录里的价格）；没有为 null。 */
  listPrice: number | null
  /** 与预期获胜价（推荐报价）对照：定价数据（P4-11 的定价同步器）上线前没有来源。 */
  winPrice: { state: 'NOT_CONNECTED'; note: string }
  /** 已计成本件数 ÷ 销售件数；需要 field.cost，没有权限或没有销量为 null。 */
  costCoverage: number | null
  notes: string[]
  freshness: InventoryFreshness
}

export const ASIN360_WIN_PRICE_NOTE = '推荐报价与预期获胜价来自定价数据（Product Pricing），在定价同步器（P4-11）上线后接入；在此之前无法判断目标价是否达到预期获胜价，也不会用别的数字代替。'

// ---- 价格模拟（纯函数，前端与测试共用）----

export interface PriceSimulation {
  price: number
  /** 模拟后的每件净利润。 */
  net: number
  /** 模拟后的净利率 = 每件净利润 ÷ 目标价。 */
  margin: number
  /** 与当前平均售价相比，每件净利润的变化。 */
  deltaNet: number
  /** 逐项每件金额（没有数据的项目仍为 null）。 */
  lines: Array<{ key: BridgeKey; label: string; perUnit: number | null }>
  /** 净利润为 0 的售价（保本价）；售价上调对利润没有帮助（比例项吃掉全部涨幅）时为 null。 */
  breakEvenPrice: number | null
}

const round2 = (value: number) => Math.round(value * 100) / 100
const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

/**
 * 按目标售价估算每件净利润：佣金、退款、促销按售价等比例变化，其余费用与成本每件固定（假设，页面原样说明）。
 * 只用“每件净利润、比例项占售价的份额”，所以不需要看到各项成本，缺成本字段权限的人同样能用；净利润算不出（缺成本）或没有销量时返回 null。
 */
export function simulatePrice(unit: Asin360UnitEconomics, targetPrice: number): PriceSimulation | null {
  if (unit.state !== 'OK' || unit.avgPrice === null || unit.netPerUnit === null || unit.proportionalShare === null) return null
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return null
  const keep = 1 - unit.proportionalShare
  const deltaPrice = targetPrice - unit.avgPrice
  const deltaNet = deltaPrice * keep
  const net = round6(unit.netPerUnit + deltaNet)
  const scale = targetPrice / unit.avgPrice
  return {
    price: targetPrice,
    net,
    margin: round6(net / targetPrice),
    deltaNet: round6(deltaNet),
    lines: unit.lines.map(line => ({
      key: line.key,
      label: line.label,
      perUnit: line.perUnit === null ? null : line.link === 'PRICE' ? targetPrice : line.link === 'PROPORTIONAL' ? round6(line.perUnit * scale) : line.perUnit,
    })),
    breakEvenPrice: keep > 0.000001 ? round2(unit.avgPrice - unit.netPerUnit / keep) : null,
  }
}

// ---- 官方对照 ----

export interface Asin360OfficialResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  recognition: ProfitBasis
  basisLabel: string
  currency: string
  range: EconomicsRange
  summary: Omit<EconomicsCompareSummary, 'ads'>
  /** 逐日对照（日期倒序，最多 90 天）。 */
  items: EconomicsCompareRow[]
  officialCoverage: { from: string; to: string } | null
  truncated: boolean
  notes: string[]
  freshness: InventoryFreshness
}

// ---- 成本版本时间线 ----

export interface Asin360CostsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  sku: string
  today: string
  row: CostDetailResponse['row']
  versions: CostDetailResponse['versions']
  versionsTruncated: boolean
  notes: string[]
}

// ---- 费用预览 ----

export type Asin360PreviewResponse = Omit<EconomicsPreviewResponse, 'pageInfo'>

// ---- 退货页签 ----

export interface Asin360ReturnDispositionRow {
  group: ReturnDispositionGroup
  label: string
  units: number
  share: number
}

export interface Asin360ReturnRecent {
  id: string
  returnDate: string
  amazonOrderId: string
  sku: string
  quantity: number
  reasonLabel: string | null
  disposition: ReturnDispositionView
}

export interface Asin360ReimbursementItem {
  id: string
  ruleCode: OpportunityRule
  ruleLabel: string
  status: string
  statusLabel: string
  estimatedAmount: number | null
  currency: string | null
  deadlineAt: string | null
  qty: number | null
  /** 已立案时的案件编号与状态。 */
  caseId: string | null
  caseNo: string | null
  caseStatusLabel: string | null
  receivedAmount: number | null
}

export interface Asin360ReturnsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  range: { from: string; to: string; defaulted: boolean }
  bucket: ReturnBucket
  /** 退货按店铺 × ASIN 统计（同一 ASIN 的多个 SKU 合在一起，与销售汇总口径一致）。 */
  totals: { returnedUnits: number; soldUnits: number | null; rate: number | null }
  trend: ReturnTrendPoint[]
  reasons: ReturnReasonRow[]
  dispositions: Asin360ReturnDispositionRow[]
  recent: Asin360ReturnRecent[]
  reimbursements: { state: 'OK' | 'NO_DATA' | 'RESTRICTED'; note: string | null; items: Asin360ReimbursementItem[] }
  /** 本 ASIN 所在类目的退货主题（客户反馈接口，P4-13 才有）。 */
  categoryThemes: { state: 'NOT_CONNECTED'; note: string }
  /** 趋势用的退货明细触到读取上限时为真。 */
  truncated: boolean
  basis: string
  freshness: InventoryFreshness
}

export const ASIN360_CATEGORY_THEMES_NOTE = '类目的退货主题来自亚马逊客户反馈接口（Customer Feedback API），在评价与反馈模块（P4-13）上线后接入；在此之前这里只有我方退货报告里的原因分布。'
