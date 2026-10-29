import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 库存台账、移除与弃置、仓储容量与费用（P2a-09，真实数据库）：
// 台账汇总的平衡校验与库存比对、明细的游标分页与事件分组筛选、移除订单的汇总与退回件收货核对（含审计）、
// 限额文件导入（来源标注、整份拒绝、与报告记录不覆盖）、范围与租户隔离、迁移升级与回滚。

type Ids = Awaited<ReturnType<DbTestApp['createTenant']>>
type Member = { userId: string; token: string }

const TARGET = '20261023030000_removal_receipt'
const NOW = Date.now()
const dayOffset = (days: number) => new Date(NOW + days * 86_400_000).toISOString().slice(0, 10)
const monthStart = (offset: number) => {
  const date = new Date(NOW)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)).toISOString().slice(0, 10)
}
const SOURCE_AT = '2026-10-20T00:00:00Z'

describe('库存台账、移除与弃置、仓储容量与费用（真实数据库）', () => {
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

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const get = async (member: Member, path: string) => {
    const res = await call(member, 'GET', path)
    expect(res.status, `${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const put = (table: string, values: Record<string, unknown>) => insertRow(h.client, table, { id: `st-${++seq}`, tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, ...values })
  const removalId = (orderId: string) => encodeURIComponent(`${a.sellerAccountId}:${orderId}`)

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'inventory_stock', db })
    a = await h.createTenant('sta')
    b = await h.createTenant('stb')
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-sta2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-STA2' })).id as string
    owner = await h.createMember(a.tenantId, 'st-owner', ['*'])
    viewer = await h.createMember(a.tenantId, 'st-viewer', ['inventory.read'])
    ownerB = await h.createMember(b.tenantId, 'st-owner-b', ['*'])
    store2Only = await h.createMember(a.tenantId, 'st-store2', ['inventory.read', 'inventory.removal.receive', 'data.import'], { scopes: [{ sellerAccountId: store2 }] })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" IN ($1, $2)`, [a.tenantId, b.tenantId])

    // 台账汇总：FN1 九月不平衡（期末 10，计算 11）、十月平衡；FN2 十月平衡
    const summary = (date: string, fnsku: string, over: Record<string, unknown>) =>
      put('InventoryLedgerSummary', { date, fnsku, sku: `SKU-${fnsku}`, aggregation: 'DAILY', sourceUpdatedAt: SOURCE_AT, ...over })
    await summary('2026-09-10', 'FN1', { startingQty: 10, receipts: 5, customerShipments: -3, endingQty: 12 })
    await summary('2026-09-11', 'FN1', { startingQty: 12, lost: -1, endingQty: 10 })
    await summary('2026-10-05', 'FN1', { startingQty: 10, receipts: 20, endingQty: 30 })
    await summary('2026-10-06', 'FN2', { startingQty: 0, receipts: 4, endingQty: 4 })
    await put('FbaInventoryRecord', { marketplaceId: 'ATVPDKIKX0DER', sellerSku: 'SKU-FN1', asin: 'B0FN1', fnsku: 'FN1', fulfillableQuantity: 25, reservedQuantity: 3, unfulfillableQuantity: 1 })

    // 台账明细
    let hash = 0
    const entry = (eventDate: string, eventType: string, over: Record<string, unknown> = {}) =>
      put('InventoryLedgerEntry', { eventDate, eventType, fnsku: 'FN1', sku: 'SKU-FN1', quantity: 1, rowHash: `h-${++hash}`, sourceUpdatedAt: SOURCE_AT, ...over })
    await entry('2026-10-05', 'Receipts', { referenceId: 'FBA15AAA', quantity: 20 })
    await entry('2026-10-04', 'Shipments', { referenceId: '111-0000001-0000001', quantity: -3 })
    await entry('2026-10-03', 'CustomerReturns', { referenceId: '111-0000001-0000001' })
    await entry('2026-10-02', 'Adjustments', { reasonCode: 'Lost', quantity: -1 })
    await entry('2026-10-01', 'WhseTransfers')
    await entry('2026-10-01', 'MysteryEvent')

    // 移除订单：RO-1 退回（两个 SKU，已发货 10 + 4）；RO-2 弃置
    const line = (orderId: string, sku: string, over: Record<string, unknown>) => put('RemovalOrder', { orderId, sku, fnsku: `F-${sku}`, sourceUpdatedAt: SOURCE_AT, status: 'Completed', ...over })
    await line('RO-1', 'SKU-A', { type: 'RETURN', requestDate: '2026-10-01', lastUpdatedDate: '2026-10-09', requestedQty: 10, shippedQty: 10, fee: 1.5, currency: 'USD' })
    await line('RO-1', 'SKU-B', { type: 'RETURN', requestDate: '2026-10-01', lastUpdatedDate: '2026-10-09', requestedQty: 5, shippedQty: 4, cancelledQty: 1, fee: 0.5, currency: 'USD' })
    await line('RO-2', 'SKU-A', { type: 'DISPOSAL', requestDate: '2026-10-03', requestedQty: 3, disposedQty: 3 })
    await put('RemovalShipment', {
      orderId: 'RO-1',
      shipmentId: '1Z1',
      sku: 'SKU-A',
      fnsku: 'F-SKU-A',
      carrier: 'UPS',
      trackingNumber: '1Z1',
      shippedQty: 10,
      shipDate: '2026-10-05',
      sourceUpdatedAt: SOURCE_AT,
    })

    // 推荐移除：最近一次写入日期是 10-20，SKU-C 只在更早的日期出现
    const plan = (snapshotDate: string, sku: string, over: Record<string, unknown>) => put('InventoryPlanningSnapshot', { snapshotDate, sku, sourceUpdatedAt: SOURCE_AT, ...over })
    await plan('2026-10-20', 'SKU-A', { removalReportQty: 20, removalReportReason: '库龄过长', available: 40 })
    await plan('2026-10-20', 'SKU-B', { removalReportQty: 0 })
    await plan('2026-10-01', 'SKU-C', { removalReportQty: 5 })

    // 仓储费用与容量：上个月有月度仓储费（两个 FNSKU）与超限费，没有长期仓储费；报告里标准尺寸利用率 85%
    const fee = (kind: string, fnsku: string, amount: number) => put('StorageFeeRecord', { chargeMonth: monthStart(-1), feeKind: kind, fnsku, amount, sourceUpdatedAt: SOURCE_AT })
    await fee('STORAGE', 'FN1', 10.5)
    await fee('STORAGE', 'FN2', 4.5)
    await fee('OVERAGE', 'FN1', 7)
    await put('StorageCapacitySnapshot', { snapshotDate: monthStart(-1), storageType: 'STANDARD', utilizationPct: 0.85, sourceKind: 'REPORT', sourceUpdatedAt: SOURCE_AT })
    // 库存里一个冗余 SKU：体积 0.5、可售 100、亚马逊可售天数 200；库龄 91-180 天有 20 件，181-270 天有 5 件
    await put('FbaInventoryRecord', { marketplaceId: 'ATVPDKIKX0DER', sellerSku: 'SKU-SLOW', asin: 'B0SLOW', fnsku: 'FSLOW', fulfillableQuantity: 100 })
    await plan('2026-10-20', 'SKU-SLOW', { fnsku: 'FSLOW', itemVolume: 0.5, volumeUnit: 'cubic feet', daysOfSupply: 200, estimatedStorageCostNextMonth: 12.34, aisEst181To210: 2.5 })
    await put('InventoryAgeSnapshot', {
      snapshotDate: dayOffset(-10),
      sku: 'SKU-SLOW',
      fnsku: 'FSLOW',
      age0to90: 75,
      age91to180: 20,
      age181to270: 5,
      age271to365: 0,
      age365plus: 0,
      ageSurchargeEstimate: 3.2,
      sourceUpdatedAt: SOURCE_AT,
    })
  }, 180_000)

  afterAll(async () => {
    await h?.close()
  })

  describe('库存台账', () => {
    const range = 'from=2026-09-01&to=2026-10-31'

    it('汇总：按店铺 × FNSKU × 月折叠，九月不平衡被标出并给出差额，十月平衡；月份倒序', async () => {
      const data = await get(owner, `/inventory/ledger?view=summary&${range}`)
      expect(data).toMatchObject({ view: 'summary', state: 'OK', total: 3, unbalancedCount: 1, truncated: false })
      expect(data.items.map((item: { month: string; fnsku: string }) => `${item.month}/${item.fnsku}`)).toEqual(['2026-10/FN1', '2026-10/FN2', '2026-09/FN1'])
      const september = data.items[2]
      expect(september).toMatchObject({ startingQty: 10, endingQty: 10, receipts: 5, customerShipments: -3, lost: -1, expectedEnding: 11, difference: -1, balanced: false })
      expect(data.items[0]).toMatchObject({ startingQty: 10, endingQty: 30, balanced: true, storeName: expect.any(String) })
    })

    it('汇总：只有最近一个月的行带库存接口比对（仓内 = 可售 + 预留 + 不可售）；没有库存记录的 SKU 比对为 null，不是 0', async () => {
      const data = await get(owner, `/inventory/ledger?view=summary&${range}`)
      const [fn1Oct, fn2Oct, fn1Sep] = data.items
      expect(fn1Oct.live).toEqual({ ledgerDate: '2026-10-05', ledgerEnding: 30, liveQty: 29, difference: 1 })
      expect(fn2Oct.live).toMatchObject({ liveQty: null, difference: null })
      expect(fn1Sep.live).toBeNull()
    })

    it('汇总：只看不平衡、搜索与分页', async () => {
      const bad = await get(owner, `/inventory/ledger?view=summary&${range}&unbalanced=true`)
      expect(bad.items).toHaveLength(1)
      expect(bad.unbalancedCount).toBe(1)
      expect((await get(owner, `/inventory/ledger?view=summary&${range}&q=fn2`)).items).toHaveLength(1)
      const page2 = await get(owner, `/inventory/ledger?view=summary&${range}&pageSize=2&page=2`)
      expect(page2).toMatchObject({ total: 3, page: 2 })
      expect(page2.items).toHaveLength(1)
    })

    it('汇总：范围外没有记录时 NO_DATA 并说明；只授权了另一个店铺的成员看不到这个店铺的台账', async () => {
      const none = await get(owner, '/inventory/ledger?view=summary&from=2025-01-01&to=2025-01-31')
      expect(none).toMatchObject({ state: 'NO_DATA', items: [], total: 0 })
      expect(none.note).toContain('尚无库存台账记录')
      expect((await get(store2Only, `/inventory/ledger?view=summary&${range}`)).total).toBe(0)
      expect((await get(ownerB, `/inventory/ledger?view=summary&${range}`)).total).toBe(0)
    })

    it('明细：事件日期倒序、游标翻页不重不漏；分类、调整细分与单据类型', async () => {
      const first = await get(owner, '/inventory/ledger?view=detail&pageSize=4')
      expect(first.items.map((item: { eventType: string }) => item.eventType).slice(0, 2)).toEqual(['Receipts', 'Shipments'])
      expect(first.pageInfo.hasMore).toBe(true)
      const second = await get(owner, `/inventory/ledger?view=detail&pageSize=4&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(second.pageInfo.hasMore).toBe(false)
      const all = [...first.items, ...second.items] as Array<{ id: string; eventType: string; group: string; adjustmentLabel: string | null; referenceKind: string | null }>
      expect(new Set(all.map(item => item.id)).size).toBe(6)
      expect(all.find(item => item.eventType === 'Receipts')).toMatchObject({ group: 'receipt', referenceKind: 'INBOUND_SHIPMENT' })
      expect(all.find(item => item.eventType === 'Shipments')).toMatchObject({ group: 'shipment', referenceKind: 'ORDER' })
      expect(all.find(item => item.eventType === 'Adjustments')).toMatchObject({ group: 'adjustment', adjustmentLabel: '丢失' })
      expect(all.find(item => item.eventType === 'MysteryEvent')).toMatchObject({ group: 'other', adjustmentLabel: null })
    })

    it('明细：按事件分组筛选（含“其他”）；游标换了筛选条件就失效', async () => {
      const count = async (group: string) => (await get(owner, `/inventory/ledger?view=detail&group=${group}`)).items.length
      expect(await count('adjustment')).toBe(1)
      expect(await count('customerReturn')).toBe(1)
      expect(await count('transfer')).toBe(1)
      expect(await count('other')).toBe(1)
      expect(await count('vendorReturn')).toBe(0)
      const page = await get(owner, '/inventory/ledger?view=detail&pageSize=2')
      const stale = await call(owner, 'GET', `/inventory/ledger?view=detail&pageSize=2&group=receipt&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)
      expect(stale.status).toBe(400)
      expect(stale.json.error.code).toBe('CURSOR_INVALID')
    })

    it('明细：搜索单据编号；其他租户与范围外成员看不到', async () => {
      expect((await get(owner, '/inventory/ledger?view=detail&q=111-0000001')).items).toHaveLength(2)
      expect((await get(store2Only, '/inventory/ledger?view=detail')).items).toHaveLength(0)
      expect((await get(ownerB, '/inventory/ledger?view=detail')).items).toHaveLength(0)
    })

    it('没有 inventory.read 权限：403，且先于参数校验', async () => {
      const noPermission = await h.createMember(a.tenantId, 'st-none', ['orders.read'])
      expect((await call(noPermission, 'GET', '/inventory/ledger?view=summary')).status).toBe(403)
      expect((await call(noPermission, 'GET', '/inventory/ledger?view=summary&bogus=1')).status).toBe(403)
      expect((await call(owner, 'GET', '/inventory/ledger?view=summary&bogus=1')).status).toBe(422)
    })
  })

  describe('移除与弃置', () => {
    it('列表：按订单汇总数量与费用（没有费用是 null）、承运商与追踪号、收货核对状态；请求日期倒序', async () => {
      const data = await get(owner, '/inventory/removals')
      expect(data).toMatchObject({ state: 'OK', total: 2 })
      expect(data.guide.title).toContain('卖家后台')
      const [ro2, ro1] = data.items
      expect(ro2).toMatchObject({ orderId: 'RO-2', type: 'DISPOSAL', fee: null, receiptState: 'NOT_APPLICABLE', shippedQty: 0, disposedQty: 3 })
      expect(ro1).toMatchObject({
        orderId: 'RO-1',
        type: 'RETURN',
        statusLabel: '已完成',
        skuCount: 2,
        requestedQty: 15,
        shippedQty: 14,
        cancelledQty: 1,
        fee: 2,
        currency: 'USD',
        carriers: ['UPS'],
        trackingNumbers: ['1Z1'],
        receiptState: 'PENDING',
        receivedQty: null,
      })
      expect(ro1.id).toBe(`${a.sellerAccountId}:RO-1`)
    })

    it('列表：类型、状态、搜索（订单号或 SKU）筛选；搜不到时 NO_DATA', async () => {
      expect((await get(owner, '/inventory/removals?type=RETURN')).items.map((item: { orderId: string }) => item.orderId)).toEqual(['RO-1'])
      expect((await get(owner, '/inventory/removals?status=completed')).total).toBe(2)
      expect((await get(owner, '/inventory/removals?q=sku-b')).items.map((item: { orderId: string }) => item.orderId)).toEqual(['RO-1'])
      const none = await get(owner, '/inventory/removals?q=nothing-matches')
      expect(none).toMatchObject({ state: 'NO_DATA', total: 0, items: [] })
    })

    it('推荐移除清单：只取最近一次写入日期里推荐数量大于 0 的 SKU', async () => {
      const data = await get(owner, '/inventory/removals/recommended')
      expect(data).toMatchObject({ state: 'OK', total: 1 })
      expect(data.items[0]).toMatchObject({ sku: 'SKU-A', removalQty: 20, reason: '库龄过长', available: 40, snapshotDate: '2026-10-20', estimatedSavings: null })
      expect((await get(ownerB, '/inventory/removals/recommended')).state).toBe('NO_DATA')
    })

    it('详情：明细行、货件、费用合计、时间线、退回地址未接入、逐 SKU 核对与是否可登记', async () => {
      const data = await get(owner, `/inventory/removals/${removalId('RO-1')}`)
      expect(data.order).toMatchObject({ orderId: 'RO-1', typeLabel: '退回', fee: 2, shippedQty: 14, receiptState: 'PENDING' })
      expect(data.lines).toHaveLength(2)
      expect(data.shipments[0]).toMatchObject({ carrier: 'UPS', trackingNumber: '1Z1', shipDate: '2026-10-05' })
      expect(data.timeline.map((item: { at: string }) => item.at)).toEqual(['2026-10-01', '2026-10-05', '2026-10-09'])
      expect(data.returnAddress.state).toBe('NOT_CONNECTED')
      expect(data.reconciliation).toMatchObject([
        { sku: 'SKU-A', expectedQty: 10, receivedQty: null, state: 'PENDING' },
        { sku: 'SKU-B', expectedQty: 4, receivedQty: null, state: 'PENDING' },
      ])
      expect(data.canReceive).toEqual({ allowed: true, reason: null })
      const disposal = await get(owner, `/inventory/removals/${removalId('RO-2')}`)
      expect(disposal.canReceive.allowed).toBe(false)
      expect(disposal.canReceive.reason).toContain('弃置')
    })

    it('详情：不存在、其他租户、范围外店铺一律 404', async () => {
      expect((await call(owner, 'GET', `/inventory/removals/${removalId('NOPE')}`)).status).toBe(404)
      expect((await call(owner, 'GET', '/inventory/removals/garbage')).status).toBe(404)
      expect((await call(ownerB, 'GET', `/inventory/removals/${removalId('RO-1')}`)).status).toBe(404)
      expect((await call(store2Only, 'GET', `/inventory/removals/${removalId('RO-1')}`)).status).toBe(404)
    })

    it('登记收货：权限先于校验；校验各分支；成功后累计核对，同日再登记视为更正并留审计', async () => {
      const path = `/inventory/removals/${removalId('RO-1')}/receipt`
      const good = { sku: 'SKU-A', receivedQty: 9, sellableQty: 8, damagedQty: 1, receivedAt: '2026-10-08', note: '一箱外包装破损' }
      expect((await call(viewer, 'POST', path, { bogus: true })).status).toBe(403)
      expect((await call(store2Only, 'POST', path, good)).status).toBe(404)
      expect((await call(owner, 'POST', path, { ...good, damagedQty: 5 })).status).toBe(422)
      const unknownSku = await call(owner, 'POST', path, { ...good, sku: 'SKU-Z' })
      expect(unknownSku.status).toBe(422)
      expect(unknownSku.json.error.fieldErrors.sku).toBeDefined()
      expect((await call(owner, 'POST', path, { ...good, receivedAt: '2999-01-01' })).status).toBe(422)
      expect((await call(owner, 'POST', `/inventory/removals/${removalId('RO-2')}/receipt`, good)).status).toBe(409)

      const first = await call(owner, 'POST', path, good)
      expect([200, 201], JSON.stringify(first.json)).toContain(first.status)
      expect(first.json.data.reconciliation).toMatchObject({ sku: 'SKU-A', expectedQty: 10, receivedQty: 9, sellableQty: 8, damagedQty: 1, difference: -1, state: 'SHORT' })
      const second = await call(owner, 'POST', path, { ...good, receivedQty: 10, sellableQty: 10, damagedQty: 0, note: '补点后核对一致' })
      expect(second.json.data.reconciliation).toMatchObject({ receivedQty: 10, difference: 0, state: 'MATCHED' })

      expect((await h.client.query(`SELECT count(*)::int AS n FROM "RemovalReceipt" WHERE "removalOrderId" = 'RO-1'`)).rows[0].n).toBe(1)
      const audits = await h.client.query(`SELECT action FROM "AuditEvent" WHERE result = 'SUCCEEDED' AND "resourceType" = 'RemovalOrder' AND "tenantId" = $1 ORDER BY "createdAt"`, [a.tenantId])
      expect(audits.rows.map(row => row.action)).toEqual(['REMOVAL_RECEIPT_RECORDED', 'REMOVAL_RECEIPT_CORRECTED'])

      const detail = await get(owner, `/inventory/removals/${removalId('RO-1')}`)
      expect(detail.receipts).toHaveLength(1)
      expect(detail.receipts[0]).toMatchObject({ sku: 'SKU-A', receivedQty: 10, note: '补点后核对一致', receivedAt: '2026-10-08' })
      expect(detail.reconciliation.map((row: { sku: string; state: string }) => `${row.sku}:${row.state}`)).toEqual(['SKU-A:MATCHED', 'SKU-B:PENDING'])
      expect(detail.order).toMatchObject({ receivedQty: 10, receiptState: 'SHORT' })
      expect(detail.timeline.some((item: { title: string }) => item.title.startsWith('登记收货'))).toBe(true)
    })
  })

  describe('仓储容量与费用', () => {
    const csv = (rows: string[]) => ['存储类型,限额,已用,采集日期', ...rows].join('\n')
    const importPath = '/inventory/capacity/limits-import'

    it('导入前：报告里的利用率与费用趋势；没有记录的费用类型是 null，不是 0；实际发生的库龄附加费标为尚未接入', async () => {
      const data = await get(owner, '/inventory/capacity')
      expect(data.state).toBe('OK')
      expect(data.utilization).toMatchObject([{ storageType: 'STANDARD', storageTypeLabel: '标准尺寸', report: { utilization: 0.85, month: monthStart(-1).slice(0, 7) }, limit: null }])
      const last = data.fees.months[data.fees.months.length - 1]
      expect(last).toEqual({ month: monthStart(-1).slice(0, 7), storage: 15, overage: 7, longTerm: null, utilization: null })
      expect(data.fees.months[0]).toEqual({ month: expect.any(String), storage: null, overage: null, longTerm: null, utilization: null })
      expect(data.fees.latestMonth).toBe(last.month)
      expect(data.notConnected.map((item: { key: string }) => item.key)).toEqual(['age-surcharge-actual', 'low-inventory-fee-actual'])
    })

    it('预测与建议：下月仓储费与库龄附加费预估来自规划与库龄报告；跨档提醒带估算增幅；冗余 SKU 按占用体积列出', async () => {
      const data = await get(owner, '/inventory/capacity')
      expect(data.forecast).toMatchObject({ nextMonthStorage: 12.34, storageSkuCount: 1, ageSurchargeEstimate: 3.2 })
      const crossing = data.forecast.crossings.find((item: { boundaryDays: number }) => item.boundaryDays === 181)
      expect(crossing).toMatchObject({ sku: 'SKU-SLOW', qty: 20, likelyCrossed: false, estimatedIncrease: 10 })
      expect(data.forecast.crossingTotal).toBe(10)
      expect(data.suggestions[0]).toMatchObject({ sku: 'SKU-SLOW', occupiedVolume: 50, volumeUnit: 'cubic feet', sellable: 100, daysOfCover: 200, nextMonthStorage: 12.34 })
      expect(data.suggestions[0].reason).toContain('可售天数 200 天')
    })

    it('导入：权限先于校验；一行有错整份拒绝并逐行说明；与月度报告重合的记录不覆盖；都不写入任何行', async () => {
      const body = (content: string, sellerAccountId = a.sellerAccountId) => ({ sellerAccountId, fileName: 'limits.csv', content })
      expect((await call(viewer, 'POST', importPath, { nonsense: 1 })).status).toBe(403)
      const bad = await call(owner, 'POST', importPath, body(csv(['标准尺寸,10000,8000,' + dayOffset(-3), '未知类型,1,1,' + dayOffset(-3)])))
      expect(bad.status).toBe(422)
      expect(bad.json.error.fieldErrors.content[0]).toContain('第 3 行')
      const clash = await call(owner, 'POST', importPath, body(csv([`标准尺寸,10000,8000,${monthStart(-1)}`])))
      expect(clash.status).toBe(422)
      expect(clash.json.error.fieldErrors.content[0]).toContain('月度报告')
      expect((await call(owner, 'POST', importPath, body(csv(['标准尺寸,1,1,']), 'seller-not-exist'))).status).toBe(404)
      expect((await call(ownerB, 'POST', importPath, body(csv(['标准尺寸,1,1,'])))).status).toBe(404)
      expect((await call(store2Only, 'POST', importPath, body(csv(['标准尺寸,1,1,'])))).status).toBe(403)
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "StorageCapacitySnapshot" WHERE "sourceKind" = 'FILE_IMPORT'`)).rows[0].n).toBe(0)
    })

    it('导入成功：逐行标注来源文件、采集日期、导入人；页面读到限额与已用比；同日再导入覆盖，不新增行', async () => {
      const date = dayOffset(-3)
      const ok = await call(owner, 'POST', importPath, { sellerAccountId: a.sellerAccountId, fileName: 'limits.csv', content: csv([`标准尺寸,"10,000",8000,${date}`, `超大件,2000,500,${date}`]) })
      expect([200, 201], JSON.stringify(ok.json)).toContain(ok.status)
      expect(ok.json.data).toEqual({ imported: 2, captureDates: [date], sourceFileName: 'limits.csv' })
      const data = await get(owner, '/inventory/capacity')
      const standard = data.utilization.find((row: { storageType: string }) => row.storageType === 'STANDARD')
      expect(standard.report.utilization).toBe(0.85)
      expect(standard.limit).toMatchObject({ limitQty: 10000, usedQty: 8000, usedRatio: 0.8, captureDate: date, sourceFileName: 'limits.csv', importedBy: expect.any(String) })
      const oversize = data.utilization.find((row: { storageType: string }) => row.storageType === 'OVERSIZE')
      expect(oversize).toMatchObject({ report: null, limit: { limitQty: 2000, usedRatio: 0.25 } })

      await call(owner, 'POST', importPath, { sellerAccountId: a.sellerAccountId, fileName: 'limits-v2.csv', content: csv([`标准尺寸,12000,,${date}`]) })
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "StorageCapacitySnapshot" WHERE "sourceKind" = 'FILE_IMPORT'`)).rows[0].n).toBe(2)
      const again = (await get(owner, '/inventory/capacity')).utilization.find((row: { storageType: string }) => row.storageType === 'STANDARD')
      expect(again.limit).toMatchObject({ limitQty: 12000, usedQty: null, usedRatio: null, sourceFileName: 'limits-v2.csv' })
      const audits = await h.client.query(`SELECT action FROM "AuditEvent" WHERE result = 'SUCCEEDED' AND "resourceType" = 'StorageCapacitySnapshot' AND "tenantId" = $1`, [a.tenantId])
      expect(audits.rows).toHaveLength(2)
    })

    it('其他租户与范围外成员看不到本租户的容量与费用', async () => {
      const other = await get(ownerB, '/inventory/capacity')
      expect(other).toMatchObject({ state: 'NO_DATA', utilization: [], suggestions: [] })
      expect(other.fees.latestMonth).toBeNull()
      expect((await get(store2Only, '/inventory/capacity')).utilization).toEqual([])
    })
  })

  describe('迁移与回滚（RemovalReceipt）', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('stock_migrate')
      client = await db.connect('stock_migrate')
      await applyMigrations(client, { before: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    const exists = async () => (await client.query(`SELECT to_regclass('"RemovalReceipt"') IS NOT NULL AS found`)).rows[0].found as boolean
    const hasColumns = async () =>
      (await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'StorageCapacitySnapshot' AND column_name IN ('sourceFileName', 'importedBy')`)).rows[0]
        .n as number

    it('升级建表并加两列；回滚全部去掉；再次升级闭环成功', async () => {
      expect(await exists()).toBe(false)
      expect(await hasColumns()).toBe(0)
      await applyMigrations(client, { only: TARGET })
      expect(await exists()).toBe(true)
      expect(await hasColumns()).toBe(2)
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      expect(await exists()).toBe(false)
      expect(await hasColumns()).toBe(0)
      await applyMigrations(client, { only: TARGET })
      expect(await exists()).toBe(true)
    })
  })

  describe('约束', () => {
    it('收货登记：同日同 SKU 只能一行；数量不能为负、良品与损坏之和不能超过实收', async () => {
      const base = { removalOrderId: 'RO-X', sku: 'S', receivedQty: 5, sellableQty: 3, damagedQty: 2, receivedAt: '2026-10-01', receivedBy: owner.userId }
      await put('RemovalReceipt', { ...base })
      await expect(put('RemovalReceipt', { ...base })).rejects.toMatchObject({ code: '23505' })
      await put('RemovalReceipt', { ...base, receivedAt: '2026-10-02' })
      await expect(put('RemovalReceipt', { ...base, receivedAt: '2026-10-03', damagedQty: 3 })).rejects.toMatchObject({ code: '23514' })
      await expect(put('RemovalReceipt', { ...base, receivedAt: '2026-10-04', receivedQty: -1, sellableQty: 0, damagedQty: 0 })).rejects.toMatchObject({ code: '23514' })
    })
  })
})
