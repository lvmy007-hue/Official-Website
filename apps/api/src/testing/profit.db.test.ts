import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 利润日表（P2b-09，真实数据库 + 后台任务代码）：迁移升级、约束、行级隔离、回滚闭环；
// 订单、费用明细、成本版本、汇率、广告花费造数后，三种收入确认口径各自得出确切的数字与标记；重复刷新幂等；跨企业隔离。

const TARGET = '20261103010000_profit_daily'
type Range = { tenantId: string; dateFrom: string; dateTo: string }
type Refresh = (db: unknown, range: Range, now?: Date) => Promise<number>
const loadRefresh = async () => (await import(/* @vite-ignore */ String('../../../worker/src/profit/run'))).refreshProfitDaily as Refresh

describe('利润日表迁移（P2b-09）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('profit_migrate')
    client = await db.connect('profit_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async () => ((await client.query(`SELECT to_regclass('"ProfitDaily"') IS NOT NULL AS found`)).rows[0] as { found: boolean }).found

  it('升级建表（行级隔离、授权）；约束拒绝非法取值与重复；回滚闭环', async () => {
    const ids = await seedTenant(client, 'pm')
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
    const rls = await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'ProfitDaily'`)
    expect(rls.rows[0].relrowsecurity).toBe(true)
    const policies = await client.query(`SELECT 1 FROM pg_policies WHERE tablename = 'ProfitDaily' AND qual LIKE '%nova_current_tenant%'`)
    expect(policies.rowCount).toBe(1)

    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, profitDate: '2026-10-05', sku: 'S1', basis: 'ORDERED', costing: 'FIFO', metricVersion: 'x' }
    const row = await insertRow(client, 'ProfitDaily', { id: 'p1', ...base, units: 3, costedUnits: 3, flags: ['A'] })
    expect(row).toMatchObject({ currency: 'USD', revenue: '0.000000', profit: null, productCost: null, fxFallback: false })
    await expect(insertRow(client, 'ProfitDaily', { id: 'p2', ...base })).rejects.toThrow(/ProfitDaily_uq/)
    await expect(insertRow(client, 'ProfitDaily', { id: 'p3', ...base, sku: 'S2', basis: 'PAID' })).rejects.toThrow(/ProfitDaily_basis_check/)
    await expect(insertRow(client, 'ProfitDaily', { id: 'p4', ...base, sku: 'S2', costing: 'LIFO' })).rejects.toThrow(/ProfitDaily_costing_check/)
    await expect(insertRow(client, 'ProfitDaily', { id: 'p5', ...base, sku: 'S2', units: 1, costedUnits: 2 })).rejects.toThrow(/ProfitDaily_units_check/)
    await expect(insertRow(client, 'ProfitDaily', { id: 'p6', ...base, sku: 'S2', costCoverage: 1.5 })).rejects.toThrow(/ProfitDaily_coverage_check|numeric field overflow/)
    // 同一个键换一种口径可以并存
    await insertRow(client, 'ProfitDaily', { id: 'p7', ...base, basis: 'SHIPPED' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
  })
})

describe('利润日表派生（P2b-09，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let refresh: Refresh
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let seq = 0
  const NOW = new Date('2026-10-20T12:00:00Z')

  const order = async (ids: typeof a, purchaseDate: string, shippedAt: string | null, sku: string, qty: number, price: number) => {
    const n = ++seq
    const row = await insertRow(admin, 'Order', {
      id: `o-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId: `111-${String(n).padStart(7, '0')}-0000001`,
      purchaseDate,
      shippedAt,
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: purchaseDate,
    })
    await insertRow(admin, 'OrderItem', {
      id: `oi-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      orderId: row.id,
      orderPurchaseDate: purchaseDate,
      amazonOrderId: row.amazonOrderId,
      orderItemId: `item-${n}`,
      asin: 'B000000001',
      sellerSku: sku,
      quantityOrdered: qty,
      quantityShipped: qty,
      itemPrice: price,
      currency: 'USD',
      sourceUpdatedAt: purchaseDate,
    })
    return row.amazonOrderId as string
  }
  const fee = async (ids: typeof a, postedAt: string, o: { category: string; subtype?: string; amount: number; orderId?: string | null; sku?: string | null; status?: string | null }) => {
    const n = ++seq
    await insertRow(admin, 'FbaFeeEvent', {
      id: `f-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      eventType: 'Fee',
      amount: o.amount,
      currency: 'USD',
      postedAt,
      sourceEventId: `fe-${n}`,
      sourceUpdatedAt: postedAt,
      amazonOrderId: o.orderId ?? null,
      sellerSku: o.sku === undefined ? null : o.sku,
      asin: o.sku ? 'B000000001' : null,
      feeCategory: o.category,
      feeSubtype: o.subtype ?? null,
      transactionStatus: o.status ?? null,
    })
  }
  const rowsOf = async (ids: typeof a, basis: string, sku?: string) =>
    (
      await admin.query(
        `SELECT to_char("profitDate", 'YYYY-MM-DD') AS d, "sku", "units", "costedUnits", "revenue"::float AS revenue, "refunds"::float AS refunds, "feeCommission"::float AS commission,
                "feeFulfillment"::float AS fulfillment, "feeOther"::float AS other, "adsSpendAllocated"::float AS "adsAllocated", "adsUnallocated"::float AS "adsUnallocated",
                "productCost"::float AS "productCost", "firstMileCost"::float AS "firstMile", "reimbursement"::float AS reimbursement, "profit"::float AS profit,
                "costCoverage"::float AS coverage, "fxRate"::float AS "fxRate", "fxFallback", "flags", "costing"
         FROM "ProfitDaily" WHERE "tenantId" = $1 AND "basis" = $2 AND ($3::text IS NULL OR "sku" = $3) ORDER BY 1, 2`,
        [ids.tenantId, basis, sku ?? null],
      )
    ).rows
  const run = (ids: typeof a, from = '2026-10-01', to = '2026-10-15') => runWithTenant(ids.tenantId, () => refresh(scoped, { tenantId: ids.tenantId, dateFrom: from, dateTo: to }, NOW))

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('profit')
    db.migrate('profit')
    admin = await db.connect('profit')
    a = await seedTenant(admin, 'a')
    b = await seedTenant(admin, 'b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('profit', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    refresh = await loadRefresh()

    // 租户 A（太平洋时区）：10-05 下单、10-06 发货的订单（2 件、40 美元）；费用 10-10 入账；退款与赔付 10-12 入账
    const orderId = await order(a, '2026-10-05T18:00:00Z', '2026-10-06T18:00:00Z', 'sku-1', 2, 40)
    await fee(a, '2026-10-10T20:00:00Z', { category: 'NON_FEE', subtype: 'Principal', amount: 40, orderId, sku: 'sku-1', status: 'RELEASED' })
    await fee(a, '2026-10-10T20:00:00Z', { category: 'COMMISSION', subtype: 'Commission', amount: -6, orderId, sku: 'sku-1' })
    await fee(a, '2026-10-10T20:00:00Z', { category: 'FULFILLMENT', subtype: 'FBAPerUnitFulfillmentFee', amount: -5, orderId, sku: 'sku-1' })
    await fee(a, '2026-10-10T20:00:00Z', { category: 'NON_FEE', subtype: 'Tax', amount: 3, orderId, sku: 'sku-1' }) // 税：不进任何一项
    await fee(a, '2026-10-11T20:00:00Z', { category: 'NON_FEE', subtype: 'Principal', amount: 99, orderId, sku: 'sku-1', status: 'DEFERRED' }) // 递延中：结算口径不计
    await fee(a, '2026-10-11T20:00:00Z', { category: 'OTHER', subtype: 'Subscription', amount: -2 }) // 没有订单、没有 SKU：店铺级
    await fee(a, '2026-10-12T20:00:00Z', { category: 'REFUND', subtype: 'Principal', amount: -10, orderId, sku: 'sku-1' })
    await fee(a, '2026-10-12T20:00:00Z', { category: 'REIMBURSEMENT', subtype: 'Lost', amount: 4, sku: 'sku-1' })
    // 成本：人民币 72/件，手工版本（价格版本）；汇率只有 10-05 的 7.2，之后的日子沿用前值
    await insertRow(admin, 'CostVersion', {
      id: 'cv-1',
      tenantId: a.tenantId,
      sku: 'sku-1',
      versionNo: 1,
      effectiveFrom: '2026-09-01',
      currency: 'CNY',
      unitProductCost: 72,
      source: 'MANUAL',
      status: 'ACTIVE',
    })
    await insertRow(admin, 'FxRate', { id: 'fx-1', tenantId: a.tenantId, quoteCurrency: 'CNY', rateDate: '2026-10-05', rate: 7.2, source: 'TEST' })
    // 广告：绑定到店铺的美元账户，只有 10-05 一天有 3.5 美元花费
    await insertRow(admin, 'AdsProfile', { id: 'ap-1', tenantId: a.tenantId, profileId: 'P1', sellerAccountId: a.sellerAccountId, bindingStatus: 'MANUAL' })
    await insertRow(admin, 'AdsMetric', { id: 'am-1', tenantId: a.tenantId, adsProfileId: 'ap-1', reportDate: '2026-10-05', cost: 3.5, sourceUpdatedAt: '2026-10-06T00:00:00Z' })
    // 租户 B：只有一张订单，没有费用、成本
    await order(b, '2026-10-05T18:00:00Z', null, 'sku-b', 1, 9)
  })
  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('下单口径：销售额按下单日；费用按订单的下单日；成本按销售日汇率折美元；退款、赔付按入账日；税不计；广告在店铺级行', async () => {
    const written = await run(a)
    expect(written).toBeGreaterThan(0)
    const sku = await rowsOf(a, 'ORDERED', 'sku-1')
    const sale = sku.find(row => row.d === '2026-10-05')
    // 2 件 × 人民币 72 ÷ 7.2 = 20 美元；当天 3.5 美元广告全部分摊到这个 SKU（当天只有它有销售）；利润 = 40 - 6 - 5 - 3.5 - 20 = 5.5
    expect(sale).toMatchObject({
      units: 2,
      costedUnits: 2,
      revenue: 40,
      commission: 6,
      fulfillment: 5,
      adsAllocated: 3.5,
      productCost: 20,
      fxRate: 7.2,
      fxFallback: false,
      coverage: 1,
      profit: 5.5,
      costing: 'FIFO',
    })
    expect(sale.flags).toContain('FIRST_MILE_MISSING')
    expect(sale.firstMile).toBeNull()
    const refundDay = sku.find(row => row.d === '2026-10-12')
    expect(refundDay).toMatchObject({ units: 0, revenue: 0, refunds: 10, reimbursement: 4, productCost: null })
    const store = (await rowsOf(a, 'ORDERED', '__STORE__')).reduce<Record<string, any>>((acc, row) => ({ ...acc, [row.d]: row }), {})
    expect(store['2026-10-11']).toMatchObject({ other: 2, adsUnallocated: null })
    // 广告已全部分摊到商品：店铺级行没有剩余，也没有“广告未分摊”标记；花费记录范围（只有 10-05）之外的日子不知道，商品行的广告列保持为空
    expect(store['2026-10-05']).toMatchObject({ units: 0, revenue: 0, adsUnallocated: 0, profit: 0 })
    expect(store['2026-10-05'].flags).not.toContain('ADS_UNALLOCATED')
    expect(sku.filter(row => row.d !== '2026-10-05').every(row => row.adsAllocated === null)).toBe(true)
    // 同一份销售额的税 3 美元没有进任何一项
    expect(sku.reduce((sum, row) => sum + row.revenue + row.commission + row.fulfillment, 0)).toBe(51)
  })

  it('发货口径：销售额与费用都按发货日；汇率沿用前值时打“汇率沿用”标记', async () => {
    const sku = await rowsOf(a, 'SHIPPED', 'sku-1')
    const shipped = sku.find(row => row.d === '2026-10-06')
    expect(shipped).toMatchObject({ units: 2, revenue: 40, commission: 6, fulfillment: 5, productCost: 20, fxRate: 7.2, fxFallback: true })
    expect(shipped.flags).toContain('FX_FALLBACK')
    expect(sku.find(row => row.d === '2026-10-05')).toBeUndefined()
    expect(sku.find(row => row.d === '2026-10-12')).toMatchObject({ refunds: 10, reimbursement: 4 })
  })

  it('结算释放口径：销售额与费用按入账日，只算已释放的；递延中的不计入并打标记；件数取自订单行', async () => {
    const sku = await rowsOf(a, 'SETTLED', 'sku-1')
    expect(sku.reduce((sum, row) => sum + row.revenue, 0)).toBe(40) // 99 美元递延中，不计
    const released = sku.find(row => row.d === '2026-10-10')
    expect(released).toMatchObject({ units: 2, revenue: 40, commission: 6, fulfillment: 5, productCost: 20, fxFallback: true })
    const deferred = (await rowsOf(a, 'SETTLED')).filter(row => row.flags.includes('DEFERRED_EXCLUDED'))
    expect(deferred.length).toBeGreaterThan(0)
  })

  it('没有成本的 SKU：利润为空、成本覆盖为 0，不当作 0 成本', async () => {
    await run(b)
    const rows = await rowsOf(b, 'ORDERED', 'sku-b')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ units: 1, costedUnits: 0, revenue: 9, productCost: null, profit: null, coverage: 0 })
    expect(rows[0].flags).toContain('COST_MISSING')
    expect(rows[0].flags).toContain('FEES_PENDING')
  })

  it('可重复执行：同一范围再刷新，结果完全相同、行数不变；换范围只重算范围内的日期', async () => {
    const snapshot = async () => (await admin.query(`SELECT "tenantId", "basis", "sku", "profitDate", "units", "revenue", "profit", "flags" FROM "ProfitDaily" ORDER BY 1, 2, 3, 4`)).rows
    const before = await snapshot()
    await run(a)
    await run(b)
    expect(await snapshot()).toEqual(before)
    await admin.query(`UPDATE "ProfitDaily" SET "revenue" = 777 WHERE "tenantId" = $1 AND "basis" = 'ORDERED' AND "profitDate" = '2026-10-05' AND "sku" = 'sku-1'`, [a.tenantId])
    await run(a, '2026-10-10', '2026-10-15') // 范围外的 10-05 不被重算
    expect((await rowsOf(a, 'ORDERED', 'sku-1')).find(row => row.d === '2026-10-05')?.revenue).toBe(777)
    await run(a)
    expect((await rowsOf(a, 'ORDERED', 'sku-1')).find(row => row.d === '2026-10-05')?.revenue).toBe(40)
  })

  it('存货计价设置：改成月末加权后重算，行上的计价方法随之变化；取值不合法时按先进先出并打标记', async () => {
    await insertRow(admin, 'TenantSetting', { id: 'ts-1', tenantId: a.tenantId, key: 'finance.inventoryCosting', valueJson: JSON.stringify('MONTH_AVG'), updatedBy: a.userId })
    await run(a)
    const month = (await rowsOf(a, 'ORDERED', 'sku-1')).find(row => row.d === '2026-10-05')
    expect(month).toMatchObject({ costing: 'MONTH_AVG', productCost: 20 })
    await admin.query(`UPDATE "TenantSetting" SET "valueJson" = '"LIFO"' WHERE id = 'ts-1'`)
    await run(a)
    const invalid = (await rowsOf(a, 'ORDERED', 'sku-1')).find(row => row.d === '2026-10-05')
    expect(invalid).toMatchObject({ costing: 'FIFO' })
    // 设置无效的标记打在店铺级行上
    const stores = await rowsOf(a, 'ORDERED', '__STORE__')
    expect(stores.every(row => row.flags.includes('COSTING_INVALID'))).toBe(true)
    expect(invalid.flags).not.toContain('COSTING_INVALID')
  })

  it('跨企业隔离：A 的上下文刷新不写 B 的数据；租户连接看不到别家的行；没有租户上下文时读不到任何行', async () => {
    const countOf = async (ids: typeof a) => ((await admin.query(`SELECT count(*)::int AS n FROM "ProfitDaily" WHERE "tenantId" = $1`, [ids.tenantId])).rows[0] as { n: number }).n
    const before = await countOf(b)
    await run(a)
    expect(await countOf(b)).toBe(before)
    const seen = await runWithTenant(b.tenantId, () => scoped.profitDaily.findMany({ select: { tenantId: true } }))
    expect(seen.length).toBe(before)
    expect(seen.every(row => row.tenantId === b.tenantId)).toBe(true)
    expect(await base.profitDaily.findMany({ select: { id: true } })).toEqual([])
    const aBefore = await countOf(a)
    await runWithTenant(b.tenantId, () => refresh(scoped, { tenantId: a.tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-15' }, NOW)).catch(() => undefined)
    expect(await countOf(a)).toBe(aBefore)
  })
})
