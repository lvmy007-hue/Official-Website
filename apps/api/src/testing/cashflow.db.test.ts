import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 回款与现金流（P2b-08，真实数据库 + 完整应用）：
// 迁移升级（预计释放日列、到账登记表、约束、行级隔离）与回滚闭环；
// 递延余额、递延与释放、打款预测、按周预测、到账核对的数值按种子数据确切；
// 到账登记：新建、乐观锁更新、冲突、校验、权限、数据范围与跨企业隔离；设置结算详情页的“手工登记到账”行。

type Member = { userId: string; token: string }
const TARGET = '20261102010000_cashflow'
const NOW = new Date()
const DAY = 86_400_000
const dayOf = (offset: number) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) + offset * DAY).toISOString().slice(0, 10)
const at = (offset: number, time = '10:00:00') => `${dayOf(offset)}T${time}.000Z`

describe('回款与现金流迁移（P2b-08）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('cashflow_migrate')
    client = await db.connect('cashflow_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0] as { found: boolean }).found
  const hasMaturity = async () =>
    ((await client.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'FbaFinancialTransaction' AND column_name = 'maturityAt'`)).rows[0] as { n: number }).n === 1

  it('升级加预计释放日列与登记表（行级隔离、授权）；约束拒绝非法取值与重复；回滚闭环且不动交易数据', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-cf', slug: 't-cf', name: '租户' })
    const legal = await insertRow(client, 'LegalEntity', { id: 'le-cf', tenantId: tenant.id })
    const seller = await insertRow(client, 'SellerAccount', { id: 's-cf', tenantId: tenant.id, legalEntityId: legal.id })
    const base = { tenantId: tenant.id, sellerAccountId: seller.id }
    for (const id of ['st-1', 'st-2']) await insertRow(client, 'FbaSettlement', { id, ...base, externalSettlementId: id.toUpperCase(), sourceUpdatedAt: '2026-01-01T00:00:00.000Z' })
    await insertRow(client, 'FbaFinancialTransaction', {
      id: 'tx-old',
      ...base,
      externalTransactionId: 'e1',
      amount: 5,
      currency: 'USD',
      postedAt: '2026-10-01T00:00:00Z',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    expect(await exists('Disbursement')).toBe(false)
    expect(await hasMaturity()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists('Disbursement')).toBe(true)
    expect(await hasMaturity()).toBe(true)
    const rls = await client.query(`SELECT relrowsecurity FROM pg_class WHERE relname = 'Disbursement'`)
    expect(rls.rows[0]).toEqual({ relrowsecurity: true })
    const policies = await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'Disbursement' AND qual LIKE '%nova_current_tenant%'`)
    expect(policies.rowCount).toBe(1)
    expect((await client.query(`SELECT "maturityAt" FROM "FbaFinancialTransaction" WHERE id = 'tx-old'`)).rows[0]).toEqual({ maturityAt: null })

    const row = (id: string, settlementId: string, over: Record<string, unknown> = {}) =>
      insertRow(client, 'Disbursement', { id, ...base, settlementId, disbursedAt: '2026-10-02', amount: 10, currency: 'USD', createdBy: 'u', updatedBy: 'u', ...over })
    expect(await row('d-1', 'st-1')).toMatchObject({ version: 1, bankLast4: null })
    await expect(row('d-dup', 'st-1')).rejects.toMatchObject({ code: '23505' })
    await expect(row('d-zero', 'st-2', { amount: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(row('d-bank', 'st-2', { bankLast4: 'abc' })).rejects.toMatchObject({ code: '23514' })
    await expect(row('d-ver', 'st-2', { version: 0 })).rejects.toMatchObject({ code: '23514' })
    expect(await row('d-ok', 'st-2', { bankLast4: '0042' })).toMatchObject({ bankLast4: '0042' })
    await expect(row('d-fk', 'no-such')).rejects.toMatchObject({ code: '23503' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists('Disbursement')).toBe(false)
    expect(await hasMaturity()).toBe(false)
    expect(((await client.query(`SELECT count(*)::int AS n FROM "FbaFinancialTransaction"`)).rows[0] as { n: number }).n).toBe(1)
    await applyMigrations(client, { only: TARGET })
    expect(await exists('Disbursement')).toBe(true)
  })
})

describe('回款与现金流（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let secondSellerId: string
  let otherSellerId: string
  let reader: Member
  let finance: Member
  let noFinance: Member
  let scoped: Member
  let other: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const confirm = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/finance/disbursements/confirm', { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]

  const settlement = (id: string, store: string, tid: string, endOffset: number, depositOffset: number | null, amount: number | null, currency = 'USD') =>
    insertRow(h.client, 'FbaSettlement', {
      id,
      tenantId: tid,
      sellerAccountId: store,
      externalSettlementId: id.toUpperCase(),
      currency,
      settlementEndDate: at(endOffset, '23:59:59'),
      depositDate: depositOffset === null ? null : at(depositOffset, '08:00:00'),
      disbursementAmount: amount,
      sortAt: at(depositOffset ?? endOffset),
      sourceUpdatedAt: at(endOffset),
    })
  const tx = (id: string, status: string, amount: number, postedOffset: number, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'FbaFinancialTransaction', {
      id: `tx-${id}`,
      tenantId,
      sellerAccountId: sellerId,
      externalTransactionId: `ext-${id}`,
      transactionType: 'Order',
      transactionStatus: status,
      amount,
      currency: 'USD',
      postedAt: at(postedOffset),
      sourceUpdatedAt: at(postedOffset),
      ...over,
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'cashflow', db })
    const a = await h.createTenant('cf-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    // 用 UTC 计算“今天”，避免测试随时区漂移
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-cf-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-CF-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('cf-b')
    otherSellerId = b.sellerAccountId
    reader = await h.createMember(tenantId, 'cf-read', ['finance.read'])
    finance = await h.createMember(tenantId, 'cf-fin', ['finance.read', 'finance.reconcile'])
    noFinance = await h.createMember(tenantId, 'cf-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'cf-scoped', ['finance.read', 'finance.reconcile'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'cf-other', ['*'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没有任何数据：给空状态说明，各区块为空而不是 0', async () => {
    const data = await ok(reader, '/finance/cashflow')
    expect(data).toMatchObject({ state: 'NO_DATA', canConfirm: false })
    expect(data.note).toContain('尚无回款与现金流数据')
    expect(data.balances.items).toEqual([])
    expect(data.deferral.totals).toEqual([])
    expect(data.payout.next).toBeNull()
    expect(data.disbursements).toMatchObject({ items: [], summary: { total: 0 } })
  })

  it('余额、递延与释放、打款预测与按周预测：数值按种子数据确切；打款类交易不进日均；预计释放日写入后并入第一次预计打款', async () => {
    // 美国店：三张结算单，周期结束日 -31、-17、-3，打款晚 3 天（最后一张的打款日就是今天）
    await settlement('st-31', sellerId, tenantId, -31, -28, 500)
    await settlement('st-17', sellerId, tenantId, -17, -14, 500)
    await settlement('st-3', sellerId, tenantId, -3, 0, 500)
    // 欧洲店：只有一张，且是欧元
    await settlement('st-eu', secondSellerId, tenantId, -10, -7, 90, 'EUR')
    await insertRow(h.client, 'AccountBalanceSnapshot', {
      id: 'bal-1',
      tenantId,
      sellerAccountId: sellerId,
      snapshotDate: dayOf(-1),
      balanceType: 'DEFERRED',
      accountType: 'PAYABLE',
      currency: 'USD',
      amount: 120.5,
    })
    await insertRow(h.client, 'AccountBalanceSnapshot', {
      id: 'bal-0',
      tenantId,
      sellerAccountId: sellerId,
      snapshotDate: dayOf(-3),
      balanceType: 'DEFERRED',
      accountType: 'PAYABLE',
      currency: 'USD',
      amount: 999,
    })
    await tx('run', 'RELEASED', 2740, -10)
    await tx('rel', 'DEFERRED_RELEASED', 60, -2)
    await tx('payout', 'RELEASED', 9999, -5, { transactionType: 'Transfer' })
    await tx('def-a', 'DEFERRED', 50, -1, { maturityAt: at(5, '00:00:00') })
    await tx('def-b', 'DEFERRED', 30, -1, { maturityAt: at(5, '00:00:00') })
    await tx('def-c', 'DEFERRED', 20, -1)

    const data = await ok(reader, '/finance/cashflow?weeks=4')
    expect(data).toMatchObject({ state: 'OK', asOf: dayOf(0), canConfirm: false })
    expect(data.balances.items).toEqual([
      { sellerAccountId: sellerId, storeName: expect.any(String), accountType: 'PAYABLE', label: '递延余额（PAYABLE）', currency: 'USD', amount: 120.5, asOf: dayOf(-1) },
    ])
    expect(data.deferral.totals).toEqual([{ currency: 'USD', amount: 100, count: 3, withMaturity: 2 }])
    expect(data.deferral.schedule.unknown).toEqual({ amount: 20, count: 1 })
    expect(data.deferral.released).toEqual([{ currency: 'USD', amount: 60, count: 1 }])

    const us = data.payout.stores.find((store: { sellerAccountId: string }) => store.sellerAccountId === sellerId)
    expect(us).toMatchObject({ cycleDays: 14, lagDays: 3, samples: 3, lastPeriodEnd: dayOf(-3) })
    expect(us.published).toEqual([expect.objectContaining({ externalSettlementId: 'ST-3', depositDate: dayOf(0), amount: 500 })])
    // 日均 (2740 + 60) ÷ 28 = 100，传输类交易不算；下次预计打款的周期结束日 +11，递延释放 80 并入
    expect(data.payout.dailyRate).toBe(100)
    expect(us.predicted[0]).toMatchObject({ periodEnd: dayOf(11), depositDate: dayOf(14), runRateAmount: 1400, deferredAmount: 80, estimated: 1480 })
    // 打款预测按币种看：美元视图里不列只有欧元结算单的欧洲店；欧元视图里它因历史不足没有预测
    expect(data.payout.stores.map((store: { sellerAccountId: string }) => store.sellerAccountId)).toEqual([sellerId])
    expect(data.currencies).toEqual(['EUR', 'USD'])
    const euView = (await ok(reader, '/finance/cashflow?currency=EUR&weeks=4')).payout.stores
    expect(euView).toEqual([expect.objectContaining({ sellerAccountId: secondSellerId, cycleDays: null, predicted: [], reason: expect.stringContaining('至少需要 2 张') })])
    expect(data.payout.next).toMatchObject({ date: dayOf(0), amount: 500, kind: 'PUBLISHED' })

    expect(data.forecast.weeks[0]).toMatchObject({ publishedInflow: 500, purchaseOutflow: null, firstMileOutflow: null, adsOutflow: null })
    expect(data.forecast.weeks[0].missing).toEqual(expect.arrayContaining(['采购付款', '头程付款', '广告扣款']))
    expect(data.forecast.weeks[2]).toMatchObject({ estimatedInflow: 1480 })
    expect(data.forecast.sources.find((item: { label: string }) => item.label === '采购付款')).toMatchObject({ state: 'RESTRICTED' })
  })

  it('到账核对：未登记、等待到账各有状态；列表里欧元与美元分开，不相加', async () => {
    const data = await ok(reader, '/finance/cashflow')
    const byId = Object.fromEntries(data.disbursements.items.map((row: { externalSettlementId: string; state: string }) => [row.externalSettlementId, row.state]))
    expect(byId).toEqual({ 'ST-3': 'AWAITING', 'ST-17': 'UNREGISTERED', 'ST-31': 'UNREGISTERED', 'ST-EU': 'UNREGISTERED' })
    expect(data.disbursements.summary).toMatchObject({ total: 4, unregistered: 3, awaiting: 1, matched: 0 })
    expect(data.disbursements.items.find((row: { externalSettlementId: string }) => row.externalSettlementId === 'ST-EU')).toMatchObject({ currency: 'EUR', expectedAmount: 90 })
  })

  it('登记到账：权限、校验、一致、改正（乐观锁）、冲突；审计与结算详情页都能看到', async () => {
    const stId = (await rows<{ id: string }>(`SELECT id FROM "FbaSettlement" WHERE "externalSettlementId" = 'ST-17'`))[0]!.id
    const body = { settlementId: stId, disbursedAt: dayOf(-13), amount: 480, currency: 'USD', bankLast4: '6789', note: '银行流水已核对' }
    expect((await confirm(reader, body)).status).toBe(403)
    expect((await confirm(noFinance, body)).status).toBe(403)
    expect((await confirm(finance, { ...body, amount: 0 })).status).toBe(422)
    expect((await confirm(finance, { ...body, disbursedAt: dayOf(3) })).status).toBe(422)
    expect((await confirm(finance, { ...body, settlementId: 'nope' })).status).toBe(404)
    expect((await confirm(scoped, body)).status).toBe(404)
    expect(await rows(`SELECT 1 FROM "Disbursement"`)).toHaveLength(0)

    const first = await confirm(finance, body)
    expect(first.status, JSON.stringify(first.json)).toBe(201)
    expect(first.json.data).toMatchObject({ version: 1, created: true, state: 'SHORT', diff: -20 })
    const saved = (
      await rows<{ amount: string; day: string; bankLast4: string; createdBy: string; sellerAccountId: string }>(`SELECT *, to_char("disbursedAt", 'YYYY-MM-DD') AS day FROM "Disbursement"`)
    )[0]!
    expect(saved).toMatchObject({ amount: '480.000000', bankLast4: '6789', createdBy: finance.userId, sellerAccountId: sellerId, day: dayOf(-13) })

    expect((await confirm(finance, body)).status).toBe(409)
    const fixed = await confirm(finance, { ...body, amount: 500, version: 1 })
    expect(fixed.status).toBe(201)
    expect(fixed.json.data).toMatchObject({ version: 2, created: false, state: 'MATCHED', diff: 0 })
    expect((await confirm(finance, { ...body, amount: 510, version: 1 })).status).toBe(409)
    expect(Number((await rows<{ amount: string }>(`SELECT amount FROM "Disbursement"`))[0]!.amount)).toBe(500)

    // 成功两次（新建、改正）；没有权限的两次请求也留了“拒绝”记录
    const audits = await rows<{ result: string; beforeJson: { amount: number } | null; afterJson: { amount: number } }>(
      `SELECT result, "beforeJson", "afterJson" FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'DISBURSEMENT_CONFIRMED' ORDER BY "occurredAt"`,
      [tenantId],
    )
    expect(audits.filter(item => item.result === 'DENIED')).toHaveLength(2)
    const succeeded = audits.filter(item => item.result === 'SUCCEEDED')
    expect(succeeded.map(item => [item.beforeJson?.amount ?? null, item.afterJson.amount])).toEqual([
      [null, 480],
      [480, 500],
    ])

    const data = await ok(finance, '/finance/cashflow')
    expect(data.canConfirm).toBe(true)
    const row = data.disbursements.items.find((item: { externalSettlementId: string }) => item.externalSettlementId === 'ST-17')
    expect(row).toMatchObject({ state: 'MATCHED', diff: 0, registered: { amount: 500, bankLast4: '6789', version: 2, createdBy: expect.any(String) } })
    expect(data.disbursements.summary).toMatchObject({ matched: 1, unregistered: 2 })

    const detail = await ok(reader, `/settlements/${stId}/disbursements`)
    expect(detail.items.map((item: { source: string }) => item.source)).toEqual(['REPORT', 'MANUAL'])
    expect(detail.items[1]).toMatchObject({ amount: 500, currency: 'USD', note: expect.stringContaining('6789') })
  })

  it('数据范围与企业隔离：收窄后只看得到自己店铺；别的企业看不到也登记不了', async () => {
    const mine = await ok(scoped, '/finance/cashflow')
    expect(mine.disbursements.items.map((row: { externalSettlementId: string }) => row.externalSettlementId)).toEqual(['ST-EU'])
    expect(mine.balances.items).toEqual([])
    expect(mine.deferral.totals).toEqual([])
    expect(mine.payout.stores).toEqual([])
    expect((await ok(scoped, '/finance/cashflow?currency=EUR')).payout.stores.map((store: { sellerAccountId: string }) => store.sellerAccountId)).toEqual([secondSellerId])
    const euId = (await rows<{ id: string }>(`SELECT id FROM "FbaSettlement" WHERE "externalSettlementId" = 'ST-EU'`))[0]!.id
    const done = await confirm(scoped, { settlementId: euId, disbursedAt: dayOf(-6), amount: 90, currency: 'EUR' })
    expect(done.status).toBe(201)
    expect(done.json.data).toMatchObject({ state: 'MATCHED' })

    const theirs = await ok(other, '/finance/cashflow')
    expect(theirs).toMatchObject({ state: 'NO_DATA' })
    expect(theirs.disbursements.items).toEqual([])
    const usId = (await rows<{ id: string }>(`SELECT id FROM "FbaSettlement" WHERE "externalSettlementId" = 'ST-3'`))[0]!.id
    expect((await confirm(other, { settlementId: usId, disbursedAt: dayOf(0), amount: 500, currency: 'USD' })).status).toBe(404)
    expect(otherSellerId).not.toBe(sellerId)
    expect(await rows(`SELECT 1 FROM "Disbursement" WHERE "tenantId" <> $1`, [tenantId])).toHaveLength(0)
  })
})
