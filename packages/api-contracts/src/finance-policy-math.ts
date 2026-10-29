import {
  DEFAULT_POLICY,
  FINANCE_POLICY_BACKDATE_DAYS,
  POLICY_KEYS,
  POLICY_KEY_LABEL,
  POLICY_VALUE_LABEL,
  type PolicyAction,
  type PolicyKey,
  type PolicyValues,
  type PolicyVersionView,
} from './finance-policy.js'

// 财务口径设置的纯函数（P2b-15）：口径比较、可用动作、生效日检查、变化描述。不碰数据库与时钟，API、worker 与前端共用。日期都是 YYYY-MM-DD 文本。

const DAY_MS = 86_400_000
const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

export const policyValuesOf = (source: PolicyValues): PolicyValues => ({
  revenueRecognition: source.revenueRecognition,
  inventoryCostMethod: source.inventoryCostMethod,
  fxRateRule: source.fxRateRule,
  adsAllocationMode: source.adsAllocationMode,
  storeFeeAllocation: source.storeFeeAllocation,
})

/** 两份口径里取值不同的项。 */
export function changedPolicyKeys(a: PolicyValues, b: PolicyValues): PolicyKey[] {
  return POLICY_KEYS.filter(key => a[key] !== b[key])
}

/** 一项口径取值的中文。 */
export function policyValueText<K extends PolicyKey>(key: K, value: PolicyValues[K]): string {
  const labels = POLICY_VALUE_LABEL[key] as Readonly<Record<string, string>>
  return labels[value] ?? String(value)
}

/** “存货计价：先进先出 → 月末加权平均”这样的变化描述，给审批人与审计看。 */
export function describePolicyChanges(from: PolicyValues, to: PolicyValues): string[] {
  return changedPolicyKeys(from, to).map(key => `${POLICY_KEY_LABEL[key]}：${policyValueText(key, from[key])} → ${policyValueText(key, to[key])}`)
}

/** 没有任何生效版本时的口径；存货计价取企业设置里已有的值（历史上手工写入的）。 */
export function defaultPolicyWith(inventoryCostMethod?: PolicyValues['inventoryCostMethod']): PolicyValues {
  return { ...DEFAULT_POLICY, inventoryCostMethod: inventoryCostMethod ?? DEFAULT_POLICY.inventoryCostMethod }
}

export interface PolicyActionInput {
  canWrite: boolean
  /** 当前待审批的版本；没有为 null。 */
  pending: Pick<PolicyVersionView, 'createdBy'> | null
  userId: string
}

const ok: PolicyAction = { allowed: true, reason: null }
const no = (reason: string): PolicyAction => ({ allowed: false, reason })
const NO_PERMISSION = '需要“修改财务口径”权限（finance.policy.write）'

/**
 * 页面按它启用按钮：
 * - 提交：有权限且没有待审批的版本（一次只审一个，避免两份修改互相覆盖）；
 * - 通过：有权限、有待审批版本、且不是发起人自己（发起人与审批人不能是同一人，permissions.md 第 3 条）；
 * - 驳回：有权限且有待审批版本；发起人自己驳回算撤回（单人企业也能撤掉写错的修改）。
 */
export function policyActionsOf(input: PolicyActionInput): { submit: PolicyAction; approve: PolicyAction; reject: PolicyAction } {
  const { canWrite, pending, userId } = input
  if (!canWrite) return { submit: no(NO_PERMISSION), approve: no(NO_PERMISSION), reject: no(NO_PERMISSION) }
  if (!pending) return { submit: ok, approve: no('没有待审批的修改'), reject: no('没有待审批的修改') }
  const own = pending.createdBy === userId
  return {
    submit: no('已有一份待审批的修改：请先审批通过、驳回或撤回，再提交新的修改'),
    approve: own ? no('发起人不能审批自己的修改，需要另一位有“修改财务口径”权限的成员审批') : ok,
    reject: ok,
  }
}

/** 生效日的取值范围检查：不晚于今天，也不早于 FINANCE_POLICY_BACKDATE_DAYS 天前。返回问题说明，没有问题返回 null。 */
export function policyEffectiveIssue(effectiveFrom: string, today: string): string | null {
  if (effectiveFrom > today) return `生效日不能晚于今天（${today}）：口径一经审批立即生效，不支持预约`
  const earliest = shiftDay(today, -FINANCE_POLICY_BACKDATE_DAYS)
  if (effectiveFrom < earliest) return `生效日不能早于 ${earliest}（最多往前 ${FINANCE_POLICY_BACKDATE_DAYS} 天）`
  return null
}

/** 把存货计价取值收窄成合法值；不认识的返回 null。 */
export function inventoryMethodOf(value: unknown): PolicyValues['inventoryCostMethod'] | null {
  return value === 'FIFO' || value === 'MOVING_AVG' || value === 'MONTH_AVG' ? value : null
}
