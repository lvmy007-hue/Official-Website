import { BRIDGE_DEFS, type BridgeKey } from './profit.js'

// 口径版本（P6-31，16 章第 7.1 节；freeze/models.md `MetricVersion`）：利润公式与业务口径可配置，每次修改形成新版本，走财务口径审批。
// 只有常量、类型与纯函数（零 zod，前端可引用）；请求校验在 metric-versions-query.ts。
//
// 约定：
//  - 同一企业同一类型同一时刻只有一个生效版本；没有任何生效版本时用系统默认配置（与改版前的计算逐项一致，版本号为 0）；
//  - 版本号 `versionNo` 与乐观锁列 `version` 是两回事；提交时带的是客户端看到的“最新版本号”（含待审批与已驳回的），别人先提交会 409；
//  - 默认配置必须与改版前的数字一致：利润公式只“新增”毛利润与毛利率两个数字，净利润与利润率不受影响。

export const METRIC_VERSION_READ = 'settings.read'
export const PROFIT_FORMULA_READ = 'finance.read'
export const BUSINESS_RULES_WRITE = 'settings.business.write'
export const METRIC_VERSION_ACTIONS = {
  submitted: 'METRIC_VERSION_SUBMITTED',
  approved: 'METRIC_VERSION_APPROVED',
  rejected: 'METRIC_VERSION_REJECTED',
  diffed: 'METRIC_VERSION_DIFFED',
} as const
export const METRIC_VERSION_LIMITS = { historyMax: 50, diffMaxDays: 366, reasonMax: 500 } as const

export const METRIC_KINDS = ['PROFIT_FORMULA', 'BUSINESS_RULES', 'PROFIT_DICTIONARY', 'ALLOCATION_RULES'] as const
export type MetricKind = (typeof METRIC_KINDS)[number]
export const METRIC_KIND_LABEL: Readonly<Record<MetricKind, string>> = {
  PROFIT_FORMULA: '利润公式',
  BUSINESS_RULES: '业务口径',
  PROFIT_DICTIONARY: '利润项目字典',
  ALLOCATION_RULES: '费用分摊规则',
}
/** 本包能编辑的两类；字典与分摊规则在各自页面里改，只在口径版本列表里查看。 */
export const EDITABLE_METRIC_KINDS = ['PROFIT_FORMULA', 'BUSINESS_RULES'] as const satisfies readonly MetricKind[]
export type EditableMetricKind = (typeof EDITABLE_METRIC_KINDS)[number]

export const METRIC_STATUSES = ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED'] as const
export type MetricStatus = (typeof METRIC_STATUSES)[number]
export const METRIC_STATUS_LABEL: Readonly<Record<MetricStatus, string>> = { DRAFT: '草稿', PENDING_APPROVAL: '待审批', ACTIVE: '生效中', RETIRED: '已失效' }

export const isMetricKind = (value: string): value is MetricKind => (METRIC_KINDS as readonly string[]).includes(value)

// ---- 利润公式 ----

/** 公式表里的行：利润桥的项目去掉净利润（结果）与汇兑损益（尚未接入），顺序即利润桥的顺序。 */
export const FORMULA_KEYS: readonly BridgeKey[] = [
  'REVENUE',
  'REFUNDS',
  'COMMISSION',
  'FULFILLMENT',
  'STORAGE',
  'AGED_SURCHARGE',
  'INBOUND_PLACEMENT',
  'OTHER_FEES',
  'PROMOTION',
  'ADS',
  'PRODUCT_COST',
  'FIRST_MILE',
  'DUTY',
  'OTHER_COST',
  'REIMBURSEMENT',
]
const FORMULA_KEY_SET: ReadonlySet<string> = new Set(FORMULA_KEYS)
export const isFormulaKey = (value: string): value is BridgeKey => FORMULA_KEY_SET.has(value)

export interface ProfitFormulaConfig {
  /** 计入毛利润的项目（按各项对净利润的带符号贡献相加）。 */
  gross: BridgeKey[]
  /** 作为毛利率分母的项目（按贡献相加，收入为正）。 */
  denominator: BridgeKey[]
}

/** 默认公式：毛利润 = 销售额 − 退款 − 促销 − 平台费用（佣金、配送、仓储、库龄附加、入仓配置、其他）− 采购成本 − 头程 − 关税；不含广告、其他成本与赔付；分母是销售额。 */
export const DEFAULT_PROFIT_FORMULA: Readonly<ProfitFormulaConfig> = {
  gross: ['REVENUE', 'REFUNDS', 'COMMISSION', 'FULFILLMENT', 'STORAGE', 'AGED_SURCHARGE', 'INBOUND_PLACEMENT', 'OTHER_FEES', 'PROMOTION', 'PRODUCT_COST', 'FIRST_MILE', 'DUTY'],
  denominator: ['REVENUE'],
}

const inOrder = (keys: readonly string[]): BridgeKey[] => FORMULA_KEYS.filter(key => keys.includes(key))

/** 把存储里读出来的 JSON 收窄成公式配置；形状不对返回 null（调用方回落到默认）。键按利润桥顺序、去重。 */
export function readFormulaConfig(raw: unknown): ProfitFormulaConfig | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { gross, denominator } = raw as Record<string, unknown>
  if (!Array.isArray(gross) || !Array.isArray(denominator)) return null
  const valid = (list: unknown[]) => list.every(item => typeof item === 'string' && isFormulaKey(item))
  if (!valid(gross) || !valid(denominator)) return null
  return { gross: inOrder(gross as string[]), denominator: inOrder(denominator as string[]) }
}

/** 公式的合法性：至少一个毛利润项目；分母至少一个，且必须是收入类项目（销售额、赔付收入），否则毛利率没有意义。 */
export function formulaIssues(config: ProfitFormulaConfig): string[] {
  const issues: string[] = []
  if (config.gross.length === 0) issues.push('毛利润至少要计入一个项目')
  if (config.gross.length > 0 && !config.gross.some(key => BRIDGE_DEFS[key].direction === 'INCOME')) issues.push('毛利润至少要计入一个收入类项目（销售额或赔付收入）')
  if (config.denominator.length === 0) issues.push('毛利率的分母至少要选一个项目')
  const notIncome = config.denominator.filter(key => BRIDGE_DEFS[key].direction !== 'INCOME')
  if (notIncome.length > 0) issues.push(`毛利率的分母只能选收入类项目，${notIncome.map(key => BRIDGE_DEFS[key].label).join('、')}是花费`)
  return issues
}

export const sameFormula = (a: ProfitFormulaConfig, b: ProfitFormulaConfig): boolean => a.gross.join() === b.gross.join() && a.denominator.join() === b.denominator.join()

/** 公式的文字写法：加号项在前、减号项在后（花费项是“−”）。 */
export function describeFormulaKeys(keys: readonly BridgeKey[]): string {
  if (keys.length === 0) return '（空）'
  const ordered = [...keys.filter(key => BRIDGE_DEFS[key].direction === 'INCOME'), ...keys.filter(key => BRIDGE_DEFS[key].direction !== 'INCOME')]
  return ordered.map((key, index) => `${termSign(key, index)}${BRIDGE_DEFS[key].label}`).join(' ')
}
function termSign(key: BridgeKey, index: number): string {
  const income = BRIDGE_DEFS[key].direction === 'INCOME'
  if (index === 0) return income ? '' : '− '
  return income ? '+ ' : '− '
}

export interface FormulaTag {
  key: BridgeKey
  label: string
  /** 加（收入类）或减（花费类）。 */
  sign: 1 | -1
}
/** 页面顶部的彩色标签：每个计入毛利润的项目一枚，加项与减项颜色不同。 */
export const formulaTags = (config: ProfitFormulaConfig): FormulaTag[] => config.gross.map(key => ({ key, label: BRIDGE_DEFS[key].label, sign: BRIDGE_DEFS[key].direction === 'INCOME' ? 1 : -1 }))

export interface FormulaTexts {
  gross: string
  margin: string
}
export const describeFormula = (config: ProfitFormulaConfig): FormulaTexts => ({
  gross: `毛利润 = ${describeFormulaKeys(config.gross)}`,
  margin: `毛利率 = 毛利润 ÷ (${config.denominator.map(key => BRIDGE_DEFS[key].label).join(' + ') || '（空）'})`,
})

export interface FormulaBridgeItem {
  key: string
  /** 对净利润的带符号贡献；没有数据为 null。 */
  contribution: number | null
  state: string
}
export interface FormulaEvaluation {
  grossProfit: number | null
  grossMargin: number | null
  denominator: number | null
  /** 公式里要算、但范围内没有数据的项目（按 0 计入，页面要写明“未含”）。 */
  missing: BridgeKey[]
  /** 算不出毛利润或毛利率的原因；能算出为 null。 */
  note: string | null
}

const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000

/**
 * 按公式从利润桥算毛利润与毛利率（纯函数，API 与差异报告共用）。
 * 采购成本是毛利润的底座：公式里计入采购成本却没有这项数据（缺成本或没有成本字段权限）时，不给毛利润，不拿缺了成本的数字冒充；
 * 其他项目没有数据（例如没有关税）说明这一类花费没有发生或没有来源，按 0 计入并列在 `missing` 里。
 */
export function evaluateFormula(config: ProfitFormulaConfig, items: readonly FormulaBridgeItem[], rows: number): FormulaEvaluation {
  const byKey = new Map(items.map(item => [item.key, item]))
  const empty = (note: string): FormulaEvaluation => ({ grossProfit: null, grossMargin: null, denominator: null, missing: [], note })
  if (rows === 0) return empty('范围内没有利润日表数据')
  const restricted = [...config.gross, ...config.denominator].filter(key => byKey.get(key)?.state === 'RESTRICTED')
  if (restricted.length > 0) return empty(`没有成本字段权限（field.cost），${[...new Set(restricted)].map(key => BRIDGE_DEFS[key].label).join('、')}算不出`)
  const missing = config.gross.filter(key => (byKey.get(key)?.contribution ?? null) === null)
  if (config.gross.includes('PRODUCT_COST') && missing.includes('PRODUCT_COST')) return empty('采购成本没有数据（没有生效的成本版本或成本没有覆盖），毛利润不给')
  const gross = round6(config.gross.reduce((sum, key) => sum + (byKey.get(key)?.contribution ?? 0), 0))
  const parts = config.denominator.map(key => byKey.get(key)?.contribution ?? null)
  const denominator = parts.every(part => part === null) ? null : round6(parts.reduce<number>((sum, part) => sum + (part ?? 0), 0))
  const margin = denominator === null || denominator <= 0 ? null : round6(gross / denominator)
  return {
    grossProfit: gross,
    grossMargin: margin,
    denominator,
    missing,
    note: margin === null ? '分母不为正，毛利率没有意义' : null,
  }
}

/** 关账快照里记录各类口径版本的键（与分摊规则的 `allocationRules` 并列，写进 PeriodSnapshot.metricVersionSnapshotJson）。 */
export const METRIC_SNAPSHOT_KEYS = { formula: 'profitFormula', rules: 'businessRules', dictionary: 'profitDictionary' } as const
export interface MetricSnapshotEntry {
  versionNo: number
  source: 'VERSION' | 'DEFAULT'
  config?: unknown
}

/** 两份利润公式的差别，逐条写成人话（提交摘要、审计与差异报告共用）。 */
export function describeFormulaChanges(before: ProfitFormulaConfig, after: ProfitFormulaConfig): string[] {
  const names = (keys: readonly BridgeKey[]) => keys.map(key => BRIDGE_DEFS[key].label).join('、')
  const changes: string[] = []
  const addedGross = after.gross.filter(key => !before.gross.includes(key))
  const removedGross = before.gross.filter(key => !after.gross.includes(key))
  if (addedGross.length > 0) changes.push(`毛利润新增计入：${names(addedGross)}`)
  if (removedGross.length > 0) changes.push(`毛利润不再计入：${names(removedGross)}`)
  const addedDen = after.denominator.filter(key => !before.denominator.includes(key))
  const removedDen = before.denominator.filter(key => !after.denominator.includes(key))
  if (addedDen.length > 0) changes.push(`毛利率分母新增：${names(addedDen)}`)
  if (removedDen.length > 0) changes.push(`毛利率分母不再包含：${names(removedDen)}`)
  return changes
}
