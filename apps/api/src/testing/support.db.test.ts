import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 支持案件（P2b-04，真实数据库 + 完整应用 + 后台同步器代码）：
// 迁移升级与回滚、检查约束与唯一键；用官方格式样例走一遍同步器（租户行级隔离下写入、重复同步幂等）；
// 列表与详情（筛选、游标、沟通从早到晚、不含邮箱电话）；数据范围与跨企业隔离；与赔付案件按亚马逊案件编号关联；受限角色未获批的状态。

type Member = { userId: string; token: string }
const TARGET = '20261029010000_support_cases'
const FIXTURES = join(__dirname, '../../../worker/fixtures/support')
const json = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8')) as Record<string, unknown>
const SYNC_AT = new Date('2026-10-25T08:00:00Z')

describe('支持案件表迁移（P2b-04）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('support_migrate')
    client = await db.connect('support_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean

  it('升级建两张表、回滚全部删除、再次升级闭环成功；沟通条数与沟通方向由数据库约束，案件与沟通各有唯一键', async () => {
    expect(await exists('SupportCase')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of ['SupportCase', 'SupportContact']) expect(await exists(table)).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of ['SupportCase', 'SupportContact']) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'sup-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const when = '2026-10-20T00:00:00.000Z'
    const kase = (over: Record<string, unknown>) =>
      insertRow(client, 'SupportCase', { id: 'sc-1', ...base, caseId: '100', subject: 's', status: 'RESOLVED', amazonCreatedAt: when, amazonUpdatedAt: when, ...over })
    expect(await kase({})).toMatchObject({ contactCount: 0, contactsForUpdatedAt: null, appointmentsJson: [] })
    await expect(kase({ id: 'sc-2' })).rejects.toMatchObject({ code: '23505' }) // 同店铺同案件编号
    await expect(kase({ id: 'sc-3', caseId: '101', contactCount: -1 })).rejects.toMatchObject({ code: '23514' })
    // 亚马逊以后新增状态值时不能让同步写不进去：状态不加检查约束
    await kase({ id: 'sc-4', caseId: '102', status: 'SOMETHING_NEW' })

    const contact = (over: Record<string, unknown>) => insertRow(client, 'SupportContact', { id: 'k-1', ...base, supportCaseId: 'sc-1', contactId: 'c1', channel: 'EMAIL', occurredAt: when, ...over })
    expect(await contact({})).toMatchObject({ direction: 'UNKNOWN', body: '', attachmentsJson: [] })
    await expect(contact({ id: 'k-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(contact({ id: 'k-3', contactId: 'c3', direction: 'SIDEWAYS' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('支持案件（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let secondSellerId: string
  let owner: Member
  let reader: Member
  let noSupport: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  let sync: (ctx: unknown, api: unknown, scope: { tenantId: string; sellerAccountId: string }, options?: { now?: Date }) => Promise<Record<string, unknown>>

  const call = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await call(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const fakeApi = (cases: Record<string, unknown>, contacts: Record<string, unknown>) => ({ listCases: async () => cases, listContacts: async () => contacts })
  const runSync = (api: unknown, sellerId = sellerAccountId) =>
    runWithTenant(tenantId, () =>
      sync({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }, api, { tenantId, sellerAccountId: sellerId }, { now: SYNC_AT }),
    )
  const firstPage = () => ({ ...json('cases.json'), nextToken: undefined })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'support', db })
    const a = await h.createTenant('sup-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-sup-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-SUP-2' })).id
    const b = await h.createTenant('sup-b')
    owner = await h.createMember(tenantId, 'sup-owner', ['*'])
    reader = await h.createMember(tenantId, 'sup-reader', ['support.read', 'reimbursements.read'])
    noSupport = await h.createMember(tenantId, 'sup-none', ['reimbursements.read'])
    scoped = await h.createMember(tenantId, 'sup-scoped', ['support.read'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'sup-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('support', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    sync = (await import(/* @vite-ignore */ String('../../../worker/src/importers/support/sync'))).syncSupportCases
  })
  afterAll(async () => {
    await h?.close()
  })

  it('同步器：在行级隔离的租户连接下写入案件与沟通；重复同步不重复写、不重复取沟通', async () => {
    const api = fakeApi(firstPage(), json('contacts.json'))
    const first = await runSync(api)
    expect(first).toMatchObject({ cases: 2, changed: 2, contactCases: 2, contacts: 8, skipped: 1, incomplete: false })
    expect((await rows(`SELECT 1 FROM "SupportCase" WHERE "tenantId" = $1`, [tenantId])).length).toBe(2)
    expect((await rows(`SELECT 1 FROM "SupportContact" WHERE "tenantId" = $1`, [tenantId])).length).toBe(8)
    const again = await runSync(api)
    expect(again).toMatchObject({ changed: 0, contactCases: 0, contacts: 0 })
    expect((await rows(`SELECT 1 FROM "SupportContact" WHERE "tenantId" = $1`, [tenantId])).length).toBe(8)
    const [stored] = await rows<{ contactCount: number; appointmentsJson: unknown }>(`SELECT "contactCount", "appointmentsJson" FROM "SupportCase" WHERE "caseId" = '9876543210'`)
    expect(stored.contactCount).toBe(4)
    expect(JSON.stringify(stored.appointmentsJson)).not.toMatch(/555 0100/)
  })

  it('列表：按最近更新新到旧；状态与关键词筛选；游标翻页不重复不遗漏；沟通条数来自已同步的记录', async () => {
    const list = await ok(owner, '/support-cases')
    expect(list.state).toBe('OK')
    expect(list.items.map((item: { caseId: string }) => item.caseId)).toEqual(['9876543210', '9876543211'])
    expect(list.items[0]).toMatchObject({ statusLabel: '等待亚马逊处理', contactCount: 4, subject: '货件 FBA15ABCDE 少收 12 件' })
    expect(list.items[1]).toMatchObject({ statusLabel: '已解决', subject: '（无主题）' })
    expect((await ok(owner, '/support-cases?status=RESOLVED')).items).toHaveLength(1)
    expect((await ok(owner, '/support-cases?q=fba15')).items.map((item: { caseId: string }) => item.caseId)).toEqual(['9876543210'])
    expect((await ok(owner, '/support-cases?q=98765432')).items).toHaveLength(2)
    expect((await ok(owner, '/support-cases?status=TRANSFERRED')).items).toEqual([])
    const page1 = await ok(owner, '/support-cases?pageSize=1')
    expect(page1.pageInfo.hasMore).toBe(true)
    const page2 = await ok(owner, `/support-cases?pageSize=1&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect([page1.items[0].caseId, page2.items[0].caseId]).toEqual(['9876543210', '9876543211'])
    expect(page2.pageInfo.hasMore).toBe(false)
  })

  it('详情：沟通从早到晚、附件只有名称、预约回电只有时间窗；返回里没有邮箱与电话号码；按系统编号或案件编号都能找', async () => {
    const [{ id }] = await rows<{ id: string }>(`SELECT "id" FROM "SupportCase" WHERE "caseId" = '9876543210'`)
    const detail = await ok(owner, `/support-cases/${id}`)
    expect(detail.contacts.map((item: { contactId: string }) => item.contactId)).toEqual(['ct-1', 'ct-2', 'ct-3', 'ct-4'])
    expect(detail.contacts[0]).toMatchObject({ directionLabel: '亚马逊', channelLabel: '邮件', attachments: ['照片.png'] })
    expect(detail.contacts[3].body).toBe('客服：您好\n我方：你好')
    expect(detail.appointments).toHaveLength(1)
    expect(detail.contactsState).toBe('OK')
    expect(JSON.stringify(detail)).not.toMatch(/example\.com|555 0100|expires-in-15-min/)
    expect((await ok(owner, '/support-cases/9876543210')).case.id).toBe(id)
    expect((await call(owner, '/support-cases/not-there')).status).toBe(404)
  })

  it('权限与范围：没有 support.read 403；范围外的店铺看不到列表与详情；其他企业看不到', async () => {
    expect((await call(noSupport, '/support-cases')).status).toBe(403)
    const [{ id }] = await rows<{ id: string }>(`SELECT "id" FROM "SupportCase" WHERE "caseId" = '9876543210'`)
    expect((await call(noSupport, `/support-cases/${id}`)).status).toBe(403)
    expect((await ok(scoped, '/support-cases')).items).toEqual([])
    expect((await call(scoped, `/support-cases/${id}`)).status).toBe(404)
    expect((await ok(other, '/support-cases')).items).toEqual([])
    expect((await call(other, `/support-cases/${id}`)).status).toBe(404)
    // 行级隔离：别的企业的租户连接直接查表也看不到
    expect(await runWithTenant('tenant-sup-b', () => tenantDb.supportCase.count())).toBe(0)
  })

  it('没有案件的店铺：没同步过写“尚未同步”；同步器记了受限角色未获批就给申请方式；同步正常写“尚无记录”', async () => {
    expect((await ok(scoped, '/support-cases')).state).toBe('NOT_CONNECTED')
    await insertRow(h.client, 'DataFreshness', {
      id: 'df-sup-2',
      tenantId,
      sellerAccountId: secondSellerId,
      sourceKey: 'support.api',
      lastAttemptAt: new Date().toISOString(),
      status: 'UNAUTHORIZED',
      lastErrorCode: 'SUP_ROLE_PENDING',
    })
    const pending = await ok(scoped, '/support-cases')
    expect(pending).toMatchObject({ state: 'ROLE_PENDING', sync: { rolePending: true, status: 'UNAUTHORIZED' } })
    expect(pending.note).toContain('Selling Partner Support')
    await h.client.query(`UPDATE "DataFreshness" SET "status" = 'NORMAL', "lastErrorCode" = NULL, "lastSuccessAt" = now() WHERE "id" = 'df-sup-2'`)
    const normal = await ok(scoped, '/support-cases')
    expect(normal.state).toBe('NO_DATA')
    expect(normal.note).toContain('尚无记录')
  })

  it('与赔付案件关联：回填的亚马逊案件编号一致就在列表、详情与赔付案件详情里互相关联；没回填写原因', async () => {
    const reimbursement = (id: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'ReimbursementCase', { id, tenantId, sellerAccountId, caseNo: `PC-${id}`, ruleCode: 'LEDGER_LOST', ownerId: owner.userId, evidenceRefsJson: '[]', ...over })
    await reimbursement('rc-linked', { amazonCaseId: '9876543210', status: 'SUBMITTED' })
    await reimbursement('rc-missing', { amazonCaseId: '5550001' })
    await reimbursement('rc-blank', {})
    const list = await ok(reader, '/support-cases')
    expect(list.items[0]).toMatchObject({ reimbursementCaseId: 'rc-linked', reimbursementCaseNo: 'PC-rc-linked' })
    expect(list.items[1].reimbursementCaseId).toBeNull()
    const detail = await ok(reader, `/support-cases/${list.items[0].id}`)
    expect(detail.links.reimbursement).toEqual({ id: 'rc-linked', caseNo: 'PC-rc-linked', statusLabel: '已提交' })
    const linked = (await ok(reader, '/reimbursements/rc-linked')).supportCases
    expect(linked.state).toBe('OK')
    expect(linked.case).toMatchObject({ caseId: '9876543210', reimbursementCaseNo: 'PC-rc-linked' })
    expect(linked.contacts).toHaveLength(4)
    expect(linked.contacts[3].body).toBe('客服：您好\n我方：你好') // 最近的在最后
    expect((await ok(reader, '/reimbursements/rc-blank')).supportCases.state).toBe('NO_ID')
    // 编号没同步到：店铺的同步状态没有成功记录，不能说“没有这个案件”
    expect((await ok(reader, '/reimbursements/rc-missing')).supportCases.state).toBe('NOT_CONNECTED')
    await insertRow(h.client, 'DataFreshness', {
      id: 'df-sup-1',
      tenantId,
      sellerAccountId,
      sourceKey: 'support.api',
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: new Date().toISOString(),
      status: 'NORMAL',
    })
    expect((await ok(reader, '/reimbursements/rc-missing')).supportCases.state).toBe('NOT_FOUND')
    // 只有赔付读取权限、没有支持案件读取权限：受限，不给内容
    const restricted = (await ok(noSupport, '/reimbursements/rc-linked')).supportCases
    expect(restricted.state).toBe('RESTRICTED')
    expect(JSON.stringify(restricted)).not.toContain('9876543210')
  })

  it('案件有更新：同步后案件与状态更新、新沟通追加，旧沟通不重复', async () => {
    const changed = firstPage() as unknown as { cases: Array<Record<string, unknown>> }
    changed.cases[0] = { ...changed.cases[0], status: 'RESOLVED', lastUpdatedDate: '2026-10-25T01:00:00Z', resolvedDate: '2026-10-25T01:00:00Z' }
    const contacts = json('contacts.json') as { contacts: Array<Record<string, unknown>> }
    const more = { contacts: [...contacts.contacts, { contactId: 'ct-6', channel: 'EMAIL', createdDate: '2026-10-25T01:00:00Z', emailContent: { sender: { role: 'AMAZON' }, message: '已解决' } }] }
    const result = await runSync(fakeApi(changed, more))
    expect(result).toMatchObject({ changed: 1, contactCases: 1, contacts: 1 })
    const detail = await ok(owner, '/support-cases/9876543210')
    expect(detail.case).toMatchObject({ status: 'RESOLVED', statusLabel: '已解决', contactCount: 5 })
    expect(detail.contacts.at(-1)).toMatchObject({ contactId: 'ct-6', body: '已解决' })
    expect(detail.contacts).toHaveLength(5)
  })
})
