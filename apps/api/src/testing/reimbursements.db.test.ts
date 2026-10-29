import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 赔付中心（P2b-03，真实数据库 + 完整应用 + 后台扫描代码）：
// 迁移升级与回滚、案件与赔付明细的检查约束；台账丢失与损坏的识别（找到的抵消、等待期内不识别、重复扫描不重复建）；
// 生成案件、状态流转（不能手工标已到账、版本冲突）、回填案件编号后赔付明细自动匹配并标已到账；证据包；数据范围与跨企业隔离；统计口径。

type Member = { userId: string; token: string }
type ScanTenant = (db: unknown, tenantId: string, now?: Date) => Promise<{ rules: Array<{ created: number }>; match: { matched: number; paid: number }; errors: string[] }>
const TARGET = '20261028010000_reimbursement_center'
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const dayAgo = (days: number) => ago(days).slice(0, 10)

describe('赔付中心表迁移（P2b-03）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('reimb_migrate')
    client = await db.connect('reimb_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean

  it('升级建三张表、回滚全部删除、再次升级闭环成功；规则、状态、金额与匹配依据由数据库约束', async () => {
    expect(await exists('ReimbursementCase')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of ['ReimbursementCase', 'ReimbursementRecord', 'EvidencePack']) expect(await exists(table)).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of ['ReimbursementCase', 'ReimbursementRecord', 'EvidencePack']) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'reimb-mig')
    let n = 0
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const kase = (over: Record<string, unknown>) =>
      insertRow(client, 'ReimbursementCase', { id: `rc-${++n}`, ...base, caseNo: `PC-${n}`, ruleCode: 'LEDGER_LOST', ownerId: ids.userId, evidenceRefsJson: '[]', ...over })
    expect(await kase({})).toMatchObject({ status: 'OPPORTUNITY', receivedAmount: '0.000000' })
    await expect(kase({ caseNo: 'PC-1' })).rejects.toMatchObject({ code: '23505' })
    await expect(kase({ ruleCode: 'MADE_UP' })).rejects.toMatchObject({ code: '23514' })
    await expect(kase({ status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(kase({ expectedAmount: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(kase({ receivedAmount: -1 })).rejects.toMatchObject({ code: '23514' })

    const record = (over: Record<string, unknown>) =>
      insertRow(client, 'ReimbursementRecord', { id: `rr-${++n}`, ...base, reimbursementId: 'R1', sku: 'A', amount: '10', currency: 'USD', approvedAt: new Date().toISOString(), ...over })
    expect(await record({})).toMatchObject({ matchedCaseId: null, matchBasis: null, fnsku: '' })
    await expect(record({})).rejects.toMatchObject({ code: '23505' })
    // 赔付冲回：金额可以为负；数量不能为负；匹配依据取值受限；匹配了案件必须有依据
    await record({ reimbursementId: 'R2', amount: '-5' })
    await expect(record({ reimbursementId: 'R3', quantity: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(record({ reimbursementId: 'R4', matchBasis: 'GUESS' })).rejects.toMatchObject({ code: '23514' })
    await expect(record({ reimbursementId: 'R5', matchedCaseId: 'rc-1' })).rejects.toMatchObject({ code: '23514' })
    await record({ reimbursementId: 'R6', matchedCaseId: 'rc-1', matchBasis: 'CASE_ID' })
  })
})

describe('赔付中心（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let secondSellerId: string
  let owner: Member
  let readOnly: Member
  let scoped: Member
  let other: Member
  let scoped_db: PrismaClient
  let scan: ScanTenant
  let seq = 0

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const runScan = (now = new Date()) => runWithTenant(tenantId, () => scan(scoped_db, tenantId, now))
  const ledger = (sku: string, days: number, quantity: number, reasonCode: string) =>
    insertRow(h.client, 'InventoryLedgerEntry', {
      id: `le-${++seq}`,
      tenantId,
      sellerAccountId,
      eventDate: dayAgo(days),
      fnsku: `X-${sku}`,
      sku,
      eventType: 'Adjustments',
      reasonCode,
      quantity,
      rowHash: `h-${seq}`,
      sourceUpdatedAt: ago(days),
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'reimbursements', db })
    const a = await h.createTenant('reimb-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-reimb-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-REIMB-2' })).id
    const b = await h.createTenant('reimb-b')
    owner = await h.createMember(tenantId, 'reimb-owner', ['*'])
    readOnly = await h.createMember(tenantId, 'reimb-readonly', ['reimbursements.read'])
    scoped = await h.createMember(tenantId, 'reimb-scoped', ['reimbursements.read', 'reimbursements.write'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'reimb-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('reimbursements', 'app') })
    scoped_db = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/reimbursements/run'))).scanTenant
    await ledger('SKU-L', 120, -3, 'Lost') // 过了等待期的丢失 → 机会
    await ledger('SKU-D', 100, -2, 'Damaged') // 过了等待期的损坏 → 机会
    await ledger('SKU-F', 120, -2, 'Lost')
    await ledger('SKU-F', 90, 2, 'Found') // 找到了：不是机会
    await ledger('SKU-W', 10, -1, 'Lost') // 还在等待期：不是机会
    void other
  })
  afterAll(async () => {
    await h?.close()
  })

  it('扫描：识别过了等待期的丢失与损坏，找到的抵消、等待期内的不识别；重复扫描不重复建', async () => {
    const first = await runScan()
    expect(first.errors).toEqual([])
    const found = await rows<{ ruleCode: string; sku: string; qty: number; status: string }>(
      `SELECT "ruleCode", "sku", "qty", "status" FROM "ReimbursementOpportunity" WHERE "tenantId" = $1 ORDER BY "sku"`,
      [tenantId],
    )
    expect(found).toEqual([
      { ruleCode: 'LEDGER_DAMAGED', sku: 'SKU-D', qty: 2, status: 'PENDING' },
      { ruleCode: 'LEDGER_LOST', sku: 'SKU-L', qty: 3, status: 'PENDING' },
    ])
    await runScan()
    expect((await rows(`SELECT 1 FROM "ReimbursementOpportunity" WHERE "tenantId" = $1`, [tenantId])).length).toBe(2)
  })

  it('机会列表：只给有读取权限的人；数据范围外的店铺看不到；其他企业看不到', async () => {
    const list = await ok(owner, 'GET', '/reimbursements/opportunities?status=PENDING')
    expect(list.items.map((item: { sku: string }) => item.sku).sort()).toEqual(['SKU-D', 'SKU-L'])
    expect(list.items[0]).toMatchObject({ connected: true, storeName: expect.any(String), estimatedAmount: null })
    expect((await call(readOnly, 'GET', '/reimbursements/opportunities')).status).toBe(200)
    expect((await ok(scoped, 'GET', '/reimbursements/opportunities')).items).toEqual([])
    expect((await ok(other, 'GET', '/reimbursements/opportunities')).items).toEqual([])
  })

  it('生成案件：没有商品成本要手填金额与币种；同一机会只能立一个案件；只读成员与范围外成员不能写', async () => {
    const opp = (await ok(owner, 'GET', '/reimbursements/opportunities?rule=LEDGER_LOST')).items[0]
    expect((await call(readOnly, 'POST', '/reimbursements', { opportunityId: opp.id })).status).toBe(403)
    expect((await call(scoped, 'POST', '/reimbursements', { opportunityId: opp.id })).status).toBeGreaterThanOrEqual(400)
    const created = await ok(owner, 'POST', '/reimbursements', { opportunityId: opp.id, expectedAmount: 30, currency: 'USD' })
    expect(created).toMatchObject({ caseNo: expect.stringMatching(/^PC-\d{8}-[A-Z0-9]{5}$/) })
    const again = await call(owner, 'POST', '/reimbursements', { opportunityId: opp.id, expectedAmount: 30, currency: 'USD' })
    expect(again.status).toBeGreaterThanOrEqual(400)
    expect((await rows<{ status: string }>(`SELECT "status" FROM "ReimbursementOpportunity" WHERE "id" = $1`, [opp.id]))[0].status).toBe('CASE_CREATED')
    const list = await ok(owner, 'GET', '/reimbursements?tab=pending')
    expect(list.items).toHaveLength(1)
    expect(list.items[0]).toMatchObject({ status: 'OPPORTUNITY', expectedAmount: 30, receivedAmount: 0, currency: 'USD', amazonCaseId: null })
    expect((await ok(other, 'GET', '/reimbursements')).items).toEqual([])
    expect((await call(other, 'GET', `/reimbursements/${created.id}`)).status).toBe(404)
  })

  it('状态流转：越级、手标已到账、缺批准金额被拒绝；版本过期提示刷新；提交后回填案件编号', async () => {
    const [kase] = (await ok(owner, 'GET', '/reimbursements?tab=pending')).items
    const patch = (body: Record<string, unknown>) => call(owner, 'PATCH', `/reimbursements/${kase.id}`, { version: kase.version, ...body })
    const paid = await patch({ status: 'PAID' })
    expect([paid.status, paid.json.error.code]).toEqual([409, 'DATA_CONDITION_FAILED'])
    const skipped = await patch({ status: 'APPROVED', approvedAmount: 30 })
    expect([skipped.status, skipped.json.error.code]).toEqual([409, 'DATA_CONDITION_FAILED'])
    const submitted = await ok(owner, 'PATCH', `/reimbursements/${kase.id}`, { version: kase.version, status: 'SUBMITTED', amazonCaseId: 'CASE-123' })
    expect(submitted).toMatchObject({ status: 'SUBMITTED', version: kase.version + 1 })
    const stale = await patch({ note: '过期版本' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).not.toBe('DATA_CONDITION_FAILED')
    const detail = await ok(owner, 'GET', `/reimbursements/${kase.id}`)
    expect(detail.case).toMatchObject({ status: 'SUBMITTED', amazonCaseId: 'CASE-123' })
    expect(detail.nextStatuses).toEqual(['IN_PROGRESS', 'APPROVED', 'PARTIAL', 'REJECTED'])
    expect(detail.supportCases.state).toBe('NOT_CONNECTED')
    expect((await rows(`SELECT 1 FROM "EntityEvent" WHERE "tenantId" = $1 AND "entityType" = 'REIMBURSEMENT_CASE' AND "entityId" = $2`, [tenantId, kase.id])).length).toBeGreaterThan(0)
  })

  it('官方赔付明细到账：按案件编号自动匹配，案件标已到账、实收只来自明细；未归属的明细保留；重复扫描不重复累加', async () => {
    const [kase] = (await ok(owner, 'GET', '/reimbursements?tab=processing')).items
    await insertRow(h.client, 'ReimbursementRecord', {
      id: 'rr-match',
      tenantId,
      sellerAccountId,
      reimbursementId: 'R-100',
      sku: 'SKU-L',
      fnsku: 'X-SKU-L',
      reason: 'Lost_Warehouse',
      quantity: 3,
      amount: '30',
      currency: 'USD',
      approvedAt: ago(1),
      amazonCaseId: 'case-123',
    })
    await insertRow(h.client, 'ReimbursementRecord', {
      id: 'rr-orphan',
      tenantId,
      sellerAccountId,
      reimbursementId: 'R-200',
      sku: 'SKU-OTHER',
      reason: 'Lost_Warehouse',
      quantity: 1,
      amount: '8',
      currency: 'USD',
      approvedAt: ago(1),
    })
    const result = await runScan()
    expect(result.errors).toEqual([])
    expect(result.match).toMatchObject({ matched: 1, paid: 1 })
    await runScan()
    const detail = await ok(owner, 'GET', `/reimbursements/${kase.id}`)
    expect(detail.case).toMatchObject({ status: 'PAID', receivedAmount: 30 })
    expect(detail.case.paidAt).not.toBeNull()
    expect(detail.records).toHaveLength(1)
    expect(detail.records[0]).toMatchObject({ reimbursementId: 'R-100', matchBasis: 'CASE_ID', matchBasisLabel: '案件编号一致' })
    expect((await rows<{ matchedCaseId: string | null }>(`SELECT "matchedCaseId" FROM "ReimbursementRecord" WHERE "id" = 'rr-orphan'`))[0].matchedCaseId).toBeNull()
    // 已到账的案件不能再手工改金额或状态
    const locked = await call(owner, 'PATCH', `/reimbursements/${kase.id}`, { version: detail.case.version, expectedAmount: 99 })
    expect([locked.status, locked.json.error.code]).toEqual([409, 'DATA_CONDITION_FAILED'])
  })

  it('统计：回收率按币种、未归属赔付、已到账平均时长、各类成功率；没有结论的类别成功率为空', async () => {
    const stats = await ok(owner, 'GET', '/reimbursements/stats')
    expect(stats.caseCounts.PAID).toBe(1)
    expect(stats.recovery).toEqual([{ currency: 'USD', expected: 30, received: 30, recoveryRate: 1, caseCount: 1 }])
    expect(stats.unmatched).toMatchObject({ count: 1, byCurrency: [{ currency: 'USD', amount: 8 }] })
    expect(stats.avgPayDays).not.toBeNull()
    const lost = stats.rules.find((item: { ruleCode: string }) => item.ruleCode === 'LEDGER_LOST')
    expect(lost).toMatchObject({ won: 1, rejected: 0, successRate: 1, connected: true })
    expect(stats.rules.find((item: { ruleCode: string }) => item.ruleCode === 'REMOVAL_LOST').successRate).toBeNull()
    expect(stats.rules.find((item: { ruleCode: string }) => item.ruleCode === 'FEE_OVERCHARGE').connected).toBe(true)
    expect(stats.windowsDefault).toBe(true)
  })

  it('证据包：清单先落库，再建导出任务；只读成员不能生成；其他企业不能生成', async () => {
    const [kase] = (await ok(owner, 'GET', '/reimbursements?tab=paid')).items
    expect((await call(readOnly, 'POST', `/reimbursements/${kase.id}/evidence-pack`, {})).status).toBe(403)
    expect((await call(other, 'POST', `/reimbursements/${kase.id}/evidence-pack`, {})).status).toBe(404)
    const pack = await ok(owner, 'POST', `/reimbursements/${kase.id}/evidence-pack`, {})
    expect(pack.lineCount).toBeGreaterThan(5)
    const stored = await rows<{ exportJobId: string | null; lineCount: number }>(`SELECT "exportJobId", "lineCount" FROM "EvidencePack" WHERE "id" = $1`, [pack.packId])
    expect(stored[0]).toMatchObject({ exportJobId: pack.exportJobId, lineCount: pack.lineCount })
    expect((await rows<{ kind: string }>(`SELECT "kind" FROM "ExportJob" WHERE "id" = $1`, [pack.exportJobId]))[0].kind).toBe('reimbursement-evidence')
    const detail = await ok(owner, 'GET', `/reimbursements/${kase.id}`)
    expect(detail.packs).toHaveLength(1)
    expect(detail.packs[0]).toMatchObject({ id: pack.packId, lineCount: pack.lineCount, downloadable: false })
  })
})
