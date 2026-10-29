import { describe, expect, it } from 'vitest'
import { fakeContext, rowsOf, scope, tsv } from './fake-context.test-helper'
import { syncLedgerDetailReport, syncLedgerSummaryReport } from './ledger-reports'
import { removalTypeOf, syncRemovalOrderReport, syncRemovalShipmentReport } from './removal-reports'
import { storageFeeRowHandler, syncLongTermFeeReport, syncOverageFeeReport, syncStorageFeeRecords } from './storage-fee-reports'

describe('库存台账（R-12、R-13）', () => {
  const header = ['date', 'fnsku', 'asin', 'msku', 'fulfillment-center', 'disposition', 'reason', 'event-type', 'reference-id', 'quantity', 'country']
  const row = (date: string, quantity: string, country = 'US') => [date, 'X001', 'B000000001', 'SKU-1', 'ONT8', 'SELLABLE', '', 'Receipts', 'FBA1', quantity, country]

  it('明细：同一天内完全相同的两行用出现序号区分（各写一行）；其他国家忽略', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(header, row('2026-10-20', '5'), row('2026-10-20', '5'), row('2026-10-20', '5', 'DE'))
    expect((await syncLedgerDetailReport(ctx, rowsOf(text), scope)).imported).toBe(2)
    const hashes = of('inventoryLedgerEntry').map(call => call.args.where.tenantId_sellerAccountId_rowHash.rowHash as string)
    expect(hashes).toHaveLength(2)
    expect(new Set(hashes).size).toBe(2)
    expect(of('inventoryLedgerEntry')[0].args.create).toMatchObject({ fnsku: 'X001', sku: 'SKU-1', quantity: 5, eventType: 'Receipts', fulfillmentCenter: 'ONT8', referenceId: 'FBA1' })
  })

  it('明细：按不同时间窗重新拉取同一天的数据，哈希保持一致（不会重复写入）', async () => {
    const narrow = fakeContext()
    const wide = fakeContext()
    await syncLedgerDetailReport(narrow.ctx, rowsOf(tsv(header, row('2026-10-21', '3'), row('2026-10-21', '3'))), scope)
    await syncLedgerDetailReport(wide.ctx, rowsOf(tsv(header, row('2026-10-20', '9'), row('2026-10-21', '3'), row('2026-10-21', '3'))), scope)
    const keys = (c: ReturnType<typeof fakeContext>) => c.of('inventoryLedgerEntry').map(call => call.args.where.tenantId_sellerAccountId_rowHash.rowHash as string)
    expect(keys(wide).slice(1)).toEqual(keys(narrow))
  })

  it('明细：缺日期或数量的行被跳过，缺关键列整份失败', async () => {
    const { ctx, of, warn } = fakeContext()
    expect((await syncLedgerDetailReport(ctx, rowsOf(tsv(header, row('2026-10-20', '5'), row('not-a-date', '5'), row('2026-10-20', ''))), scope)).imported).toBe(1)
    expect(of('inventoryLedgerEntry')).toHaveLength(1)
    expect(warn).toHaveBeenCalled()
    await expect(syncLedgerDetailReport(fakeContext().ctx, rowsOf(tsv(['a', 'b'], ['1', '2'])), scope)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })

  it('汇总：按 日期、FNSKU、仓库位置、处置、汇总粒度 落键，各类事件数量原样保存', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['date', 'fnsku', 'asin', 'msku', 'location', 'disposition', 'starting-warehouse-balance', 'receipts', 'customer-shipments', 'ending-warehouse-balance'],
      ['2026-10-20', 'X001', 'B000000001', 'SKU-1', 'ONT8', 'SELLABLE', '100', '20', '-15', '105'],
    )
    expect((await syncLedgerSummaryReport(ctx, rowsOf(text), scope)).imported).toBe(1)
    const call = of('inventoryLedgerSummary')[0].args
    expect(call.where.tenantId_sellerAccountId_date_fnsku_fulfillmentCenter_disposition_aggregation).toMatchObject({
      fnsku: 'X001',
      fulfillmentCenter: 'ONT8',
      disposition: 'SELLABLE',
      aggregation: 'DAILY',
    })
    expect(call.create).toMatchObject({ startingQty: 100, receipts: 20, customerShipments: -15, endingQty: 105 })
    expect(call.create).not.toHaveProperty('lost') // 没给的类别不写 0
  })
})

describe('仓储类费用（R-20、R-21、R-22）', () => {
  it('月度仓储费：基础费、利用率附加费（非 0 才写）与仓储利用率分别落库；月份归到月初', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['fnsku', 'asin', 'fulfillment-center', 'month-of-charge', 'base-monthly-storage-fee', 'utilization-surcharge-fee', 'storage-utilization-ratio', 'product-size-tier', 'currency'],
      ['X001', 'B000000001', 'ONT8', '2026-09', '12.5', '1.5', '0.82', 'Standard-size', 'USD'],
      ['X002', 'B000000002', 'ONT8', '2026-09', '3', '0', '', '', 'USD'],
    )
    expect((await syncStorageFeeRecords(ctx, rowsOf(text), scope)).imported).toBe(2)
    const fees = of('storageFeeRecord').map(call => call.args.create)
    expect(fees.map(fee => [fee.fnsku, fee.feeKind, fee.amount])).toEqual([
      ['X001', 'STORAGE', 12.5],
      ['X001', 'UTILIZATION', 1.5],
      ['X002', 'STORAGE', 3],
    ])
    expect(fees[0].chargeMonth.toISOString().slice(0, 10)).toBe('2026-09-01')
    expect(of('storageCapacitySnapshot')[0].args.create).toMatchObject({ storageType: 'STANDARD', utilizationPct: 0.82, sourceKind: 'REPORT' })
  })

  it('仓储利用率分段含 oversize 归入超大件；同一份数据重复导入落在同一个幂等键', async () => {
    const text = tsv(['fnsku', 'month-of-charge', 'base-monthly-storage-fee', 'storage-utilization-ratio', 'product-size-tier'], ['X001', '2026-09-30', '4', '0.5', 'Oversize'])
    const first = fakeContext()
    const again = fakeContext()
    await syncStorageFeeRecords(first.ctx, rowsOf(text), scope)
    await syncStorageFeeRecords(again.ctx, rowsOf(text), scope)
    expect(first.of('storageCapacitySnapshot')[0].args.create.storageType).toBe('OVERSIZE')
    expect(again.of('storageFeeRecord')[0].args.where).toEqual(first.of('storageFeeRecord')[0].args.where)
  })

  it('行处理器可单独复用：没有月份的行被跳过，缺关键列整份失败', async () => {
    const handler = storageFeeRowHandler(scope)
    const { ctx } = fakeContext()
    expect(await handler(ctx, { fnsku: 'X1', 'month-of-charge': '', 'base-monthly-storage-fee': '1' }, 1)).toBe('skipped')
    expect(await handler(ctx, { fnsku: '', 'month-of-charge': '2026-09' }, 1)).toBe('ignored')
    await expect(handler(ctx, { foo: '1' }, 0)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })

  it('超限费写 OVERAGE；长期仓储费把 6 个月与 12 个月档合计写 LONGTERM；金额都没给的行忽略', async () => {
    const overage = fakeContext()
    await syncOverageFeeReport(overage.ctx, rowsOf(tsv(['fnsku', 'month-of-charge', 'estimated-overage-fee'], ['X001', '2026-09', '8.25'], ['X002', '2026-09', ''])), scope)
    expect(overage.of('storageFeeRecord')).toHaveLength(1)
    expect(overage.of('storageFeeRecord')[0].args.create).toMatchObject({ feeKind: 'OVERAGE', amount: 8.25 })
    const longTerm = fakeContext()
    const text = tsv(['fnsku', 'snapshot-date', '6-mo-long-terms-storage-fee', '12-mo-long-terms-storage-fee'], ['X001', '2026-10-15', '1.5', '4'], ['X002', '2026-10-15', '', ''])
    expect((await syncLongTermFeeReport(longTerm.ctx, rowsOf(text), scope)).imported).toBe(1)
    const fee = longTerm.of('storageFeeRecord')[0].args.create
    expect(fee).toMatchObject({ feeKind: 'LONGTERM', amount: 5.5 })
    expect(fee.chargeMonth.toISOString().slice(0, 10)).toBe('2026-10-01')
  })
})

describe('移除订单与移除货件（R-18、R-19）', () => {
  it('类型映射：Return、Disposal，其余归为 OTHER', () => {
    expect(removalTypeOf('Return')).toBe('RETURN')
    expect(removalTypeOf('Disposal')).toBe('DISPOSAL')
    expect(removalTypeOf('Liquidations')).toBe('OTHER')
    expect(removalTypeOf(undefined)).toBe('OTHER')
  })

  it('移除订单：按 订单、SKU、FNSKU、处置 落键，数量与状态保存；没有申请日期的行被跳过', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['request-date', 'order-id', 'order-type', 'order-status', 'sku', 'fnsku', 'disposition', 'requested-quantity', 'shipped-quantity', 'removal-fee', 'currency'],
      ['2026-10-01T08:00:00Z', 'R1', 'Return', 'Completed', 'SKU-1', 'X001', 'Sellable', '10', '10', '3.2', 'USD'],
      ['', 'R2', 'Return', 'Pending', 'SKU-2', 'X002', 'Sellable', '1', '', '', ''],
    )
    expect((await syncRemovalOrderReport(ctx, rowsOf(text), scope)).imported).toBe(1)
    const call = of('removalOrder')[0].args
    expect(call.where.tenantId_sellerAccountId_orderId_sku_fnsku_disposition).toMatchObject({ orderId: 'R1', sku: 'SKU-1', fnsku: 'X001', disposition: 'Sellable' })
    expect(call.create).toMatchObject({ type: 'RETURN', status: 'Completed', requestedQty: 10, shippedQty: 10, fee: 3.2 })
    expect(call.create).not.toHaveProperty('disposedQty')
  })

  it('移除货件：官方报告没有货件编号时，用运单号作 shipmentId，运单号也没有时用 NOTRACK-发货日期', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['order-id', 'sku', 'fnsku', 'shipment-date', 'carrier', 'tracking-number', 'shipped-quantity'],
      ['R1', 'SKU-1', 'X001', '2026-10-05', 'UPS', '1Z999', '4'],
      ['R1', 'SKU-2', 'X002', '2026-10-06', '', '', '2'],
    )
    expect((await syncRemovalShipmentReport(ctx, rowsOf(text), scope)).imported).toBe(2)
    const ids = of('removalShipment').map(call => call.args.where.tenantId_sellerAccountId_orderId_shipmentId_sku_fnsku.shipmentId)
    expect(ids).toEqual(['1Z999', 'NOTRACK-2026-10-06'])
    expect(of('removalShipment')[0].args.create).toMatchObject({ carrier: 'UPS', shippedQty: 4 })
  })
})
