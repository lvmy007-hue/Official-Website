import type { BridgeKey } from './profit.js'
import type { BusinessRuleKey, BusinessRuleValue } from './business-rules.js'
import type { FormulaTag, FormulaTexts, MetricKind, MetricStatus, ProfitFormulaConfig } from './metric-versions.js'

// 口径版本接口的响应形状（P6-31）。纯类型。

export interface MetricVersionRef {
  kind: MetricKind
  /** 0 表示还没有生效版本，用系统默认配置。 */
  versionNo: number
  source: 'VERSION' | 'DEFAULT'
}
/** 响应里带的口径版本（利润、库存、经营控制台等）。 */
export interface MetricVersionsInUse {
  profitFormula: MetricVersionRef
  businessRules: MetricVersionRef
}

export interface MetricVersionView {
  id: string
  kind: MetricKind
  kindLabel: string
  versionNo: number
  status: MetricStatus
  statusLabel: string
  effectiveFrom: string | null
  /** 一句话说明这个版本改了什么（提交时生成）。 */
  summary: string
  reason: string | null
  createdBy: string | null
  createdByName: string | null
  createdAt: string
  approvedBy: string | null
  approvedByName: string | null
  /** 乐观锁版本号：审批时原样带回。 */
  version: number
  /** 发起人自己撤回。 */
  withdrawn: boolean
  mine: boolean
  config: unknown
}

export interface MetricVersionList {
  items: MetricVersionView[]
  page: number
  pageSize: number
  total: number
}

export interface FormulaRowInfo {
  key: BridgeKey
  label: string
  direction: 'INCOME' | 'COST' | 'RESULT'
  inGross: boolean
  inDenominator: boolean
}

export interface ProfitFormulaResponse {
  current: MetricVersionRef & { config: ProfitFormulaConfig; tags: FormulaTag[]; texts: FormulaTexts; effectiveFrom: string | null }
  /** 是否有待审批的修改。 */
  pending: MetricVersionView | null
  rows: FormulaRowInfo[]
  /** 提交修改时带回的“最新版本号”（含待审批与已驳回的）。 */
  latestVersionNo: number
  history: MetricVersionView[]
  canWrite: boolean
  canApprove: boolean
  writeBlockedReason: string | null
  note: string
}

export interface BusinessRuleCard {
  key: BusinessRuleKey
  label: string
  value: BusinessRuleValue
  valueText: string
  defaultText: string
  impact: readonly string[]
  /** 可选项（复选或单选由页面按 key 决定）。 */
  options: Array<{ value: string; label: string }>
  multiple: boolean
  pendingValue: BusinessRuleValue | null
}
export interface BusinessRulesResponse {
  current: MetricVersionRef & { effectiveFrom: string | null }
  cards: BusinessRuleCard[]
  pending: MetricVersionView | null
  latestVersionNo: number
  history: MetricVersionView[]
  canWrite: boolean
  canApprove: boolean
  writeBlockedReason: string | null
  note: string
}

export interface MetricSubmitResult {
  kind: MetricKind
  versionNo: number
  status: MetricStatus
  /** 刚提交的这一行的乐观锁版本号。 */
  version: number
  message: string
}
export interface MetricDecisionResult {
  kind: MetricKind
  versionNo: number
  status: MetricStatus
  message: string
}

export interface MetricDiffRow {
  /** YYYY-MM。 */
  month: string
  /** 该月是否已关账（快照不改动）。 */
  closed: boolean
  baseline: number | null
  proposed: number | null
  delta: number | null
  baselineMargin?: number | null
  proposedMargin?: number | null
  note: string | null
}
export interface MetricDiffReport {
  versionId: string
  kind: MetricKind
  /** 对比双方的版本号：基准是当前生效（没有为 0），目标是 :id 指定的版本。 */
  baselineVersionNo: number
  targetVersionNo: number
  from: string
  to: string
  /** 比较的数字：毛利润、净销售额，或配置文字差异。 */
  metric: 'GROSS_PROFIT' | 'NET_SALES' | 'CONFIG_ONLY'
  metricLabel: string
  configChanges: string[]
  rows: MetricDiffRow[]
  totalBaseline: number | null
  totalProposed: number | null
  totalDelta: number | null
  closedMonthsUntouched: number
  note: string
}

/** 利润总览里的毛利润与毛利率（按生效的利润公式实时计算；不改变净利润与利润率）。 */
export interface ProfitFormulaResult {
  versionNo: number
  source: 'VERSION' | 'DEFAULT'
  /** 问号里显示的当前公式文字。 */
  texts: FormulaTexts
  grossProfit: number | null
  grossMargin: number | null
  /** 公式里要算、但范围内没有数据而按 0 计入的项目名称（页面写“未含”）。 */
  missingLabels: string[]
  note: string | null
}
export interface ProfitNetSalesResult {
  versionNo: number
  source: 'VERSION' | 'DEFAULT'
  text: string
  value: number | null
}
