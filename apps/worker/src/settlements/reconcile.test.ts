import { SETTLEMENT_EXCEPTION_LIMIT } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { buildReconciliation, type LineFact, type ReconcileInput, type TxFact } from './reconcile'

// 三方核对的纯计算：全部用手写数据验证每一个数字与每一种结论（读库与写库在 run.test.ts 与真实数据库测试里）。

const start = new Date('2026-09-01T00:00:00Z')
const end = new Date('2026-09-14T23:59:59Z')
const line = (amount: number, orderId: string | null, category: LineFact['category'] = 'INCOME', amountDescription = ''): LineFact => ({
  category,
  amount,
  amazonOrderId: orderId,
  transactionType: category === 'RESERVE' ? 'Previous Reserve Amount Balance' : 'Order',
  amountDescription,
})
const tx = (amount: number, orderId: string | null, postedAt = '2026-09-05T00:00:00Z', currency = 'USD'): TxFact => ({ amazonOrderId: orderId, amount, currency, postedAt: new Date(postedAt) })

function input(over: Partial<ReconcileInput> & { lines?: LineFact[]; transactions?: TxFact[] }): ReconcileInput {
  return {
    settlement: { currency: 'USD', periodStart: start, periodEnd: end, headerTotal: null },
    lines: [],
    transactions: [],
    foundOrders: new Set(['A', 'B']),
    coverage: { apiStart: new Date('2026-01-01T00:00:00Z'), ordersStart: new Date('2026-01-01T00:00:00Z') },
    unattributedFor: async () => new Map(),
    ...over,
  }
}

describe('三方核对：对平', () => {
  it('报告与接口按订单合计一致、订单都找得到：已对平，保留金不参与比较', async () => {
    const outcome = await buildReconciliation(
      input({
        lines: [line(100, 'A'), line(-15, 'A', 'FEE', 'Commission'), line(-50, null, 'RESERVE'), line(20, 'B')],
        transactions: [tx(100, 'A'), tx(-15, 'A'), tx(20.02, 'B')],
        settlement: { currency: 'USD', periodStart: start, periodEnd: end, headerTotal: 55 },
      }),
    )
    expect(outcome.status).toBe('MATCHED')
    expect(outcome.officialAmount).toBe(105)
    expect(outcome.systemAmount).toBe(105.02)
    expect(outcome.diffAmount).toBe(-0.02)
    expect(outcome.exceptions).toEqual([])
    expect(outcome.summary).toMatchObject({ INCOME: 120, FEE: -15, RESERVE: -50 })
    expect(outcome.openingBalance).toBe(-50)
    expect(outcome.checks.map(item => item.state)).toEqual(['PASS', 'PASS', 'PASS'])
  })

  it('没有订单号的明细合并成账户级一组，与接口里没有订单号的交易比较', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(-30, null, 'FEE', 'Subscription Fee')], transactions: [tx(-30, null)] }))
    expect(outcome.status).toBe('MATCHED')
    expect(outcome.api.orderCount).toBe(0)
  })
})

describe('三方核对：差异与分类', () => {
  it('同一订单金额不一致、没有其它解释：未解释，挡住对平', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A'), line(-15, 'A', 'FEE')], transactions: [tx(100, 'A')] }))
    expect(outcome.status).toBe('DISCREPANCY')
    expect(outcome.diffAmount).toBe(-15)
    expect(outcome.exceptions).toEqual([expect.objectContaining({ kind: 'AMOUNT_MISMATCH', category: 'UNEXPLAINED', refKey: 'order:A', reportAmount: 85, apiAmount: 100, amount: -15 })])
    expect(outcome.checks[1]).toMatchObject({ key: 'REPORT_VS_API', state: 'FAIL' })
  })

  it('接口里多出的交易入账时间在结算周期之外：时间口径', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A')], transactions: [tx(100, 'A'), tx(-15, 'A', '2026-09-20T00:00:00Z')] }))
    expect(outcome.exceptions[0]).toMatchObject({ category: 'TIMING', refKey: 'order:A', amount: 15 })
    expect(outcome.exceptions[0]!.note).toContain('-15')
    expect(outcome.status).toBe('DISCREPANCY')
  })

  it('差额正好是这个订单归到别的结算单的交易：归因口径', async () => {
    const asked: string[][] = []
    const outcome = await buildReconciliation(
      input({
        lines: [line(100, 'A'), line(-15, 'A', 'FEE')],
        transactions: [tx(100, 'A')],
        unattributedFor: async ids => {
          asked.push(ids)
          return new Map([['A', -15]])
        },
      }),
    )
    expect(asked).toEqual([['A']])
    expect(outcome.exceptions[0]).toMatchObject({ category: 'ATTRIBUTION', amount: -15 })
  })

  it('报告有、接口没有，且接口最早交易晚于结算周期开始：范围；否则未解释', async () => {
    const late = await buildReconciliation(input({ lines: [line(100, 'A'), line(7, 'B')], transactions: [tx(100, 'A')], coverage: { apiStart: new Date('2026-09-10T00:00:00Z'), ordersStart: start } }))
    expect(late.exceptions).toEqual([expect.objectContaining({ kind: 'REPORT_ONLY', category: 'SCOPE', refKey: 'order:B' })])
    const covered = await buildReconciliation(input({ lines: [line(100, 'A'), line(7, 'B')], transactions: [tx(100, 'A')] }))
    expect(covered.exceptions).toEqual([expect.objectContaining({ kind: 'REPORT_ONLY', category: 'UNEXPLAINED' })])
  })

  it('接口有、报告没有：接口独有', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A')], transactions: [tx(100, 'A'), tx(9, 'B')] }))
    expect(outcome.exceptions).toEqual([expect.objectContaining({ kind: 'API_ONLY', refKey: 'order:B', reportAmount: 0, apiAmount: 9, amount: -9 })])
  })

  it('异常按金额绝对值从大到小排列', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A'), line(5, 'B')], transactions: [tx(1, 'A'), tx(1, 'B')] }))
    expect(outcome.exceptions.map(item => item.refKey)).toEqual(['order:A', 'order:B'])
  })

  it('其它币种的接口交易不与结算币种相加，只计数', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A')], transactions: [tx(100, 'A'), tx(999, 'A', '2026-09-05T00:00:00Z', 'EUR')] }))
    expect(outcome.status).toBe('MATCHED')
    expect(outcome.api).toMatchObject({ total: 100, transactionCount: 2, otherCurrencyCount: 1 })
  })
})

describe('三方核对：待核对与自检', () => {
  it('报告没到：待核对（没有报告），不产生任何异常', async () => {
    const outcome = await buildReconciliation(input({ transactions: [tx(100, 'A')] }))
    expect(outcome).toMatchObject({ status: 'PENDING', pendingReason: 'NO_REPORT', exceptions: [], txnCount: 0 })
    expect(outcome.checks.every(item => item.state === 'SKIPPED')).toBe(true)
  })

  it('没有关联的接口交易：待核对（没有交易），不把每个订单都当成“报告独有”', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A'), line(20, 'B')] }))
    expect(outcome).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TRANSACTIONS', exceptions: [] })
    expect(outcome.checks.map(item => item.state)).toEqual(['SKIPPED', 'SKIPPED', 'PASS'])
  })

  it('汇总行打款总额与明细合计不一致：自检失败并产生一条异常，挡住对平', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A')], transactions: [tx(100, 'A')], settlement: { currency: 'USD', periodStart: start, periodEnd: end, headerTotal: 90 } }))
    expect(outcome.status).toBe('DISCREPANCY')
    expect(outcome.report.selfDiff).toBe(-10)
    expect(outcome.exceptions).toEqual([expect.objectContaining({ kind: 'SELF_CHECK', category: 'UNEXPLAINED', refKey: 'self-check', amount: -10 })])
    expect(outcome.checks[0]).toMatchObject({ key: 'REPORT_SELF', state: 'FAIL' })
  })

  it('报告没给打款总额：自检跳过，不当成差异', async () => {
    const outcome = await buildReconciliation(input({ lines: [line(100, 'A')], transactions: [tx(100, 'A')] }))
    expect(outcome.checks[0]).toMatchObject({ state: 'SKIPPED' })
    expect(outcome.status).toBe('MATCHED')
  })
})

describe('三方核对：订单', () => {
  it('报告里的订单我方订单表里没有：范围外只列出不挡对平；范围内是未解释并挡住对平', async () => {
    const base = { lines: [line(100, 'A'), line(30, 'Z')], transactions: [tx(100, 'A'), tx(30, 'Z')] }
    const scope = await buildReconciliation(input({ ...base, coverage: { apiStart: start, ordersStart: new Date('2026-09-10T00:00:00Z') } }))
    expect(scope.exceptions).toEqual([expect.objectContaining({ kind: 'ORDER_MISSING', category: 'SCOPE', refKey: 'missing:Z', amount: 30 })])
    expect(scope.status).toBe('MATCHED')
    expect(scope.orders).toEqual({ reportOrders: 2, found: 1, missing: 1 })
    expect(scope.checks[2]).toMatchObject({ state: 'FAIL' })
    const inside = await buildReconciliation(input(base))
    expect(inside.exceptions[0]).toMatchObject({ kind: 'ORDER_MISSING', category: 'UNEXPLAINED' })
    expect(inside.status).toBe('DISCREPANCY')
  })

  it('异常超过上限：全部参与对平判断与统计，只保存前面金额最大的', async () => {
    const count = SETTLEMENT_EXCEPTION_LIMIT + 50
    const orders = Array.from({ length: count }, (_, index) => `O${index}`)
    const outcome = await buildReconciliation(
      input({ lines: [...orders.map((order, index) => line(10 + index, order)), line(1, 'A')], transactions: [tx(1, 'A')], foundOrders: new Set([...orders, 'A']) }),
    )
    expect(outcome.exceptions).toHaveLength(count)
    expect(outcome.saved).toHaveLength(SETTLEMENT_EXCEPTION_LIMIT)
    expect(outcome.saved[0]!.amount).toBe(10 + count - 1)
    expect(outcome.status).toBe('DISCREPANCY')
  })
})
