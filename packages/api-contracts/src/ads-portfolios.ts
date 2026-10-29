import type { CursorPageInfo } from './query'
import type { DashState } from './dashboard'
import type { AdsCampaignRatios } from './ads-campaigns'
import type { AdsTotals } from './ads-overview-math'

// 广告组合与预算契约（P3-11，08 章 8.8）：只有常量与类型，没有 zod（请求校验在 ads-portfolios-query.ts，纯函数在 ads-portfolios-math.ts）。
// 一个广告组合 = 亚马逊里一组活动加一个“预算上限”（按月循环，或指定日期范围）。本页回答三件事：这个周期里花了多少、花得比理想节奏快还是慢、该不该调日预算。
// 数据来源：广告组合（AdsPortfolio，预算上限与周期）、活动表（归属组合、日预算）、广告日汇总（逐日花费，只含美元、只含活动级行）、预算规则（AdsBudgetRule，测试版资源，功能开关控制）。
// 没有数据写“尚无记录”，同步器未交付写“尚未接入”，空值不是 0。本包只读：改预算上限、改预算规则的写入 P3-17 也没有提供入口（见 ADS_PORTFOLIO_WRITE_PENDING）。

/** 一次最多读多少个广告组合（超过标记截断）。 */
export const ADS_PORTFOLIO_ROW_LIMIT = 2000
/** 预算周期最长天数（超过当作“无法识别的周期”，防止异常数据拖出超长曲线）。 */
export const ADS_PORTFOLIO_MAX_PERIOD_DAYS = 400
/** 列表里最多按多少个不同的预算周期窗口去读已花费（按月循环的组合共用一个窗口）。 */
export const ADS_PORTFOLIO_MAX_WINDOWS = 24
/** 详情里最多列多少个活动的预算分配。 */
export const ADS_PORTFOLIO_CAMPAIGN_LIMIT = 500
/** 预算规则最多读多少条。 */
export const ADS_PORTFOLIO_RULE_LIMIT = 200

/**
 * 节奏判断的自定默认值（不是亚马逊口径，也没有对真实店铺校准）：
 * tolerance——实际累计花费与理想累计花费相差不超过 10% 算“基本匹配”；
 * historyDays——生成理想曲线时回看多少天的逐日花费（取星期分布）；
 * minHistoryDays——历史不足这么多天就退回“按天均摊”；
 * recentDays——估算“按当前速度何时花完”用最近几天的日均花费。
 */
export const ADS_PORTFOLIO_PACE_RULES = { tolerance: 0.1, historyDays: 56, minHistoryDays: 14, recentDays: 7 } as const

export const ADS_PORTFOLIO_SORTS = ['name', 'budget', 'spent', 'paceRatio', 'campaigns', 'spend', 'sales', 'acos', 'roas'] as const
export type AdsPortfolioSort = (typeof ADS_PORTFOLIO_SORTS)[number]
export const ADS_PORTFOLIO_SORT_LABEL: Record<AdsPortfolioSort, string> = {
  name: '组合名称',
  budget: '预算上限',
  spent: '已用金额',
  paceRatio: '节奏比',
  campaigns: '活动数',
  spend: '所选范围花费',
  sales: '所选范围广告销售额',
  acos: '广告成本销售比',
  roas: '广告回报率',
}

export const ADS_PORTFOLIO_PACES = ['AHEAD', 'ON_TRACK', 'BEHIND'] as const
export type AdsPortfolioPaceVerdict = (typeof ADS_PORTFOLIO_PACES)[number]
export const ADS_PORTFOLIO_PACE_LABEL: Record<AdsPortfolioPaceVerdict, string> = { AHEAD: '花得偏快', ON_TRACK: '节奏正常', BEHIND: '花得偏慢' }

/** 预算周期：按月循环、指定日期范围、认不出。 */
export type AdsPortfolioBudgetKind = 'MONTHLY' | 'DATE_RANGE' | 'UNKNOWN'
export const ADS_PORTFOLIO_KIND_LABEL: Record<AdsPortfolioBudgetKind, string> = { MONTHLY: '按月', DATE_RANGE: '指定日期范围', UNKNOWN: '周期未知' }

/** 节奏状态：OK 已算出；其余是算不出的原因。 */
export type AdsPortfolioPaceState = 'OK' | 'NO_BUDGET' | 'UNKNOWN_PERIOD' | 'OTHER_CURRENCY' | 'NO_SPEND_DATA' | 'NOT_STARTED'

/** 组合的写入动作暂未提供入口（P3-17 覆盖活动、广告组、投放对象、否定投放与关键词）。 */
export const ADS_PORTFOLIO_WRITE_PENDING = {
  state: 'NOT_CONNECTED' as const,
  note: '修改广告组合的预算上限与预算规则暂未提供写入入口（广告写入目前覆盖活动、广告组、投放对象、否定投放与关键词），请在亚马逊广告后台操作',
}

/** 节奏口径说明（页面原样显示）。 */
export const ADS_PORTFOLIO_PACE_BASIS =
  '实际累计花费 = 预算周期内、组合下全部活动的广告日汇总花费（只含美元，截至昨天；今天的数据不完整，不参与比较）。' +
  '理想累计花费 = 预算上限按“历史节奏”分配到周期内每一天：历史节奏取最近 56 天花费的星期分布（营销数据流接入前只有日级数据，没有小时节奏），' +
  '历史不足 14 天时按天均摊。节奏比 = 实际累计 ÷ 理想累计，偏差超过 10% 才判为偏快或偏慢；阈值与历史窗口是本系统自定的默认值。'

/** 预算规则功能开关：统一接口里的规则资源是测试版（会无通知变更），默认关闭，环境变量打开后才读取与显示。 */
export const ADS_BUDGET_RULES_FLAG = 'ADS_BUDGET_RULES_BETA'
export const ADS_BUDGET_RULES_DISABLED_NOTE =
  '广告统一接口里的“预算规则”资源仍是测试版（接口会无通知变更，不得在生产依赖），功能开关默认关闭，所以没有读取也不显示规则；请在亚马逊广告后台查看与设置大促日、节假日的临时预算'
export const ADS_BUDGET_RULES_EMPTY_NOTE = '功能开关已打开，但还没有预算规则记录（没有同步器写入预算规则，需要统一接口的规则资源同步后才会出现）'

/** 预算周期窗口：从预算周期类型与起止日算出本周期的起止日。 */
export interface AdsPortfolioWindow {
  kind: AdsPortfolioBudgetKind
  from: string | null
  to: string | null
  totalDays: number | null
  /** 认不出周期或周期不合法时的原因。 */
  issue: string | null
}

export interface AdsPortfolioPace {
  state: AdsPortfolioPaceState
  /** 算不出的原因，或提示（例如周期第一天、按天均摊）。 */
  note: string | null
  verdict: AdsPortfolioPaceVerdict | null
  /** 周期内已经过去的完整天数（截至昨天）与周期总天数。 */
  elapsedDays: number
  totalDays: number | null
  /** 截至昨天的理想累计花费；算不出为 null。 */
  idealSpent: number | null
  /** 实际累计花费（与 AdsPortfolioRow.spent 同一个值）。 */
  spent: number | null
  /** 实际 ÷ 理想；理想为 0 或算不出为 null。 */
  ratio: number | null
  /** 理想曲线的形状：HISTORY 按历史星期分布，LINEAR 按天均摊。 */
  shape: 'HISTORY' | 'LINEAR' | null
  /** 实际累计已经达到或超过预算上限。 */
  capReached: boolean
}

export interface AdsPortfolioBudget {
  cap: number | null
  kind: AdsPortfolioBudgetKind
  from: string | null
  to: string | null
  issue: string | null
}

export interface AdsPortfolioRow {
  /** 系统编号（AdsPortfolio.id），详情页地址用它。 */
  id: string
  portfolioId: string
  name: string
  status: string
  adsProfileId: string
  accountName: string
  storeName: string | null
  currency: string
  budget: AdsPortfolioBudget
  /** 预算周期内的已用金额：优先用广告日汇总（截至昨天），没有汇总行时退回亚马逊同步来的已用金额（来源 PORTFOLIO）；都没有为 null。 */
  spent: number | null
  spentSource: 'REPORTS' | 'PORTFOLIO' | null
  /** 亚马逊同步来的已用金额（同步时刻的值，可能落后）。 */
  reportedSpent: number
  pace: AdsPortfolioPace
  campaigns: { total: number; enabled: number }
  /** 所选日期范围内组合下活动的合计（美元）；没有汇总行或非美元组合为 null。 */
  totals: AdsTotals | null
  ratios: AdsCampaignRatios | null
  syncedAt: string
}

export interface AdsPortfolioSummary {
  /** 过滤后的组合个数，设置了预算上限的个数，三种节奏各有几个。 */
  portfolios: number
  withBudget: number
  ahead: number
  onTrack: number
  behind: number
  /** 已算出节奏的美元组合的预算上限与已用金额合计；一个都没有为 null。 */
  cap: number | null
  spent: number | null
}

export interface AdsPortfolioListResponse {
  state: Extract<DashState, 'OK' | 'NO_DATA' | 'NOT_CONNECTED'>
  note: string | null
  items: AdsPortfolioRow[]
  pageInfo: CursorPageInfo
  /** 关键指标的日期范围（没选时默认最近 30 天）。 */
  range: { from: string; to: string; defaulted: boolean }
  /** 企业时区的今天：预算周期与节奏都按它算。 */
  businessDate: string
  currency: 'USD'
  summary: AdsPortfolioSummary
  paceBasis: string
  write: typeof ADS_PORTFOLIO_WRITE_PENDING
  /** 广告组合超过 ADS_PORTFOLIO_ROW_LIMIT 或预算周期窗口超过上限，只处理了一部分。 */
  truncated: boolean
  /** 活动或汇总分组超过读取上限，合计可能缺失。 */
  metricsTruncated: boolean
}

export interface AdsPortfolioCurvePoint {
  date: string
  /** 当天结束时的理想累计花费；没有预算上限为 null。 */
  ideal: number | null
  /** 当天结束时的实际累计花费；今天及以后为 null。 */
  actual: number | null
  /** 当天花费；今天及以后或没有汇总行为 null。 */
  daily: number | null
}

export type AdsBudgetAdviceKind = 'CAP_REACHED' | 'EXHAUST_EARLY' | 'LOWER_DAILY' | 'RAISE_DAILY' | 'NOT_LIMITED_BY_BUDGET' | 'BEHIND'
export interface AdsBudgetAdvice {
  kind: AdsBudgetAdviceKind
  text: string
  /** 周期内还剩几天（含今天）、还剩多少预算。 */
  remainingDays: number
  remainingBudget: number | null
  /** 剩余预算平均到剩余天数，每天最多能花多少才不超上限。 */
  sustainableDaily: number | null
  /** 组合下启用中的美元日预算活动的日预算合计；没有可算的活动为 null。 */
  currentDailyBudget: number | null
  /** 最近几天的日均花费；没有数据为 null。 */
  recentDaily: number | null
  /** 按最近日均花费估算的预算用尽日；周期内用不完或没有数据为 null。 */
  exhaustDate: string | null
}

export interface AdsPortfolioCampaignShare {
  /** 系统编号（AdsCampaign.id），详情页地址用它。 */
  id: string
  name: string
  adProduct: string
  productLabel: string
  state: string
  servingStatus: string | null
  budget: number | null
  budgetType: string | null
  currency: string
  /** 统计区间（见 allocation.period）内该活动的花费；没有汇总行或非美元为 null。 */
  spend: number | null
  /** 占组合花费合计的比例；合计为 0 或没有花费为 null。 */
  spendShare: number | null
  /** 启用中美元日预算活动：占日预算合计的比例；其余为 null。 */
  budgetShare: number | null
}

export interface AdsBudgetRuleView {
  id: string
  campaignId: string
  campaignName: string | null
  ruleType: string
  status: string
  /** 规则参数的摘要（接口返回什么就显示什么，不解释含义）。 */
  params: Array<{ key: string; value: string }>
  syncedAt: string
}

export interface AdsPortfolioDetailResponse {
  row: AdsPortfolioRow
  /** 企业时区的今天。 */
  businessDate: string
  /** 整个预算周期逐日的理想与实际累计；没有预算周期时为空数组。 */
  curve: AdsPortfolioCurvePoint[]
  advice: AdsBudgetAdvice | null
  /** 没有建议的原因（节奏正常、周期已结束、算不出节奏等）。 */
  adviceNote: string | null
  allocation: {
    state: Extract<DashState, 'OK' | 'NO_DATA'>
    note: string | null
    items: AdsPortfolioCampaignShare[]
    truncated: boolean
    /** 花费占比统计的区间：有预算周期时是周期内（截至昨天），没有时退回页面所选的日期范围。 */
    period: { from: string; to: string; basis: 'BUDGET_PERIOD' | 'SELECTED_RANGE' } | null
  }
  rules: { state: 'DISABLED' | 'NO_DATA' | 'OK'; note: string | null; flag: typeof ADS_BUDGET_RULES_FLAG; items: AdsBudgetRuleView[] }
  range: { from: string; to: string; defaulted: boolean }
  paceBasis: string
  write: typeof ADS_PORTFOLIO_WRITE_PENDING
}
