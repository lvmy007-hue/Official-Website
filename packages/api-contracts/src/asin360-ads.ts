import type { AdsEntityMetrics, AdsSearchTermRow, AdsTargetRow } from './ads-campaigns-tabs.js'
import type { AdsAsinStock } from './ads-products.js'
import type { AdsRatios, AdsTotals } from './ads-overview-math.js'
import type { DashState } from './dashboard.js'

// ASIN 360“广告”页签（P3-19，05 章 5.2 第 3 个页签；freeze/api.md `GET /products/:id/ads`）。
// 本文件只放常量与类型（没有 zod，前端首屏引用不会带上校验代码）。数据口径沿用广告商品页（P3-09）与活动、广告组页（P3-07、P3-08），
// 这里只是把“一个商品（店铺 × ASIN）”的那一份取出来：同一个 ASIN 的多个 SKU 合在一起，与销售汇总、广告商品页一致。

/** 活动、广告组、投放对象、搜索词各块最多列出多少行（按花费从高到低），超过标记截断。 */
export const ASIN360_ADS_ROW_LIMIT = 50
/** 读取各块时的上限：先多读再按花费排序后截取，超过上限的标记截断。 */
export const ASIN360_ADS_READ_LIMIT = 500

export const ASIN360_ADS_UNBOUND_NOTE = '这个商品所在的店铺还没有绑定广告账户，没有广告数据可显示；请在连接中心把广告账户绑定到这个店铺'
export const ASIN360_ADS_NEVER_NOTE = '被推广商品日报表还没有同步（需要广告报表的“被推广商品”报告），暂无法按 ASIN 汇总广告；连接广告账户并同步报表后才会出现'
export const ASIN360_ADS_EMPTY_NOTE = '所选日期范围内这个 ASIN 没有被推广商品的报表行；没有记录不代表没有投放，可能是报表尚未覆盖这段日期'
export const ASIN360_ADS_OTHER_CURRENCY_NOTE = '指标只含美元广告账户；非美元的被推广商品行没有并入（不折算）'
/** 广告组、投放对象与搜索词的口径：这些对象的指标是对象自己的合计，不会按 ASIN 拆分。 */
export const ASIN360_ADS_SHARED_NOTE =
  '广告活动一行的数字是这个 ASIN 自己的（来自被推广商品日报表）。广告组、投放对象与搜索词的数字是它们各自的合计，亚马逊没有按 ASIN 拆开；同一个广告组里还推广别的商品时，这些数字包含它们，请参考“广告组内商品数”。'
export const ASIN360_ADS_BRAND_NOTE = '品牌分析的搜索词份额（份额高但尚未投放的词）来自品牌分析报告，在品牌分析模块（P4-04）上线后接入；在此之前不显示这份清单。'
export const ASIN360_ADS_BASIS =
  '花费、广告销售额、订单来自被推广商品日报表（只含美元）；广告占总销售比 = 广告花费 ÷ 该 ASIN 的全部销售额（订单口径）；自然销售额 = 全部销售额 − 广告销售额，' +
  '两个口径的统计时点不同（广告按归因窗口、订单按下单日），所以只是估算，广告销售额大于全部销售额时不给自然销售额。没有记录的日子留空，不当 0。'

export interface Asin360AdsBlock<T> {
  state: DashState
  note: string | null
  items: T[]
  /** 读取或展示超过上限，只列了花费最高的一部分。 */
  truncated: boolean
}

export interface Asin360AdsSummary {
  /** 范围内合计（被推广商品日报表，美元）；花费与销售额来源没给时为 null。 */
  totals: AdsTotals
  ratios: AdsRatios
  /** 这个 ASIN 的全部销售额（ASIN 日汇总，美元）；没有汇总行为 null。 */
  totalSales: number | null
  /** 广告花费 ÷ 全部销售额；任一项缺失或全部销售额不为正为 null。 */
  adsShare: number | null
  organicSales: number | null
  organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL' | null
  /** 推广这个 ASIN 的活动数（范围内有被推广商品行的活动）。 */
  campaigns: number
  /** 广告表里这个 ASIN 的广告数（在投 = 状态 ENABLED）；广告表没有这个 ASIN 的行为 null。 */
  ads: { enabled: number; total: number } | null
}

/** 逐日一点：没有被推广商品行的日子，广告列全是 null（图上断开）；没有 ASIN 日汇总的日子，销售额与占比为 null。 */
export interface Asin360AdsDailyPoint {
  date: string
  impressions: number | null
  clicks: number | null
  spend: number | null
  sales: number | null
  orders: number | null
  totalSales: number | null
  acos: number | null
  adsShare: number | null
}

/** 光环销售（转化商品日报表里被推广商品与实际购买商品不同的销售额）：没有同步器时整块“尚未接入”，有同步器但这个 ASIN 没有转化行为 null。 */
export interface Asin360AdsHalo {
  state: 'OK' | 'NOT_CONNECTED'
  note: string | null
  sales: number | null
}

/** 库存与广告：断货仍在花钱是最直接的浪费线索。spend 是所选范围的合计花费，不是断货期间的花费。 */
export interface Asin360AdsStock {
  stock: AdsAsinStock
  sellable: number | null
  snapshotDate: string | null
  spend: number | null
}

export interface Asin360AdsCampaignRow {
  /** `档案编号|活动编号`，列表里的稳定键。 */
  key: string
  /** 系统编号（AdsCampaign.id），详情页地址用它；活动记录还没同步下来时为 null，不给链接。 */
  id: string | null
  adsProfileId: string
  externalCampaignId: string
  name: string | null
  state: string | null
  productLabel: string | null
  /** 这个 ASIN 在这个活动里的合计；活动里关联了这个 ASIN 的广告、但范围内没有被推广商品行时为 null。 */
  metrics: AdsEntityMetrics | null
}

export interface Asin360AdsAdGroupRow {
  /** 系统编号（AdsAdGroup.id），广告组详情页地址用它。 */
  id: string
  adsProfileId: string
  adGroupId: string
  name: string
  state: string
  defaultBid: number | null
  /** 所属活动（外部编号）与名称、系统编号（活动记录还没同步下来时名称与系统编号为 null）。 */
  externalCampaignId: string
  campaignName: string | null
  campaignId: string | null
  /** 这个广告组里关联这个 ASIN 的广告数（在投 = 状态 ENABLED）。 */
  asinAds: { enabled: number; total: number }
  /** 广告组里一共推广了几个不同的 ASIN（含本商品）；广告表没给 ASIN 的广告不计。大于 1 时下面的指标包含别的商品。 */
  groupAsins: number
  /** 广告组自己的合计（不是这个 ASIN 的）；没有指标行为 null。 */
  metrics: AdsEntityMetrics | null
}

export interface Asin360AdsTermBlock extends Asin360AdsBlock<AdsSearchTermRow> {
  /** 标记已投放与已否定的口径。 */
  matchBasis: string
}

export interface Asin360AdsResponse {
  /** OK 有这个 ASIN 的广告记录；NO_DATA 所选范围没有；NOT_CONNECTED 没有绑定广告账户或报表还没同步。 */
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  summary: Asin360AdsSummary
  trend: Asin360AdsDailyPoint[]
  halo: Asin360AdsHalo
  stock: Asin360AdsStock
  campaigns: Asin360AdsBlock<Asin360AdsCampaignRow>
  adGroups: Asin360AdsBlock<Asin360AdsAdGroupRow>
  targets: Asin360AdsBlock<AdsTargetRow>
  searchTerms: Asin360AdsTermBlock
  /** 品牌分析份额高但尚未投放的搜索词：恒为尚未接入（P4-04）。 */
  brandGaps: { state: 'NOT_CONNECTED'; note: string }
  sharedNote: string
  basis: string
}
