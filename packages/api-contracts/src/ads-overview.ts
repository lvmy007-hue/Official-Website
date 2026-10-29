import type { DashCompare, DashGranularity, DashPeriod, DashState, TrendEvent } from './dashboard'

// 广告控制台契约（P3-05，08 章 8.1）：只有常量与类型，没有 zod（请求参数校验在 ads-overview-query.ts）。
// 数据全部来自广告日汇总（AdsDailySummary，P3-04）与店铺经营日汇总（StoreDailySummary）：
//   - 花费、广告销售额、订单、点击、曝光：广告日汇总（范围内所有可见广告账户，只含美元，不折算币种）；
//   - 总销售额、自然销售额、广告占总销售比：店铺经营日汇总（只含已绑定店铺的广告）；
//   - 状态沿用经营控制台的四态：OK、NO_DATA（已接入但没有记录）、NOT_CONNECTED（同步器未交付）、RESTRICTED。
// 可空 = 来源没给，不是 0。

export const ADS_READ = 'ads.read'

export const ADS_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY', 'SPONSORED_TELEVISION'] as const
export type AdsProductKey = (typeof ADS_PRODUCTS)[number]
export const ADS_PRODUCT_LABEL: Record<AdsProductKey, string> = {
  SPONSORED_PRODUCTS: '商品推广',
  SPONSORED_BRANDS: '品牌推广',
  SPONSORED_DISPLAY: '展示型推广',
  SPONSORED_TELEVISION: '电视推广',
}
/** 目前有同步器写入指标的广告产品；其余类型即使控制台上有行也只会在真实数据出现时才显示，没有行时标“未接入”。 */
export const ADS_CONNECTED_PRODUCTS: readonly AdsProductKey[] = ['SPONSORED_PRODUCTS']
export const ADS_OTHER_PRODUCT_LABEL = '其他（未识别类型）'

/** 控制台口径的币种：店铺经营日汇总只有美元，广告也只汇总美元，其他币种单独列出、不折算。 */
export const ADS_CONSOLE_CURRENCY = 'USD'
/** 活动级读取上限：同一广告档案 × 广告产品 × 活动算一行，超过只处理花费最高的这些并提示。 */
export const ADS_CAMPAIGN_ROW_LIMIT = 5000
/** 四象限最多画多少个活动（按花费从高到低）。 */
export const ADS_QUADRANT_LIMIT = 100
/** 异常活动清单最多列出多少个。 */
export const ADS_ANOMALY_LIST_LIMIT = 20

/**
 * 异常活动规则（自定默认值，不是亚马逊口径）：
 *   NO_CONVERSION  花费不低于 MIN_SPEND 且点击不少于 MIN_CLICKS，但没有订单；
 *   ACOS_OVER_SALES  花费不低于 MIN_SPEND 且花费大于广告销售额（ACoS 超过 100%）。
 */
export const ADS_ANOMALY_RULES = { MIN_SPEND: 20, MIN_CLICKS: 20, ACOS_LIMIT: 1 } as const
export const ADS_ANOMALY_KINDS = ['NO_CONVERSION', 'ACOS_OVER_SALES'] as const
export type AdsAnomalyKind = (typeof ADS_ANOMALY_KINDS)[number]
export const ADS_ANOMALY_LABEL: Record<AdsAnomalyKind, string> = { NO_CONVERSION: '花费无转化', ACOS_OVER_SALES: '花费超过广告销售额' }

export const ADS_CARD_KEYS = ['spend', 'sales', 'acos', 'adsShare', 'roas', 'ctr', 'cpc', 'cvr', 'budgetUtilization', 'anomalies', 'organicSales', 'haloSales'] as const
export type AdsCardKey = (typeof ADS_CARD_KEYS)[number]
export const ADS_CARD_LABEL: Record<AdsCardKey, string> = {
  spend: '花费',
  sales: '广告销售额',
  acos: '广告成本销售比',
  adsShare: '广告占总销售比',
  roas: '广告投入产出比',
  ctr: '点击率',
  cpc: '单次点击成本',
  cvr: '转化率',
  budgetUtilization: '预算利用率',
  anomalies: '异常活动数',
  organicSales: '自然销售额',
  haloSales: '光环销售额',
}
/** 数值往哪个方向变好（决定涨跌的颜色）。 */
export const ADS_CARD_GOOD_WHEN: Record<AdsCardKey, 'up' | 'down'> = {
  spend: 'up',
  sales: 'up',
  acos: 'down',
  adsShare: 'down',
  roas: 'up',
  ctr: 'up',
  cpc: 'down',
  cvr: 'up',
  budgetUtilization: 'up',
  anomalies: 'down',
  organicSales: 'up',
  haloSales: 'up',
}
export const ADS_CARD_DEFINITION: Record<AdsCardKey, { definition: string; formula?: string; source: string }> = {
  spend: { definition: '所选范围内可见广告账户的广告花费合计（只含美元）。', source: '广告日汇总' },
  sales: { definition: '广告归因的销售额合计（只含美元）。', source: '广告日汇总' },
  acos: { definition: '广告花费占广告销售额的比例；没有广告销售额时无法计算。', formula: 'ACoS = 花费 ÷ 广告销售额', source: '广告日汇总' },
  adsShare: { definition: '已绑定店铺的广告花费占店铺总销售额的比例（M-008）。', formula: '广告占总销售比 = 广告花费 ÷ 总销售额', source: '店铺经营日汇总' },
  roas: { definition: '每 1 美元广告花费带来的广告销售额。', formula: 'ROAS = 广告销售额 ÷ 花费', source: '广告日汇总' },
  ctr: { definition: '点击数占曝光数的比例。', formula: '点击率 = 点击 ÷ 曝光', source: '广告日汇总' },
  cpc: { definition: '平均每次点击的花费。', formula: '单次点击成本 = 花费 ÷ 点击', source: '广告日汇总' },
  cvr: { definition: '订单数占点击数的比例。', formula: '转化率 = 订单 ÷ 点击', source: '广告日汇总' },
  budgetUtilization: {
    definition: '带日预算的活动，花费占“当前日预算 × 活动在所选范围内的天数”的比例（估算：预算按当前值回看）。',
    formula: '预算利用率 = 花费 ÷ Σ（日预算 × 天数）',
    source: '活动管理接口的预算与广告日汇总',
  },
  anomalies: { definition: '花费无转化、花费超过广告销售额的活动数量（阈值见响应里的 rules，是自定默认值）。', source: '广告日汇总（活动级）' },
  organicSales: { definition: '店铺总销售额扣除广告归因销售额。', formula: '自然销售额 = 总销售额 − 广告销售额', source: '店铺经营日汇总' },
  haloSales: { definition: '品牌光环（买了广告商品之外的同品牌商品）带来的销售额。', source: '广告归因报告（尚未接入）' },
}

export interface AdsCard {
  key: AdsCardKey
  label: string
  state: DashState
  format: 'money' | 'percent' | 'number'
  value: number | null
  compareValue: number | null
  /** 金额与数量用比率（0.12 = +12%），百分比类指标用百分点差；没有可比数据为 null。 */
  change: number | null
  changeKind: 'ratio' | 'points'
  /** 本期逐日走势（缺失的日子为 null）；没有走势时为 null。 */
  trend: Array<number | null> | null
  note: string | null
}

/** 销售与花费趋势、总销售拆分的一个桶（日、周一、月初）。 */
export interface AdsTrendPoint {
  key: string
  spend: number | null
  sales: number | null
}
export interface AdsMixPoint {
  key: string
  totalSales: number | null
  adSales: number | null
  organicSales: number | null
  /** 已绑定店铺的广告花费（店铺经营日汇总） */
  adSpend: number | null
  /** 广告占总销售比：花费 ÷ 总销售额；总销售额为 0 或没有花费为 null */
  adsShare: number | null
}

export interface AdsProductRow {
  adProduct: string
  label: string
  /** OK 有数据；NO_DATA 已接入但所选范围没有记录；NOT_CONNECTED 同步器未交付 */
  state: DashState
  note: string | null
  spend: number | null
  sales: number | null
  orders: number
  /** 占全部花费的比例；没有花费合计为 null */
  spendShare: number | null
}

export interface AdsFunnel {
  impressions: number
  clicks: number
  orders: number
  /** 点击 ÷ 曝光 */
  clickRate: number | null
  /** 订单 ÷ 点击 */
  conversionRate: number | null
}

export interface AdsBudgetDay {
  date: string
  spend: number | null
}
export interface AdsBudgetSection {
  state: DashState
  note: string | null
  /** 逐日花费（所有美元广告） */
  days: AdsBudgetDay[]
  /** 带日预算的活动的当前日预算合计；没有为 null（估算，按当前值回看） */
  dailyBudgetTotal: number | null
  utilization: number | null
  budgetedCampaigns: number
  /** 平均超预算时长：需要活动管理接口的预算消耗数据，同步器未交付 */
  overBudget: { state: 'NOT_CONNECTED'; note: string }
}

export const ADS_QUADRANTS = ['STAR', 'WASTE', 'POTENTIAL', 'LOW'] as const
export type AdsQuadrant = (typeof ADS_QUADRANTS)[number]
export const ADS_QUADRANT_LABEL: Record<AdsQuadrant, string> = {
  STAR: '高花费低 ACoS（保持）',
  WASTE: '高花费高 ACoS（优先优化）',
  POTENTIAL: '低花费低 ACoS（可加预算）',
  LOW: '低花费高 ACoS（观察或停）',
}
export interface AdsQuadrantPoint {
  key: string
  adsProfileId: string
  adProduct: string
  campaignId: string
  name: string
  spend: number
  sales: number
  orders: number
  acos: number
  quadrant: AdsQuadrant
}
export interface AdsQuadrantSection {
  state: DashState
  note: string | null
  /** 分界线：平均每活动花费与范围整体 ACoS */
  spendLine: number | null
  acosLine: number | null
  points: AdsQuadrantPoint[]
  /** 因为没有广告销售额而没法画在图上的活动数 */
  withoutSales: number
}

export interface AdsAnomalyItem {
  key: string
  adsProfileId: string
  adProduct: string
  campaignId: string
  name: string
  kind: AdsAnomalyKind
  spend: number
  sales: number | null
  clicks: number
  orders: number
}
export interface AdsAnomalySection {
  state: DashState
  note: string | null
  count: number
  items: AdsAnomalyItem[]
  rules: typeof ADS_ANOMALY_RULES
}

export interface AdsAttributionFactor {
  key: string
  label: string
  before: number
  after: number
}
export interface AdsAttributionTree {
  title: string
  before: number
  after: number
  factors: AdsAttributionFactor[]
}
export interface AdsAttributionSection {
  state: DashState
  note: string | null
  spend: AdsAttributionTree | null
  sales: AdsAttributionTree | null
}

export interface AdsOverviewResponse {
  period: DashPeriod
  compare: DashCompare | null
  /** 没有显式选择时间范围时服务端使用默认范围（近 30 天、对比上一期） */
  defaulted: boolean
  currency: typeof ADS_CONSOLE_CURRENCY
  /** 整体状态：NOT_CONNECTED 说明可见范围内从来没有广告汇总记录；NO_DATA 说明所选范围内没有 */
  state: DashState
  note: string | null
  refreshedAt: string | null
  metricVersion: string | null
  /** 没有并入的其他币种（不折算） */
  otherCurrencies: Array<{ currency: string; spend: number | null }>
  /** 未绑定店铺的广告花费（只有“全部店铺”范围成员能看到；不计入广告占总销售比与自然销售额） */
  unboundSpend: number | null
  granularity: DashGranularity
  cards: AdsCard[]
  trend: { state: DashState; note: string | null; points: AdsTrendPoint[]; events: TrendEvent[] }
  mix: { state: DashState; note: string | null; points: AdsMixPoint[] }
  products: AdsProductRow[]
  funnel: { state: DashState; note: string | null; value: AdsFunnel | null }
  budget: AdsBudgetSection
  targetAcos: { state: 'NOT_CONNECTED'; note: string }
  quadrant: AdsQuadrantSection
  anomalies: AdsAnomalySection
  attribution: AdsAttributionSection
  /** 活动级读取是否被上限截断（只处理了花费最高的这些活动） */
  campaignsTruncated: boolean
}
