import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 结算交易（P2b-07，真实数据库 + 完整应用 + 导入器与核对任务代码）：
// 迁移升级、约束、行级隔离、回滚闭环；结算报告按真实格式导入（汇总行、明细行沿用结算单编号、保留金）后，三方核对得出确切的状态、金额与异常；
// 重复导入与重复核对幂等；数据补齐后异常自动消除并变为已对平；已对平时自动标记已对账、不再对平时退回；
// 六个接口（列表、汇总、交易明细、三方核对、异常、打款记录）的排序、筛选、游标、权限、数据范围与跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261101010000_settlements'
const NOW = new Date()
const DAY = 86_400_000
const dayOf = (offset: number) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) + offset * DAY).toISOString().slice(0, 10)
const at = (offset: number, time = '10:00:00') => `${dayOf(offset)}T${time}.000Z`

describe('结算交易迁移（P2b-07）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('settlements_migrate')
    client = await db.connect('settlements_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0] as { found: boolean }).found
  const hasColumn = async (column: string) =>
    ((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'FbaSettlement' AND column_name = $1`, [column])).rows[0] as { n: number }).n === 1
  const TABLES = ['SettlementLine', 'Reconciliation', 'ReconciliationException']

  it('升级补列并建三张表（行级隔离与授权）；旧结算单的排序时间被回填；约束拒绝非法取值与重复；回滚闭环', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-st', slug: 't-st', name: '租户' })
    const legal = await insertRow(client, 'LegalEntity', { id: 'le-st', tenantId: tenant.id })
    const seller = await insertRow(client, 'SellerAccount', { id: 's-st', tenantId: tenant.id, legalEntityId: legal.id })
    const base = { tenantId: tenant.id, sellerAccountId: seller.id }
    // 升级前就存在的旧结算单：有打款日的用打款日，只有结束日的用结束日
    await insertRow(client, 'FbaSettlement', {
      id: 'old-1',
      ...base,
      externalSettlementId: 'OLD-1',
      sourceUpdatedAt: '2026-01-01T00:00:00.000Z',
      depositDate: '2026-01-10T00:00:00.000Z',
      settlementEndDate: '2026-01-05T00:00:00.000Z',
    })
    await insertRow(client, 'FbaSettlement', { id: 'old-2', ...base, externalSettlementId: 'OLD-2', sourceUpdatedAt: '2026-01-01T00:00:00.000Z', settlementEndDate: '2026-01-05T00:00:00.000Z' })

    for (const table of TABLES) expect(await exists(table), table).toBe(false)
    expect(await hasColumn('sortAt')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of TABLES) expect(await exists(table), table).toBe(true)
    for (const column of ['openingBalance', 'disbursementAmount', 'txnCount', 'reconciliationStatus', 'diffAmount', 'summaryJson', 'sortAt']) expect(await hasColumn(column), column).toBe(true)
    const rls = await client.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [TABLES])
    expect(rls.rows.every(row => row.relrowsecurity)).toBe(true)
    const policies = await client.query(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND qual LIKE '%nova_current_tenant%'`, [TABLES])
    expect(policies.rowCount).toBe(3)
    const sorted = await client.query(`SELECT id, to_char("sortAt", 'YYYY-MM-DD') AS day FROM "FbaSettlement" ORDER BY id`)
    expect(sorted.rows).toEqual([
      { id: 'old-1', day: '2026-01-10' },
      { id: 'old-2', day: '2026-01-05' },
    ])
    expect((await client.query(`SELECT "reconciliationStatus", "txnCount" FROM "FbaSettlement" WHERE id = 'old-1'`)).rows[0] as { reconciliationStatus: string; txnCount: number }).toEqual({
      reconciliationStatus: 'PENDING',
      txnCount: 0,
    })
    await expect(client.query(`UPDATE "FbaSettlement" SET "reconciliationStatus" = 'DONE' WHERE id = 'old-1'`)).rejects.toMatchObject({ code: '23514' })

    const line = (id: string, over: Record<string, unknown> = {}) => insertRow(client, 'SettlementLine', { id, ...base, settlementId: 'old-1', lineNo: 1, category: 'INCOME', amount: 1, ...over })
    expect(await line('l-1')).toMatchObject({ currency: 'USD', transactionType: '' })
    await expect(line('l-dup')).rejects.toMatchObject({ code: '23505' })
    await expect(line('l-bad', { lineNo: 2, category: 'OTHER' })).rejects.toMatchObject({ code: '23514' })
    const recon = (id: string, over: Record<string, unknown> = {}) =>
      insertRow(client, 'Reconciliation', {
        id,
        ...base,
        settlementId: 'old-1',
        rangeStart: '2026-01-01',
        rangeEnd: '2026-01-05',
        officialAmount: 1,
        systemAmount: 1,
        diffAmount: 0,
        computedAt: '2026-01-06T00:00:00.000Z',
        ...over,
      })
    expect(await recon('r-1')).toMatchObject({ scopeKind: 'SETTLEMENT', status: 'PENDING' })
    await expect(recon('r-dup')).rejects.toMatchObject({ code: '23505' })
    await expect(recon('r-bad', { settlementId: 'old-2', status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(recon('r-bad2', { settlementId: 'old-2', scopeKind: 'WEEK' })).rejects.toMatchObject({ code: '23514' })
    const exception = (id: string, over: Record<string, unknown> = {}) =>
      insertRow(client, 'ReconciliationException', { id, tenantId: tenant.id, reconciliationId: 'r-1', kind: 'AMOUNT_MISMATCH', category: 'UNEXPLAINED', refKey: id, amount: 1, absAmount: 1, ...over })
    expect(await exception('e-1')).toMatchObject({ status: 'OPEN' })
    await expect(exception('e-dup', { refKey: 'e-1' })).rejects.toMatchObject({ code: '23505' })
    await expect(exception('e-kind', { kind: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(exception('e-cat', { category: 'NOPE' })).rejects.toMatchObject({ code: '23514' })
    await expect(exception('e-status', { status: 'DONE' })).rejects.toMatchObject({ code: '23514' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of TABLES) expect(await exists(table), table).toBe(false)
    expect(await hasColumn('sortAt')).toBe(false)
    expect(((await client.query(`SELECT count(*)::int AS n FROM "FbaSettlement"`)).rows[0] as { n: number }).n).toBe(2)
    await applyMigrations(client, { only: TARGET })
    expect(((await client.query(`SELECT count(*)::int AS n FROM "SettlementLine"`)).rows[0] as { n: number }).n).toBe(0)
    expect(((await client.query(`SELECT to_char("sortAt", 'YYYY-MM-DD') AS day FROM "FbaSettlement" WHERE id = 'old-1'`)).rows[0] as { day: string }).day).toBe('2026-01-10')
  })
})

describe('结算交易（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let secondSellerId: string
  let otherTenantId: string
  let otherSellerId: string
  let reader: Member
  let noFinance: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  let importReport: (
    ctx: unknown,
    rows: AsyncIterable<unknown>,
    tenantId: string,
    sellerAccountId: string,
    marketplaceId: string,
    options?: { now?: Date },
  ) => Promise<{ imported: number; read: number; skipped: number }>
  let reconcile: (db: PrismaClient, tenantId: string, now?: Date, sellerAccountId?: string) => Promise<{ settlements: number; matched: number; discrepancy: number; pending: number; errors: string[] }>
  let toRows: (content: string) => AsyncIterable<unknown>

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const COLUMNS = [
    'settlement-id',
    'settlement-start-date',
    'settlement-end-date',
    'deposit-date',
    'total-amount',
    'currency',
    'transaction-type',
    'order-id',
    'amount-type',
    'amount-description',
    'posted-date-time',
    'amount',
    'sku',
    'quantity-purchased',
  ]
  const report = (...lines: Array<Record<string, string>>) => [COLUMNS.join('\t'), ...lines.map(line => COLUMNS.map(column => line[column] ?? '').join('\t'))].join('\n')
  const header = (id: string, startOffset: number, endOffset: number, depositOffset: number | null, total: string) => ({
    'settlement-id': id,
    'settlement-start-date': `${dayOf(startOffset)} 00:00:00 UTC`,
    'settlement-end-date': `${dayOf(endOffset)} 23:59:59 UTC`,
    'deposit-date': depositOffset === null ? '' : `${dayOf(depositOffset)} 08:00:00 UTC`,
    'total-amount': total,
    currency: 'USD',
  })
  const detail = (order: string, amountType: string, description: string, amount: string, postedOffset: number, over: Record<string, string> = {}) => ({
    'transaction-type': 'Order',
    'order-id': order,
    'amount-type': amountType,
    'amount-description': description,
    'posted-date-time': `${dayOf(postedOffset)} 10:00:00 UTC`,
    amount,
    sku: 'SKU-1',
    'quantity-purchased': '1',
    ...over,
  })
  const importFor = (store: string, tid: string, content: string) =>
    runWithTenant(tid, () =>
      importReport({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }, toRows(content), tid, store, 'ATVPDKIKX0DER', { now: NOW }),
    )
  const run = (tid: string) => runWithTenant(tid, () => reconcile(tenantDb, tid, NOW))
  const settlementId = async (external: string, store = sellerId) =>
    (await rows<{ id: string }>(`SELECT id FROM "FbaSettlement" WHERE "sellerAccountId" = $1 AND "externalSettlementId" = $2`, [store, external]))[0]!.id
  const order = (tid: string, store: string, id: string, purchaseOffset = -31) =>
    insertRow(h.client, 'Order', { id: `ord-${id}`, tenantId: tid, sellerAccountId: store, amazonOrderId: id, purchaseDate: at(purchaseOffset), status: 'Shipped', currency: 'USD' })
  const tx = async (tid: string, store: string, external: string, id: string, orderId: string | null, amount: number, postedOffset: number) =>
    insertRow(h.client, 'FbaFinancialTransaction', {
      id: `tx-${id}`,
      tenantId: tid,
      sellerAccountId: store,
      settlementId: await settlementId(external, store),
      externalTransactionId: `ext-${id}`,
      amazonOrderId: orderId,
      transactionType: 'Order',
      transactionStatus: 'RELEASED',
      amount,
      currency: 'USD',
      postedAt: at(postedOffset),
      sourceUpdatedAt: at(postedOffset),
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'settlements', db })
    const a = await h.createTenant('st-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-st-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-ST-2' })).id
    const b = await h.createTenant('st-b')
    otherTenantId = b.tenantId
    otherSellerId = b.sellerAccountId
    reader = await h.createMember(tenantId, 'st-read', ['finance.read'])
    noFinance = await h.createMember(tenantId, 'st-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'st-scoped', ['finance.read'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(otherTenantId, 'st-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('settlements', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ syncSettlementReport: importReport } = await import(/* @vite-ignore */ String('../../../worker/src/importers/finance/settlement-report')))
    ;({ reconcileTenant: reconcile } = await import(/* @vite-ignore */ String('../../../worker/src/settlements/run')))
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

  it('没有结算单之前：列表为空并写明原因', async () => {
    const empty = await ok(reader, '/settlements')
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [], summary: { total: 0, matched: 0, discrepancy: 0, pending: 0 } })
    expect(empty.note).toContain('尚无结算单')
  })

  it('导入结算报告：汇总行写结算单，明细行沿用上一个汇总行的编号；保留金单独成类；重复导入不重复', async () => {
    // 结算单一：与接口交易完全一致（收入 100 − 佣金 15 + 收入 50 = 135，另有保留金 −20，打款 115）
    const first = report(
      header('S1', -30, -17, -15, '115'),
      detail('O1', 'ItemPrice', 'Principal', '100', -28),
      detail('O1', 'ItemFees', 'Commission', '-15', -28),
      detail('O2', 'ItemPrice', 'Principal', '50', -27),
      { 'transaction-type': '', 'amount-description': 'Previous Reserve Amount Balance', amount: '-20' },
    )
    const result = await importFor(sellerId, tenantId, first)
    expect(result).toMatchObject({ read: 5, imported: 5, skipped: 0 })
    const repeat = await importFor(sellerId, tenantId, first)
    expect(repeat.read).toBe(5)
    const [s1] = await rows<{ totalAmount: string; disbursementAmount: string; sortAt: Date }>(`SELECT * FROM "FbaSettlement" WHERE "externalSettlementId" = 'S1'`)
    expect(s1).toMatchObject({ totalAmount: '115.000000', disbursementAmount: '115.000000' })
    expect(s1.sortAt.toISOString().slice(0, 10)).toBe(dayOf(-15))
    const lines = await rows<{ lineNo: number; category: string; amount: string; amazonOrderId: string | null }>(`SELECT * FROM "SettlementLine" WHERE "settlementId" = $1 ORDER BY "lineNo"`, [
      await settlementId('S1'),
    ])
    expect(lines.map(line => [line.lineNo, line.category, Number(line.amount), line.amazonOrderId])).toEqual([
      [2, 'INCOME', 100, 'O1'],
      [3, 'FEE', -15, 'O1'],
      [4, 'INCOME', 50, 'O2'],
      [5, 'RESERVE', -20, null],
    ])
    // 结算单二：订单三金额与接口不一致、订单四在接口和我方订单里都没有
    await importFor(sellerId, tenantId, report(header('S2', -16, -3, -1, '70'), detail('O3', 'ItemPrice', 'Principal', '40', -10), detail('O4', 'ItemPrice', 'Principal', '30', -9)))
    // 结算单三：只有汇总行，明细没来（报告还没生成）
    await importFor(sellerId, tenantId, report(header('S3', -60, -41, null, '')))
    // 第二家店铺的结算单四：有明细、没有接口交易
    await importFor(secondSellerId, tenantId, report(header('S4', -20, -6, -5, '25'), detail('O5', 'ItemPrice', 'Principal', '25', -7)))
    // 另一家企业：同名结算单编号，用来证明互不串
    await importFor(otherSellerId, otherTenantId, report(header('S1', -30, -17, -15, '9'), detail('X1', 'ItemPrice', 'Principal', '9', -28)))
    expect(((await rows(`SELECT 1 FROM "FbaSettlement" WHERE "tenantId" = $1`, [tenantId])) as unknown[]).length).toBe(4)
    expect(((await rows(`SELECT 1 FROM "SettlementLine" WHERE "settlementId" = $1`, [await settlementId('S3')])) as unknown[]).length).toBe(0)
  })

  it('核对任务：已对平、有差异（三条异常）、待核对两种原因；金额与异常按种子数据确切', async () => {
    await order(tenantId, sellerId, 'O1')
    await order(tenantId, sellerId, 'O2')
    await order(tenantId, sellerId, 'O3')
    await tx(tenantId, sellerId, 'S1', 'a', 'O1', 85, -28)
    await tx(tenantId, sellerId, 'S1', 'b', 'O2', 50, -27)
    await tx(tenantId, sellerId, 'S2', 'c', 'O3', 35, -10)
    await insertRow(h.client, 'FbaFeeEvent', {
      id: 'fe-s1',
      tenantId,
      sellerAccountId: sellerId,
      sourceEventId: 'fe-s1:0',
      currency: 'USD',
      postedAt: at(-28),
      settlementId: 'S1',
      feeCategory: 'COMMISSION',
      amount: -15,
    })
    const result = await run(tenantId)
    expect(result.errors).toEqual([])
    expect(result).toMatchObject({ settlements: 4, matched: 1, discrepancy: 1, pending: 2 })

    const recon = await rows<{ status: string; pendingReason: string | null; officialAmount: string; systemAmount: string; diffAmount: string; detailJson: any }>(
      `SELECT r.* FROM "Reconciliation" r JOIN "FbaSettlement" s ON s.id = r."settlementId" WHERE s."externalSettlementId" = $1 AND s."tenantId" = $2`,
      ['S1', tenantId],
    )
    expect(recon[0]).toMatchObject({ status: 'MATCHED', officialAmount: '135.000000', systemAmount: '135.000000', diffAmount: '0.000000' })
    expect(recon[0].detailJson.checks.map((check: { state: string }) => check.state)).toEqual(['PASS', 'PASS', 'PASS'])
    const s1Recon = (await rows<{ id: string }>(`SELECT id FROM "Reconciliation" WHERE "settlementId" = $1`, [await settlementId('S1')]))[0]
    expect(await rows(`SELECT 1 FROM "ReconciliationException" WHERE "reconciliationId" = $1`, [s1Recon.id])).toHaveLength(0)

    const s2 = await settlementId('S2')
    const exceptions = await rows<{ kind: string; category: string; refKey: string; reportAmount: string; apiAmount: string; amount: string; status: string }>(
      `SELECT e.* FROM "ReconciliationException" e JOIN "Reconciliation" r ON r.id = e."reconciliationId" WHERE r."settlementId" = $1 ORDER BY e."absAmount" DESC, e."refKey"`,
      [s2],
    )
    expect(exceptions.map(item => [item.refKey, item.kind, item.category, Number(item.reportAmount), Number(item.apiAmount), Number(item.amount), item.status])).toEqual([
      ['missing:O4', 'ORDER_MISSING', 'UNEXPLAINED', 30, 0, 30, 'OPEN'],
      ['order:O4', 'REPORT_ONLY', 'UNEXPLAINED', 30, 0, 30, 'OPEN'],
      ['order:O3', 'AMOUNT_MISMATCH', 'UNEXPLAINED', 40, 35, 5, 'OPEN'],
    ])
    expect(await rows(`SELECT "status", "pendingReason" FROM "Reconciliation" WHERE "settlementId" = $1`, [await settlementId('S3')])).toEqual([{ status: 'PENDING', pendingReason: 'NO_REPORT' }])
    expect(await rows(`SELECT "status", "pendingReason" FROM "Reconciliation" WHERE "settlementId" = $1`, [await settlementId('S4', secondSellerId)])).toEqual([
      { status: 'PENDING', pendingReason: 'NO_TRANSACTIONS' },
    ])
    // 另一家企业还没有跑核对，不受影响
    expect(await rows(`SELECT 1 FROM "Reconciliation" WHERE "tenantId" = $1`, [otherTenantId])).toHaveLength(0)
  })

  it('已对平自动标记已对账；重复核对幂等', async () => {
    expect((await rows<{ reconciliationStatus: string; reconciledBy: string }>(`SELECT "reconciliationStatus", "reconciledBy" FROM "FbaFeeEvent" WHERE id = 'fe-s1'`))[0]).toEqual({
      reconciliationStatus: 'RECONCILED',
      reconciledBy: 'system:settlement',
    })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaFinancialTransaction" WHERE "reconciliationStatus" = 'RECONCILED' AND "tenantId" = $1`, [tenantId]))[0].n).toBe(2)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaFinancialTransaction" WHERE id = 'tx-c' AND "reconciliationStatus" = 'UNRECONCILED'`))[0].n).toBe(1)
    const before = await rows(`SELECT id, status FROM "ReconciliationException" WHERE "tenantId" = $1 ORDER BY id`, [tenantId])
    const again = await run(tenantId)
    expect(again.errors).toEqual([])
    expect(await rows(`SELECT id, status FROM "ReconciliationException" WHERE "tenantId" = $1 ORDER BY id`, [tenantId])).toEqual(before)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "Reconciliation" WHERE "tenantId" = $1`, [tenantId]))[0].n).toBe(4)
  })

  it('列表：默认按打款日从新到旧，状态、差额与异常数、汇总张数；筛选与游标', async () => {
    const data = await ok(reader, '/settlements')
    expect(data.state).toBe('OK')
    expect(data.items.map((item: { externalSettlementId: string }) => item.externalSettlementId)).toEqual(['S2', 'S4', 'S1', 'S3'])
    expect(data.summary).toEqual({ total: 4, matched: 1, discrepancy: 1, pending: 2 })
    expect(data.freshness).toBeDefined()
    const byId = Object.fromEntries(data.items.map((item: { externalSettlementId: string }) => [item.externalSettlementId, item]))
    expect(byId.S1).toMatchObject({
      status: 'MATCHED',
      statusLabel: '已对平',
      diffAmount: 0,
      openExceptions: 0,
      disbursementAmount: 115,
      totalAmount: 115,
      txnCount: 4,
      currency: 'USD',
      storeName: expect.any(String),
    })
    expect(byId.S1.totals).toEqual({ INCOME: 150, FEE: -15, REFUND: 0, REIMBURSEMENT: 0, ADJUSTMENT: 0, RESERVE: -20 })
    expect(byId.S2).toMatchObject({ status: 'DISCREPANCY', openExceptions: 3 })
    expect(Math.abs(byId.S2.diffAmount)).toBeGreaterThan(0)
    // 待核对不是 0：没有报告就没有各类合计与差额
    expect(byId.S3).toMatchObject({ status: 'PENDING', pendingReason: 'NO_REPORT', totals: null, diffAmount: null, totalAmount: null, txnCount: 0 })
    expect(byId.S4).toMatchObject({ status: 'PENDING', pendingReason: 'NO_TRANSACTIONS' })
    // 筛选
    expect((await ok(reader, '/settlements?status=PENDING')).items.map((item: { externalSettlementId: string }) => item.externalSettlementId)).toEqual(['S4', 'S3'])
    expect((await ok(reader, '/settlements?status=MATCHED')).items.map((item: { externalSettlementId: string }) => item.externalSettlementId)).toEqual(['S1'])
    expect((await get(reader, '/settlements?status=NOPE')).status).toBe(422)
    expect((await get(reader, '/settlements?cursor=not-a-cursor')).status).toBeGreaterThanOrEqual(400)
    // 游标：每页 2 条走完，不重不漏
    const seen: string[] = []
    let cursor = ''
    for (let page = 0; page < 6; page += 1) {
      const res = await ok(reader, `/settlements?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...res.items.map((item: { externalSettlementId: string }) => item.externalSettlementId))
      if (!res.pageInfo.hasMore) break
      cursor = res.pageInfo.nextCursor
    }
    expect(seen).toEqual(['S2', 'S4', 'S1', 'S3'])
  })

  it('汇总与交易明细：按类别合计、按科目汇总；明细筛选、游标与订单是否存在', async () => {
    const s1 = await settlementId('S1')
    const summary = await ok(reader, `/settlements/${s1}/summary`)
    expect(summary).toMatchObject({ hasReport: true, note: null })
    expect(Object.fromEntries(summary.categories.map((item: { category: string; amount: number }) => [item.category, item.amount]))).toEqual({
      INCOME: 150,
      FEE: -15,
      REFUND: 0,
      REIMBURSEMENT: 0,
      ADJUSTMENT: 0,
      RESERVE: -20,
    })
    expect(summary.breakdown.find((item: { amountDescription: string }) => item.amountDescription === 'Principal')).toMatchObject({ category: 'INCOME', count: 2, amount: 150 })
    const none = await ok(reader, `/settlements/${await settlementId('S3')}/summary`)
    expect(none).toMatchObject({ hasReport: false, categories: [] })
    expect(none.note).toContain('尚未')

    const lines = await ok(reader, `/settlements/${s1}/transactions`)
    expect(lines.items.map((item: { lineNo: number }) => item.lineNo)).toEqual([2, 3, 4, 5])
    expect(lines.canViewOrders).toBe(false)
    expect((await ok(reader, `/settlements/${s1}/transactions?category=FEE`)).items.map((item: { amount: number }) => item.amount)).toEqual([-15])
    const pageOne = await ok(reader, `/settlements/${s1}/transactions?pageSize=3`)
    expect(pageOne.items).toHaveLength(3)
    const pageTwo = await ok(reader, `/settlements/${s1}/transactions?pageSize=3&cursor=${encodeURIComponent(pageOne.pageInfo.nextCursor)}`)
    expect(pageTwo.items.map((item: { lineNo: number }) => item.lineNo)).toEqual([5])
    expect(pageTwo.pageInfo.hasMore).toBe(false)
    // 订单是否存在：有订单读取权限的才看到
    const withOrders = await h.createMember(tenantId, 'st-orders', ['finance.read', 'orders.read'])
    const s2Lines = await ok(withOrders, `/settlements/${await settlementId('S2')}/transactions`)
    expect(s2Lines.canViewOrders).toBe(true)
    expect(s2Lines.items.map((item: { amazonOrderId: string; orderFound: boolean }) => [item.amazonOrderId, item.orderFound])).toEqual([
      ['O3', true],
      ['O4', false],
    ])
    expect(s2Lines.items.every((item: { orderFound: boolean | null }) => item.orderFound !== null)).toBe(true)
  })

  it('三方核对与异常：金额、核对项、异常分类汇总；异常筛选；打款记录来自报告', async () => {
    const s2 = await settlementId('S2')
    const recon = await ok(reader, `/settlements/${s2}/reconciliation`)
    expect(recon).toMatchObject({ status: 'DISCREPANCY', officialAmount: 70, systemAmount: 35, diffAmount: 35, openExceptions: 3, tolerance: 0.05 })
    expect(recon.checks.map((check: { key: string; state: string }) => [check.key, check.state])).toEqual([
      ['REPORT_SELF', 'PASS'],
      ['REPORT_VS_API', 'FAIL'],
      ['ORDERS', 'FAIL'],
    ])
    expect(recon.exceptions).toEqual([{ category: 'UNEXPLAINED', label: '未解释', count: 3, amount: 65 }])
    const pending = await ok(reader, `/settlements/${await settlementId('S3')}/reconciliation`)
    expect(pending).toMatchObject({ status: 'PENDING', pendingReason: 'NO_REPORT', officialAmount: null, systemAmount: null, diffAmount: null })
    expect(pending.pendingNote).toBeTruthy()

    const list = await ok(reader, `/settlements/${s2}/exceptions`)
    // 金额相同的两条（都是 30）的先后由主键决定，只断言金额从大到小
    expect(list.items.map((item: { refKey: string }) => item.refKey).sort()).toEqual(['missing:O4', 'order:O3', 'order:O4'])
    expect(list.items[2].refKey).toBe('order:O3')
    expect((await ok(reader, `/settlements/${s2}/exceptions?kind=AMOUNT_MISMATCH`)).items.map((item: { refKey: string }) => item.refKey)).toEqual(['order:O3'])
    expect((await ok(reader, `/settlements/${s2}/exceptions?category=SCOPE`)).items).toEqual([])
    expect((await get(reader, `/settlements/${s2}/exceptions?category=NOPE`)).status).toBe(422)
    const page = await ok(reader, `/settlements/${s2}/exceptions?pageSize=2`)
    expect(page.items).toHaveLength(2)
    expect(page.pageInfo.hasMore).toBe(true)

    const money = await ok(reader, `/settlements/${await settlementId('S1')}/disbursements`)
    expect(money.items).toEqual([expect.objectContaining({ source: 'REPORT', amount: 115, currency: 'USD' })])
    expect(money.items[0].date.slice(0, 10)).toBe(dayOf(-15))
    // 有打款金额：可以去回款页登记到账（P2b-08），尚未登记
    expect(money.manual).toMatchObject({ available: true, note: expect.stringContaining('尚未登记') })
    // 报告没到：打款只有一行说明，金额与日期是空的（不是 0），也没有可登记的金额
    const waitingAll = await ok(reader, `/settlements/${await settlementId('S3')}/disbursements`)
    const waiting = waitingAll.items
    expect(waitingAll.manual.available).toBe(false)
    expect(waiting).toEqual([expect.objectContaining({ source: 'REPORT', amount: null, date: null })])
    expect(waiting[0].note).toContain('尚未到达')
  })

  it('权限、数据范围与跨企业隔离', async () => {
    expect((await get(noFinance, '/settlements')).status).toBe(403)
    const s1 = await settlementId('S1')
    expect((await get(noFinance, `/settlements/${s1}/summary`)).status).toBe(403)
    // 只授权第二家店铺：只看到它的结算单，其它店铺的结算单所有子接口都是 404
    const mine = await ok(scoped, '/settlements')
    expect(mine.items.map((item: { externalSettlementId: string }) => item.externalSettlementId)).toEqual(['S4'])
    expect(mine.summary.total).toBe(1)
    for (const path of ['summary', 'transactions', 'reconciliation', 'exceptions', 'disbursements']) expect((await get(scoped, `/settlements/${s1}/${path}`)).status, path).toBe(404)
    expect((await ok(scoped, `/settlements/${await settlementId('S4', secondSellerId)}/summary`)).hasReport).toBe(true)
    // 另一家企业：看不到我们的结算单，也访问不了
    const theirs = await ok(other, '/settlements')
    expect(theirs.items.map((item: { externalSettlementId: string }) => item.externalSettlementId)).toEqual(['S1'])
    expect(theirs.items[0].totalAmount).toBe(9)
    for (const path of ['summary', 'transactions', 'reconciliation', 'exceptions', 'disbursements']) expect((await get(other, `/settlements/${s1}/${path}`)).status, path).toBe(404)
    expect((await get(reader, `/settlements/${await settlementId('S1', otherSellerId)}/summary`)).status).toBe(404)
    expect((await get(reader, '/settlements/bad%20id!/summary')).status).toBe(404)
  })

  it('数据补齐后重新核对：异常自动消除并变为已对平；之后接口交易被改动又退回，系统标记的已对账随之撤销', async () => {
    const s2 = await settlementId('S2')
    await order(tenantId, sellerId, 'O4')
    await tx(tenantId, sellerId, 'S2', 'd', 'O3', 5, -10)
    await tx(tenantId, sellerId, 'S2', 'e', 'O4', 30, -9)
    const result = await run(tenantId)
    expect(result.errors).toEqual([])
    const fixed = await ok(reader, `/settlements/${s2}/reconciliation`)
    expect(fixed).toMatchObject({ status: 'MATCHED', diffAmount: 0, openExceptions: 0 })
    const resolved = await ok(reader, `/settlements/${s2}/exceptions?status=RESOLVED`)
    expect(resolved.items).toHaveLength(3)
    expect(resolved.items.every((item: { status: string }) => item.status === 'RESOLVED')).toBe(true)
    expect((await ok(reader, `/settlements/${s2}/exceptions?status=OPEN`)).items).toEqual([])
    expect((await ok(reader, '/settlements')).summary).toEqual({ total: 4, matched: 2, discrepancy: 0, pending: 2 })
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaFinancialTransaction" WHERE "settlementId" = $1 AND "reconciliationStatus" = 'RECONCILED'`, [s2]))[0].n).toBe(3)

    // 接口里这张结算单的一笔交易被改了金额：重新核对后又有差异，系统标过的已对账被撤销（费用明细与交易都退回）
    await h.client.query(`UPDATE "FbaFinancialTransaction" SET "amount" = 80 WHERE "id" = 'tx-a'`)
    await run(tenantId)
    const s1 = await settlementId('S1')
    expect(await ok(reader, `/settlements/${s1}/reconciliation`)).toMatchObject({ status: 'DISCREPANCY', openExceptions: 1 })
    expect((await rows<{ reconciliationStatus: string }>(`SELECT "reconciliationStatus" FROM "FbaFeeEvent" WHERE id = 'fe-s1'`))[0].reconciliationStatus).toBe('UNRECONCILED')
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "FbaFinancialTransaction" WHERE "settlementId" = $1 AND "reconciliationStatus" = 'RECONCILED'`, [s1]))[0].n).toBe(0)
    // 改回去又对平
    await h.client.query(`UPDATE "FbaFinancialTransaction" SET "amount" = 85 WHERE "id" = 'tx-a'`)
    await run(tenantId)
    expect(await ok(reader, `/settlements/${s1}/reconciliation`)).toMatchObject({ status: 'MATCHED', openExceptions: 0 })
    expect((await rows<{ reconciliationStatus: string }>(`SELECT "reconciliationStatus" FROM "FbaFeeEvent" WHERE id = 'fe-s1'`))[0].reconciliationStatus).toBe('RECONCILED')
  })

  it('核对只动自己企业的数据：另一家企业核对后只有它自己的结果', async () => {
    const result = await run(otherTenantId)
    expect(result).toMatchObject({ settlements: 1, pending: 1, errors: [] })
    expect(await rows(`SELECT 1 FROM "Reconciliation" WHERE "tenantId" = $1`, [otherTenantId])).toHaveLength(1)
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "Reconciliation" WHERE "tenantId" = $1`, [tenantId]))[0].n).toBe(4)
  })
})
