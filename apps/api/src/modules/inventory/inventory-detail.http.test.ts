import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp } from '../../testing/harness'
import { policyRow, prismaFor, record } from './inventory-http.test-helper'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const ALL = ['inventory.read', 'replenishment.read', 'awd.read']
const withPolicy = (over: Record<string, any> = {}, permissions = ALL) =>
  prismaFor(permissions, { replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(policyRow()), findMany: vi.fn().mockResolvedValue([policyRow()]), create: vi.fn() }, ...over })
const day = (date: string) => new Date(`${date}T00:00:00Z`)
const daily = (date: string, source: string, over: Record<string, unknown> = {}) => ({
  snapshotDate: day(date),
  source,
  sellable: null,
  inbound: null,
  reserved: null,
  unsellable: null,
  researching: null,
  ...over,
})

describe('库存详情：概览与 404', () => {
  it('编号不在范围内或不存在：404', async () => {
    harness = await createTestApp(withPolicy({ fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([]) } }))
    for (const path of ['/inventory/nope', '/inventory/nope/structure', '/inventory/nope/forecast']) expect((await harness.call('GET', path)).status, path).toBe(404)
  })

  it('概览：行、规则版本、建议卡（规则、证据、影响、风险）与新鲜度', async () => {
    const prisma = withPolicy()
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/inventory/inv-1')).json
    expect(data.row).toMatchObject({ id: 'inv-1', sku: 'SKU-1', assessment: { risk: 'HIGH', policyVersion: 1 } })
    expect(data.policy).toMatchObject({ versionNo: 1, coverageDays: 60 })
    expect(data.suggestions[0]).toMatchObject({ id: 'replenish', action: 'REPLENISH_URGENT' })
    expect(data.suggestions[0].evidence).toContain('规则版本 1')
    expect(data.freshness).toMatchObject({ lastSuccessAt: null, qualityIssues: expect.any(Number) })
    expect(data.productId).toBe('prod-1') // 链到 ASIN 360（P2a-14）
    expect(prisma.fbaInventoryRecord.findMany.mock.calls[0][0].where).toMatchObject({ id: { in: ['inv-1'] } })
  })

  it('没有配置规则：概览没有建议卡，规则为空', async () => {
    harness = await createTestApp(prismaFor(ALL))
    const { data } = (await harness.call('GET', '/inventory/inv-1')).json
    expect(data.policy).toBeNull()
    expect(data.suggestions).toEqual([])
  })
})

describe('库存详情：结构、快照、台账、入仓', () => {
  it('结构趋势：同一天多个来源只取优先级最高的一个；没有快照时 NO_DATA 并说明', async () => {
    const rows = [daily('2026-10-20', 'AFN', { sellable: 1 }), daily('2026-10-20', 'API', { sellable: 9, inbound: 3 }), daily('2026-10-21', 'API', { sellable: 8 })]
    harness = await createTestApp(withPolicy({ inventoryDailySnapshot: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue(rows) } }))
    const ok = (await harness.call('GET', '/inventory/inv-1/structure')).json.data
    expect(ok.state).toBe('OK')
    expect(ok.points).toEqual([
      { date: '2026-10-20', source: 'API', sellable: 9, inbound: 3, reserved: null, unsellable: null, researching: null },
      { date: '2026-10-21', source: 'API', sellable: 8, inbound: null, reserved: null, unsellable: null, researching: null },
    ])
    await harness.close()
    harness = await createTestApp(withPolicy())
    const none = (await harness.call('GET', '/inventory/inv-1/structure')).json.data
    expect(none).toMatchObject({ state: 'NO_DATA', points: [] })
    expect(none.note).toContain('没有库存日快照')
  })

  it('历史快照：返回可选日期与两个日期的字段；没有快照的日期 found=false 且字段为 null', async () => {
    const rows = [daily('2026-10-10', 'API', { sellable: 5 }), daily('2026-10-12', 'API', { sellable: 7 })]
    const findMany = vi.fn().mockImplementation((args: { distinct?: unknown }) => Promise.resolve(args.distinct ? [{ snapshotDate: day('2026-10-12') }, { snapshotDate: day('2026-10-10') }] : rows))
    harness = await createTestApp(withPolicy({ inventoryDailySnapshot: { groupBy: vi.fn().mockResolvedValue([]), findMany } }))
    const { data } = (await harness.call('GET', '/inventory/inv-1/snapshots?a=2026-10-10&b=2026-10-12')).json
    expect(data.availableDates).toEqual(['2026-10-12', '2026-10-10'])
    expect(data.a).toMatchObject({ date: '2026-10-10', found: true, values: { sellable: 5, source: 'API', unitsShippedT30: null } })
    expect(data.b.values.sellable).toBe(7)
    expect(data.labels.sellable).toBe('可售')
    const missing = (await harness.call('GET', '/inventory/inv-1/snapshots?a=2026-10-01&b=2026-10-12')).json.data
    expect(missing.a).toMatchObject({ found: false })
    expect(missing.a.values.sellable).toBeNull()
  })

  it('库存台账：按 FNSKU 读取、事件日期倒序、游标分页；发货与接收标出单据类型', async () => {
    const entry = (id: string, eventType: string, referenceId: string | null) => ({
      id,
      eventDate: day('2026-10-20'),
      eventType,
      reasonCode: '',
      disposition: 'SELLABLE',
      fulfillmentCenter: 'ONT8',
      quantity: -1,
      referenceId,
    })
    const findMany = vi.fn().mockResolvedValue([entry('l1', 'Shipments', '111-1'), entry('l2', 'Receipts', 'FBA1'), entry('l3', 'Adjustments', null)])
    const prisma = withPolicy({ inventoryLedgerEntry: { findMany } })
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', '/inventory/inv-1/ledger?pageSize=2')).json
    expect(data.items.map((item: { referenceKind: string | null }) => item.referenceKind)).toEqual(['ORDER', 'INBOUND_SHIPMENT'])
    expect(data.pageInfo).toMatchObject({ pageSize: 2, hasMore: true })
    expect(data.pageInfo.nextCursor).toBeTruthy()
    expect(findMany.mock.calls[0][0]).toMatchObject({ take: 3 })
    expect(JSON.stringify(findMany.mock.calls[0][0].where)).toContain('X0TEST0001')
  })

  it('库存台账：没有 FNSKU 时说明无法关联，没有记录时说明尚无记录', async () => {
    harness = await createTestApp(withPolicy({ fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([{ ...record(), fnsku: null }]) } }))
    expect((await harness.call('GET', '/inventory/inv-1/ledger')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
    await harness.close()
    harness = await createTestApp(withPolicy())
    const empty = (await harness.call('GET', '/inventory/inv-1/ledger')).json.data
    expect(empty.state).toBe('NO_DATA')
    expect(empty.note).toContain('尚无库存台账记录')
  })

  it('入仓与在途：只列含该 SKU 的计划；无货件的计划货件列为 null；到仓时间“未接入”', async () => {
    const plans = [
      {
        id: 'p1',
        name: '十月补货',
        status: 'SHIPPED',
        items: [{ sellerSku: 'SKU-1', quantity: 40 }],
        shipments: [{ shipmentId: 'FBA1', status: 'IN_TRANSIT', destinationFc: 'ONT8', unitsExpected: 100, unitsReceived: 25 }],
      },
      { id: 'p2', name: '其他商品', status: 'WORKING', items: [{ sellerSku: 'OTHER', quantity: 5 }], shipments: [] },
      { id: 'p3', name: '草稿', status: 'DRAFT', items: [{ sellerSku: 'SKU-1', quantity: 10 }], shipments: [] },
    ]
    harness = await createTestApp(withPolicy({ fbaInboundPlan: { findMany: vi.fn().mockResolvedValue(plans) } }))
    const { data } = (await harness.call('GET', '/inventory/inv-1/inbound')).json
    expect(data.counts).toEqual({ working: 10, shipped: 20, receiving: 0, total: 30, counted: 30 })
    expect(data.shipments).toHaveLength(2)
    expect(data.shipments[0]).toMatchObject({ planId: 'p1', planQuantity: 40, shipmentId: 'FBA1', unitsExpected: 100, receiveProgress: 0.25 })
    expect(data.shipments[1]).toMatchObject({ planId: 'p3', shipmentId: null, unitsExpected: null, receiveProgress: null })
    expect(data.eta).toMatchObject({ state: 'NOT_CONNECTED' })
  })
})

describe('库存详情：补货、库龄、处置、预测', () => {
  const full = () =>
    policyRow({
      serviceLevel: { toString: () => '0.9500' },
      productionDays: 10,
      domesticDays: 3,
      receivingDays: 7,
      transportPreference: 'AUTO',
      transportOptionsJson: [{ mode: 'SEA', transitDays: 30, unitCost: 0.5 }],
      casePackQty: 10,
      moq: 100,
    })

  it('补货建议（P2a-07）：我方是 8 步计算链的结果，亚马逊建议来自补货报告，差异原因只列可核对的', async () => {
    const restock = {
      sellerAccountId: 's1',
      sku: 'SKU-1',
      snapshotDate: day('2026-10-20'),
      recommendedQty: 500,
      recommendedShipDate: day('2026-10-25'),
      alertReason: '库存不足',
      recommendedAction: 'SEND',
      unitsSold30d: 450,
    }
    harness = await createTestApp(
      prismaFor(ALL, {
        replenishmentPolicy: { findFirst: vi.fn().mockResolvedValue(full()), findMany: vi.fn().mockResolvedValue([full()]), create: vi.fn() },
        amazonRestockRecommendation: { findMany: vi.fn().mockResolvedValue([restock]) },
      }),
    )
    const { data } = (await harness.call('GET', '/inventory/inv-1/replenishment')).json
    expect(data.ours).toMatchObject({ state: 'OK', policyVersion: 1, policyLevel: 'TENANT' })
    expect(data.ours.steps.map((step: { key: string }) => step.key)).toEqual(['DEMAND', 'SUPPLY', 'LEAD_TIME', 'SAFETY', 'TARGET', 'QTY', 'TRANSPORT', 'TIMING'])
    expect(data.ours.recommendedQty).toBeGreaterThan(0)
    expect(data.amazon).toMatchObject({ state: 'OK', recommendedQty: 500, source: 'RESTOCK_REPORT', recommendedShipDate: '2026-10-25' })
    expect(data.diffQty).toBe(data.ours.recommendedQty - 500)
    expect(data.diffReasons.length).toBeGreaterThan(0)
  })

  it('补货建议：旧版库存规则没有服务水平与提前期拆分时，提示补齐参数，不给数量', async () => {
    harness = await createTestApp(withPolicy())
    const { data } = (await harness.call('GET', '/inventory/inv-1/replenishment')).json
    expect(data.ours).toMatchObject({ state: 'POLICY_INCOMPLETE', recommendedQty: 0, steps: [] })
    expect(data.ours.reason).toContain('服务水平')
    expect(data.diffQty).toBeNull()
  })

  it('补货建议：没有策略时“尚未配置”，没有亚马逊报告时“无数据”，差异为 null', async () => {
    harness = await createTestApp(prismaFor(ALL))
    const { data } = (await harness.call('GET', '/inventory/inv-1/replenishment')).json
    expect(data.ours).toMatchObject({ state: 'NO_POLICY', recommendedQty: 0 })
    expect(data.amazon).toMatchObject({ state: 'NO_DATA', recommendedQty: null })
    expect(data.diffQty).toBeNull()
  })

  it('库龄与费用：没有库龄快照时 NO_DATA；有快照时给分段与跨档时间线', async () => {
    harness = await createTestApp(withPolicy())
    expect((await harness.call('GET', '/inventory/inv-1/age-fees')).json.data).toMatchObject({ state: 'NO_DATA', crossings: [], buckets: [] })
    await harness.close()
    const age = {
      sellerAccountId: 's1',
      sku: 'SKU-1',
      snapshotDate: day('2026-10-20'),
      age0to90: 0,
      age91to180: 0,
      age181to270: 20,
      age271to365: 0,
      age365plus: 0,
      age0to30: null,
      age31to60: null,
      age61to90: null,
      age366to455: null,
      age456plus: null,
      ageSurchargeEstimate: { toString: () => '3.5' },
    }
    harness = await createTestApp(
      withPolicy({ inventoryAgeSnapshot: { groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _max: { snapshotDate: day('2026-10-20') } }]), findMany: vi.fn().mockResolvedValue([age]) } }),
    )
    const { data } = (await harness.call('GET', '/inventory/inv-1/age-fees')).json
    expect(data).toMatchObject({ state: 'OK', granularity: 'COARSE', snapshotDate: '2026-10-20', surchargeEstimate: 3.5 })
    expect(data.crossings.map((item: { boundaryDays: number }) => item.boundaryDays)).toEqual([271])
  })

  it('处置建议：没有规划报告时亚马逊侧无数据；规则未配置时我方“未接入”', async () => {
    harness = await createTestApp(prismaFor(ALL))
    const { data } = (await harness.call('GET', '/inventory/inv-1/disposition')).json
    expect(data.amazon).toMatchObject({ state: 'NO_DATA', action: null, savings: null })
    expect(data.ours).toMatchObject({ state: 'NOT_CONNECTED', action: null })
  })

  it('预测：历史从第一条销量记录开始并标记断货日；未来 30 天给低、中、高', async () => {
    const start = new Date(Date.now() - 3 * 86_400_000)
    const dayOf = (offset: number) => new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + offset))
    const rows = [
      { summaryDate: dayOf(0), units: 12, inventoryAvailable: 40 },
      { summaryDate: dayOf(1), units: 0, inventoryAvailable: 0 },
    ]
    harness = await createTestApp(withPolicy({ asinDailySummary: { groupBy: vi.fn().mockResolvedValue([]), findMany: vi.fn().mockResolvedValue(rows) } }))
    const { data } = (await harness.call('GET', '/inventory/inv-1/forecast')).json
    expect(data.history.length).toBeGreaterThanOrEqual(2)
    expect(data.history[0]).toMatchObject({ units: 12, stockout: false })
    expect(data.history[1]).toMatchObject({ units: 0, stockout: true })
    expect(data.forecast).toHaveLength(0)
    expect(data.state).toBe('NO_DATA')
    expect(data.exclusions.promotionNote).toContain('尚未接入')
  })

  it('预测：有日销（订单汇总）时给出 30 天预测与口径', async () => {
    harness = await createTestApp(withPolicy())
    const { data } = (await harness.call('GET', '/inventory/inv-1/forecast')).json
    expect(data).toMatchObject({ state: 'OK', source: 'ORDERS', method: 'inventory-demand@1' })
    expect(data.forecast).toHaveLength(30)
    expect(data.forecast[0]).toMatchObject({ mid: 10 })
  })
})
