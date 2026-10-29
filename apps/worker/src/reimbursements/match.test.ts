import { describe, expect, it } from 'vitest'
import { NOW, daysAgo, dec, fakeDb, type Row } from './fake-db.test-helper'
import { matchPayouts } from './match'
import { scanTenant } from './run'

// 官方赔付明细 → 案件的自动匹配（P2b-03）：三层依据、歧义不匹配、实收累加、已到账判定、案件编号回填、重复运行幂等。

const kase = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: 't1',
  sellerAccountId: 'sa1',
  ruleCode: 'LEDGER_LOST',
  status: 'SUBMITTED',
  sku: 'SKU-1',
  amazonCaseId: null,
  evidenceRefsJson: [],
  submittedAt: daysAgo(30),
  createdAt: daysAgo(31),
  currency: 'USD',
  approvedAmount: null,
  receivedAmount: dec(0),
  decidedAt: null,
  version: 1,
  ...over,
})
const record = (id: string, over: Row = {}): Row => ({
  id,
  tenantId: 't1',
  sellerAccountId: 'sa1',
  sku: 'SKU-1',
  reason: 'Lost_Warehouse',
  approvedAt: daysAgo(5),
  amazonCaseId: null,
  originalOrderId: null,
  currency: 'USD',
  amount: dec(30),
  matchedCaseId: null,
  ...over,
})

describe('matchPayouts', () => {
  it('SKU 与原因吻合且只有一个候选：匹配、累加实收；没有批准金额，有实收即转为已到账，并写时间线与到账时间', async () => {
    const { db, tables } = fakeDb({ reimbursementCase: [kase('c1')], reimbursementRecord: [record('r1')] })
    const result = await matchPayouts(db, 't1', NOW)
    expect(result).toEqual({ matched: 1, paid: 1 })
    expect(tables.reimbursementRecord.rows[0]).toMatchObject({ matchedCaseId: 'c1', matchBasis: 'SKU_REASON' })
    expect(tables.reimbursementCase.rows[0]).toMatchObject({ status: 'PAID', receivedAmount: 30, paidAt: daysAgo(5), version: 2 })
    expect(tables.entityEvent.rows[0]).toMatchObject({ entityType: 'REIMBURSEMENT_CASE', entityId: 'c1', kind: 'reimbursement.payout', sourceRef: 'record:r1' })
  })

  it('案件编号一致优先；赔付带的亚马逊案件编号回填到还没填的案件；有批准金额时实收不足不转已到账，补足后才转', async () => {
    const { db, tables } = fakeDb({
      reimbursementCase: [kase('c1', { status: 'APPROVED', approvedAmount: dec(50), amazonCaseId: 'AMZ-1' }), kase('c2')],
      reimbursementRecord: [record('r1', { amazonCaseId: 'amz-1', amount: dec(20) })],
    })
    await matchPayouts(db, 't1', NOW)
    expect(tables.reimbursementRecord.rows[0]).toMatchObject({ matchedCaseId: 'c1', matchBasis: 'CASE_ID' })
    expect(tables.reimbursementCase.rows[0]).toMatchObject({ status: 'APPROVED', receivedAmount: 20 })
    tables.reimbursementRecord.rows.push(record('r2', { amazonCaseId: 'AMZ-1', amount: dec(30), approvedAt: daysAgo(2) }))
    await matchPayouts(db, 't1', NOW)
    expect(tables.reimbursementCase.rows[0]).toMatchObject({ status: 'PAID', receivedAmount: 50 })
  })

  it('订单与 SKU 一致且唯一才匹配；两个案件都吻合时不猜，赔付留在未归属', async () => {
    const orderRefs = [{ kind: 'ORDER', id: 'O-1', label: '' }]
    const one = fakeDb({
      reimbursementCase: [kase('c1', { ruleCode: 'REFUND_NO_RETURN', evidenceRefsJson: orderRefs })],
      reimbursementRecord: [record('r1', { reason: 'CustomerReturn', originalOrderId: 'O-1' })],
    })
    await matchPayouts(one.db, 't1', NOW)
    expect(one.tables.reimbursementRecord.rows[0]).toMatchObject({ matchedCaseId: 'c1', matchBasis: 'ORDER_SKU' })
    const two = fakeDb({ reimbursementCase: [kase('c1'), kase('c2')], reimbursementRecord: [record('r1')] })
    expect(await matchPayouts(two.db, 't1', NOW)).toEqual({ matched: 0, paid: 0 })
    expect(two.tables.reimbursementRecord.rows[0].matchedCaseId).toBeNull()
    expect(two.tables.reimbursementCase.rows.every(row => row.status === 'SUBMITTED')).toBe(true)
  })

  it('币种不一致、早于提交时间的赔付不匹配；已到账、已拒绝、待提交的案件不是候选；重复运行不重复累加', async () => {
    const { db, tables } = fakeDb({
      reimbursementCase: [kase('c1', { status: 'PAID' }), kase('c2', { status: 'REJECTED' }), kase('c3', { status: 'OPPORTUNITY' })],
      reimbursementRecord: [record('r1')],
    })
    expect(await matchPayouts(db, 't1', NOW)).toEqual({ matched: 0, paid: 0 })
    const open = fakeDb({ reimbursementCase: [kase('c1')], reimbursementRecord: [record('r1', { currency: 'EUR' }), record('r2', { approvedAt: daysAgo(40) })] })
    expect(await matchPayouts(open.db, 't1', NOW)).toEqual({ matched: 0, paid: 0 })
    const again = fakeDb({ reimbursementCase: [kase('c1', { approvedAmount: dec(100) })], reimbursementRecord: [record('r1', { amount: dec(30) })] })
    await matchPayouts(again.db, 't1', NOW)
    await matchPayouts(again.db, 't1', NOW)
    expect(again.tables.reimbursementCase.rows[0]).toMatchObject({ receivedAmount: 30, version: 2 })
    expect(again.tables.entityEvent.rows).toHaveLength(1)
    expect(tables.reimbursementCase.rows).toHaveLength(3)
  })
})

describe('scanTenant', () => {
  it('某一类检测出错不拖垮其它类：错误被收集，其余照常，过期扫描仍执行', async () => {
    const { db, tables } = fakeDb({
      reimbursementOpportunity: [{ id: 'o1', tenantId: 't1', sellerAccountId: 'sa1', ruleCode: 'LEDGER_LOST', dedupKey: 'k', status: 'PENDING', deadlineAt: daysAgo(3) }],
    })
    ;(db as unknown as { inventoryLedgerEntry: { findMany: () => Promise<never> } }).inventoryLedgerEntry.findMany = async () => {
      throw new Error('boom')
    }
    const result = await scanTenant(db, 't1', NOW)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('ledger')
    expect(result.rules.length).toBeGreaterThan(0)
    expect(result.expired).toBe(1)
    expect(tables.reimbursementOpportunity.rows[0].status).toBe('EXPIRED')
  })
})
