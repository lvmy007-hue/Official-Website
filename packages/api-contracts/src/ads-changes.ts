import type { DashPeriod, DashState } from './dashboard'
import type { CursorPageInfo } from './query'

// 广告变更记录契约（P3-14，08 章 8.11）：只有常量与类型，没有 zod（请求校验在 ads-changes-query.ts，纯函数在 ads-changes-math.ts）。
// 变更记录汇总广告对象（活动、广告组、投放对象、关键词、广告组合）的字段变化，四种来源：
//   手动（MANUAL）、自动规则（AUTO_RULE）、分时策略（DAYPARTING）——这三类由本系统的广告写入记录（P3-17），亚马逊确认写入成功后才记；
//   外部变更（EXTERNAL）——亚马逊侧或其他工具做的改动，worker 定时对比实体快照识别：只能确定发生在“上一次快照”与“检测到”之间，不知道是谁改的。
// 没有数据写“尚无记录”，没拍过快照写“尚未接入”，空值不是 0。

export const ADS_CHANGE_SOURCES = ['MANUAL', 'AUTO_RULE', 'DAYPARTING', 'EXTERNAL'] as const
export type AdsChangeSource = (typeof ADS_CHANGE_SOURCES)[number]
export const ADS_CHANGE_SOURCE_LABEL: Record<AdsChangeSource, string> = { MANUAL: '手动', AUTO_RULE: '自动规则', DAYPARTING: '分时策略', EXTERNAL: '外部变更' }

export const ADS_CHANGE_ENTITY_TYPES = ['CAMPAIGN', 'AD_GROUP', 'TARGET', 'KEYWORD', 'PORTFOLIO'] as const
export type AdsChangeEntityType = (typeof ADS_CHANGE_ENTITY_TYPES)[number]
export const ADS_CHANGE_ENTITY_LABEL: Record<AdsChangeEntityType, string> = { CAMPAIGN: '广告活动', AD_GROUP: '广告组', TARGET: '投放对象', KEYWORD: '关键词', PORTFOLIO: '广告组合' }

/** 变更字段的取值类型：决定对比前怎么规整（金额取数值、状态转大写、日期取年月日、文字去首尾空格）。 */
export type AdsChangeFieldKind = 'text' | 'money' | 'state' | 'date'
export interface AdsChangeFieldInfo {
  key: string
  label: string
  kind: AdsChangeFieldKind
}

/** 每种对象要追踪的字段（用户能改的）；投放状态、指标、标签与负责人（本系统自己的数据）不在内。 */
export const ADS_CHANGE_FIELDS: Record<AdsChangeEntityType, readonly AdsChangeFieldInfo[]> = {
  CAMPAIGN: [
    { key: 'name', label: '名称', kind: 'text' },
    { key: 'state', label: '状态', kind: 'state' },
    { key: 'budget', label: '日预算', kind: 'money' },
    { key: 'bidStrategy', label: '竞价策略', kind: 'text' },
    { key: 'portfolioId', label: '所属广告组合', kind: 'text' },
    { key: 'startDate', label: '开始日期', kind: 'date' },
    { key: 'endDate', label: '结束日期', kind: 'date' },
  ],
  AD_GROUP: [
    { key: 'name', label: '名称', kind: 'text' },
    { key: 'state', label: '状态', kind: 'state' },
    { key: 'defaultBid', label: '默认竞价', kind: 'money' },
  ],
  TARGET: [
    { key: 'expression', label: '投放表达式', kind: 'text' },
    { key: 'matchType', label: '匹配方式', kind: 'text' },
    { key: 'bid', label: '竞价', kind: 'money' },
    { key: 'state', label: '状态', kind: 'state' },
  ],
  KEYWORD: [
    { key: 'text', label: '关键词', kind: 'text' },
    { key: 'matchType', label: '匹配方式', kind: 'text' },
    { key: 'bid', label: '竞价', kind: 'money' },
    { key: 'state', label: '状态', kind: 'state' },
  ],
  PORTFOLIO: [
    { key: 'name', label: '名称', kind: 'text' },
    { key: 'budgetCap', label: '预算上限', kind: 'money' },
    { key: 'budgetPeriod', label: '预算周期', kind: 'text' },
    { key: 'budgetStart', label: '预算开始日', kind: 'date' },
    { key: 'budgetEnd', label: '预算结束日', kind: 'date' },
    { key: 'status', label: '状态', kind: 'state' },
  ],
}

/** 对象新出现（不是某个字段变了）的特殊字段名；afterValue 放对象名称。 */
export const ADS_CHANGE_CREATED = '__created'
export const ADS_CHANGE_CREATED_LABEL = '新出现'

/** 常见的广告状态中文（取值以亚马逊返回为准，没列出的原样显示）。 */
export const ADS_CHANGE_STATE_LABEL: Record<string, string> = {
  ENABLED: '已启用',
  PAUSED: '已暂停',
  ARCHIVED: '已归档',
  PROPOSED: '待审核',
  ACTIVE: '生效中',
  DISABLED: '已停用',
}

export const ADS_CHANGE_LIMITS = {
  /** 单个值最长字符数（超过截断，防止异常长的名称撑爆表）。 */
  valueMax: 500,
  labelMax: 200,
  /** 对照里最多列出同一批改动的多少个字段，以及同一对象最近的其他变更多少条。 */
  compareFieldMax: 60,
  compareRelatedMax: 10,
  /** 识别外部变更时，往前看多久的“本系统写入”来排除自己的改动（毫秒）。 */
  ownWriteLookbackMs: 24 * 3_600_000,
  /** 第一次拍快照之后多久内出现的新对象算初始同步的一部分，不记“新出现”（毫秒）。 */
  baselineGraceMs: 24 * 3_600_000,
  /** 超过这个天数的、已被更新的快照可以清理（每个对象总是保留最新一份）。 */
  snapshotKeepDays: 180,
  /** 每个对象最多保留多少份快照。 */
  snapshotKeepMax: 30,
} as const

export const ADS_CHANGE_EXTERNAL_NOTE = '外部变更通过对比两次实体快照识别：只能确定改动发生在“上一次快照”与“检测到”之间，不知道是谁改的；本系统自己写入的改动会按记录排除，不会被当成外部变更。'
export const ADS_CHANGE_WRITE_PENDING = {
  state: 'CONNECTED' as const,
  note: '手动、自动规则与分时策略的变更由广告写入记录：亚马逊确认写入成功之后才会出现在这里（提交后排队中或失败的写入在下方“写入记录”里看）。',
}

export interface AdsChangeRow {
  id: string
  source: AdsChangeSource
  entityType: AdsChangeEntityType
  /** 对象的系统编号（可用来打开详情页）。 */
  entityId: string
  /** 变更当时的对象名称；没有记下来为 null。 */
  entityLabel: string | null
  /** 字段名（`ADS_CHANGE_CREATED` 表示对象新出现）。 */
  field: string
  fieldLabel: string
  before: string | null
  after: string | null
  /** 外部变更：检测到的时间；其他来源：写入时间。 */
  occurredAt: string
  /** 外部变更：上一次快照的时间（改动发生在它与 occurredAt 之间）；其他来源为 null。 */
  sinceAt: string | null
  /** 手动变更的操作人；其他来源为 null（页面按来源显示“自动规则”“分时策略”“未知（外部）”）。 */
  actorName: string | null
  accountName: string
  storeName: string | null
  writeRunId: string | null
  /** 对象详情页的路径；对象类型没有详情页时为 null。 */
  path: string | null
}

export interface AdsChangeTracking {
  /** OK：已拍过快照；NOT_CONNECTED：范围内一次快照都没有（广告实体还没同步入库，或 worker 还没扫描过）。 */
  state: 'OK' | 'NOT_CONNECTED'
  lastSnapshotAt: string | null
  note: string
}

export interface AdsChangeProfileOption {
  id: string
  name: string
  storeName: string | null
}

export interface AdsChangeListResponse {
  state: DashState
  note: string | null
  period: DashPeriod
  defaulted: boolean
  items: AdsChangeRow[]
  /** 各来源的条数（按其他筛选条件算，不受“来源”筛选影响，页面用来做来源切换条）。 */
  counts: Record<AdsChangeSource, number>
  tracking: AdsChangeTracking
  write: typeof ADS_CHANGE_WRITE_PENDING
  externalNote: string
  profiles: AdsChangeProfileOption[]
  pageInfo: CursorPageInfo
}

export interface AdsChangeCompareField {
  key: string
  label: string
  before: string | null
  after: string | null
  changed: boolean
}

export interface AdsChangeCompareResponse {
  change: AdsChangeRow
  /** SNAPSHOT：有该时刻的实体快照，所有追踪字段都列出；CHANGE_ONLY：只有变更记录，只列被改的字段。 */
  basis: 'SNAPSHOT' | 'CHANGE_ONLY'
  basisNote: string
  fields: AdsChangeCompareField[]
  /** 同一对象前后的其他变更（最近若干条，不含这一批）。 */
  related: AdsChangeRow[]
}
