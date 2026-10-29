import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 销售与流量（P4-01，真实数据库）：迁移升级与回滚、唯一键与检查约束；数据中心写入（重复写覆盖、部分列更新不抹掉别的列）；
// 报告导入与来源核对；日汇总用官方数据覆盖订单估算（数据中心优先、报告补充、美元与日粒度才算）；跨企业隔离。
// 后台代码在 worker 里，这里按路径动态加载，让接口服务的编译范围不包含后台任务代码（测试专用）。

const TARGET = '20261119010000_sales_traffic'
const logger = { warn: () => undefined, info: () => undefined, error: () => undefined }
const usd = (value: number) => ({ amount: value, currencyCode: 'USD' })

describe('销售与流量表迁移（P4-01）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('sales_traffic_migrate')
    client = await db.connect('sales_traffic_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
  const tables = ['SalesTrafficDaily', 'SalesTrafficAsinDaily', 'SalesTrafficDiff']

  it('升级建三张表、回滚全部删除、再次升级闭环成功；两张日表按月分区', async () => {
    for (const table of tables) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of tables) expect(await exists(table)).toBe(true)
    for (const table of ['SalesTrafficDaily', 'SalesTrafficAsinDaily']) {
      const partitions = (await client.query(`SELECT count(*)::int AS n FROM pg_inherits WHERE inhparent = $1::regclass`, [`"${table}"`])).rows[0].n as number
      expect(partitions, table).toBeGreaterThan(24)
    }
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of tables) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of tables) expect(await exists(table)).toBe(true)
  })

  it('唯一键与检查约束由数据库保证；同键的两个来源可以并存', async () => {
    const ids = await seedTenant(client, 'st-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const daily = (over: Record<string, unknown>) =>
      insertRow(client, 'SalesTrafficDaily', { id: `d-${Math.random()}`, ...base, date: '2026-10-05', granularity: 'DAY', source: 'DATA_KIOSK', ...over })
    expect(await daily({})).toMatchObject({ orderedSales: null, sessions: null, buyBoxPct: null, currency: 'USD' }) // 没给的列存空，不是 0
    await expect(daily({})).rejects.toMatchObject({ code: '23505' })
    await daily({ source: 'REPORT' })
    await daily({ granularity: 'WEEK' })
    await expect(daily({ granularity: 'YEAR' })).rejects.toMatchObject({ code: '23514' })
    await expect(daily({ source: 'MANUAL', date: '2026-10-06' })).rejects.toMatchObject({ code: '23514' })
    await expect(daily({ sessions: -1, date: '2026-10-06' })).rejects.toMatchObject({ code: '23514' })
    await expect(daily({ buyBoxPct: 1.5, date: '2026-10-06' })).rejects.toMatchObject({ code: '23514' }) // 比率存 0 到 1 的小数，95.5 这样的百分数进不来

    const asin = (over: Record<string, unknown>) =>
      insertRow(client, 'SalesTrafficAsinDaily', { id: `a-${Math.random()}`, ...base, date: '2026-10-05', asin: 'B0A', asinGranularity: 'CHILD', sku: '', source: 'DATA_KIOSK', ...over })
    await asin({})
    await expect(asin({})).rejects.toMatchObject({ code: '23505' })
    await asin({ sku: 'S1' })
    await asin({ asinGranularity: 'SKU', sku: 'S1' })
    await expect(asin({ asinGranularity: 'GRAND' })).rejects.toMatchObject({ code: '23514' })
    await expect(asin({ units: -2, asin: 'B0B' })).rejects.toMatchObject({ code: '23514' })

    const diff = (over: Record<string, unknown>) =>
      insertRow(client, 'SalesTrafficDiff', { id: `f-${Math.random()}`, ...base, level: 'DAY', date: '2026-10-05', asin: '', sku: '', metric: 'sessions', ...over })
    await diff({})
    await expect(diff({})).rejects.toMatchObject({ code: '23505' })
    await expect(diff({ metric: 'profit' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('销售与流量（真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let w: Record<string, any>

  const ctx = () => ({ prisma: scoped, logger })
  const asTenant = <T>(ids: typeof a, fn: () => Promise<T>) => runWithTenant(ids.tenantId, fn)
  const kioskDate = (ids: typeof a, params: Record<string, string>, row: Record<string, unknown>) =>
    asTenant(ids, () => w.date.handle(ctx(), row, { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }, params))
  const kioskAsin = (ids: typeof a, params: Record<string, string>, row: Record<string, unknown>) =>
    asTenant(ids, () => w.asin.handle(ctx(), row, { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }, params))
  const dateRow = (date: string, salesAmount: number | null, units: number | null, sessions: number | null, currency = 'USD') => ({
    startDate: date,
    endDate: date,
    sales: salesAmount === null ? {} : { orderedProductSales: { amount: salesAmount, currencyCode: currency }, unitsOrdered: units },
    traffic: sessions === null ? {} : { sessions },
  })
  const asinRow = (asin: string, salesAmount: number, units: number, sessions: number, extra: Record<string, unknown> = {}) => ({
    startDate: '2026-10-05',
    endDate: '2026-10-05',
    parentAsin: 'B0PARENT01',
    childAsin: asin,
    sales: { orderedProductSales: usd(salesAmount), unitsOrdered: units },
    traffic: { sessions, pageViews: sessions * 2, buyBoxPercentage: 90 },
    ...extra,
  })
  const query = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  const storeRows = (ids: typeof a) =>
    query<{ d: string; orders: number; units: number; sales: number; sessions: number | null; source: string; version: string }>(
      `SELECT to_char("summaryDate", 'YYYY-MM-DD') AS d, "orders", "units", "salesAmount"::float AS sales, "sessions", "salesSource" AS source, "metricVersion" AS version FROM "StoreDailySummary" WHERE "tenantId" = $1 ORDER BY 1`,
      [ids.tenantId],
    )
  const asinRows = (ids: typeof a) =>
    query<{ d: string; asin: string; sku: string | null; units: number; sales: number; sessions: number | null; pv: number | null; bb: number | null; source: string }>(
      `SELECT to_char("summaryDate", 'YYYY-MM-DD') AS d, "asin", "sku", "units", "salesAmount"::float AS sales, "sessions", "pageViews" AS pv, "buyBoxPct"::float AS bb, "salesSource" AS source
       FROM "AsinDailySummary" WHERE "tenantId" = $1 ORDER BY 1, 2`,
      [ids.tenantId],
    )
  const refresh = async (ids: typeof a) => {
    const range = { tenantId: ids.tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-10' }
    await asTenant(ids, () => w.summary.refreshStoreDailySummary(scoped, range))
    await asTenant(ids, () => w.summary.refreshAsinDailySummary(scoped, range))
  }
  async function* doc(document: Record<string, unknown>) {
    yield document
  }
  const reportDoc = (sales: number, asinSales: number, date = '2026-10-05') => ({
    reportSpecification: { reportType: 'GET_SALES_AND_TRAFFIC_REPORT' },
    salesAndTrafficByDate: [{ date, salesByDate: { orderedProductSales: usd(sales), unitsOrdered: 9 }, trafficByDate: { sessions: 310, pageViews: 500 } }],
    salesAndTrafficByAsin: [{ parentAsin: 'B0PARENT01', childAsin: 'B000000001', salesByAsin: { orderedProductSales: usd(asinSales), unitsOrdered: 7 }, trafficByAsin: { sessions: 120 } }],
  })
  const importReport = (ids: typeof a, document: Record<string, unknown>, day: string) =>
    asTenant(ids, () =>
      w.report.syncSalesTrafficReport(ctx(), doc(document), ids.tenantId, ids.sellerAccountId, {
        from: new Date(`${day}T00:00:00Z`),
        to: new Date(`${day}T23:59:59.999Z`),
        reportJobId: null,
        now: new Date('2026-10-24T00:00:00Z'),
      }),
    )
  const diffs = (ids: typeof a) =>
    query<{ level: string; asin: string; metric: string; kiosk: number; report: number; delta: number }>(
      `SELECT "level", "asin", "metric", "kioskValue"::float AS kiosk, "reportValue"::float AS report, "delta"::float AS delta FROM "SalesTrafficDiff" WHERE "tenantId" = $1 ORDER BY "level", "metric"`,
      [ids.tenantId],
    )

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('sales_traffic')
    db.migrate('sales_traffic')
    admin = await db.connect('sales_traffic')
    a = await seedTenant(admin, 'sta')
    b = await seedTenant(admin, 'stb')
    await admin.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = ANY($1)`, [[a.tenantId, b.tenantId]])
    base = new PrismaClient({ datasourceUrl: db.urlFor('sales_traffic', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const load = async (path: string) => import(/* @vite-ignore */ String(`../../../worker/src/${path}`))
    w = {
      date: (await load('datakiosk/sales-traffic')).salesTrafficDateDataset,
      asin: (await load('datakiosk/sales-traffic')).salesTrafficAsinDataset,
      report: await load('importers/sales-traffic/report'),
      diff: await load('importers/sales-traffic/diff'),
      summary: await load('derivers/summary-sql'),
    }
    // 租户 A 的订单（上海时区之外，UTC）：10-05 一张订单两个 ASIN
    const order = await insertRow(admin, 'Order', {
      id: 'o-1',
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      amazonOrderId: '111-0000001-0000001',
      purchaseDate: '2026-10-05T12:00:00Z',
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: '2026-10-05T12:00:00Z',
    })
    for (const [index, item] of [
      { asin: 'B000000001', sku: 'sku-1', qty: 2, price: 20 },
      { asin: 'B000000002', sku: null, qty: 1, price: 5.5 },
    ].entries()) {
      await insertRow(admin, 'OrderItem', {
        id: `oi-${index}`,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        orderId: order.id,
        orderPurchaseDate: order.purchaseDate,
        amazonOrderId: order.amazonOrderId,
        orderItemId: `item-${index}`,
        asin: item.asin,
        sellerSku: item.sku,
        quantityOrdered: item.qty,
        itemPrice: item.price,
        currency: 'USD',
        sourceUpdatedAt: '2026-10-05T12:00:00Z',
      })
    }
  }, 120_000)
  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('数据中心写入：在行级隔离的租户连接下写入；重复写不重复；部分列更新不抹掉别的列', async () => {
    expect(await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-05', 100, 9, 300))).toBe('imported')
    await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-05', 100, 9, 300)) // 重复写
    await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-05', null, null, 310)) // 这次官方只给了会话数
    await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-06', 50, 4, 80))
    await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-07', null, null, 40)) // 只有会话数
    await kioskDate(a, { granularity: 'DAY' }, dateRow('2026-10-09', 70, 3, 10, 'EUR')) // 欧元：保留币种，汇总不用
    await kioskDate(a, { granularity: 'WEEK' }, dateRow('2026-10-04', 999, 99, 999)) // 周粒度：汇总不用
    await kioskDate(b, { granularity: 'DAY' }, dateRow('2026-10-05', 5000, 500, 5))
    const stored = await query<{ d: string; granularity: string; sales: number | null; units: number | null; sessions: number | null; currency: string; source: string }>(
      `SELECT to_char("date", 'YYYY-MM-DD') AS d, "granularity", "orderedSales"::float AS sales, "unitsOrdered" AS units, "sessions", "currency", "source" FROM "SalesTrafficDaily" WHERE "tenantId" = $1 ORDER BY 1, 2`,
      [a.tenantId],
    )
    expect(stored).toHaveLength(5)
    expect(stored.find(row => row.d === '2026-10-05')).toEqual({ d: '2026-10-05', granularity: 'DAY', sales: 100, units: 9, sessions: 310, currency: 'USD', source: 'DATA_KIOSK' })
    expect(stored.find(row => row.d === '2026-10-07')).toMatchObject({ sales: null, units: null, sessions: 40 }) // 官方没给的存空，不是 0
    expect(stored.find(row => row.d === '2026-10-09')?.currency).toBe('EUR')

    await kioskAsin(a, { asinGranularity: 'CHILD', date: '2026-10-05' }, asinRow('B000000001', 70, 7, 120))
    await kioskAsin(a, { asinGranularity: 'CHILD', date: '2026-10-05' }, asinRow('B000000003', 10, 1, 20))
    await kioskAsin(a, { asinGranularity: 'CHILD', date: '2026-10-05' }, asinRow('B000000003', 10, 1, 20)) // 重复写
    await kioskAsin(a, { asinGranularity: 'SKU', date: '2026-10-05' }, asinRow('B000000001', 555, 55, 5, { sku: 'S' }))
    expect(await kioskAsin(a, { asinGranularity: 'CHILD', date: '2026-10-05' }, asinRow('B000000001', 1, 1, 1, { endDate: '2026-10-06' }))).toBe('skipped') // 跨多天的行放不进日表
    expect(Number((await query<{ n: string }>(`SELECT count(*) AS n FROM "SalesTrafficAsinDaily" WHERE "tenantId" = $1`, [a.tenantId]))[0]?.n)).toBe(3)
  })

  it('日汇总：官方日粒度美元数据覆盖订单估算，订单数仍取订单表；官方只有会话数的日子也有行；非美元与周粒度不用', async () => {
    await refresh(a)
    const rows = await storeRows(a)
    expect(rows.map(row => row.d)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07'])
    expect(rows[0]).toEqual({ d: '2026-10-05', orders: 1, units: 9, sales: 100, sessions: 310, source: 'DATA_KIOSK', version: 'p4-01@1' })
    expect(rows[1]).toEqual({ d: '2026-10-06', orders: 0, units: 4, sales: 50, sessions: 80, source: 'DATA_KIOSK', version: 'p4-01@1' })
    expect(rows[2]).toEqual({ d: '2026-10-07', orders: 0, units: 0, sales: 0, sessions: 40, source: 'ORDERS', version: 'p4-01@1' })
  })

  it('ASIN 日汇总：官方子体行覆盖订单估算并补上会话、浏览量、购物车获得率；官方有而订单没有的 ASIN 也有行；SKU 粒度行不用', async () => {
    expect(await asinRows(a)).toEqual([
      { d: '2026-10-05', asin: 'B000000001', sku: 'sku-1', units: 7, sales: 70, sessions: 120, pv: 240, bb: 0.9, source: 'DATA_KIOSK' },
      { d: '2026-10-05', asin: 'B000000002', sku: null, units: 1, sales: 5.5, sessions: null, pv: null, bb: null, source: 'ORDERS' },
      { d: '2026-10-05', asin: 'B000000003', sku: null, units: 1, sales: 10, sessions: 20, pv: 40, bb: 0.9, source: 'DATA_KIOSK' },
    ])
  })

  it('可重复执行：再刷新一次结果相同；另一个企业的官方数据不影响本企业，也不被本企业动到', async () => {
    const before = [await storeRows(a), await asinRows(a)]
    await refresh(a)
    expect([await storeRows(a), await asinRows(a)]).toEqual(before)
    await refresh(b)
    expect(await storeRows(b)).toEqual([{ d: '2026-10-05', orders: 0, units: 500, sales: 5000, sessions: 5, source: 'DATA_KIOSK', version: 'p4-01@1' }])
    expect(await storeRows(a)).toEqual(before[0])
  })

  it('报告导入：来源 REPORT 与数据中心行并存；差异超过阈值记录，不覆盖任何一边', async () => {
    const result = await importReport(a, reportDoc(130, 90), '2026-10-05')
    expect(result).toMatchObject({ imported: 2, read: 2, skipped: 0 })
    const sources = await query<{ source: string; sales: number }>(
      `SELECT "source", "orderedSales"::float AS sales FROM "SalesTrafficDaily" WHERE "tenantId" = $1 AND "date" = '2026-10-05' AND "granularity" = 'DAY' ORDER BY 1`,
      [a.tenantId],
    )
    expect(sources).toEqual([
      { source: 'DATA_KIOSK', sales: 100 },
      { source: 'REPORT', sales: 130 },
    ])
    expect(await diffs(a)).toEqual([
      { level: 'CHILD', asin: 'B000000001', metric: 'orderedSales', kiosk: 70, report: 90, delta: 20 },
      { level: 'DAY', asin: '', metric: 'orderedSales', kiosk: 100, report: 130, delta: 30 },
    ])
    expect(await diffs(b)).toEqual([])
  })

  it('再次核对：差异消失后记录删除；报告独有的日子补进汇总，同键数据中心优先', async () => {
    await importReport(a, reportDoc(101, 70), '2026-10-05') // 101 比 100 只差 1：在容差内
    expect(await diffs(a)).toEqual([])
    await importReport(a, reportDoc(30, 3, '2026-10-08'), '2026-10-08')
    await refresh(a)
    const rows = await storeRows(a)
    expect(rows.find(row => row.d === '2026-10-05')).toMatchObject({ sales: 100, source: 'DATA_KIOSK' }) // 报告的 101 不顶替数据中心
    expect(rows.find(row => row.d === '2026-10-08')).toMatchObject({ orders: 0, units: 9, sales: 30, sessions: 310, source: 'REPORT' })
    const asins = await asinRows(a)
    expect(asins.filter(row => row.d === '2026-10-08')).toEqual([{ d: '2026-10-08', asin: 'B000000001', sku: null, units: 7, sales: 3, sessions: 120, pv: null, bb: null, source: 'REPORT' }])
    expect(asins.find(row => row.d === '2026-10-05' && row.asin === 'B000000001')).toMatchObject({ sales: 70, source: 'DATA_KIOSK' })
  })

  it('行级隔离：别的企业连接看不到本企业的销售与流量行', async () => {
    const visible = await asTenant(b, () => scoped.salesTrafficDaily.findMany({ select: { tenantId: true } }))
    expect(visible.every(row => row.tenantId === b.tenantId)).toBe(true)
    expect(visible.length).toBeGreaterThan(0)
    expect(await asTenant(b, () => scoped.salesTrafficAsinDaily.count())).toBe(0)
    expect(await asTenant(b, () => scoped.salesTrafficDiff.count())).toBe(0)
  })
})
