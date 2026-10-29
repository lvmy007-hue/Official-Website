import { describe, expect, it } from 'vitest'
import { REIMBURSEMENT_WINDOW_DEFAULTS, ReimbursementWindowsSchema, resolveWindows } from './reimbursement-windows.js'
import {
  averagePayDays,
  CASE_STEPS,
  caseStepOf,
  isPaidInFull,
  matchPayout,
  netLedgerClaims,
  nextCaseStatuses,
  reasonMatchesRule,
  recoveryByCurrency,
  ruleStats,
  validateCaseUpdate,
  type MatchCandidate,
} from './reimbursements-math.js'
import { CASE_STATUSES } from './reimbursements.js'
import { OPPORTUNITY_RULES } from './receiving.js'

describe('案件状态流转', () => {
  it('待提交只能提交；已拒绝可以重新提交；已到账是终点；已到账不能手工标', () => {
    expect(nextCaseStatuses('OPPORTUNITY')).toEqual(['SUBMITTED'])
    expect(nextCaseStatuses('REJECTED')).toEqual(['SUBMITTED'])
    expect(nextCaseStatuses('PAID')).toEqual([])
    for (const status of CASE_STATUSES) expect(nextCaseStatuses(status)).not.toContain('PAID')
  })

  it('校验：越级、手标已到账、缺批准金额、部分批准不小于应收、批准超应收、已到账改金额', () => {
    const base = { status: 'SUBMITTED' as const, expectedAmount: 100, approvedAmount: null, amazonCaseId: null }
    expect(validateCaseUpdate(base, { status: 'IN_PROGRESS' })).toBeNull()
    expect(validateCaseUpdate({ ...base, status: 'OPPORTUNITY' }, { status: 'APPROVED' })).toContain('不能直接改成')
    expect(validateCaseUpdate(base, { status: 'PAID' })).toContain('自动匹配')
    expect(validateCaseUpdate(base, { status: 'APPROVED' })).toContain('批准的金额')
    expect(validateCaseUpdate(base, { status: 'PARTIAL', approvedAmount: 100 })).toContain('部分批准')
    expect(validateCaseUpdate(base, { status: 'APPROVED', approvedAmount: 120 })).toContain('不应大于')
    expect(validateCaseUpdate(base, { status: 'APPROVED', approvedAmount: 100 })).toBeNull()
    expect(validateCaseUpdate({ ...base, status: 'PAID' }, { approvedAmount: 50 })).toContain('已到账')
  })

  it('步骤条：被拒绝时第 4 步标失败', () => {
    expect(CASE_STEPS).toHaveLength(5)
    expect(caseStepOf('OPPORTUNITY')).toEqual({ current: 0, failed: false })
    expect(caseStepOf('REJECTED')).toEqual({ current: 3, failed: true })
    expect(caseStepOf('PARTIAL')).toEqual({ current: 3, failed: false })
    expect(caseStepOf('PAID')).toEqual({ current: 4, failed: false })
  })
})

describe('台账丢失净额', () => {
  const events = [
    { id: 'b', date: '2026-08-05', qty: 2 },
    { id: 'a', date: '2026-08-01', qty: 3 },
  ]
  it('找到与赔付的数量从最早的事件开始抵扣；没有覆盖则原样返回；全覆盖返回空', () => {
    expect(netLedgerClaims(events, 0).map(item => [item.id, item.qty])).toEqual([
      ['a', 3],
      ['b', 2],
    ])
    expect(netLedgerClaims(events, 4).map(item => [item.id, item.qty])).toEqual([['b', 1]])
    expect(netLedgerClaims(events, 5)).toEqual([])
    expect(netLedgerClaims(events, 99)).toEqual([])
    expect(netLedgerClaims([{ id: 'z', date: '2026-08-01', qty: 0 }], 0)).toEqual([])
  })
})

describe('赔付明细归属', () => {
  const since = new Date('2026-10-01T00:00:00Z')
  const candidate = (over: Partial<MatchCandidate> = {}): MatchCandidate => ({
    id: 'c1',
    sellerAccountId: 's1',
    ruleCode: 'LEDGER_LOST',
    sku: 'SKU-1',
    amazonCaseId: null,
    orderRefs: [],
    since,
    ...over,
  })
  const record = (over: Record<string, unknown> = {}) => ({
    sellerAccountId: 's1',
    sku: 'SKU-1',
    reason: 'Lost_Warehouse',
    approvedAt: new Date('2026-10-10T00:00:00Z'),
    amazonCaseId: null,
    originalOrderId: null,
    ...over,
  })

  it('案件编号一致优先；编号重复不猜', () => {
    expect(matchPayout(record({ amazonCaseId: ' ABC ' }), [candidate({ amazonCaseId: 'abc' }), candidate({ id: 'c2' })])).toEqual({ caseId: 'c1', basis: 'CASE_ID' })
    expect(matchPayout(record({ amazonCaseId: 'abc' }), [candidate({ amazonCaseId: 'abc' }), candidate({ id: 'c2', amazonCaseId: 'abc' })])).toBeNull()
  })
  it('订单号加 SKU 一致且唯一', () => {
    const list = [candidate({ ruleCode: 'REFUND_NO_RETURN', orderRefs: ['O-1'] })]
    expect(matchPayout(record({ reason: 'x', originalOrderId: 'O-1' }), list)).toEqual({ caseId: 'c1', basis: 'ORDER_SKU' })
    expect(matchPayout(record({ reason: 'x', originalOrderId: 'O-2' }), list)).toBeNull()
  })
  it('SKU 与原因吻合、提交不晚于批准日一天；候选不唯一不猜；别的店铺不算', () => {
    expect(matchPayout(record(), [candidate()])).toEqual({ caseId: 'c1', basis: 'SKU_REASON' })
    expect(matchPayout(record(), [candidate(), candidate({ id: 'c2' })])).toBeNull()
    expect(matchPayout(record(), [candidate({ sellerAccountId: 's2' })])).toBeNull()
    expect(matchPayout(record(), [candidate({ since: new Date('2026-10-20T00:00:00Z') })])).toBeNull()
    expect(matchPayout(record({ reason: 'Damaged_Warehouse' }), [candidate()])).toBeNull()
  })
  it('原因关键字', () => {
    expect(reasonMatchesRule('Lost_Warehouse', 'LEDGER_LOST')).toBe(true)
    expect(reasonMatchesRule('Damaged Warehouse', 'LEDGER_DAMAGED')).toBe(true)
    expect(reasonMatchesRule('', 'LEDGER_LOST')).toBe(false)
  })
  it('已到账判定：有批准金额要达到，差一分以内算够', () => {
    expect(isPaidInFull(0, 10)).toBe(false)
    expect(isPaidInFull(9.99, 10)).toBe(true)
    expect(isPaidInFull(5, 10)).toBe(false)
    expect(isPaidInFull(1, null)).toBe(true)
  })
})

describe('回收率与成功率', () => {
  const stat = (over: Record<string, unknown> = {}) => ({
    status: 'PAID' as const,
    ruleCode: 'LEDGER_LOST' as const,
    currency: 'USD',
    expectedAmount: 100,
    receivedAmount: 80,
    submittedAt: new Date('2026-10-01T00:00:00Z'),
    firstPaidAt: new Date('2026-10-11T00:00:00Z'),
    ...over,
  })
  it('回收率按币种分开，只算已提交且有应收金额的；没有分母是空而不是 0', () => {
    const rows = recoveryByCurrency([stat(), stat({ currency: 'EUR', expectedAmount: 50, receivedAmount: 50 }), stat({ status: 'OPPORTUNITY' }), stat({ expectedAmount: null })])
    expect(rows.map(row => row.currency)).toEqual(['EUR', 'USD'])
    expect(rows[1]).toMatchObject({ expected: 100, received: 80, recoveryRate: 0.8, caseCount: 1 })
    expect(recoveryByCurrency([stat({ expectedAmount: 0 })])[0].recoveryRate).toBeNull()
    expect(recoveryByCurrency([])).toEqual([])
  })
  it('平均到账天数：没有样本是空', () => {
    expect(averagePayDays([stat(), stat({ firstPaidAt: new Date('2026-10-04T00:00:00Z') })])).toEqual({ days: 6.5, sample: 2 })
    expect(averagePayDays([stat({ firstPaidAt: null })])).toEqual({ days: null, sample: 0 })
  })
  it('成功率：批准、部分批准、已到账算成功，拒绝算失败，没结论是空', () => {
    const basis = Object.fromEntries(OPPORTUNITY_RULES.map(rule => [rule, '依据'])) as Record<(typeof OPPORTUNITY_RULES)[number], string>
    const rows = ruleStats([stat(), stat({ status: 'REJECTED' }), stat({ status: 'SUBMITTED' })], { LEDGER_LOST: 4 }, rule => rule !== 'FEE_OVERCHARGE', basis)
    const lost = rows.find(row => row.ruleCode === 'LEDGER_LOST')
    expect(lost).toMatchObject({ pendingOpportunities: 4, submitted: 3, won: 1, rejected: 1, successRate: 0.5, connected: true })
    expect(rows.find(row => row.ruleCode === 'LEDGER_DAMAGED')?.successRate).toBeNull()
    expect(rows.find(row => row.ruleCode === 'FEE_OVERCHARGE')?.connected).toBe(false)
  })
})

describe('机会时限设置', () => {
  it('缺失或被改坏的那一类回到默认值，其余保留', () => {
    expect(resolveWindows(null)).toEqual(REIMBURSEMENT_WINDOW_DEFAULTS)
    const out = resolveWindows({ LEDGER_LOST: { waitDays: 10, windowDays: 100 }, LEDGER_DAMAGED: { waitDays: 500, windowDays: 100 }, REMOVAL_LOST: 'x' })
    expect(out.LEDGER_LOST).toEqual({ waitDays: 10, windowDays: 100 })
    expect(out.LEDGER_DAMAGED).toEqual(REIMBURSEMENT_WINDOW_DEFAULTS.LEDGER_DAMAGED)
    expect(out.REMOVAL_LOST).toEqual(REIMBURSEMENT_WINDOW_DEFAULTS.REMOVAL_LOST)
  })
  it('整体校验：等待期不能长于申请期限，必须是整数', () => {
    expect(ReimbursementWindowsSchema.safeParse(REIMBURSEMENT_WINDOW_DEFAULTS).success).toBe(true)
    expect(ReimbursementWindowsSchema.safeParse({ ...REIMBURSEMENT_WINDOW_DEFAULTS, LEDGER_LOST: { waitDays: 50, windowDays: 40 } }).success).toBe(false)
    expect(ReimbursementWindowsSchema.safeParse({ ...REIMBURSEMENT_WINDOW_DEFAULTS, LEDGER_LOST: { waitDays: 1.5, windowDays: 40 } }).success).toBe(false)
  })
})
