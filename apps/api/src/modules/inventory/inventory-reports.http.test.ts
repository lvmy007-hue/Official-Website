import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 跨仓总览与进销存报表接口（P6-25）：权限先于参数校验；跨仓聚合不重复计算（在途与已到仓互斥）、国内仓与货值按权限降级；
// 进销存期初 + 变动 = 期末、不平衡的行标出、货值用期末日生效的成本版本、没有成本版本不估算。

const dec = (value: string) => ({ toString: () => value })
const day = (text: string) => new Date(`${text}T00:00:00Z`)
const FULL = ['inventory.read', 'warehouse.read', 'field.cost']
const RANGE = 'from=2026-09-01&to=2026-10-31'

const fba = {
  sellerAccountId: 's1',
  sellerSku: 'SKU-A',
  fulfillableQuantity: 50,
  reservedQuantity: 5,
  unfulfillableQuantity: 1,
  inboundWorkingQuantity: 3,
  inboundShippedQuantity: 4,
  inboundReceivingQuantity: 0,
}
const awd = (date: string, onhand: number) => ({ sellerAccountId: 's1', sku: 'SKU-A', snapshotDate: day(date), onhandQty: onhand, inboundToAwdQty: 2, outboundToFbaInTransit: 6 })
const version = (versionNo: number, effectiveFrom: string, over: Record<string, unknown> = {}) => ({
  sku: 'SKU-A',
  versionNo,
  effectiveFrom: day(effectiveFrom),
  currency: 'USD',
  unitProductCost: dec('10'),
  unitFirstMileCost: dec('2'),
  unitDutyCost: null,
  unitOtherCost: null,
  ...over,
})
const ledger = (fnsku: string, sku: string, over: Record<string, unknown> = {}) => ({
  sellerAccountId: 's1',
  date: day('2026-10-31'),
  fnsku,
  asin: 'B0AAAAAAA1',
  sku,
  fulfillmentCenter: 'ABC1',
  disposition: 'SELLABLE',
  aggregation: 'MONTHLY',
  startingQty: 0,
  receipts: 0,
  customerShipments: 0,
  customerReturns: 0,
  vendorReturns: 0,
  transfers: 0,
  found: 0,
  lost: 0,
  damaged: 0,
  disposed: 0,
  other: 0,
  endingQty: 0,
  unknownEvents: 0,
  ...over,
})
const LEDGER = [
  ledger('X1', 'SKU-A', { startingQty: 100, receipts: 50, customerShipments: -60, customerReturns: 5, lost: -2, endingQty: 93 }),
  ledger('X2', 'SKU-A', { startingQty: 10, customerShipments: -10, endingQty: 0 }),
  ledger('X3', 'SKU-B', { startingQty: 10, customerShipments: -3, endingQty: 9 }),
]

function stub(permissions: string[], over: Record<string, unknown> = {}) {
  const base = sessionStub(permissions)
  return {
    ...base,
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
    fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([fba]) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([{ sellerSku: 'SKU-A', title: '无线鼠标' }]) },
    awdInventory: { findMany: vi.fn().mockResolvedValue([awd('2026-10-27', 20), awd('2026-10-20', 99)]) },
    warehouse: { findMany: vi.fn().mockResolvedValue([{ id: 'w1', name: '深圳仓' }]) },
    inventoryMovement: {
      groupBy: vi.fn().mockResolvedValue([
        { warehouseId: 'w1', sellerSku: 'SKU-A', _sum: { quantity: 30 } },
        { warehouseId: 'w1', sellerSku: 'SKU-OLD', _sum: { quantity: 0 } },
      ]),
    },
    firstMileShipmentItem: { findMany: vi.fn().mockResolvedValue([{ sku: 'SKU-A', quantity: 15, shipmentId: 'sh1', shipment: { waybillNo: 'WB-1' } }]) },
    costVersion: { findMany: vi.fn().mockResolvedValue([version(0, '2026-01-01', { unitProductCost: dec('8') }), version(1, '2026-09-01'), version(2, '2026-11-01', { unitProductCost: dec('99') })]) },
    inventoryLedgerSummary: { findMany: vi.fn().mockResolvedValue(LEDGER) },
    ...over,
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[] = FULL, over: Record<string, unknown> = {}) => {
  const prisma = stub(permissions, over)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const read = async (path: string, permissions: string[] = FULL, over: Record<string, unknown> = {}) => {
  const { call, prisma } = await open(permissions, over)
  const response = await call('GET', path)
  expect(response.status).toBe(200)
  return { data: response.json.data, prisma }
}

describe('权限与参数', () => {
  it('未登录 401；没有 inventory.read 403 且先于参数校验，不读任何业务数据', async () => {
    const { call, prisma } = await open(['orders.read'])
    for (const path of ['/inventory/all-warehouses', '/inventory/movement']) {
      expect((await call('GET', path, { auth: false })).status).toBe(401)
      expect((await call('GET', `${path}?sort=坏:asc`)).status).toBe(403)
    }
    expect(prisma.fbaInventoryRecord.findMany).not.toHaveBeenCalled()
    expect(prisma.inventoryLedgerSummary.findMany).not.toHaveBeenCalled()
  })

  it('排序字段或筛选值非法返回 422', async () => {
    const { call } = await open()
    expect((await call('GET', '/inventory/all-warehouses?sort=value:asc')).status).toBe(422)
    expect((await call('GET', '/inventory/movement?unbalanced=yes')).status).toBe(422)
    expect((await call('GET', '/inventory/movement?sort=stockValue:asc')).status).toBe(422)
  })
})

describe('跨仓总览', () => {
  it('按 SKU 聚合：已到仓与在途互斥相加，AWD 发往 FBA 只展示不计入合计，AWD 取最近一天快照', async () => {
    const { data } = await read('/inventory/all-warehouses')
    expect(data.total).toBe(1)
    const row = data.items[0]
    expect(row.sku).toBe('SKU-A')
    expect(row.title).toBe('无线鼠标')
    expect(row.cells).toMatchObject({ fbaSellable: 50, fbaReserved: 5, fbaUnsellable: 1, awdOnhand: 20, domesticOnhand: 30, fbaInbound: 7, awdInbound: 2, firstMileTransit: 15, awdToFba: 6 })
    expect(row.onHand).toBe(106)
    expect(row.inTransit).toBe(24)
    expect(row.total).toBe(130)
    expect(data.summary).toMatchObject({ onHand: 106, inTransit: 24, total: 130 })
  })

  it('可以展开到每个仓：FBA、AWD、国内仓、头程在途各一行，子行相加等于合计', async () => {
    const { data } = await read('/inventory/all-warehouses')
    const children = data.items[0].children as Array<{ kind: string; label: string; total: number }>
    expect(children.map(child => `${child.kind}:${child.label}`).sort()).toEqual(['AWD:美国主店', 'DOMESTIC:深圳仓', 'FBA:美国主店', 'FIRST_MILE:WB-1'])
    expect(children.reduce((sum, child) => sum + child.total, 0)).toBe(data.items[0].total)
  })

  it('头程在途只取已出库、未送达、没有关联亚马逊货件的运单（避免与 FBA 入库中、已到仓重复）', async () => {
    const { prisma } = await read('/inventory/all-warehouses')
    expect(prisma.firstMileShipmentItem.findMany.mock.calls[0]![0].where).toMatchObject({
      tenantId: 'tenant-1',
      shipment: { outboundAt: { not: null }, ataDelivery: null, linkedInboundShipmentIds: { isEmpty: true } },
    })
  })

  it('货值 = 合计数量 × 今天生效的成本版本单价；未来生效的版本不用', async () => {
    const { data } = await read('/inventory/all-warehouses')
    expect(data.items[0].unitCost).toBe(12)
    expect(data.items[0].stockValue).toBe(1560)
    expect(data.summary.stockValue).toBe(1560)
  })

  it('没有仓库读取权限：国内仓与头程列不返回并说明原因，不读这两张表', async () => {
    const { data, prisma } = await read('/inventory/all-warehouses', ['inventory.read', 'field.cost'])
    expect(data.items[0].cells.domesticOnhand).toBeNull()
    expect(data.items[0].cells.firstMileTransit).toBeNull()
    expect(data.items[0].total).toBe(76 + 9)
    expect(data.restrictions[0]).toMatchObject({ metrics: ['domesticOnhand', 'firstMileTransit'], reason: '需要仓库读取权限' })
    expect(prisma.inventoryMovement.groupBy).not.toHaveBeenCalled()
    expect(prisma.firstMileShipmentItem.findMany).not.toHaveBeenCalled()
  })

  it('没有成本字段权限：货值为空并标明受限，不读成本版本', async () => {
    const { data, prisma } = await read('/inventory/all-warehouses', ['inventory.read', 'warehouse.read'])
    expect(data.costRestricted).toBe(true)
    expect(data.items[0].stockValue).toBeNull()
    expect(data.items[0].unitCost).toBeNull()
    expect(prisma.costVersion.findMany).not.toHaveBeenCalled()
  })

  it('没有成本版本的 SKU 货值是 null，不是 0；没有任何库存数据时 NO_DATA', async () => {
    const none = await read('/inventory/all-warehouses', FULL, { costVersion: { findMany: vi.fn().mockResolvedValue([]) } })
    expect(none.data.items[0].stockValue).toBeNull()
    const empty = await read('/inventory/all-warehouses', FULL, {
      fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([]) },
      awdInventory: { findMany: vi.fn().mockResolvedValue([]) },
      inventoryMovement: { groupBy: vi.fn().mockResolvedValue([]) },
      firstMileShipmentItem: { findMany: vi.fn().mockResolvedValue([]) },
    })
    expect(empty.data.state).toBe('NO_DATA')
    expect(empty.data.items).toEqual([])
  })

  it('搜索、排序、分页', async () => {
    const more = { ...fba, sellerSku: 'SKU-B', fulfillableQuantity: 500 }
    const { data } = await read('/inventory/all-warehouses?sort=total:desc&pageSize=1&page=2', FULL, { fbaInventoryRecord: { findMany: vi.fn().mockResolvedValue([fba, more]) } })
    expect(data.total).toBe(2)
    expect(data.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-A'])
    const found = await read('/inventory/all-warehouses?q=鼠标')
    expect(found.data.items).toHaveLength(1)
  })

  it('每个查询都带企业条件', async () => {
    const { prisma } = await read('/inventory/all-warehouses')
    expect(prisma.fbaInventoryRecord.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1' })
    expect(prisma.awdInventory.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1' })
    expect(prisma.inventoryMovement.groupBy.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1' })
  })
})

describe('进销存报表', () => {
  it('同一 SKU 多个 FNSKU 合并：期初 + 变动 = 期末，变动归并成六类，周转与存销比用发货件数', async () => {
    const { data } = await read(`/inventory/movement?${RANGE}`)
    const row = data.items.find((item: { sku: string }) => item.sku === 'SKU-A')
    expect(row).toMatchObject({ month: '2026-10', openingQty: 110, endingQty: 93, expectedEnding: 93, difference: 0, balanced: true, shippedUnits: 70 })
    expect(row.flows).toEqual({ receipts: 50, shipments: -70, returns: 5, transfers: 0, adjustments: -2, other: 0 })
    expect(row.openingQty + Object.values(row.flows as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(row.endingQty)
    expect(row.sellThrough).toBe(1.33)
    expect(row.turnoverDays).toBe(41.2)
  })

  it('货值用期末日生效的成本版本，整行一个单价，期初货值 + 变动货值 = 期末货值；未来版本不用', async () => {
    const { data } = await read(`/inventory/movement?${RANGE}`)
    const row = data.items.find((item: { sku: string }) => item.sku === 'SKU-A')
    expect(row).toMatchObject({ unitCost: 12, costVersionNo: 1, costEffectiveFrom: '2026-09-01', valueNote: null })
    const flows = Object.values(row.values.flows as Record<string, number>).reduce((a, b) => a + b, 0)
    expect(row.values.opening + flows).toBe(row.values.ending)
    expect(row.values).toMatchObject({ opening: 1320, ending: 1116, difference: 0 })
  })

  it('不平衡的行标出差额，不改数据；筛选“只看不平衡”；汇总计数不受筛选影响', async () => {
    const { data } = await read(`/inventory/movement?${RANGE}&unbalanced=true`)
    expect(data.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-B'])
    expect(data.items[0]).toMatchObject({ balanced: false, difference: 2, endingQty: 9, expectedEnding: 7 })
    expect(data.unbalancedCount).toBe(1)
    expect(data.total).toBe(1)
  })

  it('没有成本版本的 SKU 货值是 null 并写原因；币种不是美元不估算', async () => {
    const { data } = await read(`/inventory/movement?${RANGE}`)
    const b = data.items.find((item: { sku: string }) => item.sku === 'SKU-B')
    expect(b.values).toBeNull()
    expect(b.valueNote).toContain('没有生效的成本版本')
    const eur = await read(`/inventory/movement?${RANGE}`, FULL, { costVersion: { findMany: vi.fn().mockResolvedValue([version(1, '2026-09-01', { currency: 'EUR' })]) } })
    expect(eur.data.items.find((item: { sku: string }) => item.sku === 'SKU-A').valueNote).toContain('EUR')
  })

  it('没有成本字段权限：货值为空并标明受限，不读成本版本；数量照常', async () => {
    const { data, prisma } = await read(`/inventory/movement?${RANGE}`, ['inventory.read'])
    expect(data.costRestricted).toBe(true)
    expect(data.items.every((item: { values: unknown }) => item.values === null)).toBe(true)
    expect(data.items.find((item: { sku: string }) => item.sku === 'SKU-A').endingQty).toBe(93)
    expect(prisma.costVersion.findMany).not.toHaveBeenCalled()
  })

  it('合计行：数量按全部符合筛选的行相加；排序空值排最后；分页', async () => {
    const { data } = await read(`/inventory/movement?${RANGE}&sort=sku:asc&pageSize=1`)
    expect(data.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-A'])
    expect(data.total).toBe(2)
    expect(data.totals).toMatchObject({ openingQty: 120, endingQty: 102, difference: 2, openingValue: 1320, endingValue: 1116 })
  })

  it('没有台账记录：NO_DATA，不是 0；读取行数达到上限提示截断', async () => {
    const empty = await read(`/inventory/movement?${RANGE}`, FULL, { inventoryLedgerSummary: { findMany: vi.fn().mockResolvedValue([]) } })
    expect(empty.data.state).toBe('NO_DATA')
    const many = Array.from({ length: 20_000 }, (_, index) => ledger(`F${index}`, `S${index}`))
    const big = await read(`/inventory/movement?${RANGE}`, FULL, { inventoryLedgerSummary: { findMany: vi.fn().mockResolvedValue(many) } })
    expect(big.data.truncated).toBe(true)
  })

  it('读取台账带企业条件与日期范围', async () => {
    const { prisma } = await read(`/inventory/movement?${RANGE}&q=SKU-A`)
    expect(prisma.inventoryLedgerSummary.findMany.mock.calls[0]![0].where).toMatchObject({ tenantId: 'tenant-1', date: { gte: day('2026-09-01'), lte: day('2026-10-31') } })
  })
})
