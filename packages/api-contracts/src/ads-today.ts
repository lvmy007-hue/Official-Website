import type { DashState } from './dashboard'

// 今日广告契约（P3-06，08 章 8.2）：只有常量与类型，没有 zod（本接口只接全局范围参数）。
// 数据来源：
//   - 今日指标与小时曲线：营销数据流 ads-performance-v1 的小时指标（AdsPerformanceHourly，活动级，只含美元）；
//   - 预算：当前日预算来自活动管理接口（AdsCampaign），今日花费来自小时指标；“超预算”状态只看活动管理接口的投放状态（数据流不含预算消耗）；
//   - 断货仍在投放：被推广商品日报表（AdsAdvertisedProductMetric）与库存快照（接口来源）；
//   - 未接入营销数据流时：正式显示“未接入”，退化展示最近一天的广告日汇总（AdsDailySummary）。
// 可空 = 来源没给，不是 0。

export const ADS_TODAY_METRIC_VERSION = 'p3-06@1'

/** 数据流状态：LIVE 接收端已配置且今日有小时指标；NOT_CONNECTED 接收端未配置（14.10）；NO_DATA 接收端已配置但今日还没有小时指标。 */
export type AdsTodayStreamState = 'LIVE' | 'NOT_CONNECTED' | 'NO_DATA'

/** 页面必须标注的更新节奏：转化类指标滞后，不能当成“今天没卖出去”。 */
export const ADS_TODAY_UPDATE_NOTE = '花费与点击来自营销数据流，最快每 15 分钟更新一次；广告销售额与订单是转化数据，通常滞后数小时，今日偏低属正常，以日终报表为准。'
export const ADS_TODAY_ESTIMATE_NOTE = '估算：按今天已过去时间的平均花费速度外推，没有考虑分时段的投放差异，也不含广告平台自己的预算分配。'
export const ADS_TODAY_OUT_OF_BUDGET_NOTE = '超预算状态来自活动管理接口的投放状态（营销数据流第二版不含预算消耗数据集），随活动同步刷新，不是实时的。'

/** 小时曲线的历史同时段区间带：取过去这么多天里同一小时。 */
export const ADS_TODAY_HISTORY_DAYS = 14
/** 同时段样本少于这个数不画区间带（样本太少的区间没有意义）。 */
export const ADS_TODAY_BAND_MIN_SAMPLES = 3
/** 单次点击成本突增的基线：今天之前的这么多天。 */
export const ADS_TODAY_BASELINE_DAYS = 7
/** 断货商品仍在投放：回看被推广商品日报表的天数（含今天）。 */
export const ADS_TODAY_STOCKOUT_LOOKBACK_DAYS = 3
/** 预算耗尽时间外推至少需要的已过去小时数：刚过零点样本太少，不外推。 */
export const ADS_TODAY_PREDICT_MIN_HOURS = 1
/** 活动级读取上限，超过只处理一部分并提示。 */
export const ADS_TODAY_ROW_LIMIT = 5000
/** 预算进度、异常清单最多列出多少行。 */
export const ADS_TODAY_LIST_LIMIT = 20

/**
 * 今日异常规则（自定默认值，不是亚马逊口径）：
 *   CPC_SURGE            今日点击不少于 CPC_MIN_CLICKS，基线（今天之前 7 天）点击不少于 BASELINE_MIN_CLICKS，今日单次点击成本不低于基线的 CPC_RATIO 倍；
 *   SPEND_NO_CONVERSION  今日花费不低于 NO_CONVERSION_MIN_SPEND 且点击不少于 NO_CONVERSION_MIN_CLICKS，但今天还没有订单（转化滞后，仅提示）。
 */
export const ADS_TODAY_ANOMALY_RULES = {
  CPC_RATIO: 1.5,
  CPC_MIN_CLICKS: 10,
  BASELINE_MIN_CLICKS: 50,
  NO_CONVERSION_MIN_SPEND: 20,
  NO_CONVERSION_MIN_CLICKS: 20,
} as const
export const ADS_TODAY_ANOMALY_KINDS = ['CPC_SURGE', 'SPEND_NO_CONVERSION'] as const
export type AdsTodayAnomalyKind = (typeof ADS_TODAY_ANOMALY_KINDS)[number]
export const ADS_TODAY_ANOMALY_LABEL: Record<AdsTodayAnomalyKind, string> = { CPC_SURGE: '单次点击成本突增', SPEND_NO_CONVERSION: '花费突增但今天没有转化' }

export interface AdsTodayTotals {
  spend: number | null
  clicks: number
  impressions: number
  /** 花费 ÷ 点击；没有点击或没有花费为 null */
  cpc: number | null
  sales: number | null
  orders: number
}

export interface AdsTodayBand {
  spendMin: number | null
  spendMax: number | null
  clicksMin: number
  clicksMax: number
  samples: number
}

export interface AdsTodayHour {
  /** 小时起点（ISO，UTC） */
  hourStart: string
  /** 这个小时已经过去（含当前小时）；未到的小时没有数 */
  elapsed: boolean
  /** 这个小时没有小时指标行时为 null（不当 0） */
  spend: number | null
  clicks: number | null
  sales: number | null
  orders: number | null
  band: AdsTodayBand | null
}

export const ADS_TODAY_EXHAUST_STATES = ['EXHAUSTED', 'PROJECTED', 'NOT_TODAY', 'TOO_EARLY', 'NO_SPEND'] as const
export type AdsTodayExhaustState = (typeof ADS_TODAY_EXHAUST_STATES)[number]
export const ADS_TODAY_EXHAUST_LABEL: Record<AdsTodayExhaustState, string> = {
  EXHAUSTED: '今日预算已用完',
  PROJECTED: '预计耗尽（估算）',
  NOT_TODAY: '预计今天不会耗尽',
  TOO_EARLY: '今天刚开始，暂不外推',
  NO_SPEND: '今天还没有花费',
}

export interface AdsTodayBudgetRow {
  key: string
  adsProfileId: string
  campaignId: string
  name: string
  dailyBudget: number
  /** 今日花费；小时指标里没有这个活动为 null */
  spend: number | null
  /** 花费 ÷ 日预算；没有花费为 null */
  progress: number | null
  exhaust: AdsTodayExhaustState | null
  /** 预计耗尽时刻（ISO），只有 PROJECTED 才有 */
  exhaustAt: string | null
}

export interface AdsTodayBudget {
  state: DashState
  note: string | null
  /** 启用中、日预算的美元活动的日预算合计 */
  dailyBudgetTotal: number | null
  /** 这些活动的今日花费合计 */
  spentToday: number | null
  progress: number | null
  budgetedCampaigns: number
  /** 因为同一广告档案里活动编号重复而没法确认花费归属的活动数 */
  ambiguous: number
  rows: AdsTodayBudgetRow[]
  truncated: boolean
}

export interface AdsTodayOutOfBudgetRow {
  key: string
  adsProfileId: string
  adProduct: string
  campaignId: string
  name: string
  servingStatus: string
}
export interface AdsTodayOutOfBudget {
  state: DashState
  note: string | null
  count: number
  rows: AdsTodayOutOfBudgetRow[]
}

export interface AdsTodayAnomaly {
  key: string
  kind: AdsTodayAnomalyKind
  adsProfileId: string
  campaignId: string
  name: string
  spend: number
  clicks: number
  orders: number
  cpc: number | null
  /** 单次点击成本基线（突增类才有） */
  baselineCpc: number | null
  /** 今日单次点击成本 ÷ 基线 */
  ratio: number | null
}

export interface AdsTodayAnomalies {
  state: DashState
  note: string | null
  rules: typeof ADS_TODAY_ANOMALY_RULES
  count: number
  items: AdsTodayAnomaly[]
}

export interface AdsTodayStockoutItem {
  key: string
  asin: string
  sellerAccountId: string
  storeName: string | null
  /** 最近一次库存快照的可售数量（同一 ASIN 各 SKU 相加） */
  sellable: number
  snapshotDate: string
  /** 回看期内的花费合计与有花费的天数 */
  spend: number
  days: number
  /** 当前日均浪费金额 = 回看期花费 ÷ 有花费的天数 */
  dailyWaste: number
}
export interface AdsTodayStockout {
  state: DashState
  note: string | null
  lookbackDays: number
  items: AdsTodayStockoutItem[]
}

export interface AdsTodayResponse {
  streamState: AdsTodayStreamState
  note: string | null
  updateNote: string
  /** 企业时区的今天（YYYY-MM-DD） */
  businessDate: string
  /** 小时指标最近一次更新时刻；没有为 null */
  asOf: string | null
  currency: 'USD'
  metricVersion: string
  /** 今日小时指标里没有并入的其他币种（不折算） */
  otherCurrencies: Array<{ currency: string; spend: number | null }>
  totals: { state: DashState; note: string | null; value: AdsTodayTotals | null; yesterdaySameHour: AdsTodayTotals | null }
  /** 数据流未接入或今日没有小时指标时退化展示的最近一天日报表汇总 */
  fallback: { summaryDate: string; totals: AdsTodayTotals; refreshedAt: string | null } | null
  hours: { state: DashState; note: string | null; items: AdsTodayHour[]; historyDays: number }
  budget: AdsTodayBudget
  outOfBudget: AdsTodayOutOfBudget
  anomalies: AdsTodayAnomalies
  stockout: AdsTodayStockout
  /** 活动级读取是否被上限截断 */
  truncated: boolean
}
