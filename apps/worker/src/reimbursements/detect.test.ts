import { REIMBURSEMENT_WINDOW_DEFAULTS } from '@nova/api-contracts'
import { describe, expect, it } from 'vitest'
import { detectLedger } from './detect-ledger'
import { detectRemovalLost } from './detect-removal'
import { detectRefundNoReturn, detectReturnDisposition } from './detect-returns'
import { NOW, daysAgo, dec, fakeDb, type Row, type Tables } from './fake-db.test-helper'
import { writeOpportunity } from './opportunity-write'
import { newContext } from './scan'

// 6 类机会的检测、等待期与期限、净额抵扣、官方赔付扣减、人工状态不被覆盖、条件消失转“差异已消除”（P2b-03）。

const ctxOf = (data: Tables = {}, windows = REIMBURSEMENT_WINDOW_DEFAULTS) => {
  const { db, tables } = fakeDb(data)
  return { ctx: newContext(db, 't1', NOW, windows), tables }
}
const cost = (sku: string, amount: number) => ({ tenantId: 't1', sku, status: 'ACTIVE', unitProductCost: dec(amount), currency: 'USD', versionNo: 1 })
const ledger = (id: string, daysBack: number, reason: string, quantity: number, sku = 'SKU-1'): Row => ({
  id,
  tenantId: 't1',
  sellerAccountId: 'sa1',
  eventDate: daysAgo(daysBack),
  fnsku: 'FN1',
  sku,
  eventType: 'Adjustments',
  reasonCode: reason,
  quantity,
})
const opps = (tables: Record<string, { rows: Row[] }>, rule?: string) => tables.reimbursementOpportunity.rows.filter(row => !rule || row.ruleCode === rule)

describe('writeOpportunity 写入规则', () => {
  const base = { tenantId: 't1', sellerAccountId: 'sa1', ruleCode: 'LEDGER_LOST' as const, dedupKey: 'k1', sku: 'SKU-1', qty: 3, evidence: [], now: NOW, window: { waitDays: 45, windowDays: 540 } }

  it('等待期内不产出；过了等待期产出并按商品成本估算；没有商品成本时金额为空，不是 0', async () => {
    const waiting = fakeDb({ costVersion: [cost('SKU-1', 10)] })
    expect(await writeOpportunity(waiting.db, { ...base, anchor: daysAgo(10) })).toBe('skipped')
    expect(waiting.tables.reimbursementOpportunity.rows).toHaveLength(0)
    const open = fakeDb({ costVersion: [cost('SKU-1', 10)] })
    expect(await writeOpportunity(open.db, { ...base, anchor: daysAgo(60) })).toBe('created')
    expect(open.tables.reimbursementOpportunity.rows[0]).toMatchObject({ status: 'PENDING', estimatedAmount: 30, currency: 'USD', sku: 'SKU-1', qty: 3 })
    const noCost = fakeDb()
    await writeOpportunity(noCost.db, { ...base, anchor: daysAgo(60) })
    expect(noCost.tables.reimbursementOpportunity.rows[0].estimatedAmount).toBeNull()
  })

  it('过了申请期限的新机会不产出；已有的待处理转为已过期；时限放宽后已过期的机会恢复待处理', async () => {
    const fresh = fakeDb()
    expect(await writeOpportunity(fresh.db, { ...base, anchor: daysAgo(600) })).toBe('skipped')
    const existing = fakeDb()
    await writeOpportunity(existing.db, { ...base, anchor: daysAgo(100), window: { waitDays: 45, windowDays: 540 } })
    await writeOpportunity(existing.db, { ...base, anchor: daysAgo(100), window: { waitDays: 45, windowDays: 90 } })
    expect(existing.tables.reimbursementOpportunity.rows[0].status).toBe('EXPIRED')
    await writeOpportunity(existing.db, { ...base, anchor: daysAgo(100), window: { waitDays: 45, windowDays: 540 } })
    expect(existing.tables.reimbursementOpportunity.rows[0].status).toBe('PENDING')
  })

  it('已生成案件、已忽略的机会扫描永远不动；差异已消除的再次出现时恢复待处理', async () => {
    for (const status of ['CASE_CREATED', 'IGNORED']) {
      const handled = fakeDb({ reimbursementOpportunity: [{ id: 'o1', tenantId: 't1', sellerAccountId: 'sa1', ruleCode: 'LEDGER_LOST', dedupKey: 'k1', status, qty: 9 }] })
      expect(await writeOpportunity(handled.db, { ...base, anchor: daysAgo(60) })).toBe('skipped')
      expect(handled.tables.reimbursementOpportunity.rows[0]).toMatchObject({ status, qty: 9 })
    }
    const resolved = fakeDb({ reimbursementOpportunity: [{ id: 'o1', tenantId: 't1', sellerAccountId: 'sa1', ruleCode: 'LEDGER_LOST', dedupKey: 'k1', status: 'RESOLVED', qty: 9 }] })
    await writeOpportunity(resolved.db, { ...base, anchor: daysAgo(60) })
    expect(resolved.tables.reimbursementOpportunity.rows[0]).toMatchObject({ status: 'PENDING', qty: 3 })
  })
})

describe('台账丢失与损坏', () => {
  it('找到的数量与官方赔付的数量从最早的丢失开始抵扣，剩余才是机会；还在等待期的事件不产出', async () => {
    const { ctx, tables } = ctxOf({
      inventoryLedgerEntry: [
        ledger('l1', 100, 'Lost', -4),
        ledger('l2', 80, 'Lost', -3),
        ledger('l3', 10, 'Lost', -2),
        ledger('f1', 70, 'Found', 2),
        ledger('l-dmg', 90, 'Damaged', -1),
        ledger('x1', 60, 'Received', 5),
      ],
      reimbursementRecord: [{ tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-1', approvedAt: daysAgo(55), amount: dec(20), quantity: 2, reason: 'Lost_Warehouse' }],
      costVersion: [cost('SKU-1', 5)],
    })
    const results = await detectLedger(ctx)
    const lost = opps(tables, 'LEDGER_LOST')
    expect(lost.map(row => [row.dedupKey, row.qty])).toEqual([['l2', 3]])
    expect(lost.find(row => row.dedupKey === 'l2')).toMatchObject({ estimatedAmount: 15, status: 'PENDING' })
    expect(opps(tables, 'LEDGER_DAMAGED').map(row => row.dedupKey)).toEqual(['l-dmg'])
    expect(results.map(item => item.rule)).toEqual(['LEDGER_LOST', 'LEDGER_DAMAGED'])
  })

  it('原因不吻合的赔付（如退货类）不抵扣丢失；之后到账了吻合的赔付，待处理的机会转为差异已消除', async () => {
    const { ctx, tables } = ctxOf({
      inventoryLedgerEntry: [ledger('l1', 100, 'Lost', -3)],
      reimbursementRecord: [{ tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-1', approvedAt: daysAgo(50), amount: dec(9), quantity: 3, reason: 'CustomerReturn' }],
    })
    await detectLedger(ctx)
    expect(opps(tables, 'LEDGER_LOST')[0]).toMatchObject({ status: 'PENDING', qty: 3 })
    tables.reimbursementRecord.rows.push({ tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-1', approvedAt: daysAgo(20), amount: dec(9), quantity: 3, reason: 'Lost_Warehouse' })
    // 每轮扫描用新的上下文（成本与已赔付数量的缓存只在一轮内有效）
    const again = await detectLedger(newContext(ctx.db, 't1', NOW, ctx.windows))
    expect(opps(tables, 'LEDGER_LOST')[0].status).toBe('RESOLVED')
    expect(again[0].resolved).toBe(1)
  })

  it('时限从设置读：等待期改长后，原本已到期的事件不再产出', async () => {
    const windows = { ...REIMBURSEMENT_WINDOW_DEFAULTS, LEDGER_LOST: { waitDays: 120, windowDays: 540 } }
    const { ctx, tables } = ctxOf({ inventoryLedgerEntry: [ledger('l1', 100, 'Lost', -3)] }, windows)
    await detectLedger(ctx)
    expect(opps(tables, 'LEDGER_LOST')).toHaveLength(0)
  })
})

describe('退款后未收到退货', () => {
  const refund = (order: string, daysBack: number): Row => ({ tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: order, transactionType: 'Refund', amount: dec(-20), postedAt: daysAgo(daysBack) })
  const item = (order: string, sku: string, qty: number): Row => ({ tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: order, sellerSku: sku, quantityOrdered: qty, quantityShipped: qty })

  it('有退款、没有退货记录、官方赔付里也没有的订单产出机会；有退货或已赔付的不产出', async () => {
    const { ctx, tables } = ctxOf({
      fbaFinancialTransaction: [refund('O-A', 50), refund('O-B', 50), refund('O-C', 50), refund('O-D', 10)],
      orderItem: [item('O-A', 'SKU-1', 2), item('O-B', 'SKU-2', 1), item('O-C', 'SKU-3', 1), item('O-D', 'SKU-4', 1)],
      fbaReturnCase: [{ tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: 'O-B' }],
      reimbursementRecord: [{ tenantId: 't1', sellerAccountId: 'sa1', originalOrderId: 'O-C', sku: 'SKU-3', amount: dec(10) }],
      costVersion: [cost('SKU-1', 7)],
    })
    await detectRefundNoReturn(ctx)
    const rows = opps(tables, 'REFUND_NO_RETURN')
    expect(rows.map(row => row.dedupKey)).toEqual(['O-A:SKU-1'])
    expect(rows[0]).toMatchObject({ qty: 2, estimatedAmount: 14, sku: 'SKU-1' })
  })

  it('订单还没同步下来（没有订单行）时仍产出，但不写 SKU 与数量；之后客户退货记录出现，机会转为差异已消除', async () => {
    const { ctx, tables } = ctxOf({ fbaFinancialTransaction: [refund('O-A', 50)] })
    await detectRefundNoReturn(ctx)
    expect(opps(tables)[0]).toMatchObject({ dedupKey: 'O-A:', sku: null, qty: null, estimatedAmount: null })
    tables.fbaReturnCase.rows.push({ tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: 'O-A' })
    const result = await detectRefundNoReturn(ctx)
    expect(result.resolved).toBe(1)
    expect(opps(tables)[0].status).toBe('RESOLVED')
  })
})

describe('退货处置损坏与移除订单丢失', () => {
  it('承运商损坏的退货产出机会，官方赔付里已有同订单同 SKU 的不产出', async () => {
    const row = (id: string, order: string): Row => ({
      id,
      tenantId: 't1',
      sellerAccountId: 'sa1',
      amazonOrderId: order,
      sellerSku: 'SKU-1',
      quantity: 1,
      returnDate: daysAgo(30),
      disposition: 'CARRIER_DAMAGED',
      detailedDisposition: 'CARRIER_DAMAGED',
    })
    const { ctx, tables } = ctxOf({
      fbaReturnCase: [row('rt1', 'O-A'), row('rt2', 'O-B')],
      reimbursementRecord: [{ tenantId: 't1', sellerAccountId: 'sa1', originalOrderId: 'O-B', sku: 'SKU-1', amount: dec(10) }],
    })
    await detectReturnDisposition(ctx)
    expect(opps(tables, 'RETURN_DISPOSITION').map(item => item.dedupKey)).toEqual(['rt1'])
  })

  it('已关闭的移除订单：申请数量减去发出、弃置、取消得到缺口，再扣官方赔付；处理中的不看', async () => {
    const order = (id: string, over: Row): Row => ({
      id,
      tenantId: 't1',
      sellerAccountId: 'sa1',
      orderId: id,
      sku: 'SKU-1',
      fnsku: 'FN1',
      disposition: 'Sellable',
      status: 'Completed',
      requestDate: daysAgo(80),
      lastUpdatedDate: daysAgo(70),
      requestedQty: 10,
      shippedQty: 6,
      disposedQty: 0,
      cancelledQty: 0,
      inProcessQty: 0,
      ...over,
    })
    const { ctx, tables } = ctxOf({
      removalOrder: [order('RM1', {}), order('RM2', { status: 'Pending', inProcessQty: 4 }), order('RM3', { shippedQty: 10 }), order('RM4', { sku: 'SKU-9', fnsku: 'FN9' })],
      reimbursementRecord: [{ tenantId: 't1', sellerAccountId: 'sa1', sku: 'SKU-9', approvedAt: daysAgo(60), amount: dec(40), quantity: 4, reason: 'Lost_Removal' }],
    })
    await detectRemovalLost(ctx)
    expect(opps(tables, 'REMOVAL_LOST').map(row => [row.dedupKey, row.qty])).toEqual([['RM1:SKU-1:FN1:Sellable', 4]])
  })
})
