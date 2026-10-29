import type { CursorPageInfo } from './query'
import type { DashState } from './dashboard'
import type { AdsCampaignRatios } from './ads-campaigns'
import type { AdsLevelSummary } from './ads-levels'
import type { AdsTotals } from './ads-overview-math'

// 广告商品契约（P3-09，08 章 8.6）：只有常量与类型，没有 zod（请求校验在 ads-products-query.ts，纯函数在 ads-products-math.ts）。
// 一行 = 一个店铺 × 一个 ASIN：把这个 ASIN 在所选范围内被推广过的全部活动合在一起看。
// 数据来源：被推广商品日报表（AdsAdvertisedProductMetric，只含美元）、ASIN 日汇总（该 ASIN 的全部销售额，店铺口径）、转化商品日报表（光环销售）、
// 广告表（在投广告数）、商品资料与最近一次库存快照。没有数据写“尚无记录”，同步器未交付写“尚未接入”，空值不是 0。
// 本包只读：按 ASIN 暂停与启用全部相关广告、复制到其他广告组的批量入口 P3-17 也没有提供（见 ADS_ASIN_WRITE_PENDING）。

/** 一次最多处理多少个“店铺 × ASIN”（按花费从高到低），超过标记截断。 */
export const ADS_ASIN_ROW_LIMIT = 3000
/** 读被推广商品日报表时最多读多少个“广告档案 × ASIN × 活动”分组（Prisma take 上限 20000，多读一行判断是否截断）。 */
export const ADS_ASIN_GROUP_LIMIT = 19_999
/** 列表默认回看天数（没有选择时间范围时），与活动列表一致。 */
export const ADS_ASIN_DEFAULT_DAYS = 30

export const ADS_ASIN_SORTS = ['spend', 'sales', 'orders', 'acos', 'roas', 'adsShare', 'organicSales', 'totalSales', 'campaigns', 'asin'] as const
export type AdsAsinSort = (typeof ADS_ASIN_SORTS)[number]
export const ADS_ASIN_STOCKS = ['OUT_OF_STOCK', 'IN_STOCK', 'UNKNOWN'] as const
export type AdsAsinStock = (typeof ADS_ASIN_STOCKS)[number]
export const ADS_ASIN_STOCK_LABEL: Record<AdsAsinStock, string> = { OUT_OF_STOCK: '断货', IN_STOCK: '有货', UNKNOWN: '库存未知' }

/** 广告账户没有绑定店铺：拿不到该店铺的总销售额、商品资料与库存。 */
export const ADS_ASIN_UNBOUND_NOTE = '这个广告账户还没有绑定店铺，没有总销售额、商品资料与库存可对照；请在连接中心绑定店铺'
/** 转化商品日报表里还没有任何行（P5-12A 起每天定时同步）：光环销售没有来源，写“尚无记录”，不是 0。 */
export const ADS_ASIN_HALO_NOTE = '光环销售来自“转化商品日报”（被推广商品与实际购买商品不同的销售额）；目前尚无记录——报表每天同步一次，可能还没同步到，或广告账户没有跨商品的购买'
/** 广告分摊（P3-16）已进入利润日表；本页暂不显示每行的广告后利润，指向利润分析的广告利润页签。 */
export const ADS_ASIN_PROFIT_NOTE = '广告分摊后的利润请到“利润分析 → 广告利润”页签查看；本页暂不显示每行的广告后利润'
/** 按 ASIN 的批量写入暂未提供入口。 */
export const ADS_ASIN_WRITE_PENDING = {
  state: 'NOT_CONNECTED' as const,
  note: '按 ASIN 暂停或启用全部相关广告、复制到其他广告组的批量入口暂未提供，请到广告活动或广告组页面逐个操作，或在亚马逊广告后台操作',
}

/** 自然销售额口径：ASIN 的全部销售额（按下单日、店铺口径）减去广告销售额（归因窗口内）；两个口径的统计时间不同，所以只是估算。 */
export const ADS_ASIN_ORGANIC_BASIS = '自然销售额 = 该 ASIN 的全部销售额（订单口径）− 广告销售额（广告归因口径）。两个口径统计时点不同，数字是估算；广告销售额大于全部销售额时不给自然销售额'

export interface AdsAsinRow {
  /** 店铺编号（未绑定店铺的广告账户为 '-'）加 ASIN，列表里的稳定键。 */
  key: string
  asin: string
  title: string | null
  imageUrl: string | null
  storeId: string | null
  storeName: string | null
  /** 范围内合计（被推广商品日报表，美元）；花费与销售额来源没给时为 null。 */
  totals: AdsTotals
  ratios: AdsCampaignRatios
  /** 该 ASIN 的全部销售额（ASIN 日汇总，美元）；没有汇总行或没有绑定店铺为 null。 */
  totalSales: number | null
  /** 广告花费 ÷ 该 ASIN 的全部销售额；任一项缺失或总销售额不为正为 null。 */
  adsShare: number | null
  organicSales: number | null
  /** 自然销售额没有给出的原因：广告销售额大于全部销售额（归因口径不同）。 */
  organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL' | null
  /** 光环销售额（转化商品日报表里购买了别的商品的销售额）；没有转化商品行为 null。 */
  haloSales: number | null
  /** 推广这个 ASIN 的活动数（范围内有被推广商品行的活动）。 */
  campaigns: number
  /** 广告表里这个 ASIN 的广告数（在投 = 状态 ENABLED）；广告表没有这个 ASIN 的行为 null。 */
  ads: { enabled: number; total: number } | null
  stock: AdsAsinStock
  sellable: number | null
  snapshotDate: string | null
}

export interface AdsAsinSummary {
  /** 过滤后的“店铺 × ASIN”个数。 */
  products: number
  spend: number | null
  sales: number | null
  /** 断货商品的个数与仍在花的钱（库存已知且可售为 0 才算；库存未知的不计）。 */
  outOfStock: { products: number; spend: number | null }
}

export interface AdsAsinListResponse {
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  items: AdsAsinRow[]
  pageInfo: CursorPageInfo
  range: { from: string; to: string; defaulted: boolean }
  currency: 'USD'
  summary: AdsAsinSummary
  /** 汇总行（P6-23）：筛选后的全部“店铺 × ASIN”合计与比率。 */
  level: AdsLevelSummary
  /** 转化商品日报表是否有来源（没有任何行就是尚未接入，每行的光环销售恒为空）。 */
  halo: { state: 'OK' | 'NOT_CONNECTED'; note: string | null }
  profit: { state: 'NOT_CONNECTED'; note: string }
  organicBasis: string
  write: typeof ADS_ASIN_WRITE_PENDING
  /** “店铺 × ASIN”超过 ADS_ASIN_ROW_LIMIT，只处理了花费最高的一部分。 */
  truncated: boolean
  /** 报表分组超过读取上限，花费较低的商品可能缺失。 */
  metricsTruncated: boolean
}
