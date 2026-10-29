import { describe, expect, it } from 'vitest'
import { ALLOCATION_BASES, DEFAULT_POLICY, FINANCE_POLICY_BACKDATE_DAYS, FX_RATE_RULES, POLICY_KEYS, POLICY_VALUE_LABEL, type PolicyValues } from './finance-policy.js'
import { changedPolicyKeys, defaultPolicyWith, describePolicyChanges, inventoryMethodOf, policyActionsOf, policyEffectiveIssue, policyValueText, policyValuesOf } from './finance-policy-math.js'
import { FinancePolicyApprovalBodySchema, FinancePolicySubmitBodySchema, FinancePolicyVersionParamSchema } from './finance-policy-query.js'
import { INVENTORY_COSTINGS, PROFIT_BASES } from './profit.js'

// 财务口径设置（P2b-15）的纯函数与请求校验：口径比较与变化描述、可用动作（发起人不能审批自己的）、生效日范围、请求体。

const policy = (over: Partial<PolicyValues> = {}): PolicyValues => ({ ...DEFAULT_POLICY, ...over })

describe('口径取值与标签', () => {
  it('每项口径的每个取值都有中文标签；默认口径与现有利润计算一致', () => {
    for (const key of POLICY_KEYS) {
      const labels = POLICY_VALUE_LABEL[key] as Record<string, string>
      expect(Object.values(labels).every(text => text.length > 0)).toBe(true)
    }
    expect(Object.keys(POLICY_VALUE_LABEL.revenueRecognition)).toEqual([...PROFIT_BASES])
    expect(Object.keys(POLICY_VALUE_LABEL.inventoryCostMethod)).toEqual([...INVENTORY_COSTINGS])
    expect(Object.keys(POLICY_VALUE_LABEL.adsAllocationMode)).toEqual([...ALLOCATION_BASES])
    expect(DEFAULT_POLICY).toEqual({ revenueRecognition: 'ORDERED', inventoryCostMethod: 'FIFO', fxRateRule: 'SALE_DAY', adsAllocationMode: 'BY_SALES', storeFeeAllocation: 'BY_SALES' })
    expect(FX_RATE_RULES).toEqual(['SALE_DAY'])
  })

  it('policyValuesOf 只取五项口径；defaultPolicyWith 只替换存货计价', () => {
    expect(policyValuesOf({ ...policy({ adsAllocationMode: 'BY_UNITS' }), extra: 1 } as PolicyValues)).toEqual(policy({ adsAllocationMode: 'BY_UNITS' }))
    expect(defaultPolicyWith('MONTH_AVG')).toEqual(policy({ inventoryCostMethod: 'MONTH_AVG' }))
    expect(defaultPolicyWith()).toEqual(DEFAULT_POLICY)
  })

  it('inventoryMethodOf：只认三种合法取值', () => {
    expect(inventoryMethodOf('MOVING_AVG')).toBe('MOVING_AVG')
    expect(inventoryMethodOf('LIFO')).toBeNull()
    expect(inventoryMethodOf(undefined)).toBeNull()
    expect(inventoryMethodOf(3)).toBeNull()
  })
})

describe('口径变化', () => {
  it('找出取值不同的项并按固定顺序描述；没有变化为空', () => {
    const next = policy({ revenueRecognition: 'SETTLED', inventoryCostMethod: 'MONTH_AVG', storeFeeAllocation: 'BY_UNITS' })
    expect(changedPolicyKeys(DEFAULT_POLICY, next)).toEqual(['revenueRecognition', 'inventoryCostMethod', 'storeFeeAllocation'])
    expect(describePolicyChanges(DEFAULT_POLICY, next)).toEqual(['收入确认口径：下单口径 → 结算释放口径', '存货计价方法：先进先出 → 月末加权平均', '店铺级费用分摊规则：按销售额 → 按销量'])
    expect(changedPolicyKeys(DEFAULT_POLICY, policy())).toEqual([])
    expect(describePolicyChanges(DEFAULT_POLICY, policy())).toEqual([])
    expect(policyValueText('adsAllocationMode', 'BY_UNITS')).toBe('按销量')
  })
})

describe('可用动作', () => {
  it('没有权限：全部不可用并说明需要的权限', () => {
    const actions = policyActionsOf({ canWrite: false, pending: null, userId: 'u1' })
    for (const key of ['submit', 'approve', 'reject'] as const) expect(actions[key]).toMatchObject({ allowed: false, reason: expect.stringContaining('finance.policy.write') })
  })

  it('没有待审批的修改：只能提交', () => {
    const actions = policyActionsOf({ canWrite: true, pending: null, userId: 'u1' })
    expect(actions.submit).toEqual({ allowed: true, reason: null })
    expect(actions.approve.allowed).toBe(false)
    expect(actions.reject.allowed).toBe(false)
  })

  it('有待审批的修改：不能再提交；发起人不能审批自己的，但可以撤回；别人可以审批与驳回', () => {
    const own = policyActionsOf({ canWrite: true, pending: { createdBy: 'u1' }, userId: 'u1' })
    expect(own.submit.allowed).toBe(false)
    expect(own.approve).toMatchObject({ allowed: false, reason: expect.stringContaining('发起人') })
    expect(own.reject.allowed).toBe(true)
    const others = policyActionsOf({ canWrite: true, pending: { createdBy: 'u1' }, userId: 'u2' })
    expect(others.approve.allowed).toBe(true)
    expect(others.reject.allowed).toBe(true)
  })
})

describe('生效日范围', () => {
  it('不晚于今天、不早于 366 天前；边界当天可以', () => {
    expect(policyEffectiveIssue('2026-10-23', '2026-10-23')).toBeNull()
    expect(policyEffectiveIssue('2026-10-24', '2026-10-23')).toContain('不能晚于今天')
    expect(FINANCE_POLICY_BACKDATE_DAYS).toBe(366)
    expect(policyEffectiveIssue('2025-10-22', '2026-10-23')).toBeNull()
    expect(policyEffectiveIssue('2025-10-21', '2026-10-23')).toContain('不能早于 2025-10-22')
  })
})

describe('请求校验', () => {
  const valid = {
    version: 0,
    effectiveFrom: '2026-10-20',
    revenueRecognition: 'ORDERED',
    inventoryCostMethod: 'FIFO',
    adsAllocationMode: 'BY_SALES',
    storeFeeAllocation: 'BY_UNITS',
    reason: ' 改按销量分摊 ',
  }

  it('提交：合法请求通过并去掉原因两端空白、汇率规则补默认值', () => {
    expect(FinancePolicySubmitBodySchema.parse(valid)).toMatchObject({ reason: '改按销量分摊', fxRateRule: 'SALE_DAY', version: 0 })
  })

  it('提交：不认识的取值、坏日期、没有原因、负版本号都拒绝', () => {
    for (const bad of [
      { inventoryCostMethod: 'LIFO' },
      { revenueRecognition: 'PAID' },
      { adsAllocationMode: 'EQUAL' },
      { effectiveFrom: '2026-02-30' },
      { effectiveFrom: '2026/10/20' },
      { reason: ' ' },
      { reason: '改' },
      { version: -1 },
    ]) {
      expect(FinancePolicySubmitBodySchema.safeParse({ ...valid, ...bad }).success, JSON.stringify(bad)).toBe(false)
    }
  })

  it('审批：通过可以不写意见；驳回必须写至少 2 个字', () => {
    expect(FinancePolicyApprovalBodySchema.parse({ decision: 'APPROVED', version: 1 })).toMatchObject({ comment: '' })
    expect(FinancePolicyApprovalBodySchema.safeParse({ decision: 'REJECTED', version: 1 }).success).toBe(false)
    expect(FinancePolicyApprovalBodySchema.safeParse({ decision: 'REJECTED', version: 1, comment: '好' }).success).toBe(false)
    expect(FinancePolicyApprovalBodySchema.parse({ decision: 'REJECTED', version: 2, comment: '写错了' })).toMatchObject({ comment: '写错了' })
    expect(FinancePolicyApprovalBodySchema.safeParse({ decision: 'MAYBE', version: 1 }).success).toBe(false)
    expect(FinancePolicyApprovalBodySchema.safeParse({ decision: 'APPROVED', version: 0 }).success).toBe(false)
  })

  it('路径里的版本号：正整数文本', () => {
    expect(FinancePolicyVersionParamSchema.parse('3')).toBe(3)
    for (const bad of ['0', '-1', 'abc', '1.5']) expect(FinancePolicyVersionParamSchema.safeParse(bad).success, bad).toBe(false)
  })
})
