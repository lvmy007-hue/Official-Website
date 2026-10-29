import { describe, expect, it } from 'vitest'
import { classifyLedgerEvent, ledgerExpectedEnding, LedgerDetailQuerySchema, LedgerSummaryQuerySchema, type LedgerFlows } from './inventory-ledger'
import { RemovalListQuerySchema, RemovalReceiptBodySchema, removalReceiptState, removalStatusLabel } from './inventory-removals'
import { StorageLimitImportBodySchema, storageTypeLabel } from './inventory-capacity'

// P2a-09 契约：台账平衡与事件分类、移除订单收货状态与参数校验、限额导入参数。

const flows = (over: Partial<LedgerFlows> = {}): LedgerFlows => ({
  startingQty: 100,
  receipts: 50,
  customerShipments: -30,
  customerReturns: 5,
  vendorReturns: 0,
  transfers: 0,
  found: 1,
  lost: -2,
  damaged: -1,
  disposed: 0,
  other: 0,
  unknownEvents: 0,
  endingQty: 123,
  ...over,
})

describe('台账平衡', () => {
  it('期初 + 全部变动（带符号相加）= 期望期末', () => {
    expect(ledgerExpectedEnding(flows())).toBe(123)
    expect(ledgerExpectedEnding(flows({ endingQty: 0 }))).toBe(123)
  })
})

describe('台账事件分类', () => {
  it.each([
    ['Receipts', 'receipt'],
    ['Shipments', 'shipment'],
    ['CustomerReturns', 'customerReturn'],
    ['Customer Returns', 'customerReturn'],
    ['VendorReturns', 'vendorReturn'],
    ['WhseTransfers', 'transfer'],
    ['Adjustments', 'adjustment'],
    ['SomethingNew', 'other'],
    ['', 'other'],
  ])('%s 归入 %s', (type, group) => {
    expect(classifyLedgerEvent(type, '').group).toBe(group)
  })

  it('调整类按原因细分；认不出原因时不细分；非调整类不细分', () => {
    expect(classifyLedgerEvent('Adjustments', 'Lost in warehouse').adjustment).toBe('lost')
    expect(classifyLedgerEvent('Adjustments', 'DAMAGED_BY_CARRIER').adjustment).toBe('damaged')
    expect(classifyLedgerEvent('Adjustments', 'Found').adjustment).toBe('found')
    expect(classifyLedgerEvent('Adjustments', 'Disposed').adjustment).toBe('disposed')
    expect(classifyLedgerEvent('Adjustments', 'Removal order').adjustment).toBe('removal')
    expect(classifyLedgerEvent('Adjustments', 'Q').adjustment).toBeNull()
    expect(classifyLedgerEvent('Shipments', 'Lost').adjustment).toBeNull()
  })
})

describe('台账查询参数', () => {
  it('汇总：页码分页，只看不平衡是布尔；未知参数拒绝', () => {
    expect(LedgerSummaryQuerySchema.parse({ view: 'summary', unbalanced: 'true', page: '2' })).toMatchObject({ unbalanced: true, page: 2, sort: { field: 'month', dir: 'desc' } })
    expect(() => LedgerSummaryQuerySchema.parse({ group: 'receipt' })).toThrow()
  })

  it('明细：游标分页，事件分组只接受登记的值', () => {
    expect(LedgerDetailQuerySchema.parse({ view: 'detail', group: 'adjustment', pageSize: '50' })).toMatchObject({ group: 'adjustment', pageSize: 50 })
    expect(() => LedgerDetailQuerySchema.parse({ group: 'nope' })).toThrow()
    expect(() => LedgerDetailQuerySchema.parse({ unbalanced: 'true' })).toThrow()
  })
})

describe('移除订单', () => {
  it('收货状态：只有退回订单且有发货才核对；没有登记是待登记，不是 0', () => {
    expect(removalReceiptState('DISPOSAL', 10, null)).toBe('NOT_APPLICABLE')
    expect(removalReceiptState('RETURN', 0, null)).toBe('NOT_APPLICABLE')
    expect(removalReceiptState('RETURN', 10, null)).toBe('PENDING')
    expect(removalReceiptState('RETURN', 10, 10)).toBe('MATCHED')
    expect(removalReceiptState('RETURN', 10, 8)).toBe('SHORT')
    expect(removalReceiptState('RETURN', 10, 12)).toBe('OVER')
    expect(removalReceiptState('RETURN', 10, 0)).toBe('SHORT')
  })

  it('状态中文名：登记过的翻译，没登记的原样显示，空值写尚无记录', () => {
    expect(removalStatusLabel('Completed')).toBe('已完成')
    expect(removalStatusLabel('Canceled')).toBe('已取消')
    expect(removalStatusLabel('Weird')).toBe('Weird')
    expect(removalStatusLabel('')).toBe('尚无记录')
  })

  it('列表参数：类型只接受登记值，默认按请求日期倒序', () => {
    expect(RemovalListQuerySchema.parse({})).toMatchObject({ sort: { field: 'requestDate', dir: 'desc' }, page: 1 })
    expect(() => RemovalListQuerySchema.parse({ type: 'SELL' })).toThrow()
  })

  it('收货登记：良品与损坏之和不能超过实收；数量必须是非负整数；未知字段拒绝', () => {
    const ok = { sku: 'A', receivedQty: 10, sellableQty: 8, damagedQty: 2 }
    expect(RemovalReceiptBodySchema.parse(ok)).toMatchObject(ok)
    expect(RemovalReceiptBodySchema.safeParse({ ...ok, damagedQty: 3 }).success).toBe(false)
    expect(RemovalReceiptBodySchema.safeParse({ ...ok, receivedQty: -1 }).success).toBe(false)
    expect(RemovalReceiptBodySchema.safeParse({ ...ok, receivedQty: 1.5 }).success).toBe(false)
    expect(RemovalReceiptBodySchema.safeParse({ ...ok, receivedAt: '2026/10/01' }).success).toBe(false)
    expect(RemovalReceiptBodySchema.safeParse({ ...ok, extra: 1 }).success).toBe(false)
  })
})

describe('仓储限额导入参数', () => {
  it('店铺、文件名、内容都必填；内容有上限', () => {
    expect(StorageLimitImportBodySchema.safeParse({ sellerAccountId: 's1', fileName: 'a.csv', content: 'x' }).success).toBe(true)
    expect(StorageLimitImportBodySchema.safeParse({ sellerAccountId: '', fileName: 'a.csv', content: 'x' }).success).toBe(false)
    expect(StorageLimitImportBodySchema.safeParse({ sellerAccountId: 's1', fileName: 'a.csv', content: 'x'.repeat(100_001) }).success).toBe(false)
  })

  it('存储类型中文名；未登记的原样显示', () => {
    expect(storageTypeLabel('STANDARD')).toBe('标准尺寸')
    expect(storageTypeLabel('OTHER_TYPE')).toBe('OTHER_TYPE')
  })
})
