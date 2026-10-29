import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keyring, createMasterKeyProvider, prismaKeyStore } from '@nova/crypto'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { Prisma, PrismaClient } from '@prisma/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SystemPrismaService } from '../platform/prisma.service'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { registerPiiSentinel } from './pii-response-guard'
import { startTestDatabase, type TestDatabase } from './test-database'

// 个人信息统一出口（P6-14，真实数据库 + 完整应用 + worker 的写入与清理代码）：
// 403（缺权限）、422（请求不合格）、审计完整且不含明文、跨企业与范围外 404、过期与未同步的如实说明；
// 其他读接口只给掩码（登记了明文哨兵，任何响应里出现明文都会让测试失败）；
// 迁移与回滚、存量加密、到期清理、导入写密文、明文列删除脚本的检查。

const TARGET = '20261216010000_return_comment_cipher'
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const later = (days: number) => new Date(Date.now() + days * DAY).toISOString()

const BUYER = { buyerName: 'Alice Pii Buyer', buyerEmail: 'alice.pii@example.com', addressLine1: '1 Pii Street', city: 'Pii City', state: 'WA', postalCode: '98101', country: 'US' }
const COMMENT = 'comment-secret-ZZ 联系 13912345678'
const SUPPORT_BODY = 'Please ship to 77 Pii Lane or call 13987654321'
const LEGACY = 'legacy-secret-comment 13711112222'
const IMPORTED = 'imported-secret-comment 13633334444 or imp@example.org'
// 明文哨兵：之后 call 经过的每个非 /pii/reveal 响应里出现它们都会直接失败（统一守卫）
registerPiiSentinel(
  BUYER.buyerName,
  BUYER.buyerEmail,
  BUYER.addressLine1,
  'comment-secret-ZZ',
  '13912345678',
  SUPPORT_BODY,
  '77 Pii Lane',
  '13987654321',
  LEGACY,
  'legacy-secret-comment',
  'imported-secret-comment',
  'imp@example.org',
)

type Member = { userId: string; token: string }
const RETURN_FIELDS = ['customerComments']
const ORDER_FIELDS = ['buyerName', 'buyerEmail', 'buyerPhone', 'addressLine1', 'city', 'state', 'postalCode', 'country']

describe('个人信息统一出口（P6-14，真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：新增加密列，可回滚、可再次升级；明文列删除脚本带检查', () => {
    it('升级保留旧备注明文（不改动）；三个新列与索引存在；回滚后新列与索引消失、明文仍在；可再次升级', async () => {
      await db.createDatabase('pii_upgrade')
      const client = await db.connect('pii_upgrade')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedBasic(client, 'u')
        await insertRow(client, 'FbaReturnCase', {
          id: 'old',
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          amazonOrderId: '111-1',
          asin: 'B1',
          sellerSku: 'S1',
          returnDate: ago(3),
          customerComments: 'old plain',
        })
        await applyMigrations(client, { only: TARGET })
        const row = (await client.query(`SELECT "customerComments", "customerCommentsCipher", "customerCommentsExpiresAt", "customerCommentsKinds" FROM "FbaReturnCase" WHERE id = 'old'`)).rows[0]
        expect(row).toEqual({ customerComments: 'old plain', customerCommentsCipher: null, customerCommentsExpiresAt: null, customerCommentsKinds: null })
        const index = async () => (await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'FbaReturnCase_commentexp_idx'`)).rows.length
        expect(await index()).toBe(1)

        await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
        const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaReturnCase' AND column_name LIKE 'customerComments%' ORDER BY 1`)).rows.map(
          item => item.column_name,
        )
        expect(columns).toEqual(['customerComments'])
        expect(await index()).toBe(0)
        expect((await client.query(`SELECT "customerComments" FROM "FbaReturnCase" WHERE id = 'old'`)).rows[0].customerComments).toBe('old plain')

        await applyMigrations(client, { only: TARGET })
        expect(await index()).toBe(1)
      } finally {
        await client.end()
      }
    })

    it('明文列删除脚本：还有未加密的行就拒绝；清空后才删除；重复执行无副作用；删除后加入列可回滚结构', async () => {
      await db.createDatabase('pii_drop')
      db.migrate('pii_drop')
      const client = await db.connect('pii_drop')
      try {
        const script = readFileSync(join(MIGRATIONS_DIR, '..', '..', 'ops', 'drop-return-comment-plaintext.sql'), 'utf8')
        const ids = await seedBasic(client, 'd')
        await insertRow(client, 'FbaReturnCase', {
          id: 'plain',
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          amazonOrderId: '111-1',
          asin: 'B1',
          sellerSku: 'S1',
          returnDate: ago(3),
          customerComments: 'still plain',
        })
        await expect(client.query(script)).rejects.toThrow(/还有 1 行退货备注没有加密/)
        const stillThere = async () => (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_name = 'FbaReturnCase' AND column_name = 'customerComments'`)).rows.length
        expect(await stillThere()).toBe(1)
        await client.query(`UPDATE "FbaReturnCase" SET "customerComments" = NULL`)
        await client.query(script)
        expect(await stillThere()).toBe(0)
        await client.query(script) // 重复执行：列已不存在，什么也不做
        // 回滚说明：加回列（内容不会回来）
        await client.query(`ALTER TABLE "FbaReturnCase" ADD COLUMN "customerComments" TEXT`)
        expect(await stillThere()).toBe(1)
      } finally {
        await client.end()
      }
    })
  })

  describe('接口', () => {
    let h: DbTestApp
    let system: PrismaClient
    let tenantDb: PrismaClient
    let base: PrismaClient
    let a: Awaited<ReturnType<DbTestApp['createTenant']>>
    let b: Awaited<ReturnType<DbTestApp['createTenant']>>
    let full: Member
    let noBuyer: Member
    let onlyBuyer: Member
    let scoped: Member
    let other: Member
    let sealText: (text: string) => Promise<string>
    let secrets: { sealBuyerPii(text: string): Promise<string> }
    let commentCipher = ''

    const reveal = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/pii/reveal', { body })
    const order = (id: string, no: string, tenantId: string, sellerAccountId: string, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'Order', { id, tenantId, sellerAccountId, amazonOrderId: no, purchaseDate: ago(5), status: 'Shipped', fulfillmentStatus: 'Shipped', currency: 'USD', amount: 10, ...extra })
    const returned = (id: string, tenantId: string, sellerAccountId: string, no: string, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'FbaReturnCase', { id, tenantId, sellerAccountId, amazonOrderId: no, asin: 'B000000001', sellerSku: 'SKU-1', quantity: 1, returnDate: ago(4), ...extra })
    const audits = async () => (await h.client.query(`SELECT * FROM "AuditEvent" WHERE action = 'PII_REVEALED' ORDER BY "occurredAt", id`)).rows
    const rowOf = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows[0]

    beforeAll(async () => {
      h = await createDbTestApp({ database: 'pii_api', db })
      a = await h.createTenant('pii-a')
      b = await h.createTenant('pii-b')
      await insertRow(h.client, 'SellerAccount', { id: 'seller-pii-a2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PII-A2' })
      const all = ['orders.read', 'returns.read', 'support.read', 'field.buyer']
      full = await h.createMember(a.tenantId, 'pii-full', all)
      noBuyer = await h.createMember(a.tenantId, 'pii-nobuyer', ['orders.read', 'returns.read', 'support.read'])
      onlyBuyer = await h.createMember(a.tenantId, 'pii-onlybuyer', ['field.buyer'])
      scoped = await h.createMember(a.tenantId, 'pii-scoped', all, { scopes: [{ sellerAccountId: 'seller-pii-a2' }] })
      other = await h.createMember(b.tenantId, 'pii-other', all)

      system = h.app.get(SystemPrismaService) as unknown as PrismaClient
      const { provider, legacyRoot } = createMasterKeyProvider(process.env)
      const keyring = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: provider, legacyRoot, cacheTtlMs: 0 })
      sealText = async text => (await keyring.seal('buyer-pii', text)).ciphertext
      secrets = { sealBuyerPii: sealText }
      base = new PrismaClient({ datasourceUrl: db.urlFor('pii_api', 'app') })
      tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient

      const sealedBuyer = await sealText(JSON.stringify(BUYER))
      commentCipher = await sealText(COMMENT)
      // 订单：ord-1 有买家信息；ord-2 没同步过；ord-3 已过保留期但后台任务还没清除
      await order('ord-1', '111-PII-0000001', a.tenantId, a.sellerAccountId, { piiCiphertext: sealedBuyer, piiExpiresAt: later(20) })
      await order('ord-2', '111-PII-0000002', a.tenantId, a.sellerAccountId)
      await order('ord-3', '111-PII-0000003', a.tenantId, a.sellerAccountId, { piiCiphertext: sealedBuyer, piiExpiresAt: ago(1) })
      await order('ord-b', '111-PII-00000B1', b.tenantId, b.sellerAccountId, { piiCiphertext: sealedBuyer, piiExpiresAt: later(20) })
      // 退货：ret-1 有备注（含电话）；ret-2 没有；ret-3 已过保留期但还没清除；ret-b 别的企业
      await returned('ret-1', a.tenantId, a.sellerAccountId, '111-PII-0000001', { customerCommentsCipher: commentCipher, customerCommentsExpiresAt: later(10), customerCommentsKinds: 'PHONE' })
      await returned('ret-2', a.tenantId, a.sellerAccountId, '111-PII-0000002', { asin: 'B000000002' })
      await returned('ret-3', a.tenantId, a.sellerAccountId, '111-PII-0000003', {
        asin: 'B000000003',
        customerCommentsCipher: commentCipher,
        customerCommentsExpiresAt: ago(1),
        customerCommentsKinds: 'PHONE',
      })
      await returned('ret-b', b.tenantId, b.sellerAccountId, '111-PII-00000B1', { customerCommentsCipher: commentCipher, customerCommentsExpiresAt: later(10), customerCommentsKinds: 'PHONE' })
      // 支持案件：正文按原文保存
      for (const [caseRowId, tenantId, store, caseNo, contactId] of [
        ['sc-1', a.tenantId, a.sellerAccountId, '9001', 'ct-1'],
        ['sc-b', b.tenantId, b.sellerAccountId, '9002', 'ct-b'],
      ] as const) {
        await insertRow(h.client, 'SupportCase', {
          id: caseRowId,
          tenantId,
          sellerAccountId: store,
          caseId: caseNo,
          subject: 'Where is my order',
          status: 'OPEN',
          amazonCreatedAt: ago(2),
          amazonUpdatedAt: ago(1),
          contactsForUpdatedAt: ago(1),
          contactCount: 1,
        })
        await insertRow(h.client, 'SupportContact', {
          id: contactId,
          tenantId,
          sellerAccountId: store,
          supportCaseId: caseRowId,
          contactId: `${contactId}-x`,
          channel: 'EMAIL',
          direction: 'FROM_AMAZON',
          body: SUPPORT_BODY,
          occurredAt: ago(1),
        })
      }
    })
    afterAll(async () => {
      await base?.$disconnect()
      await h?.close()
    })

    const orderBody = (objectId: string, fields = ORDER_FIELDS) => ({ objectType: 'ORDER', objectId, fields, reason: '客户来电核对收货地址' })
    const returnBody = (objectId: string) => ({ objectType: 'RETURN', objectId, fields: RETURN_FIELDS, reason: '核对退货原因' })
    const supportBody = (objectId: string) => ({ objectType: 'SUPPORT_CONTACT', objectId, fields: ['body'], reason: '核对客户诉求' })

    it('没有 field.buyer：三类对象都是 403，不留成功审计；只有 field.buyer 没有对象读权限也是 403', async () => {
      for (const body of [orderBody('ord-1'), returnBody('ret-1'), supportBody('ct-1')]) {
        expect((await reveal(noBuyer, body)).status, body.objectType).toBe(403)
        expect((await reveal(onlyBuyer, body)).status, body.objectType).toBe(403)
      }
      const rows = await audits()
      expect(rows.filter(row => row.result === 'SUCCEEDED')).toHaveLength(0)
      const denied = rows.filter(row => row.result === 'DENIED')
      expect(denied.length).toBeGreaterThanOrEqual(3)
      expect(denied[0]).toMatchObject({ tenantId: a.tenantId, actorId: noBuyer.userId, resourceType: 'PiiObject' })
      expect((await h.call(null, 'POST', '/pii/reveal', { body: orderBody('ord-1') })).status).toBe(401)
    })

    it('请求不合格：422（理由为空或太短、字段为空或重复或不属于该对象、多余字段、对象类型与编号不合格），不留成功审计', async () => {
      const bad: Array<Record<string, unknown>> = [
        {},
        { ...orderBody('ord-1'), reason: '' },
        { ...orderBody('ord-1'), reason: '   ' },
        { ...orderBody('ord-1'), reason: '好' },
        { ...orderBody('ord-1'), fields: [] },
        { ...orderBody('ord-1'), fields: ['buyerName', 'buyerName'] },
        { ...orderBody('ord-1'), fields: ['customerComments'] },
        { ...returnBody('ret-1'), fields: ['buyerName'] },
        { ...orderBody('ord-1'), objectType: 'SUPPLIER' },
        { ...orderBody('ord-1'), objectId: 'bad id' },
        { ...orderBody('ord-1'), extra: true },
      ]
      for (const body of bad) expect((await reveal(full, body)).status, JSON.stringify(body)).toBe(422)
      expect((await audits()).filter(row => row.result === 'SUCCEEDED')).toHaveLength(0)
    })

    it('订单：解密返回；审计完整（企业、操作人、对象、理由、结果、请求编号、字段名）且不含明文；幂等记录与存储的密文里也没有明文', async () => {
      const res = await reveal(full, orderBody('ord-1'))
      expect(res.status).toBe(200)
      expect(res.json.data).toMatchObject({ objectType: 'ORDER', objectId: 'ord-1', state: 'OK', note: null, values: { ...BUYER, buyerPhone: null } })
      expect(new Date(res.json.data.expiresAt).getTime()).toBeLessThanOrEqual(Date.now() + 61_000)
      const rows = (await audits()).filter(row => row.result === 'SUCCEEDED')
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        tenantId: a.tenantId,
        actorId: full.userId,
        action: 'PII_REVEALED',
        resourceType: 'Order',
        resourceId: 'ord-1',
        reason: '客户来电核对收货地址',
        result: 'SUCCEEDED',
        source: 'API',
      })
      expect(rows[0].requestId).toBeTruthy()
      expect(rows[0].detail).toMatchObject({ amazonOrderId: '111-PII-0000001', outcome: 'OK', objectType: 'ORDER' })
      expect(rows[0].detail.fields).toEqual(expect.arrayContaining(['buyerName', 'buyerEmail', 'addressLine1', 'city', 'country']))
      expect(rows[0].detail.fields).not.toContain('buyerPhone')
      // 邮编按完整数字匹配，避免请求号十六进制子串（如 45198101）被当成明文。
      const noPlaintext = /Alice|alice\.pii|Pii Street|Pii City|\b98101\b/
      expect(JSON.stringify(rows)).not.toMatch(noPlaintext)
      expect(JSON.stringify((await h.client.query(`SELECT * FROM "IdempotencyRecord"`)).rows)).not.toMatch(noPlaintext)
      expect((await rowOf(`SELECT "piiCiphertext" FROM "Order" WHERE id = 'ord-1'`)).piiCiphertext).not.toMatch(noPlaintext)
      // 亚马逊订单号也能定位
      expect((await reveal(full, orderBody('111-PII-0000001', ['buyerName']))).json.data.values).toEqual({ buyerName: BUYER.buyerName })
    })

    it('退货备注与支持案件正文：同一出口、同样的审计规则；备注在库里只有密文', async () => {
      const ret = await reveal(full, returnBody('ret-1'))
      expect(ret.status).toBe(200)
      expect(ret.json.data).toMatchObject({ state: 'OK', values: { customerComments: COMMENT } })
      expect(new Date(ret.json.data.retainedUntil).getTime()).toBeGreaterThan(Date.now())
      const sup = await reveal(full, supportBody('ct-1'))
      expect(sup.json.data).toMatchObject({ state: 'OK', values: { body: SUPPORT_BODY }, retainedUntil: null })
      const rows = (await audits()).filter(row => row.result === 'SUCCEEDED' && row.resourceType !== 'Order')
      expect(rows.map(row => row.resourceType).sort()).toEqual(['FbaReturnCase', 'SupportContact'])
      expect(rows.find(row => row.resourceType === 'FbaReturnCase')).toMatchObject({ resourceId: 'ret-1', actorId: full.userId, reason: '核对退货原因' })
      expect(rows.find(row => row.resourceType === 'SupportContact')?.detail).toMatchObject({ caseId: '9001', fields: ['body'] })
      expect(JSON.stringify(rows)).not.toMatch(/comment-secret|13912345678|Pii Lane|13987654321/)
      expect((await rowOf(`SELECT "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = 'ret-1'`)).customerCommentsCipher).not.toMatch(/comment-secret|13912345678/)
    })

    it('跨企业与范围外：别的企业的编号、范围外店铺的对象一律 404，不泄露存在；也不返回任何内容', async () => {
      for (const body of [orderBody('ord-b'), orderBody('111-PII-00000B1'), returnBody('ret-b'), supportBody('ct-b')]) {
        const res = await reveal(full, body)
        expect(res.status, JSON.stringify(body)).toBe(404)
        expect(JSON.stringify(res.json)).not.toMatch(/Alice|comment-secret|Pii Lane/)
      }
      for (const body of [orderBody('ord-1'), returnBody('ret-1'), supportBody('ct-1')]) expect((await reveal(other, body)).status, `other ${body.objectType}`).toBe(404)
      for (const body of [orderBody('ord-1'), returnBody('ret-1'), supportBody('ct-1')]) expect((await reveal(scoped, body)).status, `scoped ${body.objectType}`).toBe(404)
      // 自己企业的仍然可看
      expect((await reveal(other, orderBody('ord-b', ['buyerName']))).json.data.values).toEqual({ buyerName: BUYER.buyerName })
    })

    it('没有内容、已过保留期：如实说明，不返回空壳，仍留审计（结果写在详情里）', async () => {
      const before = (await audits()).filter(row => row.result === 'SUCCEEDED').length
      const cases: Array<[Record<string, unknown>, string]> = [
        [orderBody('ord-2'), 'NOT_SYNCED'],
        [orderBody('ord-3'), 'EXPIRED'],
        [returnBody('ret-2'), 'NOT_SYNCED'],
        [returnBody('ret-3'), 'EXPIRED'],
      ]
      for (const [body, state] of cases) {
        const res = await reveal(full, body)
        expect(res.status, JSON.stringify(body)).toBe(200)
        expect(res.json.data, JSON.stringify(body)).toMatchObject({ state, values: {}, expiresAt: null })
        expect(res.json.data.note).toEqual(expect.any(String))
      }
      const rows = (await audits()).filter(row => row.result === 'SUCCEEDED')
      expect(rows.length).toBe(before + 4)
      expect(rows.slice(-4).map(row => row.detail.outcome)).toEqual(['NOT_SYNCED', 'EXPIRED', 'NOT_SYNCED', 'EXPIRED'])
    })

    it('其他读接口只给掩码：支持案件正文掩码并带类别；退货详情只给状态与类别；列表与订单各页签没有任何明文（哨兵守卫）', async () => {
      const detail = (await h.call(full.token, 'GET', '/support-cases/sc-1')).json.data
      expect(detail.contacts[0].body).toBe('Please ship to [地址已隐藏] or call [电话已隐藏]')
      expect(detail.contacts[0].piiKinds).toEqual(['PHONE', 'ADDRESS'])
      const comment = async (id: string) => (await h.call(full.token, 'GET', `/returns/${id}`)).json.data.buyerComments
      expect(await comment('ret-1')).toMatchObject({ state: 'AVAILABLE', kinds: ['PHONE'] })
      expect(await comment('ret-2')).toEqual({ state: 'NONE', kinds: [], retainedUntil: null })
      expect(await comment('ret-3')).toMatchObject({ state: 'EXPIRED', kinds: [] })
      for (const path of [
        '/returns',
        '/support-cases',
        `/orders?from=${ago(20).slice(0, 10)}&to=${later(2).slice(0, 10)}`,
        '/orders/ord-1',
        '/orders/ord-1/items',
        '/orders/ord-1/timeline',
        '/orders/ord-1/returns',
        '/returns/ret-1',
      ]) {
        expect((await h.call(full.token, 'GET', path)).status, path).toBe(200) // 响应里出现个人信息字段名或明文哨兵时，call 本身就会抛错
      }
    })

    it('存量加密：升级前的明文备注被加密并清空明文，已过保留期的直接清掉，已有密文的只清明文；重复运行无事可做；加密后的备注仍能经统一出口看到', async () => {
      await returned('leg-1', a.tenantId, a.sellerAccountId, '111-PII-LEG1', { asin: 'B000000010', returnDate: ago(2), customerComments: LEGACY })
      await returned('leg-2', a.tenantId, a.sellerAccountId, '111-PII-LEG2', { asin: 'B000000011', returnDate: ago(90), customerComments: LEGACY })
      await returned('leg-3', a.tenantId, a.sellerAccountId, '111-PII-LEG3', {
        asin: 'B000000012',
        returnDate: ago(2),
        customerComments: LEGACY,
        customerCommentsCipher: commentCipher,
        customerCommentsExpiresAt: later(5),
        customerCommentsKinds: 'PHONE',
      })
      // 加密之前详情不会泄露升级前的明文：显示为“没有”
      expect((await h.call(full.token, 'GET', '/returns/leg-1')).json.data.buyerComments.state).toBe('NONE')

      const { backfillReturnComments } = await import(/* @vite-ignore */ String('../../../worker/src/maintenance/return-comments'))
      const logs: unknown[] = []
      const logger = { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) }
      const summary = await backfillReturnComments({ systemPrisma: system, secrets, logger })
      expect(summary).toMatchObject({ scanned: 3, encrypted: 1, cleared: 1, keptNewer: 1, failed: 0 })
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "FbaReturnCase" WHERE "customerComments" IS NOT NULL`)).rows[0].n).toBe(0)
      const leg1 = await rowOf(`SELECT * FROM "FbaReturnCase" WHERE id = 'leg-1'`)
      expect(leg1.customerCommentsCipher).toBeTruthy()
      expect(leg1.customerCommentsCipher).not.toContain('legacy-secret')
      expect(leg1.customerCommentsKinds).toBe('PHONE')
      expect(new Date(leg1.customerCommentsExpiresAt).getTime()).toBeGreaterThan(Date.now())
      expect((await rowOf(`SELECT "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = 'leg-2'`)).customerCommentsCipher).toBeNull()
      expect((await rowOf(`SELECT "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = 'leg-3'`)).customerCommentsCipher).toBe(commentCipher)
      expect(JSON.stringify(logs)).not.toMatch(/legacy-secret|13711112222/)
      expect((await reveal(full, returnBody('leg-1'))).json.data).toMatchObject({ state: 'OK', values: { customerComments: LEGACY } })
      expect((await reveal(full, returnBody('leg-2'))).json.data.state).toBe('NOT_SYNCED')
      expect(await backfillReturnComments({ systemPrisma: system, secrets, logger })).toMatchObject({ scanned: 0 })
    })

    it('到期清理：过了保留期的备注密文、保留期与类别一并清除，订单买家信息同样；没到期的不动', async () => {
      const { purgeExpiredBuyerInformation } = await import(/* @vite-ignore */ String('../../../worker/src/listeners/schedule-jobs'))
      await purgeExpiredBuyerInformation({ systemPrisma: system, logger: { info: () => undefined } } as never)
      const gone = await rowOf(`SELECT "customerCommentsCipher", "customerCommentsExpiresAt", "customerCommentsKinds" FROM "FbaReturnCase" WHERE id = 'ret-3'`)
      expect(gone).toEqual({ customerCommentsCipher: null, customerCommentsExpiresAt: null, customerCommentsKinds: null })
      expect((await rowOf(`SELECT "piiCiphertext" FROM "Order" WHERE id = 'ord-3'`)).piiCiphertext).toBeNull()
      expect((await rowOf(`SELECT "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = 'ret-1'`)).customerCommentsCipher).toBe(commentCipher)
      expect((await reveal(full, returnBody('ret-3'))).json.data.state).toBe('NOT_SYNCED')
    })

    it('导入：退货报告里的备注只以密文写入（保留期按退货日起 30 天、类别已识别），明文列为空；报告没给备注的重复导入不覆盖旧备注', async () => {
      const importer = await import(/* @vite-ignore */ String('../../../worker/src/importers/returns/report'))
      const helper = await import(/* @vite-ignore */ String('../../../worker/src/importers/inventory/fake-context.test-helper'))
      const header = [
        'return-date',
        'order-id',
        'sku',
        'asin',
        'fnsku',
        'product-name',
        'quantity',
        'fulfillment-center-id',
        'detailed-disposition',
        'reason',
        'status',
        'license-plate-number',
        'customer-comments',
      ]
      const returnDate = ago(2)
      const line = (comments: string) => [
        returnDate,
        '111-PII-IMP1',
        'SKU-IMP',
        'B000000099',
        'X00IMP',
        '保温杯',
        '1',
        'ABE2',
        'SELLABLE',
        'DEFECTIVE',
        'Unit returned to inventory',
        'LPN-IMP',
        comments,
      ]
      const run = (comments: string, withSecrets = true) =>
        runWithTenant(a.tenantId, () =>
          importer.syncReturnsReport(
            { prisma: tenantDb, logger: { info: () => undefined, warn: () => undefined, error: () => undefined }, ...(withSecrets ? { secrets } : {}) },
            helper.rowsOf(helper.tsv(header, line(comments))),
            a.tenantId,
            a.sellerAccountId,
            'ATVPDKIKX0DER',
            { now: new Date() },
          ),
        )
      expect(await run(IMPORTED)).toMatchObject({ imported: 1 })
      const row = await rowOf(`SELECT * FROM "FbaReturnCase" WHERE "licensePlateNumber" = 'LPN-IMP'`)
      expect(row.customerComments).toBeNull()
      expect(row.customerCommentsCipher).toBeTruthy()
      expect(row.customerCommentsCipher).not.toContain('imported-secret')
      expect(row.customerCommentsKinds).toBe('PHONE,EMAIL')
      // 库里是不带时区的时间，pg 驱动会按本机时区解读；用 epoch 直接按 UTC 比较
      const expiryMs = Number((await rowOf(`SELECT (extract(epoch FROM "customerCommentsExpiresAt") * 1000)::float8 AS ms FROM "FbaReturnCase" WHERE id = $1`, [row.id])).ms)
      expect(expiryMs).toBe(new Date(returnDate).getTime() + 30 * DAY)
      expect((await reveal(full, returnBody(row.id))).json.data.values.customerComments).toBe(IMPORTED)
      // 报告这次没给备注：旧备注保留；没有加密能力时即使有备注也不写
      await run('')
      expect((await rowOf(`SELECT "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = $1`, [row.id])).customerCommentsCipher).toBe(row.customerCommentsCipher)
      await run('another-secret-note', false)
      expect(await rowOf(`SELECT "customerComments", "customerCommentsCipher" FROM "FbaReturnCase" WHERE id = $1`, [row.id])).toEqual({
        customerComments: null,
        customerCommentsCipher: row.customerCommentsCipher,
      })
    })
  })
})

async function seedBasic(client: import('pg').Client, suffix: string) {
  const tenant = await insertRow(client, 'Tenant', { id: `tenant-${suffix}`, slug: `tenant-${suffix}`, name: `租户${suffix}` })
  const legalEntity = await insertRow(client, 'LegalEntity', { id: `le-${suffix}`, tenantId: tenant.id })
  const seller = await insertRow(client, 'SellerAccount', { id: `seller-${suffix}`, tenantId: tenant.id, legalEntityId: legalEntity.id })
  return { tenantId: tenant.id as string, sellerAccountId: seller.id as string }
}
