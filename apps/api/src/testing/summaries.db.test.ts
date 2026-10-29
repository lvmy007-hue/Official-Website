import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-01 验收（真实数据库）：经营日汇总、ASIN 日汇总。
// 刷新代码在后台任务进程里；这里按路径动态加载，让接口服务的编译范围不包含后台任务代码（测试专用）。
type Range = { tenantId: string; dateFrom: string; dateTo: string }
type Refresh = (db: unknown, range: Range) => Promise<number>
const loadRefreshers = async () => {
  const module = await import(/* @vite-ignore */ String('../../../worker/src/derivers/summary-sql'))
  return { store: module.refreshStoreDailySummary as Refresh, asin: module.refreshAsinDailySummary as Refresh, version: module.METRIC_VERSION as string }
}

describe('日汇总（P2a-01，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let store: Refresh
  let asin: Refresh
  let version: string
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let seq = 0

  const order = async (ids: typeof a, purchaseDate: string, status = 'Shipped', items: Array<{ asin: string | null; sku?: string; qty: number; price: number; currency?: string }> = []) => {
    const n = ++seq
    const row = await insertRow(admin, 'Order', {
      id: `o-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId: `111-${String(n).padStart(7, '0')}-0000001`,
      purchaseDate,
      status,
      currency: 'USD',
      sourceUpdatedAt: purchaseDate,
    })
    for (const [index, item] of items.entries()) {
      await insertRow(admin, 'OrderItem', {
        id: `oi-${n}-${index}`,
        tenantId: ids.tenantId,
        sellerAccountId: ids.sellerAccountId,
        orderId: row.id,
        orderPurchaseDate: purchaseDate,
        amazonOrderId: row.amazonOrderId,
        orderItemId: `item-${n}-${index}`,
        asin: item.asin,
        sellerSku: item.sku ?? null,
        quantityOrdered: item.qty,
        itemPrice: item.price,
        currency: item.currency ?? 'USD',
        sourceUpdatedAt: purchaseDate,
      })
    }
  }
  const refund = async (ids: typeof a, postedAt: string, amount: number) => {
    const n = ++seq
    await insertRow(admin, 'FbaFinancialTransaction', {
      id: `t-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      externalTransactionId: `txn-${n}`,
      transactionType: 'Refund',
      amount,
      currency: 'USD',
      postedAt,
      sourceUpdatedAt: postedAt,
    })
  }
  const fee = async (ids: typeof a, postedAt: string, amount: number, description: string, eventType = 'Fee') => {
    const n = ++seq
    await insertRow(admin, 'FbaFeeEvent', {
      id: `f-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      eventType,
      amount,
      currency: 'USD',
      postedAt,
      description,
      sourceEventId: `fe-${n}`,
      sourceUpdatedAt: postedAt,
    })
  }
  const storeRows = async (ids: typeof a) =>
    (
      await admin.query(
        `SELECT to_char("summaryDate", 'YYYY-MM-DD') AS d, "orders", "units", "salesAmount"::float AS sales, "refundAmount"::float AS refund, "feeAmount"::float AS fee, ` +
          ` "adsSpend", "profit", "sessions", "metricVersion" FROM "StoreDailySummary" WHERE "tenantId" = $1 ORDER BY 1`,
        [ids.tenantId],
      )
    ).rows
  const asinRows = async (ids: typeof a) =>
    (
      await admin.query(
        `SELECT to_char("summaryDate", 'YYYY-MM-DD') AS d, "asin", "sku", "units", "salesAmount"::float AS sales, "sessions", "inventoryAvailable" FROM "AsinDailySummary" WHERE "tenantId" = $1 ORDER BY 1, 2`,
        [ids.tenantId],
      )
    ).rows
  const inTenant = <T>(ids: typeof a, fn: () => Promise<T>) => runWithTenant(ids.tenantId, fn)

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('summaries')
    db.migrate('summaries')
    admin = await db.connect('summaries')
    a = await seedTenant(admin, 'a')
    b = await seedTenant(admin, 'b')
    await admin.query(`UPDATE "Tenant" SET "timezone" = 'Asia/Shanghai' WHERE id = $1`, [b.tenantId])
    base = new PrismaClient({ datasourceUrl: db.urlFor('summaries', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ store, asin, version } = await loadRefreshers())

    // 租户 A（太平洋时区）：2026-10-04 23:30 与 10-05 00:30（本地）的两张订单，一张取消的订单，一张欧元订单
    await order(a, '2026-10-05T06:30:00Z', 'Shipped', [
      { asin: 'B000000001', sku: 'sku-1', qty: 2, price: 20 },
      { asin: 'B000000002', qty: 1, price: 5.5 },
    ])
    await order(a, '2026-10-05T07:30:00Z', 'Unshipped', [
      { asin: 'B000000001', sku: 'sku-1', qty: 1, price: 10 },
      { asin: null, qty: 3, price: 9 },
    ])
    await order(a, '2026-10-05T10:00:00Z', 'Canceled', [{ asin: 'B000000001', qty: 9, price: 90 }])
    await order(a, '2026-10-05T12:00:00Z', 'Shipped', [{ asin: 'B000000003', qty: 4, price: 100, currency: 'EUR' }])
    await refund(a, '2026-10-05T20:00:00Z', -12.5)
    await fee(a, '2026-10-05T20:00:00Z', -3.2, 'Fees/FBA Fulfillment Fee')
    await fee(a, '2026-10-05T20:00:00Z', -1, 'ServiceFee', 'ServiceFee')
    await fee(a, '2026-10-05T20:00:00Z', 10, 'Product Charges/Principle', 'Principle') // 收入明细：不算费用
    // 租户 B（上海时区）：同一个 UTC 时刻落在不同的本地日
    await order(b, '2026-10-05T17:00:00Z', 'Shipped', [{ asin: 'B0000000B1', qty: 1, price: 7 }]) // 上海 10-06 01:00
  })
  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  const range: Range = { tenantId: '', dateFrom: '2026-10-01', dateTo: '2026-10-10' }

  it('经营日汇总：按企业时区落日；取消订单、非美元订单不计；退款与费用按入账日；没有数据的列保持为空而不是 0', async () => {
    await inTenant(a, () => store(scoped, { ...range, tenantId: a.tenantId }))
    const rows = await storeRows(a)
    expect(rows.map(row => row.d)).toEqual(['2026-10-04', '2026-10-05'])
    expect(rows[0]).toMatchObject({ orders: 1, units: 3, sales: 25.5, refund: 0, fee: 0, metricVersion: version })
    // 10-05：订单 1 张（取消的不计、欧元订单只计订单数不计金额与件数）→ 订单 2 张（本地 00:30 的与欧元的）；金额只含美元
    expect(rows[1]).toMatchObject({ orders: 2, units: 4, sales: 19, refund: 12.5, fee: 4.2 })
    for (const row of rows) expect([row.adsSpend, row.profit, row.sessions]).toEqual([null, null, null])
  })

  it('ASIN 日汇总：按 ASIN 分组，没有 ASIN 的行只进经营日汇总；库存、会话为空', async () => {
    await inTenant(a, () => asin(scoped, { ...range, tenantId: a.tenantId }))
    expect(await asinRows(a)).toEqual([
      { d: '2026-10-04', asin: 'B000000001', sku: 'sku-1', units: 2, sales: 20, sessions: null, inventoryAvailable: null },
      { d: '2026-10-04', asin: 'B000000002', sku: null, units: 1, sales: 5.5, sessions: null, inventoryAvailable: null },
      { d: '2026-10-05', asin: 'B000000001', sku: 'sku-1', units: 1, sales: 10, sessions: null, inventoryAvailable: null },
    ])
  })

  it('可重复执行：同一范围再刷新一次，结果完全相同、行数不变', async () => {
    const before = [await storeRows(a), await asinRows(a)]
    const written = await inTenant(a, () => store(scoped, { ...range, tenantId: a.tenantId }))
    await inTenant(a, () => asin(scoped, { ...range, tenantId: a.tenantId }))
    expect(written).toBe(2)
    expect([await storeRows(a), await asinRows(a)]).toEqual(before)
  })

  it('只重算范围内的日期：范围外的旧汇总不被删除；原始数据变化后重算得到新值', async () => {
    await insertRow(admin, 'StoreDailySummary', { id: 'keep-old', tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, summaryDate: '2026-09-01', metricVersion: 'old', orders: 7 })
    await order(a, '2026-10-06T18:00:00Z', 'Shipped', [{ asin: 'B000000009', qty: 1, price: 1 }])
    await inTenant(a, () => store(scoped, { ...range, tenantId: a.tenantId, dateFrom: '2026-10-05', dateTo: '2026-10-06' }))
    const rows = await storeRows(a)
    expect(rows.map(row => [row.d, row.orders])).toEqual([
      ['2026-09-01', 7],
      ['2026-10-04', 1],
      ['2026-10-05', 2],
      ['2026-10-06', 1],
    ])
  })

  it('租户隔离与时区：租户 B 按上海时区落日，不受租户 A 的刷新影响，也看不到 A 的数据', async () => {
    expect(await storeRows(b)).toEqual([])
    await inTenant(b, () => store(scoped, { ...range, tenantId: b.tenantId }))
    expect((await storeRows(b)).map(row => [row.d, row.orders, row.sales])).toEqual([['2026-10-06', 1, 7]])
    expect((await storeRows(a)).some(row => row.sales === 7)).toBe(false)
  })

  it('没有租户上下文时什么都不做（行级安全让所有行不可见，既删不掉也写不进）', async () => {
    const before = await storeRows(a)
    expect(await store(scoped, { ...range, tenantId: a.tenantId }).catch(() => 0)).toBe(0)
    expect(await storeRows(a)).toEqual(before)
  })

  it('租户连接（普通账号）只能读写本租户的汇总：用 B 的上下文刷新 A 的范围，写不进 A 的数据', async () => {
    const before = await storeRows(a)
    await inTenant(b, () => store(scoped, { ...range, tenantId: a.tenantId })).catch(() => undefined)
    expect(await storeRows(a)).toEqual(before)
  })
})
