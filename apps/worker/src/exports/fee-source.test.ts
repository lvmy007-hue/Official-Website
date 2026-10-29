import { EXPORT_KINDS, FEE_EXPORT_KIND } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { EXPORT_SOURCES } from './sources'
import { feeEvents } from './fee-source'

// 费用事件导出源（P2b-05）：筛选与页面一致、不导出“不是费用”的明细、金额带符号、分页续取、列与契约一致。

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  postedAt: new Date('2026-10-20T08:00:00Z'),
  feeCategory: 'FULFILLMENT',
  feeSubtype: 'FBAPerUnitFulfillmentFee',
  amount: { toString: () => '-3.22' },
  currency: 'USD',
  transactionStatus: 'RELEASED',
  amazonOrderId: '111-1',
  asin: 'B0TEST0001',
  sellerSku: 'SKU-1',
  settlementId: null,
  sourceEventId: 'tx-1:0',
  reconciliationStatus: 'DISCREPANCY',
  reconciliationNote: '与结算单不符',
  sellerAccount: { displayName: '美国主店' },
  ...over,
})
const collect = async (iterable: AsyncIterable<unknown>) => {
  const rows: Array<Record<string, unknown>> = []
  for await (const item of iterable) rows.push(item as Record<string, unknown>)
  return rows
}

describe('费用事件导出', () => {
  it('已登记到导出源，且契约里的每一列都有取数', async () => {
    expect(EXPORT_SOURCES[FEE_EXPORT_KIND]).toBe(feeEvents)
    const spec = EXPORT_KINDS.find(item => item.kind === FEE_EXPORT_KIND)
    expect(spec).toBeDefined()
    const findMany = vi.fn().mockResolvedValue([row('a')])
    const [first] = await collect(feeEvents({ db: { fbaFeeEvent: { findMany } } as never, tenantId: 't1', filters: {}, storeIds: null }))
    for (const column of spec?.columns ?? []) expect(first, column.key).toHaveProperty(column.key)
  })

  it('字段转成中文名；金额是带符号的数字；来源与对账状态有中文', async () => {
    const findMany = vi
      .fn()
      .mockResolvedValue([
        row('a'),
        row('b', { feeCategory: 'STORAGE', feeSubtype: 'STORAGE_FEE', transactionStatus: null, sourceEventId: 'storage:x', reconciliationStatus: 'UNRECONCILED', reconciliationNote: null }),
      ])
    const rows = await collect(feeEvents({ db: { fbaFeeEvent: { findMany } } as never, tenantId: 't1', filters: {}, storeIds: null }))
    expect(rows[0]).toMatchObject({
      storeName: '美国主店',
      category: '配送费',
      amount: -3.22,
      currency: 'USD',
      transactionStatus: '已释放',
      reconciliation: '有差异',
      reconciliationNote: '与结算单不符',
      source: expect.any(String),
    })
    expect(rows[1]).toMatchObject({ category: '仓储费', transactionStatus: null, reconciliation: '未对账' })
    expect(rows[0].source).not.toBe(rows[1].source)
  })

  it('筛选与页面一致：时间范围用页面给的起止时刻；企业与店铺范围；类别、状态、对账状态、关键词；缺省排除 NON_FEE', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    await collect(
      feeEvents({
        db: { fbaFeeEvent: { findMany } } as never,
        tenantId: 't1',
        storeIds: ['s1'],
        filters: { fromAt: '2026-10-01T07:00:00.000Z', toAt: '2026-11-01T07:00:00.000Z', category: 'STORAGE', status: 'DEFERRED', reconciliation: 'DISCREPANCY', q: 'abc' },
      }),
    )
    const where = findMany.mock.calls[0][0].where
    expect(where).toMatchObject({ tenantId: 't1', sellerAccountId: { in: ['s1'] }, feeCategory: 'STORAGE', transactionStatus: 'DEFERRED', reconciliationStatus: 'DISCREPANCY' })
    expect(where.postedAt).toEqual({ gte: new Date('2026-10-01T07:00:00.000Z'), lt: new Date('2026-11-01T07:00:00.000Z') })
    expect(JSON.stringify(where.OR)).toContain('sourceRecordId')

    findMany.mockClear()
    await collect(feeEvents({ db: { fbaFeeEvent: { findMany } } as never, tenantId: 't1', storeIds: null, filters: { category: 'NOPE', status: 'BAD' } }))
    const open = findMany.mock.calls[0][0].where
    expect(open.feeCategory).toEqual({ not: 'NON_FEE' })
    expect(open).not.toHaveProperty('transactionStatus')
    expect(open).not.toHaveProperty('sellerAccountId')
  })

  it('一页取满时按（入账时间，编号）继续取下一页，直到取空', async () => {
    const full = Array.from({ length: 2000 }, (_, index) => row(`id-${String(index).padStart(4, '0')}`))
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(full)
      .mockResolvedValueOnce([row('last')])
    const rows = await collect(feeEvents({ db: { fbaFeeEvent: { findMany } } as never, tenantId: 't1', filters: {}, storeIds: null }))
    expect(rows).toHaveLength(2001)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(findMany.mock.calls[1][0].where)).toContain('id-1999')
  })
})
