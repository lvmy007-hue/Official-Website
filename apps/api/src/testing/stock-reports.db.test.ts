import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 销量统计、跨仓总览、进销存报表（P6-25，真实数据库）：
// 进销存期初 + 变动 = 期末、不平衡的行标出、货值与成本版本一致（按期末日取价）、跨仓聚合不重复计算（在途与已到仓互斥）、
// 销量统计各粒度合计一致、范围与租户隔离、字段权限降级。

type Ids = Awaited<ReturnType<DbTestApp['createTenant']>>
type Member = { userId: string; token: string }
const SOURCE_AT = '2026-10-20T00:00:00Z'

describe('销量统计、跨仓总览、进销存报表（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let a: Ids
  let b: Ids
  let store2: string
  let owner: Member
  let viewer: Member
  let ownerB: Member
  let store2Only: Member
  let seq = 0

  const call = (member: Member, path: string) => h.call(member.token, 'GET', path)
  const get = async (member: Member, path: string) => {
    const res = await call(member, path)
    expect(res.status, `${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const put = (table: string, values: Record<string, unknown>, ids: Ids = a) => insertRow(h.client as Client, table, { id: `sr-${++seq}`, tenantId: ids.tenantId, ...values })
  const ledger = (date: string, fnsku: string, sku: string, over: Record<string, unknown>, sellerAccountId = a.sellerAccountId) =>
    put('InventoryLedgerSummary', { sellerAccountId, date, fnsku, sku, aggregation: 'DAILY', sourceUpdatedAt: SOURCE_AT, ...over })
  const cost = (sku: string, versionNo: number, effectiveFrom: string, over: Record<string, unknown> = {}) =>
    put('CostVersion', { sku, versionNo, effectiveFrom, currency: 'USD', status: 'ACTIVE', source: 'MANUAL', unitProductCost: 5, ...over })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'stock_reports', db })
    a = await h.createTenant('sra')
    b = await h.createTenant('srb')
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-sra2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-SRA2' })).id as string
    owner = await h.createMember(a.tenantId, 'sr-owner', ['*'])
    viewer = await h.createMember(a.tenantId, 'sr-viewer', ['inventory.read', 'analytics.read'])
    ownerB = await h.createMember(b.tenantId, 'sr-owner-b', ['*'])
    store2Only = await h.createMember(a.tenantId, 'sr-store2', ['inventory.read', 'warehouse.read', 'field.cost'], { scopes: [{ sellerAccountId: store2 }] })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" IN ($1, $2)`, [a.tenantId, b.tenantId])

    // 台账：SKU-A 九月、十月都平衡；SKU-B 十月不平衡（期末 5，计算 8）；SKU-C 在另一个店铺
    await ledger('2026-09-30', 'FN-A', 'SKU-A', { startingQty: 100, receipts: 20, customerShipments: -30, endingQty: 90 })
    await ledger('2026-10-31', 'FN-A', 'SKU-A', { startingQty: 90, customerShipments: -20, customerReturns: 2, lost: -2, endingQty: 70 })
    await ledger('2026-10-31', 'FN-B', 'SKU-B', { startingQty: 10, customerShipments: -2, endingQty: 5 })
    await ledger('2026-10-31', 'FN-C', 'SKU-C', { startingQty: 7, endingQty: 7 }, store2)
    await put(
      'InventoryLedgerSummary',
      { sellerAccountId: b.sellerAccountId, date: '2026-10-31', fnsku: 'FN-Z', sku: 'SKU-Z', aggregation: 'DAILY', startingQty: 1, endingQty: 1, sourceUpdatedAt: SOURCE_AT },
      b,
    )
    // 成本：SKU-A 两个生效版本，十月 15 日起换新版；SKU-B 没有成本
    await cost('SKU-A', 1, '2026-01-01', { unitProductCost: 5 })
    await cost('SKU-A', 2, '2026-10-15', { unitProductCost: 6, unitFirstMileCost: 1 })

    // 跨仓：SKU-A 的 FBA、AWD（两天快照）、国内仓（入 100 出 40）与三张头程运单
    await put('FbaInventoryRecord', {
      sellerAccountId: a.sellerAccountId,
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAA1',
      fulfillableQuantity: 50,
      reservedQuantity: 5,
      unfulfillableQuantity: 1,
      inboundWorkingQuantity: 3,
      inboundShippedQuantity: 4,
      inboundReceivingQuantity: 0,
      sourceUpdatedAt: SOURCE_AT,
    })
    await put('AwdInventory', {
      sellerAccountId: a.sellerAccountId,
      sku: 'SKU-A',
      snapshotDate: '2026-10-27',
      onhandQty: 20,
      inboundToAwdQty: 2,
      outboundToFbaInTransit: 6,
      sourceUpdatedAt: SOURCE_AT,
    })
    await put('AwdInventory', { sellerAccountId: a.sellerAccountId, sku: 'SKU-A', snapshotDate: '2026-10-20', onhandQty: 99, sourceUpdatedAt: SOURCE_AT })
    const warehouse = await put('Warehouse', { code: 'WH-SR', name: '深圳仓', kind: 'DOMESTIC' })
    await put('InventoryMovement', { warehouseId: warehouse.id, sellerSku: 'SKU-A', movementType: 'RECEIPT', quantity: 100, occurredAt: '2026-10-01T00:00:00Z' })
    await put('InventoryMovement', { warehouseId: warehouse.id, sellerSku: 'SKU-A', movementType: 'OUT', quantity: -40, occurredAt: '2026-10-10T00:00:00Z' })
    const forwarder = await put('FreightForwarder', { name: '海运通' })
    const shipment = async (waybillNo: string, over: Record<string, unknown>, quantity: number) => {
      const row = await put('FirstMileShipment', { forwarderId: forwarder.id, waybillNo, mode: 'SEA', createdBy: a.userId, ...over })
      await put('FirstMileShipmentItem', { shipmentId: row.id, sku: 'SKU-A', quantity })
    }
    await shipment('WB-TRANSIT', { outboundAt: '2026-10-12T00:00:00Z' }, 15)
    await shipment('WB-PENDING', {}, 8)
    await shipment('WB-DELIVERED', { outboundAt: '2026-10-05T00:00:00Z', ataDelivery: '2026-10-20' }, 12)
    await shipment('WB-LINKED', { outboundAt: '2026-10-12T00:00:00Z', linkedInboundShipmentIds: ['FBA-SHIP-1'] }, 9)

    // 销量统计：两个 ASIN，十月 6、7、13 日有记录（6 日周二，7 日周三）
    await put('FbaProduct', { sellerAccountId: a.sellerAccountId, asin: 'B0AAAAAAA1', sellerSku: 'SKU-A', title: '无线鼠标', marketplaceId: 'ATVPDKIKX0DER' })
    const daily = (summaryDate: string, asin: string, units: number, salesAmount: number, sellerAccountId = a.sellerAccountId, ids: Ids = a) =>
      put('AsinDailySummary', { sellerAccountId, summaryDate, asin, units, salesAmount, currency: 'USD', metricVersion: 'v1' }, ids)
    await daily('2026-10-06', 'B0AAAAAAA1', 3, 30)
    await daily('2026-10-07', 'B0AAAAAAA1', 4, 41.5)
    await daily('2026-10-13', 'B0AAAAAAA1', 5, 50)
    await daily('2026-10-07', 'B0BBBBBBB2', 2, 20)
    await daily('2026-10-07', 'B0OTHER001', 99, 999, b.sellerAccountId, b)
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  describe('进销存', () => {
    const RANGE = 'from=2026-09-01&to=2026-10-31'
    it('期初 + 变动 = 期末，货值与按月取价的成本版本一致（九月旧版、十月新版）', async () => {
      const data = await get(owner, `/inventory/movement?${RANGE}`)
      const rows = Object.fromEntries(data.items.map((row: { id: string }) => [row.id, row]))
      const sep = rows['SKU-A|2026-09']
      const oct = rows['SKU-A|2026-10']
      expect(sep).toMatchObject({ openingQty: 100, endingQty: 90, balanced: true, unitCost: 5, costVersionNo: 1 })
      expect(oct).toMatchObject({ openingQty: 90, endingQty: 70, balanced: true, unitCost: 7, costVersionNo: 2 })
      for (const row of [sep, oct]) {
        const flows = Object.values(row.flows as Record<string, number>).reduce((x, y) => x + y, 0)
        expect(row.openingQty + flows).toBe(row.endingQty)
        const valueFlows = Object.values(row.values.flows as Record<string, number>).reduce((x, y) => x + y, 0)
        expect(row.values.opening + valueFlows).toBeCloseTo(row.values.ending, 2)
      }
      expect(sep.values).toMatchObject({ opening: 500, ending: 450 })
      expect(oct.values).toMatchObject({ opening: 630, ending: 490 })
      expect(oct.flows).toMatchObject({ shipments: -20, returns: 2, adjustments: -2 })
    })

    it('不平衡的行标出差额、没有成本的 SKU 货值为空；“只看不平衡”只留下它', async () => {
      const all = await get(owner, `/inventory/movement?${RANGE}`)
      const bRow = all.items.find((row: { sku: string }) => row.sku === 'SKU-B')
      expect(bRow).toMatchObject({ balanced: false, difference: -3, expectedEnding: 8, endingQty: 5, values: null })
      expect(bRow.valueNote).toContain('成本版本')
      expect(all.unbalancedCount).toBe(1)
      const only = await get(owner, `/inventory/movement?${RANGE}&unbalanced=true`)
      expect(only.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-B'])
    })

    it('没有成本字段权限：数量照常、货值为空；租户与店铺范围隔离', async () => {
      const noCost = await get(viewer, `/inventory/movement?${RANGE}`)
      expect(noCost.costRestricted).toBe(true)
      expect(noCost.items.every((row: { values: unknown }) => row.values === null)).toBe(true)
      const scoped = await get(store2Only, `/inventory/movement?${RANGE}`)
      expect(scoped.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-C'])
      const other = await get(ownerB, `/inventory/movement?${RANGE}`)
      expect(other.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-Z'])
    })
  })

  describe('跨仓总览', () => {
    it('在途与已到仓不重复：已出库未送达且未关联货件的运单计入在途，待出库、已送达、已关联的不计', async () => {
      const data = await get(owner, '/inventory/all-warehouses?q=SKU-A')
      const row = data.items[0]
      expect(row.cells).toMatchObject({ fbaSellable: 50, awdOnhand: 20, domesticOnhand: 60, firstMileTransit: 15, fbaInbound: 7, awdInbound: 2, awdToFba: 6 })
      expect(row.onHand).toBe(50 + 5 + 1 + 20 + 60)
      expect(row.inTransit).toBe(7 + 2 + 15)
      expect(row.total).toBe(row.onHand + row.inTransit)
      const labels = row.children.map((child: { kind: string; label: string }) => `${child.kind}:${child.label}`)
      expect(labels).toContain('FIRST_MILE:WB-TRANSIT')
      for (const skipped of ['WB-PENDING', 'WB-DELIVERED', 'WB-LINKED']) expect(labels.join()).not.toContain(skipped)
      expect(row.children.reduce((sum: number, child: { total: number }) => sum + child.total, 0)).toBe(row.total)
    })

    it('货值按今天生效的成本版本；没有成本字段权限为空；没有仓库权限不显示国内仓与头程', async () => {
      const data = await get(owner, '/inventory/all-warehouses?q=SKU-A')
      expect(data.items[0].unitCost).toBe(7)
      expect(data.items[0].stockValue).toBe(data.items[0].total * 7)
      const viewerData = await get(viewer, '/inventory/all-warehouses?q=SKU-A')
      expect(viewerData.costRestricted).toBe(true)
      expect(viewerData.items[0].stockValue).toBeNull()
      expect(viewerData.items[0].cells.domesticOnhand).toBeNull()
      expect(viewerData.items[0].cells.firstMileTransit).toBeNull()
      expect(viewerData.restrictions[0].reason).toContain('仓库读取权限')
    })

    it('租户隔离：另一个企业看不到这些库存', async () => {
      const other = await get(ownerB, '/inventory/all-warehouses')
      expect(other.state).toBe('NO_DATA')
      expect(other.items).toEqual([])
    })
  })

  describe('销量统计', () => {
    const RANGE = 'from=2026-10-05&to=2026-10-14'
    it('日、周、月三种粒度的小计一致，且等于明细之和', async () => {
      const dayData = await get(viewer, `/analytics/sales-stat?${RANGE}&granularity=DAY`)
      const weekData = await get(viewer, `/analytics/sales-stat?${RANGE}&granularity=WEEK`)
      const monthData = await get(viewer, `/analytics/sales-stat?${RANGE}&granularity=MONTH`)
      const totalOf = (data: { rows: Array<{ asin: string; total: number }> }, asin: string) => data.rows.find(row => row.asin === asin)?.total
      for (const data of [dayData, weekData, monthData]) {
        expect(totalOf(data, 'B0AAAAAAA1')).toBe(12)
        expect(data.summary.total).toBe(14)
      }
      expect(dayData.buckets).toHaveLength(10)
      expect(weekData.buckets).toEqual(['2026-10-05', '2026-10-12'])
      const row = weekData.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
      expect(row.values).toEqual([7, 5])
    })

    it('销售额与销量切换；可用库存与周转天数；没有库存记录的 ASIN 为空', async () => {
      const sales = await get(viewer, `/analytics/sales-stat?${RANGE}&metric=sales`)
      expect(sales.rows.find((row: { asin: string }) => row.asin === 'B0AAAAAAA1').total).toBe(121.5)
      const row = sales.rows.find((item: { asin: string }) => item.asin === 'B0AAAAAAA1')
      // 可售 50 ÷（12 件 ÷ 10 天）≈ 41.7
      expect(row.availableStock).toBe(50)
      expect(row.turnoverDays).toBe(41.7)
      const bare = sales.rows.find((item: { asin: string }) => item.asin === 'B0BBBBBBB2')
      expect(bare.availableStock).toBeNull()
      expect(bare.turnoverDays).toBeNull()
    })

    it('范围与租户隔离：另一个企业的销量不出现；只有一个店铺授权的成员看不到其他店铺', async () => {
      const mine = await get(viewer, `/analytics/sales-stat?${RANGE}`)
      expect(mine.rows.find((row: { asin: string }) => row.asin === 'B0OTHER001')).toBeUndefined()
      const theirs = await get(ownerB, `/analytics/sales-stat?${RANGE}`)
      expect(theirs.rows.map((row: { asin: string }) => row.asin)).toEqual(['B0OTHER001'])
      const forbidden = await call(store2Only, `/analytics/sales-stat?${RANGE}`)
      expect(forbidden.status).toBe(403)
    })
  })
})
