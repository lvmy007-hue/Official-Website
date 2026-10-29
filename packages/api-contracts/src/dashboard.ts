import { z } from 'zod'

// 经营控制台契约（P2a-02，04 章 4.1）：接口参数、响应形状、视图模板与日报模板。
// 前后端共用；这里只放类型与常量，不含取数逻辑。
//
// 数据状态（每个区域、每张卡都带）：
//   OK            有数据；
//   NO_DATA       来源已接入，但所选范围内没有记录（显示“尚无记录”，不显示成 0 以外的任何推断）；
//   NOT_CONNECTED 来源的同步器还没有交付（显示“尚未接入”并写明由哪个阶段接入）；
//   RESTRICTED    缺少字段权限（例如净利润需要 field.profit）。
// 为空的列表示“没有数据”，不是 0；销售额、订单数这类已接入的业务指标，没有记录的日子才按 0 计。

export const DASH_GRANULARITIES = ['day', 'week', 'month'] as const
export type DashGranularity = (typeof DASH_GRANULARITIES)[number]
export const TREND_METRICS = ['sales', 'orders', 'units', 'profit', 'adsSpend'] as const
export type TrendMetric = (typeof TREND_METRICS)[number]
export const RANK_BY = ['sales', 'profit', 'margin', 'profitChange'] as const
export type RankBy = (typeof RANK_BY)[number]

export const TREND_METRIC_LABEL: Record<TrendMetric, string> = { sales: '销售额', orders: '订单数', units: '件数', profit: '净利润', adsSpend: '广告花费' }
export const RANK_BY_LABEL: Record<RankBy, string> = { sales: '销售额', profit: '净利润', margin: '利润率', profitChange: '利润变化' }
export const GRANULARITY_LABEL: Record<DashGranularity, string> = { day: '日', week: '周', month: '月' }

const businessDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD')
  .refine(value => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), '日期不存在')
export const TrendQuerySchema = z.object({ granularity: z.enum(DASH_GRANULARITIES).default('day'), metric: z.enum(TREND_METRICS).default('sales') })
export const AttributionQuerySchema = z.object({ date: businessDate, granularity: z.enum(DASH_GRANULARITIES).default('day') })
export const AsinRankQuerySchema = z.object({ rankBy: z.enum(RANK_BY).default('sales') })

export type DashState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'RESTRICTED'

export interface DashPeriod {
  from: string
  to: string
  days: number
}
export interface DashCompare extends DashPeriod {
  mode: 'previous' | 'yoy' | 'custom'
}

// ---- 7 个指标卡 ----
export const KPI_KEYS = ['sales', 'profit', 'margin', 'adsSpend', 'adsShare', 'stockRisk', 'anomalies'] as const
export type KpiKey = (typeof KPI_KEYS)[number]

export interface KpiCard {
  key: KpiKey
  label: string
  state: DashState
  format: 'money' | 'percent' | 'number'
  value: number | null
  compareValue: number | null
  /** 变化：金额与数量用比率（0.12 表示 +12%），百分比类指标用百分点差；没有可比数据为 null。 */
  change: number | null
  changeKind: 'ratio' | 'points'
  /** 本期逐日走势（缺失的日子为 null）；没有走势时为 null。 */
  trend: Array<number | null> | null
  /** 不是 OK 时的原因，或补充说明。 */
  note: string | null
  /** 下钻目标页（路由清单里的组件名）。 */
  drill: string
}

/** 目标达成进度的横幅（经营控制台第一行，04 章 4.1 第 2 项）。 */
export type KpiTargetBanner =
  | { state: 'NOT_CONNECTED'; note: string }
  | {
      state: 'OK'
      note: string | null
      metric: 'sales'
      periodStart: string
      periodEnd: string
      targetValue: number
      actualValue: number
      achievementRatio: number | null
      /** 按天均摊节奏算出的“到今天应完成比例”。 */
      expectedToDateRatio: number
      /** 范围内有多少店铺已设置目标 / 范围内店铺总数。 */
      storesCovered: number
      storesTotal: number
    }

export interface KpisResponse {
  period: DashPeriod
  compare: DashCompare | null
  /** 没有显式选择时间范围时，服务端使用默认范围（近 30 天、对比上一期）。 */
  defaulted: boolean
  currency: 'USD'
  metricVersion: string | null
  salesSource: string | null
  /** 汇总最近一次刷新时间（取范围内汇总行的最大值）；没有汇总行为 null。 */
  refreshedAt: string | null
  cards: KpiCard[]
  /** 净利润卡的“官方净收益对照”角标。 */
  officialProfit: { state: 'NOT_CONNECTED'; note: string }
  /** 目标达成进度（P2a-04 消费方之一）。只统计范围内已设置当月整店销售额目标的店铺；统一按线性节奏换算（更精细的节奏线在目标与预算页本身）。 */
  target: KpiTargetBanner
  anomalyBreakdown: { critical: number; warning: number; info: number }
}

// ---- 趋势 ----
export interface TrendPoint {
  /** 桶的起始日（日、周一、月初），YYYY-MM-DD */
  key: string
  value: number | null
}
export interface TrendEvent {
  date: string
  label: string
  kind: string
}
export interface TrendResponse {
  period: DashPeriod
  compare: DashCompare | null
  granularity: DashGranularity
  metric: TrendMetric
  state: DashState
  note: string | null
  unit: 'money' | 'number'
  points: TrendPoint[]
  /** 环比线（上一期，按位置对齐到本期的桶）；没有数据为 null。 */
  previous: TrendPoint[] | null
  /** 同比线（去年同期，按位置对齐）；没有数据为 null。 */
  yoy: TrendPoint[] | null
  /** 双轴的第二条线：主指标为销售额时叠加净利润；没有利润数据或没有权限为 null。 */
  profit: { state: DashState; note: string | null; points: TrendPoint[] | null }
  events: TrendEvent[]
}

// ---- 指标树归因 ----
export interface AttributionFactor {
  key: 'sessions' | 'conversion' | 'units' | 'unitPrice'
  label: string
  before: number
  after: number
}
export interface AttributionResponse {
  granularity: DashGranularity
  current: { from: string; to: string }
  previous: { from: string; to: string }
  state: DashState
  sales: { before: number; after: number }
  /** THREE_FACTOR：会话 × 转化率 × 件单价；TWO_FACTOR：会话数据缺失时退化为 件数 × 件单价 */
  mode: 'THREE_FACTOR' | 'TWO_FACTOR'
  factors: AttributionFactor[]
  unavailable: Array<{ key: string; label: string; reason: string }>
  profitBridge: { state: DashState; note: string }
}

// ---- 店铺对比、ASIN 排名 ----
export interface StoreCompareRow {
  storeId: string
  storeName: string
  sales: number
  compareSales: number | null
  salesChange: number | null
  profit: number | null
  margin: number | null
  adsShare: number | null
}
export interface StoreCompareResponse {
  period: DashPeriod
  compare: DashCompare | null
  rows: StoreCompareRow[]
  columns: { profit: DashState; ads: DashState; inventoryRisk: DashState; accountHealth: DashState }
  notes: { profit: string | null; ads: string | null; inventoryRisk: string; accountHealth: string }
}

export interface AsinRankRow {
  asin: string
  sku: string | null
  units: number
  sales: number
  profit: number | null
  margin: number | null
  /** 利润变化（本期利润 − 对比期利润）；没有对比期或没有利润为 null */
  profitChange: number | null
  salesChange: number | null
}
export interface AsinRankResponse {
  period: DashPeriod
  compare: DashCompare | null
  rankBy: RankBy
  state: DashState
  note: string | null
  top: AsinRankRow[]
  bottom: AsinRankRow[]
  /** 利润率、利润变化只在销售额靠前的候选 ASIN 内排名时说明候选数量 */
  candidateLimit: number | null
}

// ---- 波动异常（三期对比，P6-28；metrics.md 10.5）----
/** 三期：本期、上期、上上期，长度都等于所选范围，首尾相接；“连续恶化”= 销售额连续两期下降。 */
export interface VolatilityRow {
  asin: string
  sku: string | null
  /** 本期、上期、上上期销售额 */
  sales: number
  previousSales: number
  earlierSales: number
  /** 本期相对上期、上期相对上上期的变化比率（-0.2 表示下降 20%） */
  salesChange: number
  previousChange: number
  /** 两期累计下降金额（上上期 − 本期，为正） */
  totalDrop: number
}
export interface VolatilityResponse {
  period: DashPeriod
  previous: DashPeriod
  earlier: DashPeriod
  state: DashState
  note: string | null
  rows: VolatilityRow[]
  /** 只在上上期销售额靠前的这么多个 ASIN 内检查；没有限制为 null */
  candidateLimit: number | null
}

// ---- 暂未交付的区域（广告异常、库存风险）----
export interface PendingSection {
  state: 'NOT_CONNECTED'
  note: string
  /** 由哪个工作包接入 */
  workPackage: string
}

// ---- 增长归因瀑布 ----
export interface WaterfallItem {
  key: string
  label: string
  /** 对销售额变化的贡献；断货损失未接入时为 null */
  amount: number | null
  kind: 'store' | 'asin' | 'new' | 'stockout' | 'other' | 'unattributed'
  /** 模型估算项（断货损失）标注 */
  estimate?: boolean
  note?: string
}
export interface WaterfallResponse {
  period: DashPeriod
  compare: DashCompare | null
  state: DashState
  note: string | null
  base: number
  current: number
  total: number
  /** 按店铺拆解：各店铺变化之和 = 总变化 */
  byStore: WaterfallItem[]
  /** 按驱动因素拆解：贡献最大的 ASIN、新品、断货损失、其余、未归属 ASIN；已接入项之和 = 总变化 */
  byDriver: WaterfallItem[]
}

// ---- 现金视角 ----
export interface CashResponse {
  state: DashState
  note: string | null
  period: DashPeriod
  /** 本期入账交易里已释放的金额（美元） */
  released: number | null
  /** 递延中余额：每个店铺取最近一次余额快照（美元）；没有快照为 null */
  deferred: { amount: number; asOf: string } | null
  /** 下次预计打款日：取尚未到来的最早结算打款日；没有为 null（不推测） */
  nextPayoutDate: string | null
  nextPayoutNote: string
}

// ---- 视图模板（4 种）----
export const OVERVIEW_SECTIONS = ['kpis', 'trend', 'queue', 'storeCompare', 'asinRank', 'volatility', 'adAnomalies', 'inventoryRisk', 'waterfall', 'cash', 'sourceHealth'] as const
export type OverviewSection = (typeof OVERVIEW_SECTIONS)[number]
export const OVERVIEW_SECTION_LABEL: Record<OverviewSection, string> = {
  kpis: '指标卡',
  trend: '销售与利润趋势',
  queue: '待我处理',
  storeCompare: '店铺经营对比',
  asinRank: 'ASIN 利润排名',
  volatility: '波动异常',
  adAnomalies: '广告异常',
  inventoryRisk: '库存风险分布',
  waterfall: '增长归因瀑布',
  cash: '现金视角',
  sourceHealth: '数据源健康',
}

export const OVERVIEW_TEMPLATES = ['owner', 'operation', 'finance', 'supply'] as const
export type OverviewTemplate = (typeof OVERVIEW_TEMPLATES)[number]
export interface OverviewTemplateSpec {
  key: OverviewTemplate
  label: string
  /** 显示的区域，按此顺序 */
  sections: readonly OverviewSection[]
  /** 显示的指标卡，按此顺序 */
  cards: readonly KpiKey[]
}
const ALL_SECTIONS: readonly OverviewSection[] = ['kpis', 'trend', 'queue', 'storeCompare', 'asinRank', 'volatility', 'adAnomalies', 'inventoryRisk', 'waterfall', 'cash', 'sourceHealth']
export const OVERVIEW_TEMPLATE_SPECS: readonly OverviewTemplateSpec[] = [
  { key: 'owner', label: '经营者', sections: ALL_SECTIONS, cards: KPI_KEYS },
  {
    key: 'operation',
    label: '运营',
    sections: ['kpis', 'trend', 'queue', 'asinRank', 'volatility', 'adAnomalies', 'inventoryRisk', 'storeCompare', 'waterfall', 'sourceHealth'],
    cards: ['sales', 'adsSpend', 'adsShare', 'stockRisk', 'anomalies'],
  },
  { key: 'finance', label: '财务', sections: ['kpis', 'cash', 'trend', 'storeCompare', 'waterfall', 'queue', 'sourceHealth'], cards: ['sales', 'profit', 'margin', 'adsSpend', 'anomalies'] },
  { key: 'supply', label: '供应链', sections: ['kpis', 'inventoryRisk', 'queue', 'trend', 'asinRank', 'waterfall', 'sourceHealth'], cards: ['sales', 'stockRisk', 'anomalies'] },
]
export const overviewTemplateOf = (key: string | undefined): OverviewTemplateSpec => OVERVIEW_TEMPLATE_SPECS.find(spec => spec.key === key) ?? OVERVIEW_TEMPLATE_SPECS[0]!

/** 个人布局（保存在保存视图里）：在模板基础上隐藏的区域与指标卡；区域顺序跟随模板。 */
export const OVERVIEW_VIEW_PAGE_KEY = 'overview'
export const OVERVIEW_LAYOUT_VIEW_NAME = '我的布局'
export const OverviewLayoutSchema = z.object({
  template: z.enum(OVERVIEW_TEMPLATES),
  hiddenSections: z.array(z.enum(OVERVIEW_SECTIONS)).max(OVERVIEW_SECTIONS.length),
  hiddenCards: z.array(z.enum(KPI_KEYS)).max(KPI_KEYS.length),
})
export type OverviewLayout = z.infer<typeof OverviewLayoutSchema>

// ---- 经营日报模板（走导出任务）----
export const REPORT_TEMPLATES = ['daily', 'weekly', 'monthly'] as const
export type ReportTemplate = (typeof REPORT_TEMPLATES)[number]
export const REPORT_TEMPLATE_LABEL: Record<ReportTemplate, string> = { daily: '日报', weekly: '周报', monthly: '月报' }
export const REPORT_TEMPLATE_HINT: Record<ReportTemplate, string> = { daily: '所选截止日当天', weekly: '截止日往前 7 天（含截止日）', monthly: '截止日所在自然月（截至截止日）' }
export const OVERVIEW_REPORT_KIND = 'overview-report'

/** 日报模板对应的日期范围（含首尾）。 */
export function reportRange(template: ReportTemplate, endDate: string): { from: string; to: string } {
  const end = Date.parse(`${endDate}T00:00:00Z`)
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  if (template === 'daily') return { from: endDate, to: endDate }
  if (template === 'weekly') return { from: iso(end - 6 * 86_400_000), to: endDate }
  return { from: `${endDate.slice(0, 7)}-01`, to: endDate }
}
