import { describe, expect, it } from 'vitest'
import { fakeContext, rowsOf, scope, tsv } from './fake-context.test-helper'
import { syncPlanningReport, syncRecommendedRemovalReport } from './planning-reports'
import { syncRestockReport } from './restock-report'
import { syncSnapshotReport } from './snapshot-reports'

describe('库存快照类报告（R-09、R-10、R-11、R-14、R-15）', () => {
  it('库存报告：写当日来源分行，可售、在途合计、不可售取自报告；没给的列不出现；只有自发货的商品不写', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      ['sku', 'fnsku', 'asin', 'afn-listing-exists', 'afn-fulfillable-quantity', 'afn-unsellable-quantity', 'afn-inbound-working-quantity', 'afn-inbound-shipped-quantity', 'afn-total-quantity'],
      ['SKU-1', 'X001', 'B000000001', 'Yes', '10', '2', '3', '4', '19'],
      ['SKU-MFN', '', 'B000000002', 'No', '', '', '', '', ''],
    )
    const result = await syncSnapshotReport(ctx, rowsOf(text), scope, 'MYI_UNSUPPRESSED')
    expect(result.imported).toBe(1)
    const call = of('inventoryDailySnapshot')[0].args
    expect(call.where.tenantId_sellerAccountId_sku_fnsku_snapshotDate_source).toMatchObject({ sku: 'SKU-1', fnsku: 'X001', source: 'MYI_UNSUPPRESSED' })
    expect(call.create).toMatchObject({ sellable: 10, unsellable: 2, inbound: 7, asin: 'B000000001', sourceReportJobId: 'rj1' })
    expect(call.create).not.toHaveProperty('reserved')
    expect(call.create.snapshotDate.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    expect(of('inventoryDailySnapshot')).toHaveLength(1)
  })

  it('亚马逊物流库存报告按处置状态区分可售与不可售；预留报告取各预留类别；滞留报告带原因', async () => {
    const afn = fakeContext()
    await syncSnapshotReport(
      afn.ctx,
      rowsOf(tsv(['seller-sku', 'fulfillment-channel-sku', 'warehouse-condition-code', 'quantity-available'], ['A', 'F1', 'SELLABLE', '5'], ['B', 'F2', 'UNSELLABLE', '2'])),
      scope,
      'AFN',
    )
    expect(afn.of('inventoryDailySnapshot').map(call => call.args.create)).toMatchObject([
      { sku: 'A', source: 'AFN', sellable: 5 },
      { sku: 'B', source: 'AFN', unsellable: 2 },
    ])
    const reserved = fakeContext()
    await syncSnapshotReport(
      reserved.ctx,
      rowsOf(tsv(['sku', 'fnsku', 'reserved_qty', 'reserved_customerorders', 'reserved_fc-transfers', 'reserved_fc-processing'], ['A', 'F1', '9', '4', '3', '2'])),
      scope,
      'RESERVED',
    )
    expect(reserved.of('inventoryDailySnapshot')[0].args.create).toMatchObject({ source: 'RESERVED', reserved: 9, reservedCustomerOrder: 4, reservedTransfer: 3, reservedProcessing: 2 })
    const stranded = fakeContext()
    await syncSnapshotReport(stranded.ctx, rowsOf(tsv(['sku', 'fnsku', 'stranded-quantity', 'stranded-reason'], ['A', 'F1', '6', 'Missing listing'])), scope, 'STRANDED')
    expect(stranded.of('inventoryDailySnapshot')[0].args.create).toMatchObject({ source: 'STRANDED', stranded: 6, strandedReason: 'Missing listing' })
  })

  it('同一天同一来源重复导入落在同一个幂等键上；表头缺关键列失败码是 PARSE_HEADER；整行没有数量的忽略', async () => {
    const text = tsv(['sku', 'fnsku', 'quantity-available'], ['A', 'F1', '5'])
    const first = fakeContext()
    const again = fakeContext()
    await syncSnapshotReport(first.ctx, rowsOf(text), scope, 'AFN')
    await syncSnapshotReport(again.ctx, rowsOf(text), scope, 'AFN')
    expect(again.of('inventoryDailySnapshot')[0].args.where).toEqual(first.of('inventoryDailySnapshot')[0].args.where)
    await expect(syncSnapshotReport(fakeContext().ctx, rowsOf(tsv(['foo', 'bar'], ['1', '2'])), scope, 'AFN')).rejects.toMatchObject({ code: 'PARSE_HEADER' })
    const empty = fakeContext()
    expect((await syncSnapshotReport(empty.ctx, rowsOf(tsv(['sku', 'fnsku', 'quantity-available'], ['A', 'F1', ''])), scope, 'AFN')).imported).toBe(0)
  })
})

describe('库存规划报告（R-08）与推荐移除（R-17）', () => {
  const header = [
    'sku',
    'fnsku',
    'asin',
    'available',
    'days-of-supply',
    'inv-age-0-to-90-days',
    'inv-age-91-to-180-days',
    'estimated-ais-181-210-days',
    'estimated-ais-211-240-days',
    'recommended-ship-in-quantity',
  ]

  it('规划快照写全字段，库龄快照写库龄分段与库龄附加费预估（各分段之和）', async () => {
    const { ctx, of } = fakeContext()
    await syncPlanningReport(ctx, rowsOf(tsv(header, ['SKU-1', 'X001', 'B000000001', '40', '35.5', '30', '10', '1.25', '2.5', '60'])), scope)
    const planning = of('inventoryPlanningSnapshot')[0].args
    expect(planning.where.tenantId_sellerAccountId_sku_fnsku_snapshotDate).toMatchObject({ sku: 'SKU-1', fnsku: 'X001' })
    expect(planning.create).toMatchObject({ available: 40, daysOfSupply: 35.5, age0to90: 30, age91to180: 10, recommendedShipInQty: 60, asin: 'B000000001' })
    const age = of('inventoryAgeSnapshot')[0].args.create
    expect(age).toMatchObject({ age0to90: 30, age91to180: 10, ageSurchargeEstimate: 3.75 })
  })

  it('报告没有库龄列时不写库龄快照；报告自带 snapshot-date 时用它', async () => {
    const { ctx, of } = fakeContext()
    await syncPlanningReport(ctx, rowsOf(tsv(['sku', 'fnsku', 'available', 'snapshot-date'], ['SKU-1', 'X001', '40', '2026-10-20'])), scope)
    expect(of('inventoryAgeSnapshot')).toHaveLength(0)
    expect(of('inventoryPlanningSnapshot')[0].args.create.snapshotDate.toISOString().slice(0, 10)).toBe('2026-10-20')
  })

  it('推荐移除报告只写移除三列，不带规划报告的其他列', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(['sku', 'fnsku', 'recommended-removal-quantity', 'recommended-removal-reason'], ['SKU-1', 'X001', '12', 'Aged inventory'], ['SKU-2', 'X002', '', ''])
    expect((await syncRecommendedRemovalReport(ctx, rowsOf(text), scope)).imported).toBe(1)
    const create = of('inventoryPlanningSnapshot')[0].args.create
    expect(create).toMatchObject({ removalReportQty: 12, removalReportReason: 'Aged inventory' })
    expect(create).not.toHaveProperty('recommendedRemovalQty')
    expect(create.removalReportUpdatedAt).toEqual(scope.now)
  })
})

describe('官方补货建议（R-16）', () => {
  it('写入建议补货量与双源核对用的字段；非美国站的行忽略', async () => {
    const { ctx, of } = fakeContext()
    const text = tsv(
      [
        'country',
        'merchant-sku',
        'fnsku',
        'asin',
        'recommended-replenishment-qty',
        'recommended-ship-date',
        'alert',
        'total-days-of-supply-including-units-from-open-shipments',
        'units-sold-last-30-days',
        'sales-last-30-days',
      ],
      ['US', 'SKU-1', 'X001', 'B000000001', '120', '2026-10-25', 'Out of stock', '14', '90', '1800.5'],
      ['DE', 'SKU-2', 'X002', 'B000000002', '5', '2026-10-25', '', '', '', ''],
    )
    expect((await syncRestockReport(ctx, rowsOf(text), scope)).imported).toBe(1)
    const create = of('amazonRestockRecommendation')[0].args.create
    expect(create).toMatchObject({ sku: 'SKU-1', recommendedQty: 120, alertReason: 'Out of stock', daysOfSupply: 14, unitsSold30d: 90, salesLast30d: 1800.5 })
    expect(create.recommendedShipDate.toISOString().slice(0, 10)).toBe('2026-10-25')
    expect(create.snapshotDate).toEqual(scope.snapshotDate)
  })
})
