import { INVENTORY_COSTING_LABEL, PROFIT_BASIS_LABEL, type InventoryCosting, type ProfitBasis } from './profit.js'

// 财务口径设置（P2b-15，09 章 9.12 第 2 个页签）：收入确认口径、存货计价方法、广告分摊规则、店铺级费用分摊规则。
// 只有常量与类型（zod 在 finance-policy-query.ts）。修改要经审批、带版本；已关账期间的数字不受影响。

export const FINANCE_POLICY_READ = 'settings.read'
export const FINANCE_POLICY_WRITE = 'finance.policy.write'
/** 再次验证身份的动作名（STEP_UP_ACTIONS 里的 'finance.policy'）。 */
export const FINANCE_POLICY_STEP_UP = 'finance.policy'

export const FINANCE_POLICY_HISTORY_LIMIT = 50
/** 生效日期最多往前补多少天（再早的数没有意义，也不该靠改口径翻旧账）。 */
export const FINANCE_POLICY_BACKDATE_DAYS = 366

export const POLICY_STATUSES = ['PENDING', 'ACTIVE', 'REPLACED', 'REJECTED'] as const
export type PolicyStatus = (typeof POLICY_STATUSES)[number]
export const POLICY_STATUS_LABEL: Readonly<Record<PolicyStatus, string>> = { PENDING: '待审批', ACTIVE: '生效中', REPLACED: '已替换', REJECTED: '已驳回或撤回' }

/** 广告与店铺级费用都按销售额（默认）或销量分摊到商品。 */
export const ALLOCATION_BASES = ['BY_SALES', 'BY_UNITS'] as const
export type AllocationBasis = (typeof ALLOCATION_BASES)[number]
export const ALLOCATION_BASIS_LABEL: Readonly<Record<AllocationBasis, string>> = { BY_SALES: '按销售额', BY_UNITS: '按销量' }

/** 汇率折算规则目前只有一种（利润按销售日汇率折美元），先登记在版本里，保证以后多一种时旧版本仍可复现。 */
export const FX_RATE_RULES = ['SALE_DAY'] as const
export type FxRateRule = (typeof FX_RATE_RULES)[number]
export const FX_RATE_RULE_LABEL: Readonly<Record<FxRateRule, string>> = { SALE_DAY: '按销售日汇率折算，当天没有汇率时沿用前值（上限见汇率页）' }

export interface PolicyValues {
  revenueRecognition: ProfitBasis
  inventoryCostMethod: InventoryCosting
  fxRateRule: FxRateRule
  adsAllocationMode: AllocationBasis
  storeFeeAllocation: AllocationBasis
}
export type PolicyKey = keyof PolicyValues
export const POLICY_KEYS: readonly PolicyKey[] = ['revenueRecognition', 'inventoryCostMethod', 'fxRateRule', 'adsAllocationMode', 'storeFeeAllocation']

/** 没有任何已生效版本时的口径：与现有计算保持一致（下单口径、先进先出、销售日汇率、按销售额分摊）。 */
export const DEFAULT_POLICY: Readonly<PolicyValues> = {
  revenueRecognition: 'ORDERED',
  inventoryCostMethod: 'FIFO',
  fxRateRule: 'SALE_DAY',
  adsAllocationMode: 'BY_SALES',
  storeFeeAllocation: 'BY_SALES',
}

export const POLICY_VALUE_LABEL: { [K in PolicyKey]: Readonly<Record<PolicyValues[K], string>> } = {
  revenueRecognition: PROFIT_BASIS_LABEL,
  inventoryCostMethod: INVENTORY_COSTING_LABEL,
  fxRateRule: FX_RATE_RULE_LABEL,
  adsAllocationMode: ALLOCATION_BASIS_LABEL,
  storeFeeAllocation: ALLOCATION_BASIS_LABEL,
}

export const POLICY_KEY_LABEL: Readonly<Record<PolicyKey, string>> = {
  revenueRecognition: '收入确认口径',
  inventoryCostMethod: '存货计价方法',
  fxRateRule: '汇率折算规则',
  adsAllocationMode: '广告分摊规则',
  storeFeeAllocation: '店铺级费用分摊规则',
}

/** 这条口径现在被谁使用（店铺级费用分摊自 P6-19 起已接入，按费用项在 /app/finance/allocation-rules 配置）：WIRED 是已经被计算使用，RECORDED 只是登记在版本里、对应的计算还没有接入。 */
export type PolicyConsumer = 'WIRED' | 'RECORDED'

export interface PolicyFieldInfo {
  key: PolicyKey
  label: string
  description: string
  consumer: PolicyConsumer
  /** 使用情况的说明（已接入时写用在哪里；未接入时写什么时候接入）。 */
  consumerNote: string
  /** 只有一种取值的字段不能改。 */
  editable: boolean
  options: Array<{ value: string; label: string }>
}

export interface PolicyVersionView extends PolicyValues {
  id: string
  versionNo: number
  status: PolicyStatus
  effectiveFrom: string
  reason: string | null
  /** 乐观锁版本号：审批时带上。 */
  version: number
  createdBy: string
  createdByName: string | null
  createdAt: string
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: string | null
  decisionComment: string | null
  /** 驳回的人就是发起人：算撤回。 */
  withdrawn: boolean
  /** 是当前用户提交的（页面据此把驳回写成撤回）。 */
  mine: boolean
  /** 生效后被替换的时间。 */
  replacedAt: string | null
}

export interface PolicyCurrent {
  /** DEFAULT：还没有任何审批通过的版本，用的是系统默认口径（存货计价可能来自历史上手工写入的企业设置）。 */
  source: 'VERSION' | 'DEFAULT'
  versionNo: number
  effectiveFrom: string | null
  values: PolicyValues
  /** 企业设置里的存货计价取值不合法时为 false（利润计算会退回先进先出）。 */
  inventoryMethodValid: boolean
}

export interface PolicyAction {
  allowed: boolean
  reason: string | null
}

export interface FinancePolicyResponse {
  current: PolicyCurrent
  pending: PolicyVersionView | null
  history: PolicyVersionView[]
  historyTruncated: boolean
  /** 目前最新的版本号（含待审批与已驳回的），提交时带回，防止两个人同时改。 */
  latestVersionNo: number
  fields: PolicyFieldInfo[]
  /** 企业时区的今天。 */
  today: string
  actions: { submit: PolicyAction; approve: PolicyAction; reject: PolicyAction }
  /** 当前关账中或已关账的期间数（说明用）：这些期间的利润不会因为口径变化而重算。 */
  frozenPeriodCount: number
}

export interface PolicySubmitResult {
  versionNo: number
  version: number
  status: PolicyStatus
  message: string
}

export interface PolicyDecisionResult {
  versionNo: number
  status: PolicyStatus
  message: string
}
