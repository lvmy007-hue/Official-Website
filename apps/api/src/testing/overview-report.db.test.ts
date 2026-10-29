import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { EXPORT_KINDS } from '@nova/api-contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-02 验收（真实数据库）：经营报表的导出取数（读店铺日汇总）。取数代码在后台任务进程里，这里按路径动态加载。
type Row = Record<string, unknown>
type Source = (context: { db: unknown; tenantId: string; filters: Record<string, unknown>; storeIds: string[] | null }) => AsyncIterable<Row>
const loadSource = async () => {
  const module = await import(/* @vite-ignore */ String('../../../worker/src/exports/sources'))
  return { source: (module.EXPORT_SOURCES as Record<string, Source>)['overview-report'], pageSize: module.EXPORT_PAGE_SIZE as number }
}

describe('经营报表导出取数（P2a-02，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let source: Source
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  const secondStore = 'seller-a2'
  let seq = 0

  const summary = (tenantId: string, sellerAccountId: string, day: string, values: Record<string, unknown> = {}) =>
    insertRow(admin, 'StoreDailySummary', { id: `sd-${++seq}`, tenantId, sellerAccountId, summaryDate: day, metricVersion: 'v1', orders: 1, units: 1, salesAmount: 10, ...values })
  const collect = async (tenantId: string, filters: Record<string, unknown>, storeIds: string[] | null) => {
    const rows: Row[] = []
    await runWithTenant(tenantId, async () => {
      for await (const row of source({ db: scoped, tenantId, filters, storeIds })) rows.push(row)
    })
    return rows
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('overviewreport')
    db.migrate('overviewreport')
    admin = await db.connect('overviewreport')
    a = await seedTenant(admin, 'a')
    b = await seedTenant(admin, 'b')
    await admin.query(`UPDATE "SellerAccount" SET "displayName" = 'A 一店' WHERE id = $1`, [a.sellerAccountId])
    await admin.query(`UPDATE "SellerAccount" SET "displayName" = 'B 店' WHERE id = $1`, [b.sellerAccountId])
    await insertRow(admin, 'SellerAccount', { id: secondStore, tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', displayName: 'A 二店' })
    base = new PrismaClient({ datasourceUrl: db.urlFor('overviewreport', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ source } = await loadSource())

    await summary(a.tenantId, a.sellerAccountId, '2026-10-01', { orders: 3, units: 5, salesAmount: 120.5, refundAmount: 10, feeAmount: 18.25, adsSpend: 9, profit: 30, sessions: 80 })
    await summary(a.tenantId, secondStore, '2026-10-01', { orders: 2, units: 2, salesAmount: 40 })
    await summary(a.tenantId, a.sellerAccountId, '2026-10-02', { salesAmount: 70 })
    await summary(a.tenantId, a.sellerAccountId, '2026-10-05', { salesAmount: 99 })
    await summary(b.tenantId, b.sellerAccountId, '2026-10-01', { salesAmount: 777 })
  }, 120_000)

  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('契约登记：权限是概览读取，列里没有广告、利润、会话（尚未接入）', () => {
    const spec = EXPORT_KINDS.find(item => item.kind === 'overview-report')
    expect(spec?.permission).toBe('overview.read')
    expect(spec?.columns.map(column => column.key)).toEqual(['summaryDate', 'storeName', 'currency', 'orders', 'units', 'salesAmount', 'refundAmount', 'feeAmount'])
    expect(spec?.columns.some(column => column.sensitive)).toBe(false)
  })

  it('按日期范围取，日期升序、同日按店铺名；金额是数字；只有登记的列，不含广告、利润、会话与编号', async () => {
    const rows = await collect(a.tenantId, { from: '2026-10-01', to: '2026-10-02' }, null)
    expect(rows.map(row => [row.summaryDate, row.storeName])).toEqual([
      ['2026-10-01', 'A 一店'],
      ['2026-10-01', 'A 二店'],
      ['2026-10-02', 'A 一店'],
    ])
    expect(rows[0]).toEqual({ summaryDate: '2026-10-01', storeName: 'A 一店', currency: 'USD', orders: 3, units: 5, salesAmount: 120.5, refundAmount: 10, feeAmount: 18.25 })
  })

  it('范围收窄到某些店铺时只含这些店铺；店铺范围为空数组时没有任何行', async () => {
    expect((await collect(a.tenantId, {}, [secondStore])).map(row => row.storeName)).toEqual(['A 二店'])
    expect(await collect(a.tenantId, {}, [])).toEqual([])
  })

  it('不带日期时取全部；只带起始或结束日期时单边生效；非法日期被忽略', async () => {
    expect(await collect(a.tenantId, {}, null)).toHaveLength(4)
    expect(await collect(a.tenantId, { from: '2026-10-02' }, null)).toHaveLength(2)
    expect(await collect(a.tenantId, { to: '2026-10-01' }, null)).toHaveLength(2)
    expect(await collect(a.tenantId, { from: 'abc' }, null)).toHaveLength(4)
  })

  it('租户隔离：看不到其他租户的汇总', async () => {
    const rows = await collect(b.tenantId, {}, null)
    expect(rows.map(row => row.salesAmount)).toEqual([777])
    expect(rows.every(row => row.storeName === 'B 店')).toBe(true)
  })

  it('超过一页时分页取全，不重不漏', async () => {
    const { pageSize } = await loadSource()
    const total = pageSize + 3
    await admin.query(
      `INSERT INTO "StoreDailySummary" ("id", "tenantId", "sellerAccountId", "summaryDate", "metricVersion", "updatedAt")
       SELECT 'pg-' || n, $1, $2, DATE '1990-01-01' + n, 'v1', now() FROM generate_series(0, $3::int - 1) AS n`,
      [a.tenantId, a.sellerAccountId, total],
    )
    const rows = await collect(a.tenantId, { to: '1999-12-31' }, [a.sellerAccountId])
    expect(rows).toHaveLength(total)
    expect(new Set(rows.map(row => row.summaryDate)).size).toBe(total)
    expect(rows[0].summaryDate).toBe('1990-01-01')
  }, 60_000)
})
