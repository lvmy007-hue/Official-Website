import type { CostLayer } from './costing'

// 利润日表派生用到的数据形状（P2b-09）。

export interface DayRange {
  /** 企业时区的日历日，闭区间，YYYY-MM-DD。 */
  from: string
  to: string
}

/** 销售行：某店铺某 SKU 某天的件数与销售额（SQL 聚合）。sku 为空串表示订单行没有 SKU。 */
export interface SalesRow {
  sellerAccountId: string
  sku: string
  asin: string | null
  day: string
  currency: string
  units: number
  revenue: number
}

/**
 * 费用明细行（SQL 聚合）：某店铺某 SKU 某天某类某子类型某状态的金额合计。
 * mode：ORDER 按所属订单的确认日；POSTED 按入账日（退款、赔付、没有订单号的账户级明细、结算释放口径）；UNLINKED 有订单号但订单没同步，按入账日。
 */
export interface FeeRow {
  sellerAccountId: string
  sku: string
  asin: string | null
  day: string
  category: string
  subtype: string | null
  status: string | null
  currency: string
  mode: 'ORDER' | 'POSTED' | 'UNLINKED'
  amount: number
  lines: number
}

/** 某个 SKU 的四条成本流：采购成本、头程成本、其他成本、关税（P6-18），各自按入库批次或价格版本计价。 */
export interface SkuStreams {
  product: CostLayer[]
  firstMile: CostLayer[]
  other: CostLayer[]
  /** 关税：来自生效成本版本的单件关税；没有填写关税的 SKU 为空（不是 0）。 */
  duty?: CostLayer[]
}

export interface AdsInfo {
  /** 有广告花费记录的日期范围（含）；范围之外的日子是“不知道”而不是 0。 */
  first: string | null
  last: string | null
  byDay: Map<string, number>
  /** 有非美元的广告账户或花费没有计入。 */
  nonUsd: boolean
}

/** 广告商品报表归属：店铺 → 日 → 被推广 ASIN → 花费；以及店铺 → ASIN → 商品目录里的 SKU（P3-16）。 */
export interface AdsAttribution {
  direct: Map<string, Map<string, Map<string, number>>>
  asinSkus: Map<string, Map<string, string[]>>
}

export interface FxEntry {
  rate: number
  source: string
  carriedForward: boolean
}
/** 取某币种某天的汇率（1 美元折合多少该币种）；缺失返回 null。 */
export type FxLookup = (currency: string, day: string) => FxEntry | null
