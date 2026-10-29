import { describe, expect, it } from 'vitest'
import { allocateByWeights, monthStartDate, monthText, pickRuleForMonth, snapshotAllocationRules, type AllocationRuleLite } from './allocation-rules.js'
import { AllocationPreviewBodySchema, AllocationRuleCreateBodySchema, AllocationRuleUpdateBodySchema, AllocationRulesQuerySchema } from './allocation-rules-query.js'

// 费用分摊规则（P6-19）：分摊纯函数（各份之和等于原始金额、尾差记到占比最大者）、按月取规则、关账快照、请求校验。

const sum = (parts: ReadonlyArray<{ amount: number }>) => Math.round(parts.reduce((acc, part) => acc + part.amount, 0) * 1e6) / 1e6

describe('allocateByWeights', () => {
  it('按权重比例分摊，各份之和恰好等于原始金额', () => {
    const result = allocateByWeights(-100, [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 2 },
      { key: 'C', weight: 3 },
    ])
    expect(sum(result.parts)).toBe(-100)
    expect(result.unallocated).toBe(0)
    expect(result.parts.map(part => part.key)).toEqual(['A', 'B', 'C'])
    expect(result.parts.map(part => part.share.toFixed(4))).toEqual(['0.1667', '0.3333', '0.5000'])
  })

  it('不能整除时尾差记到占比最大的 SKU', () => {
    const result = allocateByWeights(10, [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 1 },
      { key: 'C', weight: 2 },
    ])
    expect(sum(result.parts)).toBe(10)
    const by = Object.fromEntries(result.parts.map(part => [part.key, part.amount]))
    expect(by.A).toBe(2.5)
    expect(by.B).toBe(2.5)
    expect(by.C).toBe(5)
    const odd = allocateByWeights(0.000005, [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 3 },
    ])
    expect(sum(odd.parts)).toBe(0.000005)
    expect(odd.parts.find(part => part.key === 'B')?.amount).toBeGreaterThanOrEqual(odd.parts.find(part => part.key === 'A')?.amount ?? 0)
  })

  it('权重相同的尾差记到 key 排序靠前的 SKU（结果可重复）', () => {
    const first = allocateByWeights(0.000001, [
      { key: 'B', weight: 1 },
      { key: 'A', weight: 1 },
    ])
    expect(first.parts.find(part => part.key === 'A')?.amount).toBe(0.000001)
    expect(first.parts.find(part => part.key === 'B')?.amount).toBe(0)
    expect(
      allocateByWeights(0.000001, [
        { key: 'A', weight: 1 },
        { key: 'B', weight: 1 },
      ]),
    ).toEqual(first)
  })

  it('金额为负（花费）与为正（返还）符号保持；零权重与非法权重不参与', () => {
    const result = allocateByWeights(-7.77, [
      { key: 'A', weight: 0 },
      { key: 'B', weight: 1 },
      { key: 'C', weight: Number.NaN },
      { key: 'D', weight: 1 },
    ])
    expect(result.parts.map(part => part.key)).toEqual(['B', 'D'])
    expect(sum(result.parts)).toBe(-7.77)
    expect(result.parts.every(part => part.amount < 0)).toBe(true)
    expect(
      sum(
        allocateByWeights(3.33, [
          { key: 'X', weight: 1 },
          { key: 'Y', weight: 2 },
        ]).parts,
      ),
    ).toBe(3.33)
  })

  it('没有正权重时整笔留在店铺级，不丢失', () => {
    expect(allocateByWeights(-50, [])).toEqual({ parts: [], unallocated: -50 })
    expect(allocateByWeights(-50, [{ key: 'A', weight: 0 }])).toEqual({ parts: [], unallocated: -50 })
  })

  it('随机权重下总和始终不变', () => {
    let seed = 7
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let round = 0; round < 200; round += 1) {
      const weights = Array.from({ length: 1 + Math.floor(next() * 12) }, (_, index) => ({ key: `S${index}`, weight: Math.round(next() * 1000) / 7 + 0.001 }))
      const total = Math.round((next() - 0.5) * 2_000_000) / 1000
      expect(sum(allocateByWeights(total, weights).parts)).toBe(Math.round(total * 1e6) / 1e6)
    }
  })
})

describe('pickRuleForMonth', () => {
  const rules: AllocationRuleLite[] = [
    { feeItemId: 'F1', basis: 'SALES_AMOUNT', manualWeights: null, effectiveMonth: '2026-03' },
    { feeItemId: 'F1', basis: 'SALES_UNITS', manualWeights: null, effectiveMonth: '2026-06' },
    { feeItemId: 'F2', basis: 'MANUAL', manualWeights: { A: 1 }, effectiveMonth: '2026-01' },
  ]
  it('取生效月不晚于所算月份的最近一条，没有则为空', () => {
    expect(pickRuleForMonth(rules, 'F1', '2026-02')).toBeNull()
    expect(pickRuleForMonth(rules, 'F1', '2026-03')?.basis).toBe('SALES_AMOUNT')
    expect(pickRuleForMonth(rules, 'F1', '2026-05')?.basis).toBe('SALES_AMOUNT')
    expect(pickRuleForMonth(rules, 'F1', '2026-06')?.basis).toBe('SALES_UNITS')
    expect(pickRuleForMonth(rules, 'F2', '2027-01')?.basis).toBe('MANUAL')
    expect(pickRuleForMonth(rules, 'F9', '2026-06')).toBeNull()
  })
  it('月份与日期互转', () => {
    expect(monthStartDate('2026-07').toISOString()).toBe('2026-07-01T00:00:00.000Z')
    expect(monthText(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07')
  })
})

describe('snapshotAllocationRules', () => {
  it('期间内每个月记录各费用项适用的规则版本', () => {
    const rules = [
      { id: 'r1', feeItemId: 'F1', basis: 'SALES_AMOUNT' as const, manualWeights: null, effectiveMonth: '2026-01', version: 2 },
      { id: 'r2', feeItemId: 'F1', basis: 'SALES_UNITS' as const, manualWeights: null, effectiveMonth: '2026-03', version: 1 },
    ]
    const snapshot = snapshotAllocationRules(rules, '2026-02-15', '2026-03-10')
    expect(snapshot.allocationRules?.months['2026-02']).toEqual([{ ruleId: 'r1', feeItemId: 'F1', basis: 'SALES_AMOUNT', effectiveMonth: '2026-01', version: 2 }])
    expect(snapshot.allocationRules?.months['2026-03']).toEqual([{ ruleId: 'r2', feeItemId: 'F1', basis: 'SALES_UNITS', effectiveMonth: '2026-03', version: 1 }])
    expect(Object.keys(snapshot.allocationRules?.months ?? {})).toEqual(['2026-02', '2026-03'])
    expect(snapshotAllocationRules([], '2026-02-01', '2026-02-28').allocationRules?.months).toEqual({ '2026-02': [] })
  })
})

describe('请求校验', () => {
  it('新建：月份格式、手动比例与依据一致', () => {
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'SALES_AMOUNT', effectiveMonth: '2026-07' }).success).toBe(true)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'SALES_AMOUNT', effectiveMonth: '2026-13' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'SALES_AMOUNT', effectiveMonth: '2026-07-01' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'MANUAL', effectiveMonth: '2026-07' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'MANUAL', manualWeights: {}, effectiveMonth: '2026-07' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'MANUAL', manualWeights: { A: 0 }, effectiveMonth: '2026-07' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'MANUAL', manualWeights: { A: 2, B: 1 }, effectiveMonth: '2026-07' }).success).toBe(true)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'SALES_UNITS', manualWeights: { A: 1 }, effectiveMonth: '2026-07' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'FOO', effectiveMonth: '2026-07' }).success).toBe(false)
    expect(AllocationRuleCreateBodySchema.safeParse({ feeItemId: 'F1', basis: 'SALES_UNITS', effectiveMonth: '2026-07', extra: 1 }).success).toBe(false)
  })
  it('修改必须带版本号；不能改费用项与生效月', () => {
    expect(AllocationRuleUpdateBodySchema.safeParse({ id: 'r1', version: 1, basis: 'SALES_UNITS' }).success).toBe(true)
    expect(AllocationRuleUpdateBodySchema.safeParse({ id: 'r1', basis: 'SALES_UNITS' }).success).toBe(false)
    expect(AllocationRuleUpdateBodySchema.safeParse({ id: 'r1', version: 1, basis: 'SALES_UNITS', effectiveMonth: '2026-07' }).success).toBe(false)
  })
  it('预览与列表查询', () => {
    expect(AllocationPreviewBodySchema.safeParse({ month: '2026-07', rule: { feeItemId: 'F1', basis: 'SALES_UNITS' } }).success).toBe(true)
    expect(AllocationPreviewBodySchema.safeParse({ month: '2026-7', rule: { feeItemId: 'F1', basis: 'SALES_UNITS' } }).success).toBe(false)
    expect(AllocationRulesQuerySchema.safeParse({}).success).toBe(true)
    expect(AllocationRulesQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
  })
})
