import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 销售税（P2b-12，真实数据库 + 完整应用 + 报告导入器代码）：
// 迁移升级（新表、唯一键、约束、行级隔离）与回滚闭环；按真实列格式导入税务文档库报告后，按州、辖区、月度趋势与订单对账的数值按种子数据确切；
// 重复导入不翻倍，只覆盖新报告所涵盖的日期；每家店取得情况来自同步新鲜度；权限、数据范围与跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261105010000_sales_tax'
const QUERY = 'from=2026-09-01&to=2026-10-31'

describe('销售税迁移（P2b-12）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('sales_tax_migrate')
    client = await db.connect('sales_tax_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async () => ((await client.query(`SELECT to_regclass('"SalesTaxSummary"') IS NOT NULL AS found`)).rows[0] as { found: boolean }).found

  it('升级建表（行级隔离、授权）；约束拒绝非法来源、负行数、空州与重复；删企业级联删除；回滚闭环', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-tax', slug: 't-tax', name: '租户' })
    const legal = await insertRow(client, 'LegalEntity', { id: 'le-tax', tenantId: tenant.id })
    const seller = await insertRow(client, 'SellerAccount', { id: 's-tax', tenantId: tenant.id, legalEntityId: legal.id })
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
    expect((await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'SalesTaxSummary'`)).rows[0]).toEqual({ relrowsecurity: true })
    const policies = await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'SalesTaxSummary' AND qual LIKE '%nova_current_tenant%'`)
    expect(policies.rowCount).toBe(1)

    const row = (id: string, over: Record<string, unknown> = {}) =>
      insertRow(client, 'SalesTaxSummary', { id, tenantId: tenant.id, sellerAccountId: seller.id, taxPeriod: '2026-10-01', state: 'WA', source: 'TAX_LIBRARY', taxCollected: 5, ...over })
    expect(await row('t-1')).toMatchObject({ jurisdictionKey: '', taxKind: 'SALES_TAX', currency: 'USD', lineCount: 0, taxableSales: null })
    await expect(row('t-dup')).rejects.toMatchObject({ code: '23505' })
    expect(await row('t-juris', { jurisdictionKey: 'KING COUNTY' })).toMatchObject({ jurisdictionKey: 'KING COUNTY' })
    expect(await row('t-day', { taxPeriod: '2026-10-02' })).toBeTruthy()
    await expect(row('t-src', { state: 'OR', source: 'GUESS' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('t-lines', { state: 'OR', lineCount: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(row('t-state', { state: '  ' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('t-fk', { sellerAccountId: 'no-such', state: 'CA' })).rejects.toMatchObject({ code: '23503' })

    await client.query(`DELETE FROM "SellerAccount" WHERE id = $1`, [seller.id])
    expect(((await client.query(`SELECT count(*)::int AS n FROM "SalesTaxSummary"`)).rows[0] as { n: number }).n).toBe(0)

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
  })
})

describe('销售税（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let secondSellerId: string
  let otherTenantId: string
  let otherSellerId: string
  let reader: Member
  let noTax: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  let importReport: (
    ctx: unknown,
    rows: AsyncIterable<unknown>,
    tenantId: string,
    sellerAccountId: string,
    options: { reportJobId: string | null; now: Date },
  ) => Promise<{ imported: number; read: number; skipped: number }>
  let toRows: (content: string) => AsyncIterable<unknown>

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const HEADER = ['purchase-date', 'ship-to-state', 'jurisdiction-name', 'tax-type', 'taxable-amount', 'tax-amount']
  const report = (...lines: string[][]) => [HEADER.join('\t'), ...lines.map(line => line.join('\t'))].join('\n')
  const importFor = (store: string, tid: string, content: string) =>
    runWithTenant(tid, () =>
      importReport({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }, toRows(content), tid, store, { reportJobId: null, now: new Date() }),
    )
  const charge = (id: string, store: string, tid: string, kind: string, amount: number, purchaseDate: string, currency = 'USD') =>
    insertRow(h.client, 'OrderCharge', {
      id: `ch-${id}`,
      tenantId: tid,
      sellerAccountId: store,
      orderId: `ord-${id}`,
      orderItemId: `item-${id}`,
      amazonOrderId: `A-${id}`,
      purchaseDate,
      chargeKind: kind,
      componentKey: kind,
      amount,
      currency,
    })
  const order = (id: string, store: string, tid: string, purchaseDate: string) =>
    insertRow(h.client, 'Order', { id: `ord-${id}`, tenantId: tid, sellerAccountId: store, amazonOrderId: `A-${id}`, purchaseDate, status: 'Shipped', currency: 'USD' })
  const orderTax = async (id: string, store: string, tid: string, amount: number, purchaseDate: string, kind = 'TAX', currency = 'USD') => {
    await order(id, store, tid, purchaseDate)
    await charge(id, store, tid, kind, amount, purchaseDate, currency)
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'salestax', db })
    const a = await h.createTenant('tax-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-tax-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-TAX-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('tax-b')
    otherTenantId = b.tenantId
    otherSellerId = b.sellerAccountId
    reader = await h.createMember(tenantId, 'tax-read', ['finance.tax.read'])
    noTax = await h.createMember(tenantId, 'tax-none', ['finance.read'])
    scoped = await h.createMember(tenantId, 'tax-scoped', ['finance.tax.read'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(otherTenantId, 'tax-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('salestax', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ syncSalesTaxReport: importReport } = await import(/* @vite-ignore */ String('../../../worker/src/importers/tax/sales-tax-report')))
    const streaming = await import(/* @vite-ignore */ String('../../../worker/src/streaming/rows'))
    toRows = content =>
      streaming.tsvRows(
        streaming.readLines(
          (async function* () {
            yield Buffer.from(content)
          })(),
        ),
      )
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没有任何数据：NO_DATA 与原因；每家店写“尚无记录”；没有权限 403', async () => {
    const empty = await ok(reader, `/finance/sales-tax?${QUERY}`)
    expect(empty).toMatchObject({ state: 'NO_DATA', states: [], reconciliation: [], totals: { taxCollected: null, taxableSales: null, ordersTax: null } })
    expect(empty.note).toContain('税务文档库')
    expect(empty.stores.map((store: { state: string }) => store.state)).toEqual(['NO_RECORD', 'NO_RECORD'])
    expect((await get(noTax, `/finance/sales-tax?${QUERY}`)).status).toBe(403)
  })

  it('导入报告后：按州、辖区汇总，订单号与收货地址列不进库；重复导入数值不变', async () => {
    const first = report(
      ['2026-09-10T08:00:00Z', 'wa', 'King County', 'Sales Tax', '100', '10'],
      ['2026-09-10T09:00:00Z', 'WA', 'King County', 'Sales Tax', '55', '5.5'],
      ['2026-09-12', 'WA', '', 'Sales Tax', '30', '3'],
      ['2026-09-15', 'CA', '', 'Sales Tax', '70', '7'],
      ['2026-10-05', 'WA', 'King County', 'Sales Tax', '40', '4'],
    )
    expect(await importFor(sellerId, tenantId, first)).toMatchObject({ read: 5, imported: 5, skipped: 0 })
    expect(await importFor(sellerId, tenantId, first)).toMatchObject({ read: 5, imported: 5 })
    await importFor(secondSellerId, tenantId, report(['2026-09-20', 'WA', '', 'Sales Tax', '20', '2']))
    await importFor(otherSellerId, otherTenantId, report(['2026-09-20', 'TX', '', 'Sales Tax', '900', '99']))
    const stored = await rows<{ state: string; jurisdictionKey: string; taxCollected: string; lineCount: number }>(
      `SELECT * FROM "SalesTaxSummary" WHERE "sellerAccountId" = $1 AND "taxPeriod" = '2026-09-10'`,
      [sellerId],
    )
    expect(stored.map(item => [item.state, item.jurisdictionKey, Number(item.taxCollected), item.lineCount])).toEqual([['WA', 'KING COUNTY', 15.5, 2]])
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "SalesTaxSummary" WHERE "sellerAccountId" = $1`, [sellerId]))[0]!.n).toBe(4)

    const data = await ok(reader, `/finance/sales-tax?${QUERY}`)
    expect(data.state).toBe('OK')
    expect(data.states.map((row: { state: string; taxCollected: number; taxableSales: number; lineCount: number }) => [row.state, row.taxCollected, row.taxableSales, row.lineCount])).toEqual([
      ['WA', 24.5, 245, 5],
      ['CA', 7, 70, 1],
    ])
    expect(data.states[0].jurisdictions.map((item: { jurisdictionKey: string; taxCollected: number }) => [item.jurisdictionKey, item.taxCollected])).toEqual([
      ['KING COUNTY', 19.5],
      ['', 5],
    ])
    expect(data.totals).toMatchObject({ taxCollected: 31.5, taxableSales: 315, ordersTax: null })
    expect(data.states[0].share).toBeCloseTo(24.5 / 31.5, 3)
    expect(data.trend).toEqual([
      { month: '2026-09', from: '2026-09-01', to: '2026-09-30', reportTax: 27.5, ordersTax: null },
      { month: '2026-10', from: '2026-10-01', to: '2026-10-31', reportTax: 4, ordersTax: null },
    ])
    // 没有订单税额：每月都是“订单里没有税额记录”，不是差额
    expect(data.reconciliation.map((row: { storeName: string; month: string; state: string; diff: number | null }) => [row.month, row.state, row.diff])).toEqual([
      ['2026-09', 'NO_ORDERS', null],
      ['2026-09', 'NO_ORDERS', null],
      ['2026-10', 'NO_ORDERS', null],
    ])
    // 汇总表里没有订单号、收货地址之类的列
    const columns = Object.keys((await rows<Record<string, unknown>>(`SELECT * FROM "SalesTaxSummary" LIMIT 1`))[0]!)
    expect(columns).not.toContain('amazonOrderId')
    expect(columns.filter(column => /address|city|postal|buyer/i.test(column))).toEqual([])
  })

  it('新报告只覆盖它所涵盖的日期：同一天的旧汇总被替换，其余日期保持不变', async () => {
    await importFor(sellerId, tenantId, report(['2026-09-10', 'WA', 'King County', 'Sales Tax', '80', '12']))
    const data = await ok(reader, `/finance/sales-tax?${QUERY}`)
    const wa = data.states.find((row: { state: string }) => row.state === 'WA')
    expect(wa.taxCollected).toBe(21) // 24.5 − 15.5（9 月 10 日旧值）+ 12
    expect(wa.jurisdictions.find((item: { jurisdictionKey: string }) => item.jurisdictionKey === 'KING COUNTY')).toMatchObject({ taxCollected: 16, lineCount: 2 })
    expect(data.states.find((row: { state: string }) => row.state === 'CA').taxCollected).toBe(7)
  })

  it('订单接口的税按月对账：一致、有差异、报告里没有、订单里没有；只算 TAX 与美元，别的企业的订单不计入', async () => {
    // 九月主店：报告 22（WA 12 + 3，CA 7），订单 20 + 4 = 24 → 有差异（-2）；九月二店：报告 2、订单没有 → 订单里没有
    await orderTax('o1', sellerId, tenantId, 20, '2026-09-05T10:00:00Z')
    await orderTax('o2', sellerId, tenantId, 4, '2026-09-28T23:59:59Z')
    // 不计入：销售额类、欧元、别的企业
    await orderTax('o3', sellerId, tenantId, 500, '2026-09-06T10:00:00Z', 'ITEM')
    await orderTax('o4', sellerId, tenantId, 77, '2026-09-07T10:00:00Z', 'TAX', 'EUR')
    await orderTax('o5', otherSellerId, otherTenantId, 123, '2026-09-08T10:00:00Z')
    // 十月主店：订单 9（报告 4）→ 有差异；十月二店：订单 5、报告没有 → 报告里没有
    await orderTax('o6', sellerId, tenantId, 9, '2026-10-01T00:00:00Z')
    await orderTax('o7', secondSellerId, tenantId, 5, '2026-10-20T10:00:00Z')

    const data = await ok(reader, `/finance/sales-tax?${QUERY}`)
    const label = (id: string) => (id === sellerId ? 'main' : id === secondSellerId ? 'second' : id)
    const rowsOf = data.reconciliation.map((row: { sellerAccountId: string; month: string; reportTax: number | null; ordersTax: number | null; diff: number | null; state: string }) => [
      label(row.sellerAccountId),
      row.month,
      row.reportTax,
      row.ordersTax,
      row.diff,
      row.state,
    ])
    expect(rowsOf.sort((a: unknown[], b: unknown[]) => `${a[1]}${a[0]}`.localeCompare(`${b[1]}${b[0]}`))).toEqual([
      ['main', '2026-09', 22, 24, -2, 'DIFFERENT'],
      ['second', '2026-09', 2, null, null, 'NO_ORDERS'],
      ['main', '2026-10', 4, 9, -5, 'DIFFERENT'],
      ['second', '2026-10', null, 5, null, 'NO_REPORT'],
    ])
    expect(data.totals.ordersTax).toBe(38)
    expect(data.trend.map((point: { month: string; reportTax: number | null; ordersTax: number | null }) => [point.month, point.reportTax, point.ordersTax])).toEqual([
      ['2026-09', 24, 24],
      ['2026-10', 4, 14],
    ])
    expect(data.sources.map((item: { source: string; state: string; total: number | null }) => [item.source, item.state, item.total])).toEqual([
      ['TAX_LIBRARY', 'OK', 28],
      ['ORDER_API', 'OK', 38],
      ['SHIPMENT_REPORT', 'NOT_CONNECTED', null],
    ])
  })

  it('每家店的取得情况来自同步新鲜度：已取得、待生成；失败写中文原因', async () => {
    const now = new Date().toISOString()
    await insertRow(h.client, 'DataFreshness', { id: 'fr-1', tenantId, sellerAccountId: sellerId, sourceKey: 'rpt.sales-tax', lastAttemptAt: now, lastSuccessAt: now, status: 'NORMAL' })
    await insertRow(h.client, 'DataFreshness', {
      id: 'fr-2',
      tenantId,
      sellerAccountId: secondSellerId,
      sourceKey: 'rpt.sales-tax',
      lastAttemptAt: now,
      status: 'WAITING_DEPENDENCY',
      lastErrorCode: 'TAX_NOT_GENERATED',
    })
    const stores = (await ok(reader, `/finance/sales-tax?${QUERY}`)).stores
    const stateOf = (list: Array<{ sellerAccountId: string; state: string }>, id: string) => list.find(store => store.sellerAccountId === id)?.state
    expect(stateOf(stores, sellerId)).toBe('AVAILABLE')
    expect(stateOf(stores, secondSellerId)).toBe('NOT_GENERATED')
    expect(stores.find((store: { sellerAccountId: string }) => store.sellerAccountId === secondSellerId).note).toContain('税务文档库')
    await h.client.query(`UPDATE "DataFreshness" SET status = 'UNAUTHORIZED', "lastErrorCode" = 'TAX_ROLE_PENDING' WHERE id = 'fr-2'`)
    const after = (await ok(reader, `/finance/sales-tax?${QUERY}`)).stores
    expect(after.find((store: { sellerAccountId: string }) => store.sellerAccountId === secondSellerId)).toMatchObject({ state: 'ROLE_PENDING', stateLabel: '未授权' })
  })

  it('数据范围：限定店铺的成员只看到自己店铺的州汇总、趋势与对账；跨企业完全隔离', async () => {
    const mine = await ok(scoped, `/finance/sales-tax?${QUERY}`)
    expect(mine.stores.map((store: { storeName: string }) => store.storeName)).toEqual(['欧洲店'])
    expect(mine.states.map((row: { state: string; taxCollected: number }) => [row.state, row.taxCollected])).toEqual([['WA', 2]])
    expect(mine.totals).toMatchObject({ taxCollected: 2, ordersTax: 5 })
    expect(mine.reconciliation.map((row: { storeName: string }) => row.storeName)).toEqual(['欧洲店', '欧洲店'])
    const theirs = await ok(other, `/finance/sales-tax?${QUERY}`)
    expect(theirs.states.map((row: { state: string; taxCollected: number }) => [row.state, row.taxCollected])).toEqual([['TX', 99]])
    expect(theirs.totals.ordersTax).toBe(123)
    expect(theirs.stores.map((store: { sellerAccountId: string }) => store.sellerAccountId)).toEqual([otherSellerId])
  })

  it('范围太长只保留最近 14 个月，参数不合法 422', async () => {
    const long = await ok(reader, '/finance/sales-tax?from=2025-01-01&to=2026-10-31')
    expect(long.range).toMatchObject({ from: '2025-09-01', clamped: true })
    expect(long.trend).toHaveLength(14)
    expect((await get(reader, '/finance/sales-tax?from=nope&to=2026-10-31')).status).toBe(422)
  })
})
