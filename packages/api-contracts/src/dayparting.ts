import type { AdsHourlyCell } from './ads-campaigns-tabs'
import type { DashState } from './dashboard'

// 分时策略契约（P3-12，08 章 8.9）：只有常量与类型，没有 zod（请求校验在 dayparting-query.ts，纯函数在 dayparting-math.ts）。
// 一个策略 = 一个广告档案 + 一组活动或广告组 + 星期 × 小时共 168 格的取值：竞价系数策略每格是系数（0.1 至 3），启停策略每格是 1（启用）或 0（暂停）。
// 分析（星期 × 小时热力图）来自营销数据流的小时指标，历史只有 14 天；数据流接收端暂缓期间（14.10）显示“尚未接入”。
// 本包交付：热力图分析、策略的创建与修改（系统内的数据）、当前时段应执行的值、效果模拟（模型估算）。
// 调度执行与写亚马逊在 P3-17 接入：每小时对已启用的策略按当前时段取值，需要写入开关“分时策略执行”与对应动作的开关；开关关闭时写入被拒绝并记失败。

export const DAYPARTING_WRITE = 'ads.rule.write'
/** 分时策略执行的写入开关键（执行器随 P3-17 接入；页面上说明用）。 */
export const DAYPARTING_SWITCH = 'sw.ads.dayparting.run'

/** 热力图与模拟只看最近这么多天：报告接口的小时维度只保留 14 天（ADS_REPORT_LIMITS.HOURLY），数据流也不会补历史。 */
export const DAYPARTING_HISTORY_DAYS = 14
/** 一周的小时格数：周一 0 点为第 0 格。 */
export const DAYPARTING_GRID_SIZE = 168
export const DAYPARTING_STRATEGY_LIMIT = 100
export const DAYPARTING_TARGET_LIMIT = 200
export const DAYPARTING_RUN_LIMIT = 50
export const DAYPARTING_NAME_MAX = 80
/** 竞价系数的取值范围与基准竞价上限（自定的默认值，不是亚马逊口径）。 */
export const DAYPARTING_MULTIPLIER = { min: 0.1, max: 3, baseBidMax: 1000 } as const

export const DAYPARTING_KINDS = ['BID_MULTIPLIER', 'ON_OFF'] as const
export type DaypartingKind = (typeof DAYPARTING_KINDS)[number]
export const DAYPARTING_KIND_LABEL: Record<DaypartingKind, string> = { BID_MULTIPLIER: '按时段调整竞价（系数）', ON_OFF: '按时段启停' }

/** 作用对象：活动或广告组。投放对象粒度没有做（见 CR-067）。 */
export const DAYPARTING_LEVELS = ['CAMPAIGN', 'AD_GROUP'] as const
export type DaypartingLevel = (typeof DAYPARTING_LEVELS)[number]
export const DAYPARTING_LEVEL_LABEL: Record<DaypartingLevel, string> = { CAMPAIGN: '活动', AD_GROUP: '广告组' }

export const DAYPARTING_STATUSES = ['ACTIVE', 'PAUSED'] as const
export type DaypartingStatus = (typeof DAYPARTING_STATUSES)[number]
export const DAYPARTING_STATUS_LABEL: Record<DaypartingStatus, string> = { ACTIVE: '已启用', PAUSED: '已暂停' }

/** 热力图可切换的指标。 */
export const DAYPARTING_METRICS = ['spend', 'orders', 'acos', 'cpc'] as const
export type DaypartingMetric = (typeof DAYPARTING_METRICS)[number]
export const DAYPARTING_METRIC_LABEL: Record<DaypartingMetric, string> = { spend: '花费', orders: '转化（订单）', acos: '广告成本销售比', cpc: '单次点击成本' }

/** QUEUED：已提交写入、等亚马逊确认（P3-17）；确认后改为 APPLIED，失败改为 FAILED。 */
export const DAYPARTING_RUN_OUTCOMES = ['QUEUED', 'APPLIED', 'SKIPPED', 'FAILED'] as const
export type DaypartingRunOutcome = (typeof DAYPARTING_RUN_OUTCOMES)[number]
export const DAYPARTING_OUTCOME_LABEL: Record<DaypartingRunOutcome, string> = { QUEUED: '已提交，等待亚马逊确认', APPLIED: '已执行', SKIPPED: '已跳过', FAILED: '失败' }

export const DAYPARTING_CREATED_ACTION = 'ADS_DAYPARTING_CREATED'
export const DAYPARTING_UPDATED_ACTION = 'ADS_DAYPARTING_UPDATED'

/** 调度执行写亚马逊（P3-17 接入）：每小时对已启用的策略按当前时段取值，与亚马逊当前值不同时才提交写入。 */
export const DAYPARTING_EXECUTION_PENDING = {
  state: 'CONNECTED' as const,
  note: '已启用的策略每小时按所在时区的当前时段写亚马逊：启停策略暂停或启用对象，广告组级竞价系数策略把默认竞价改为基准竞价 × 系数；需要同时打开该动作的写入开关与“分时策略执行”开关并完成广告授权，否则该小时记为已跳过。活动级竞价系数没有对应的亚马逊字段，只记为已跳过',
}

/**
 * 效果模拟的模型参数（自定的粗略假设，不是亚马逊口径，也没有对真实店铺校准；页面与接口都原样写明）：
 * 竞价系数 m：点击量按 m 的 clickElasticity 次方变化，单次点击成本按 m 的 cpcPassThrough 次方变化，转化率与客单价不变；
 * 启停：暂停的小时格整格归零，不考虑预算被省下后挪到别的时段。
 */
export const DAYPARTING_SIM_MODEL = { clickElasticity: 0.5, cpcPassThrough: 1 } as const
export const DAYPARTING_SIM_ASSUMPTIONS = [
  '模型估算，不是亚马逊的预测：用最近 14 天作用对象的小时指标，按“星期 × 小时”累计后逐格套用策略。',
  '竞价系数 m：点击量按 m 的 0.5 次方变化，单次点击成本按 m 变化（线性），转化率与客单价不变。',
  '启停：暂停的小时格花费、点击、订单与销售额整格归零，不考虑预算省下后挪到其他时段。',
  '没有历史记录的小时格不参与估算；样本只有 14 天，同一格最多 2 个样本，波动很大，只作方向参考。',
] as const

// ---- 响应类型 ----

export interface DaypartingTargetView {
  /** 活动或广告组的系统编号。 */
  id: string
  /** 已不存在（被同步删除）时为 null。 */
  name: string | null
}

export interface DaypartingDue {
  weekday: number
  hour: number
  /** 当前小时格的取值；没有格子（不应出现）为 null。 */
  value: number | null
  /** 例如“竞价 ×1.20”“暂停”“启用”。 */
  label: string
}

export interface DaypartingStrategyRow {
  id: string
  adsProfileId: string
  accountName: string
  storeName: string | null
  name: string
  kind: DaypartingKind
  level: DaypartingLevel
  status: DaypartingStatus
  timezone: string
  baseBid: number | null
  targets: DaypartingTargetView[]
  /** 168 格取值（周一 0 点起）。 */
  grid: number[]
  /** 例如“竞价系数：32 格提高，40 格降低，96 格不变”。 */
  summary: string
  /** 按策略自己的时区，此刻应执行的取值。 */
  due: DaypartingDue
  version: number
  createdAt: string
  updatedAt: string
  updatedByName: string | null
}

export interface DaypartingHeatmap {
  state: Exclude<DashState, 'RESTRICTED'>
  note: string | null
  /** 企业时区，格子按它归到“星期 × 小时”。 */
  zone: string
  historyDays: number
  cells: AdsHourlyCell[]
}

export interface DaypartingProfileOption {
  id: string
  name: string
  storeName: string | null
  /** 广告档案自己的时区；没有同步为 null（创建时用企业时区）。 */
  timezone: string | null
}

export interface DaypartingRunRow {
  id: string
  strategyId: string
  strategyName: string
  entityId: string
  entityName: string | null
  hour: number
  appliedMultiplier: number
  executed: boolean
  outcome: DaypartingRunOutcome
  message: string | null
  runAt: string
}

export interface DaypartingListResponse {
  streamConnected: boolean
  heatmap: DaypartingHeatmap
  strategies: { state: Exclude<DashState, 'RESTRICTED'>; note: string | null; items: DaypartingStrategyRow[]; truncated: boolean }
  runs: { state: Exclude<DashState, 'RESTRICTED'>; note: string | null; items: DaypartingRunRow[] }
  profiles: DaypartingProfileOption[]
  canWrite: boolean
  execution: typeof DAYPARTING_EXECUTION_PENDING
  assumptions: readonly string[]
}

/** 模拟用的合计：花费与销售额可空（来源没给），acos、cpc 是由它们算出的比率（分母为 0 或缺失时为 null）。 */
export interface DaypartingTotals {
  clicks: number
  spend: number | null
  sales: number | null
  orders: number
  acos: number | null
  cpc: number | null
}

export interface DaypartingSimulateResponse {
  state: Exclude<DashState, 'RESTRICTED'>
  note: string | null
  strategyId: string
  historyDays: number
  /** 历史里有记录的小时格数（共 168 格）。 */
  coveredCells: number
  /** 策略相对基准有变化的小时格数（系数不是 1，或暂停）。 */
  changedCells: number
  baseline: DaypartingTotals | null
  estimated: DaypartingTotals | null
  model: typeof DAYPARTING_SIM_MODEL
  assumptions: readonly string[]
}

/** 创建与修改的返回：最新的策略行。 */
export interface DaypartingWriteResult {
  strategy: DaypartingStrategyRow
}
