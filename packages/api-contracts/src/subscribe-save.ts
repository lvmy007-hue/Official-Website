import type { FreshnessViewStatus } from './freshness.js'
import type { InventoryFreshness } from './inventory.js'
import type { CursorPageInfo } from './query.js'

// 订阅省（P4-06，04 章 4.9，importers.md I-19）：亚马逊补货接口（Replenishment API v2022-11-07）的卖家指标、报价与报价指标，同步器在 P2a-07 已交付。
// 本文件放常量、标签、响应类型与一个纯函数（不含 zod，前端首屏会引用）；查询校验在 subscribe-save-query.ts。
// 本页只读：订阅省的报价与折扣在卖家后台设置，系统不写亚马逊。

export const SUBSCRIBE_SAVE_READ = 'analytics.read'
export const SNS_JOB_TYPE = 'FBA_REPLENISHMENT'
export const SNS_FRESHNESS_KEY = 'replenishment.api'
/** 接口没有授权（403）时同步任务使用的通用失败码，新鲜度状态为“未授权”。 */
export const SNS_ROLE_MISSING = 'ROLE_MISSING'
export const SNS_ROLE_GUIDE =
  '订阅省接口（亚马逊补货接口）需要为应用授权对应角色：在亚马逊开发者控制台的应用资料里勾选该接口文档所列的角色（Inventory and Order Tracking、Brand Analytics）并提交审核，审核通过后到连接中心重新授权店铺，数据会在下一次同步出现。'
export const SNS_NOT_APPLICABLE_NOTE = '范围内的店铺没有开通订阅省，或没有订阅省报价：这里不显示数字。开通订阅省后，数据会在下一次同步（约每 6 小时）出现。'

/** 报价快照超过这么多天不再被当作“预计订阅出货”：与补货计算第 1 步的规则相同（replenishment-math 的 SUBSCRIBE_MAX_AGE_DAYS 引用本常量）。 */
export const SNS_FORECAST_MAX_AGE_DAYS = 7
/** 同步器只拉最近 31 天的日级指标（官方上限），更早的日期没有记录。 */
export const SNS_DAY_RETENTION_DAYS = 31
/** 月度对照显示最近几个自然月（同步器拉近 6 个自然月）。 */
export const SNS_MONTHS_SHOWN = 6
/** 读取上限（日指标行与报价行都用）：Prisma 单次最多 20000 行，多读一行判断是否被截断。 */
export const SNS_READ_LIMIT = 19_999

export const SNS_BASIS =
  '来自亚马逊补货接口的订阅省数据：指标按天与按月同步（日级只有最近 31 天），报价与预计订阅出货是每次同步时的快照；金额按亚马逊给的币种分别显示，不同币种不相加；多个店铺时某天有的店铺没有记录，合计只含有记录的店铺；没有给的值显示“尚无记录”，不当 0。'
export const SNS_CANCEL_NOTE = '订阅取消数尚未接入：同步器目前只向亚马逊请求订阅出货件数、订阅销售额与活跃订阅数三项指标。官方是否提供取消指标需要对照真实响应核对，核对前不显示数字。'
export const SNS_REPLENISH_NOTE = '预计订阅出货件数是确定性需求：满足条件的报价已叠加进补货建议的第 1 步（需求预测），并从历史销量里扣除上月订阅部分以免重复计算。'

export const SNS_CARD_KEYS = ['activeSubscribers', 'shippedUnits', 'revenue', 'cancellations', 'forecast30', 'forecast60', 'forecast90', 'offers'] as const
export type SnsCardKey = (typeof SNS_CARD_KEYS)[number]
export const SNS_CARD_LABEL: Readonly<Record<SnsCardKey, string>> = {
  activeSubscribers: '活跃订阅数',
  shippedUnits: '订阅出货件数',
  revenue: '订阅销售额',
  cancellations: '订阅取消数',
  forecast30: '未来 30 天预计订阅出货件数',
  forecast60: '未来 60 天预计订阅出货件数',
  forecast90: '未来 90 天预计订阅出货件数',
  offers: '参与订阅省的报价',
}

/** OK 有数字；NO_DATA 尚无记录；NOT_CONNECTED 尚未接入；STALE 报价快照已过期，没有可用的预测。 */
export type SnsCardState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'STALE'
export const SNS_CARD_STATE_TEXT: Readonly<Record<Exclude<SnsCardState, 'OK'>, string>> = {
  NO_DATA: '尚无记录',
  NOT_CONNECTED: '尚未接入',
  STALE: '数据已过期',
}

export interface SnsMoney {
  currency: string
  amount: number
}

export interface SnsCard {
  key: SnsCardKey
  label: string
  unit: 'count' | 'money'
  value: number | null
  /** 金额卡的币种（金额最大的币种）；其余币种在 others。 */
  currency: string | null
  others: SnsMoney[]
  /** 对比期的值（只有累计类的两张卡带；没有对比期或对比期没有记录为 null）。 */
  previous: number | null
  state: SnsCardState
  note: string | null
}

export const SNS_ELIGIBILITIES = ['ELIGIBLE', 'INELIGIBLE', 'SUSPENDED'] as const
export const SNS_ELIGIBILITY_LABEL: Readonly<Record<string, string>> = { ELIGIBLE: '可订阅', INELIGIBLE: '不可订阅', SUSPENDED: '已暂停' }
/** 这两种状态下补货计算不叠加订阅预测（与 replenishment-math 一致）。 */
export const SNS_BLOCKED_ELIGIBILITY: readonly string[] = ['INELIGIBLE', 'SUSPENDED']
export const snsEligibilityLabel = (value: string | null | undefined): string => (value ? (SNS_ELIGIBILITY_LABEL[value] ?? value) : '未提供')

/** 两个明细列表可用的排序字段（校验在 subscribe-save-query.ts；放这里是为了前端下拉与服务端共用同一份）。 */
export const SNS_ASIN_SORTS = ['forecastNext30', 'forecastNext60', 'forecastNext90', 'subscriptions', 'shippedUnitsPrevMonth'] as const
export const SNS_OFFER_SORTS = ['forecastNext30', 'subscriptions', 'price', 'inventory'] as const
export type SnsAsinSort = (typeof SNS_ASIN_SORTS)[number]
export type SnsOfferSort = (typeof SNS_OFFER_SORTS)[number]
export const SNS_SORT_LABEL: Readonly<Record<SnsAsinSort | SnsOfferSort, string>> = {
  forecastNext30: '未来 30 天预计出货',
  forecastNext60: '未来 60 天预计出货',
  forecastNext90: '未来 90 天预计出货',
  subscriptions: '订阅数',
  shippedUnitsPrevMonth: '上月订阅出货',
  price: '价格',
  inventory: '库存',
}

export const SNS_GATE_REASONS = ['STALE', 'INELIGIBLE', 'NO_FORECAST', 'NO_PREV_MONTH'] as const
export type SnsGateReason = (typeof SNS_GATE_REASONS)[number]
export const SNS_GATE_LABEL: Readonly<Record<SnsGateReason, string>> = {
  STALE: `报价快照已超过 ${SNS_FORECAST_MAX_AGE_DAYS} 天`,
  INELIGIBLE: '报价当前不可订阅',
  NO_FORECAST: '亚马逊没有给出未来 30 天预测',
  NO_PREV_MONTH: '缺少上月订阅出货件数',
}

export interface SnsOfferFacts {
  snapshotDate: string
  eligibility: string | null
  forecastNext30: number | null
  shippedUnitsPrevMonth: number | null
  prevMonthDays: number | null
}

const DAY_MS = 86_400_000
export const snsDayDiff = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS)

/**
 * 这条报价有没有被补货建议当作确定性需求叠加（规则与 replenishment-math 的 adjustDemand 订阅省一段逐条相同，两边有一致性测试）：
 * 快照在 7 天内、报价可订阅、有未来 30 天预测、有上月订阅出货件数与当月天数，四条都满足才叠加。
 */
export function snsReplenishmentGate(offer: SnsOfferFacts, today: string): { used: boolean; reason: SnsGateReason | null } {
  if (snsDayDiff(offer.snapshotDate, today) > SNS_FORECAST_MAX_AGE_DAYS) return { used: false, reason: 'STALE' }
  if (offer.eligibility !== null && SNS_BLOCKED_ELIGIBILITY.includes(offer.eligibility)) return { used: false, reason: 'INELIGIBLE' }
  if (offer.forecastNext30 === null) return { used: false, reason: 'NO_FORECAST' }
  if (offer.shippedUnitsPrevMonth === null || !offer.prevMonthDays) return { used: false, reason: 'NO_PREV_MONTH' }
  return { used: true, reason: null }
}

export interface SnsSync {
  status: FreshnessViewStatus
  statusLabel: string
  lastSuccessAt: string | null
  errorCode: string | null
  errorMessage: string | null
  /** 接口角色未获批（失败码 ROLE_MISSING）。 */
  rolePending: boolean
}

export interface SnsRange {
  from: string
  to: string
  days: number
  defaulted: boolean
}

export interface SnsTrendPoint {
  date: string
  activeSubscribers: number | null
  shippedUnits: number | null
  /** 金额只取趋势币种（金额最大的币种）；这一天没有记录或不是该币种为 null。 */
  revenue: number | null
}

export interface SnsMonthPoint {
  /** 自然月，YYYY-MM。 */
  month: string
  activeSubscribers: number | null
  shippedUnits: number | null
  revenue: number | null
}

export interface SnsTrend {
  currency: string | null
  points: SnsTrendPoint[]
  months: SnsMonthPoint[]
  /** 范围内有日级记录的天数与范围总天数（日级指标只同步最近 31 天，更早的日期没有记录）。 */
  coverage: { dataDays: number; rangeDays: number }
}

/** 预计订阅出货所依据的报价快照：各店铺各自取最近一次，超过 7 天的店铺不计入。 */
export interface SnsForecastInfo {
  /** 各店铺最近快照日期里最新的一个。 */
  snapshotDate: string | null
  offers: number
  /** 有未来 30 天预测的报价数。 */
  offersWithForecast: number
  /** 快照已过期、没有计入预测的店铺名。 */
  staleStores: string[]
  /** 被补货建议用作确定性需求的报价数。 */
  usedInReplenishment: number
}

export type SnsOverviewState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'NOT_APPLICABLE' | 'ROLE_PENDING'

export interface SnsOverviewResponse {
  state: SnsOverviewState
  note: string | null
  range: SnsRange
  compare: { from: string; to: string; days: number } | null
  sync: SnsSync
  cards: SnsCard[]
  trend: SnsTrend
  forecast: SnsForecastInfo
  /** 日级指标行数超过读取上限，合计与趋势只含已读到的部分。 */
  truncated: boolean
  freshness: InventoryFreshness
  basis: string
  replenishNote: string
}

/** ASIN 明细：同一店铺同一 ASIN 的各 SKU 报价合并（件数相加，没有一条报价给值就是空）。 */
export interface SnsAsinRow {
  key: string
  asin: string
  skus: string[]
  sellerAccountId: string
  storeName: string | null
  snapshotDate: string
  /** 订阅数（订阅了这些报价的买家订阅条数）。 */
  subscriptions: number | null
  shippedUnitsPrevMonth: number | null
  forecastNext30: number | null
  forecastNext60: number | null
  forecastNext90: number | null
  /** 是否有报价被补货建议当作确定性需求；没有的写原因（取第一条不满足的原因）。 */
  replenishment: { used: boolean; reason: SnsGateReason | null }
  /** 系统里对应的商品（用于跳转 ASIN 360）；找不到为 null。 */
  productId: string | null
}

export interface SnsOfferRow {
  key: string
  sku: string
  asin: string
  sellerAccountId: string
  storeName: string | null
  snapshotDate: string
  eligibility: string | null
  eligibilityLabel: string
  fulfillment: string | null
  /** 卖家承担的基础折扣百分比（如 10 表示 10%）。 */
  discountPct: number | null
  price: number | null
  currency: string | null
  inventory: number | null
  stockRisk: string | null
  subscriptions: number | null
  forecastNext30: number | null
  replenishment: { used: boolean; reason: SnsGateReason | null }
}

export type SnsListState = 'OK' | 'NO_DATA' | 'NOT_CONNECTED' | 'NOT_APPLICABLE' | 'ROLE_PENDING'

export interface SnsListResponse<Row> {
  state: SnsListState
  note: string | null
  items: Row[]
  pageInfo: CursorPageInfo
  /** 报价数超过读取上限，列表只含已读到的部分。 */
  truncated: boolean
  /** 各店铺最近快照日期里最新的一个。 */
  snapshotDate: string | null
  /** 快照已过期的店铺名（这些店铺的行仍显示，但“补货”一列写原因）。 */
  staleStores: string[]
  sync: SnsSync
  freshness: InventoryFreshness
  basis: string
}
export type SnsAsinListResponse = SnsListResponse<SnsAsinRow>
export type SnsOfferListResponse = SnsListResponse<SnsOfferRow>

/** 没有可显示数据时的整体状态与说明（有数据由调用方直接返回 OK）。 */
export function snsEmptyState(sync: SnsSync): { state: SnsOverviewState; note: string } {
  if (sync.rolePending) return { state: 'ROLE_PENDING', note: SNS_ROLE_GUIDE }
  if (sync.status === 'NOT_APPLICABLE') return { state: 'NOT_APPLICABLE', note: SNS_NOT_APPLICABLE_NOTE }
  if (sync.status === 'NO_RECORD' || sync.status === 'NOT_CONNECTED') return { state: 'NOT_CONNECTED', note: '订阅省尚未同步：店铺授权后约每 6 小时同步一次' }
  if (sync.status === 'NORMAL' || sync.status === 'DELAYED' || sync.status === 'WAITING_DEPENDENCY') return { state: 'NO_DATA', note: '尚无记录：亚马逊补货接口里没有这个范围内店铺的订阅省数据' }
  return { state: 'NOT_CONNECTED', note: sync.errorMessage ?? '订阅省同步没有成功，暂时没有可显示的数据' }
}
