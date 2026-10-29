import type { DashState } from './dashboard'
import type { CursorPageInfo } from './query'

// 广告自动规则契约（P3-13，08 章 8.10）：只有常量与类型，没有 zod（请求校验在 ads-rules-query.ts，纯函数在 ads-rules-math.ts）。
// 一条规则 = 一个广告账户 + 对象层级（活动、投放词、搜索词）+ 条件（指标、时间窗口、阈值，AND 关系）+ 对象文本过滤 + 动作 + 护栏 + 执行频率 + 模式。
// 两种模式：建议模式命中后只生成待办（不改亚马逊）；自动执行模式要写亚马逊，需要写入开关“自动规则执行”（P3-17 接入）——
// 活动与投放词层级的命中提交写入；搜索词层级没有所属广告组，只生成待办（记录里写明）。
// 评估只用日级指标（活动来自广告日汇总，投放词来自广告指标表，搜索词来自词级报表；只看美元），没有数据写“尚无记录”，不当 0。

export const ADS_RULE_WRITE = 'ads.rule.write'
/** 自动规则执行的写入开关键（执行器随 P3-17 接入；创建与改成自动模式时要求它已开启）。 */
export const ADS_RULE_SWITCH = 'sw.ads.rule.run'

export const ADS_RULE_CREATED_ACTION = 'ADS_RULE_CREATED'
export const ADS_RULE_UPDATED_ACTION = 'ADS_RULE_UPDATED'
export const ADS_RULE_DRY_RUN_ACTION = 'ADS_RULE_DRY_RUN'

export const ADS_RULE_LIMITS = {
  nameMax: 80,
  conditionsMax: 5,
  filtersMax: 5,
  filterTextMax: 80,
  campaignsMax: 200,
  /** 每个对象的“每日执行次数上限”可选范围。 */
  dailyLimitMax: 200,
  dailyLimitDefault: 20,
  /** 规则列表一次最多返回多少条；一个企业的规则数上限。 */
  ruleMax: 200,
  /** 一次评估最多读多少个对象与多少行日指标（超过就带 truncated，不静默截断）。 */
  subjectMax: 5000,
  dayRowMax: 19_999,
  /** 试运行返回的命中与跳过条数上限。 */
  dryRunHitMax: 200,
  dryRunSkipMax: 100,
  runPageMax: 100,
  /** 调整幅度的取值范围（百分比、金额）与每个动作的最小值。 */
  percentMin: -90,
  percentMax: 300,
  amountAbs: 1000,
  valueFloor: 0.01,
  valueCeiling: 100_000,
} as const

export const ADS_RULE_LEVELS = ['CAMPAIGN', 'TARGET', 'SEARCH_TERM'] as const
export type AdsRuleLevel = (typeof ADS_RULE_LEVELS)[number]
export const ADS_RULE_LEVEL_LABEL: Record<AdsRuleLevel, string> = { CAMPAIGN: '活动', TARGET: '投放词（关键词与投放）', SEARCH_TERM: '搜索词' }

export const ADS_RULE_MODES = ['SUGGEST', 'AUTO'] as const
export type AdsRuleMode = (typeof ADS_RULE_MODES)[number]
export const ADS_RULE_MODE_LABEL: Record<AdsRuleMode, string> = { SUGGEST: '建议模式（命中只生成待办）', AUTO: '自动执行模式' }

export const ADS_RULE_STATUSES = ['ACTIVE', 'PAUSED'] as const
export type AdsRuleStatus = (typeof ADS_RULE_STATUSES)[number]
export const ADS_RULE_STATUS_LABEL: Record<AdsRuleStatus, string> = { ACTIVE: '已启用', PAUSED: '已暂停' }

/** 执行频率：评估只用日级指标，所以最短是每天一次；小时级数据在数据流接收端暂缓期间没有。 */
export const ADS_RULE_FREQUENCIES = ['DAILY', 'EVERY_3_DAYS', 'WEEKLY'] as const
export type AdsRuleFrequency = (typeof ADS_RULE_FREQUENCIES)[number]
export const ADS_RULE_FREQUENCY_LABEL: Record<AdsRuleFrequency, string> = { DAILY: '每天一次', EVERY_3_DAYS: '每 3 天一次', WEEKLY: '每周一次' }
export const ADS_RULE_FREQUENCY_HOURS: Record<AdsRuleFrequency, number> = { DAILY: 24, EVERY_3_DAYS: 72, WEEKLY: 168 }

export const ADS_RULE_WINDOWS = [1, 3, 7, 14, 30] as const
export type AdsRuleWindow = (typeof ADS_RULE_WINDOWS)[number]
/** 评估到哪一天：数据只到昨天（今天的指标不完整），窗口从这一天往前数。 */
export const ADS_RULE_ASOF_LAG_DAYS = 1

/** 指标与单位：money 是美元，percent 是百分数（30 表示 30%），count 是个数，times 是倍数。 */
export const ADS_RULE_METRICS = ['spend', 'sales', 'orders', 'clicks', 'impressions', 'acos', 'cpc', 'ctr', 'cvr', 'roas'] as const
export type AdsRuleMetric = (typeof ADS_RULE_METRICS)[number]
export type AdsRuleUnit = 'money' | 'percent' | 'count' | 'times'
export const ADS_RULE_METRIC_INFO: Record<AdsRuleMetric, { label: string; unit: AdsRuleUnit }> = {
  spend: { label: '花费', unit: 'money' },
  sales: { label: '广告销售额', unit: 'money' },
  orders: { label: '订单', unit: 'count' },
  clicks: { label: '点击', unit: 'count' },
  impressions: { label: '曝光', unit: 'count' },
  acos: { label: '广告成本销售比', unit: 'percent' },
  cpc: { label: '单次点击成本', unit: 'money' },
  ctr: { label: '点击率', unit: 'percent' },
  cvr: { label: '转化率', unit: 'percent' },
  roas: { label: '广告投入产出比', unit: 'times' },
}

export const ADS_RULE_OPS = ['gt', 'gte', 'lt', 'lte'] as const
export type AdsRuleOp = (typeof ADS_RULE_OPS)[number]
export const ADS_RULE_OP_LABEL: Record<AdsRuleOp, string> = { gt: '大于', gte: '大于或等于', lt: '小于', lte: '小于或等于' }
export const ADS_RULE_OP_SYMBOL: Record<AdsRuleOp, string> = { gt: '>', gte: '≥', lt: '<', lte: '≤' }

export const ADS_RULE_FILTER_FIELDS = ['NAME', 'CAMPAIGN_NAME'] as const
export type AdsRuleFilterField = (typeof ADS_RULE_FILTER_FIELDS)[number]
export const ADS_RULE_FILTER_FIELD_LABEL: Record<AdsRuleFilterField, string> = { NAME: '对象名称', CAMPAIGN_NAME: '所属活动名称' }
export const ADS_RULE_FILTER_MODES = ['CONTAINS', 'NOT_CONTAINS'] as const
export type AdsRuleFilterMode = (typeof ADS_RULE_FILTER_MODES)[number]
export const ADS_RULE_FILTER_MODE_LABEL: Record<AdsRuleFilterMode, string> = { CONTAINS: '包含', NOT_CONTAINS: '不包含' }

export const ADS_RULE_ACTION_TYPES = ['ADJUST_BID', 'ADJUST_BUDGET', 'PAUSE', 'ENABLE', 'NEGATE', 'ADD_KEYWORD'] as const
export type AdsRuleActionType = (typeof ADS_RULE_ACTION_TYPES)[number]
export const ADS_RULE_ACTION_LABEL: Record<AdsRuleActionType, string> = {
  ADJUST_BID: '调整竞价',
  ADJUST_BUDGET: '调整日预算',
  PAUSE: '暂停',
  ENABLE: '启用',
  NEGATE: '添加否定投放',
  ADD_KEYWORD: '添加为关键词',
}
/** 每个层级能做的动作：活动管状态与预算，投放词管竞价与状态，搜索词管否定与加词。 */
export const ADS_RULE_LEVEL_ACTIONS: Record<AdsRuleLevel, readonly AdsRuleActionType[]> = {
  CAMPAIGN: ['PAUSE', 'ENABLE', 'ADJUST_BUDGET'],
  TARGET: ['ADJUST_BID', 'PAUSE', 'ENABLE'],
  SEARCH_TERM: ['NEGATE', 'ADD_KEYWORD'],
}
export const ADS_RULE_ADJUST_MODES = ['PERCENT', 'AMOUNT'] as const
export const ADS_RULE_NEGATE_MATCHES = ['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'] as const
export const ADS_RULE_NEGATE_MATCH_LABEL: Record<(typeof ADS_RULE_NEGATE_MATCHES)[number], string> = { NEGATIVE_EXACT: '否定精确', NEGATIVE_PHRASE: '否定词组' }
export const ADS_RULE_KEYWORD_MATCHES = ['EXACT', 'PHRASE', 'BROAD'] as const
export const ADS_RULE_KEYWORD_MATCH_LABEL: Record<(typeof ADS_RULE_KEYWORD_MATCHES)[number], string> = { EXACT: '精确匹配', PHRASE: '词组匹配', BROAD: '广泛匹配' }

/** QUEUED：自动执行已提交写入、等亚马逊确认（P3-17）；确认后改为 APPLIED，失败改为 FAILED。 */
export const ADS_RULE_RUN_OUTCOMES = ['SUGGESTED', 'QUEUED', 'APPLIED', 'SKIPPED', 'FAILED'] as const
export type AdsRuleRunOutcome = (typeof ADS_RULE_RUN_OUTCOMES)[number]
export const ADS_RULE_OUTCOME_LABEL: Record<AdsRuleRunOutcome, string> = { SUGGESTED: '已生成待办', QUEUED: '已提交，等待亚马逊确认', APPLIED: '已执行', SKIPPED: '已跳过', FAILED: '失败' }

/** 规则质量的统计窗口与“执行后效果”对比的前后各几天。 */
export const ADS_RULE_QUALITY_DAYS = 30
export const ADS_RULE_EFFECT_DAYS = 7

/** 自动执行写亚马逊（P3-17 接入）：活动与投放词层级的命中直接提交写入；搜索词层级没有所属广告组，只生成待办。 */
export const ADS_RULE_EXECUTION_PENDING = {
  state: 'CONNECTED' as const,
  note: '自动执行模式命中活动或投放词时会写亚马逊广告账户，需要同时打开该动作的写入开关与“自动规则执行”开关并完成广告授权，否则本次只记为已跳过；搜索词层级的动作（否定、加词）需要所属广告组，只生成待办，不会改变亚马逊账户',
}

// ---- 规则内容（库里 conditionJson / scopeJson / actionJson / guardrailJson 的形状，也是接口收发的形状） ----

export interface AdsRuleCondition {
  metric: AdsRuleMetric
  windowDays: AdsRuleWindow
  op: AdsRuleOp
  /** 阈值，单位随指标：美元、百分数、个数、倍数。 */
  value: number
}

export interface AdsRuleTextFilter {
  field: AdsRuleFilterField
  mode: AdsRuleFilterMode
  text: string
}

export type AdsRuleAction =
  | { type: 'ADJUST_BID'; mode: (typeof ADS_RULE_ADJUST_MODES)[number]; value: number }
  | { type: 'ADJUST_BUDGET'; mode: (typeof ADS_RULE_ADJUST_MODES)[number]; value: number }
  | { type: 'PAUSE' }
  | { type: 'ENABLE' }
  | { type: 'NEGATE'; matchType: (typeof ADS_RULE_NEGATE_MATCHES)[number] }
  | { type: 'ADD_KEYWORD'; matchType: (typeof ADS_RULE_KEYWORD_MATCHES)[number]; bid: number }

/** 护栏：最低与最高值（竞价、预算、新词的出价）、单次调整幅度上限（百分比）、每个规则每天最多处理的对象数。 */
export interface AdsRuleGuardrails {
  minValue: number | null
  maxValue: number | null
  maxChangePercent: number | null
  dailyLimit: number
}

export interface AdsRuleSpec {
  level: AdsRuleLevel
  conditions: AdsRuleCondition[]
  textFilters: AdsRuleTextFilter[]
  /** 限定的活动（系统编号）；空数组表示这个广告账户下的全部活动。 */
  campaignIds: string[]
  action: AdsRuleAction
  guardrails: AdsRuleGuardrails
}

// ---- 评估用的对象与结果 ----

export interface AdsRuleDay {
  /** YYYY-MM-DD。 */
  date: string
  impressions: number
  clicks: number
  spend: number | null
  sales: number | null
  orders: number
}

/** 被评估的对象：key 是稳定的对象标识（活动、投放词用外部编号，搜索词用“活动编号|词”）。 */
export interface AdsRuleSubject {
  key: string
  label: string
  campaignLabel: string | null
  /** 活动与投放词：ENABLED、PAUSED、ARCHIVED 等；搜索词：TARGETED、NEGATED、UNTARGETED。 */
  state: string | null
  bid: number | null
  budget: number | null
  daily: AdsRuleDay[]
}

export interface AdsRuleHit {
  key: string
  label: string
  campaignLabel: string | null
  /** 触发时各条件指标的取值（单位同指标）；没有数据为 null。 */
  metrics: Record<string, number | null>
  actionType: AdsRuleActionType
  /** 动作前后的值：竞价与预算是金额文字，状态是状态名，搜索词是“未投放”与匹配方式。 */
  before: string | null
  after: string | null
  /** 例如“按单次调整幅度上限从 +50% 收窄为 +30%”。 */
  notes: string[]
  /** 排序用：近 30 天花费，没有为 null。 */
  spend: number | null
}

export interface AdsRuleSkip {
  key: string
  label: string
  reason: string
}

export interface AdsRuleEvaluation {
  /** 通过范围与文本过滤、真正参与判断的对象数。 */
  evaluated: number
  /** 条件全部满足的对象数（含后来因状态或护栏不能动作的）。 */
  matched: number
  hits: AdsRuleHit[]
  skipped: AdsRuleSkip[]
}

// ---- 接口响应 ----

export interface AdsRuleRow {
  id: string
  adsProfileId: string
  accountName: string
  storeName: string | null
  name: string
  mode: AdsRuleMode
  status: AdsRuleStatus
  frequency: AdsRuleFrequency
  spec: AdsRuleSpec
  /** 中文摘要：条件、过滤、动作、护栏、范围。 */
  summary: { conditions: string; filters: string | null; action: string; guardrails: string; scope: string }
  lastRunAt: string | null
  /** 最近一次定时评估的对象数与命中数；从没评估过为 null。 */
  lastEvaluated: number | null
  lastMatched: number | null
  version: number
  createdAt: string
  updatedAt: string
  updatedByName: string | null
}

export interface AdsRuleProfileOption {
  id: string
  name: string
  storeName: string | null
}

export interface AdsRuleAutoStatus {
  allowed: boolean
  /** 开关没开时的原因（含强制关闭）；开了为 null。 */
  reason: string | null
}

export interface AdsRuleListResponse {
  rules: { state: Exclude<DashState, 'RESTRICTED'>; note: string | null; items: AdsRuleRow[]; truncated: boolean }
  profiles: AdsRuleProfileOption[]
  canWrite: boolean
  auto: AdsRuleAutoStatus
  execution: typeof ADS_RULE_EXECUTION_PENDING
}

export interface AdsRuleTotalsView {
  spend: number | null
  sales: number | null
  orders: number
  clicks: number
  acos: number | null
}

export interface AdsRuleEffect {
  state: Exclude<DashState, 'RESTRICTED'>
  note: string | null
  /** 统计了几次已执行的动作（前后 7 天都有数据的才算）。 */
  samples: number
  windowDays: number
  before: AdsRuleTotalsView | null
  after: AdsRuleTotalsView | null
}

export interface AdsRuleQuality {
  windowDays: number
  lastScan: { at: string | null; evaluated: number | null; matched: number | null; hitRate: number | null }
  recent: { runs: number; suggested: number; applied: number; skipped: number; failed: number; objects: number }
  /** 建议生成的待办里，已被处理（已处理、无需处理、误报）与仍在处理中的个数；采纳率 = 已处理 ÷ 已关闭。 */
  adoption: { state: Exclude<DashState, 'RESTRICTED'>; open: number; handled: number; notNeeded: number; falsePositive: number; adoptionRate: number | null }
  effect: AdsRuleEffect
  notes: string[]
}

export interface AdsRuleDetailResponse {
  rule: AdsRuleRow
  quality: AdsRuleQuality
  canWrite: boolean
  auto: AdsRuleAutoStatus
  execution: typeof ADS_RULE_EXECUTION_PENDING
}

export interface AdsRuleDryRunResponse {
  state: Exclude<DashState, 'RESTRICTED'>
  note: string | null
  /** 评估截止的那一天（窗口从它往前数）。 */
  asOf: string
  /** 库里这个账户最新有指标的一天；没有数据为 null。 */
  dataThrough: string | null
  evaluated: number
  matched: number
  dailyLimit: number
  hits: AdsRuleHit[]
  skipped: AdsRuleSkip[]
  /** 命中或跳过的对象超过返回上限，只列了前面一部分。 */
  truncated: boolean
  /** 读取的对象或指标行数超过上限，评估可能不完整。 */
  incomplete: boolean
  caveats: readonly string[]
}

export interface AdsRuleRunRow {
  id: string
  entityKey: string
  entityLabel: string | null
  actionType: AdsRuleActionType
  before: string | null
  after: string | null
  outcome: AdsRuleRunOutcome
  executed: boolean
  message: string | null
  workItemId: string | null
  /** 触发时的指标取值。 */
  evidence: Record<string, number | null>
  runAt: string
}

export interface AdsRuleRunsResponse {
  state: Exclude<DashState, 'RESTRICTED'>
  note: string | null
  items: AdsRuleRunRow[]
  pageInfo: CursorPageInfo
}

/** 创建与修改的返回：最新的规则行。 */
export interface AdsRuleWriteResult {
  rule: AdsRuleRow
}

export const ADS_RULE_DRY_RUN_CAVEATS = [
  '试运行只读，不改任何数据，也不生成待办；只用日级指标，评估截止日之后的数据不参与。',
  '按当前的对象状态、竞价与预算计算：历史上这些值可能不同，所以动作前后的值只是“如果现在执行”的结果。',
  '没有数据的指标不会被当成 0：缺数据的对象一律不命中。只统计美元账户。',
  '每个规则每天最多处理“每日执行次数上限”个对象，超出的对象按近 30 天花费从高到低取舍。',
] as const
