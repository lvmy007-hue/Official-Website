import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keyring, createMasterKeyProvider, prismaKeyStore } from '@nova/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SystemPrismaService } from '../platform/prisma.service'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { registerPiiSentinel } from './pii-response-guard'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2b-02 退货页（真实数据库）：迁移升级与回滚（唯一键、新列、回填）、列表筛选与游标分页、数据范围与租户隔离、
// 退款与收货先后、退款后未收到退货清单、退货分析的退货率（没有销售汇总时为空）、买家备注只在详情里。

const TARGET = '20261027010000_returns_page'
const COMMENT = 'secret comment 13800000000'
registerPiiSentinel(COMMENT, '13800000000')
const DAY = 86_400_000
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString()
const dayOf = (days: number) => ago(days).slice(0, 10)

describe('退货页（P2b-02，真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：新增列、新唯一键与索引，可回滚、可再次升级', () => {
    it('升级保留旧退货并回填详细处置；同一订单同一时间可有多个退货件；回滚后列与新索引消失、旧唯一键恢复；可再次升级', async () => {
      await db.createDatabase('returns_upgrade')
      const client = await db.connect('returns_upgrade')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedTenant(client, 'u')
        const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, amazonOrderId: '111-1', asin: 'B000000001', sellerSku: 'SKU-1', returnDate: '2026-09-10T10:00:00Z' }
        await insertRow(client, 'FbaReturnCase', { id: 'old', ...base, disposition: 'SELLABLE' })
        await applyMigrations(client, { only: TARGET })
        const old = (await client.query(`SELECT "detailedDisposition", "fnsku", "licensePlateNumber", "customerComments" FROM "FbaReturnCase" WHERE id = 'old'`)).rows[0]
        expect(old).toEqual({ detailedDisposition: 'SELLABLE', fnsku: '', licensePlateNumber: '', customerComments: null })
        // 同一订单、同一 ASIN、同一时间，不同退货件编号：新唯一键允许
        await insertRow(client, 'FbaReturnCase', { id: 'second', ...base, licensePlateNumber: 'LPN2' })
        await expect(insertRow(client, 'FbaReturnCase', { id: 'dup', ...base, licensePlateNumber: 'LPN2' })).rejects.toThrow(/FbaReturnCase_report_uq|duplicate/)
        const names = async () => (await client.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'FbaReturnCase' ORDER BY indexname`)).rows.map(row => row.indexname as string)
        expect(await names()).toEqual(expect.arrayContaining(['FbaReturnCase_report_uq', 'FbaReturnCase_order_idx', 'FbaReturnCase_date_idx']))
        expect(await names()).not.toContain('FbaReturnCase_sellerAccountId_amazonOrderId_asin_returnDate_key')

        await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
        const columns = (
          await client.query(
            `SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaReturnCase' AND column_name IN ('fnsku', 'licensePlateNumber', 'detailedDisposition', 'customerComments', 'reimbursementCaseId')`,
          )
        ).rows
        expect(columns).toEqual([])
        expect(await names()).toContain('FbaReturnCase_sellerAccountId_amazonOrderId_asin_returnDate_key')
        expect(await names()).not.toEqual(expect.arrayContaining(['FbaReturnCase_report_uq']))
        // 回滚时同一订单同一时间的多行只保留最早的一行
        expect((await client.query(`SELECT count(*)::int AS n FROM "FbaReturnCase" WHERE "amazonOrderId" = '111-1'`)).rows[0].n).toBe(1)

        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT "licensePlateNumber" FROM "FbaReturnCase" WHERE id = 'old'`)).rows[0].licensePlateNumber).toBe('')
      } finally {
        await client.end()
      }
    })
  })

  describe('接口', () => {
    let h: DbTestApp
    let a: Awaited<ReturnType<DbTestApp['createTenant']>>
    let b: Awaited<ReturnType<DbTestApp['createTenant']>>
    let reader: { token: string }
    let scoped: { token: string }
    let other: { token: string }
    let noPermission: { token: string }
    let commentCipher = ''

    const order = (id: string, no: string, daysAgo: number, amount: number, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'Order', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        amazonOrderId: no,
        purchaseDate: ago(daysAgo),
        status: 'Shipped',
        fulfillmentStatus: 'Shipped',
        currency: 'USD',
        amount,
        ...extra,
      })
    const finance = (id: string, no: string, type: string, status: string, amount: number, daysAgo: number) =>
      insertRow(h.client, 'FbaFinancialTransaction', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        externalTransactionId: id,
        amazonOrderId: no,
        transactionType: type,
        transactionStatus: status,
        amount,
        postedAt: ago(daysAgo),
      })
    const returned = (id: string, tenantId: string, sellerAccountId: string, no: string, daysAgo: number, extra: Record<string, unknown> = {}) =>
      insertRow(h.client, 'FbaReturnCase', { id, tenantId, sellerAccountId, amazonOrderId: no, asin: 'B000000001', sellerSku: 'SKU-1', quantity: 1, returnDate: ago(daysAgo), ...extra })
    const sold = (asin: string, daysAgo: number, units: number) =>
      insertRow(h.client, 'AsinDailySummary', { id: `sum-${asin}-${daysAgo}`, tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, summaryDate: dayOf(daysAgo), asin, units, metricVersion: 'v1' })

    beforeAll(async () => {
      h = await createDbTestApp({ database: 'returns_api', db })
      a = await h.createTenant('a')
      b = await h.createTenant('b')
      await insertRow(h.client, 'SellerAccount', { id: 'seller-a2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2' })
      reader = await h.createMember(a.tenantId, 'reader', ['returns.read'])
      scoped = await h.createMember(a.tenantId, 'scoped', ['returns.read'], { scopes: [{ sellerAccountId: 'seller-a2' }] })
      noPermission = await h.createMember(a.tenantId, 'nop', ['member.read'])
      other = await h.createMember(b.tenantId, 'other', ['returns.read'])

      // R1：退款（35 天前）早于收到退货（30 天前）；可售；有买家备注（与买家信息同一把密钥加密，保留期还有 10 天；含电话，类别记为电话）
      const { provider, legacyRoot } = createMasterKeyProvider(process.env)
      const keyring = new Keyring({ store: prismaKeyStore(h.app.get(SystemPrismaService).dataEncryptionKey), master: provider, legacyRoot, cacheTtlMs: 0 })
      commentCipher = (await keyring.seal('buyer-pii', COMMENT)).ciphertext
      await order('o-R1', '111-R1', 40, 30)
      await finance('t-R1', '111-R1', 'Shipment', 'RELEASED', 27, 39)
      await finance('t-R1r', '111-R1', 'Refund', 'RELEASED', -30, 35)
      await returned('r1', a.tenantId, a.sellerAccountId, '111-R1', 30, {
        reason: 'DEFECTIVE',
        disposition: 'SELLABLE',
        detailedDisposition: 'SELLABLE',
        licensePlateNumber: 'LPN-R1',
        fnsku: 'X1',
        fulfillmentCenterId: 'ONT8',
        reportStatus: 'Unit returned to inventory',
        customerCommentsCipher: commentCipher,
        customerCommentsExpiresAt: new Date(Date.now() + 10 * DAY).toISOString(),
        customerCommentsKinds: 'PHONE',
      })
      // R2：有交易但没有退款；顾客损坏；数量 2；另一个 ASIN
      await order('o-R2', '111-R2', 20, 40)
      await finance('t-R2', '111-R2', 'Shipment', 'RELEASED', 36, 19)
      await returned('r2', a.tenantId, a.sellerAccountId, '111-R2', 10, {
        asin: 'B000000002',
        sellerSku: 'SKU-2',
        quantity: 2,
        reason: 'NOT_AS_DESCRIBED',
        disposition: 'DAMAGED',
        detailedDisposition: 'CUSTOMER_DAMAGED',
      })
      // R3：订单与财务交易都没有；没有处置、没有原因
      await returned('r3', a.tenantId, a.sellerAccountId, '111-R3', 5)
      // R4：另一个店铺（seller-a2）
      await insertRow(h.client, 'Order', {
        id: 'o-R4',
        tenantId: a.tenantId,
        sellerAccountId: 'seller-a2',
        amazonOrderId: '111-R4',
        purchaseDate: ago(15),
        status: 'Shipped',
        currency: 'USD',
        amount: 10,
      })
      await returned('r4', a.tenantId, 'seller-a2', '111-R4', 3, { asin: 'B000000003', sellerSku: 'SKU-3', reason: 'UNWANTED_ITEM', detailedDisposition: 'SELLABLE' })
      // 默认 90 天之外
      await returned('r-old', a.tenantId, a.sellerAccountId, '111-OLD', 200, { reason: 'DEFECTIVE' })
      // 同一订单的第二个退货件
      await returned('r1b', a.tenantId, a.sellerAccountId, '111-R1', 30, {
        asin: 'B000000002',
        sellerSku: 'SKU-2',
        licensePlateNumber: 'LPN-R1B',
        reason: 'WRONG_ITEM',
        detailedDisposition: 'DEFECTIVE',
      })

      // 待核实：退款 60 天前、没有退货；退款 10 天前（未满 30 天）；退款 35 天前但有退货（R1）
      await order('o-W1', '111-W1', 70, 25)
      await finance('t-W1', '111-W1', 'Shipment', 'RELEASED', 22, 69)
      await finance('t-W1r', '111-W1', 'Refund', 'RELEASED', -25, 60)
      await order('o-W2', '111-W2', 30, 25)
      await finance('t-W2r', '111-W2', 'Refund', 'RELEASED', -25, 10)
      // B 租户
      await insertRow(h.client, 'Order', {
        id: 'o-B1',
        tenantId: b.tenantId,
        sellerAccountId: b.sellerAccountId,
        amazonOrderId: '111-B1',
        purchaseDate: ago(20),
        status: 'Shipped',
        currency: 'USD',
        amount: 10,
      })
      await returned('r-b', b.tenantId, b.sellerAccountId, '111-B1', 5, { reason: 'DEFECTIVE' })

      // 销售汇总：A1（B000000001）在 30 与 20 天前各 50 件；其余 ASIN 没有汇总
      await sold('B000000001', 30, 50)
      await sold('B000000001', 20, 50)
    })
    afterAll(async () => {
      await h?.close()
    })

    const get = (token: string, path: string) => h.call(token, 'GET', path)
    const idsOf = async (query: string, token = reader.token) => (await get(token, `/returns?${query}`)).json.data.items.map((item: { id: string }) => item.id)

    describe('列表', () => {
      it('默认最近 90 天、本租户、按退货日期倒序；带处置、原因、退款、收货先后与赔付状态；没有买家备注', async () => {
        const res = await get(reader.token, '/returns?pageSize=50')
        expect(res.status).toBe(200)
        const { data } = res.json
        expect(data.range.defaulted).toBe(true)
        const order = data.items.map((item: { id: string }) => item.id)
        expect(order.slice(0, 3)).toEqual(['r4', 'r3', 'r2'])
        expect(order.slice(3).sort()).toEqual(['r1', 'r1b'])
        const rows = Object.fromEntries(data.items.map((item: { id: string }) => [item.id, item]))
        expect(rows.r1).toMatchObject({
          amazonOrderId: '111-R1',
          orderId: 'o-R1',
          reasonLabel: '商品有缺陷',
          licensePlateNumber: 'LPN-R1',
          fulfillmentCenterId: 'ONT8',
          disposition: { group: 'SELLABLE', label: '可售', sellable: true },
          refund: { state: 'FULL', amount: 30 },
          receipt: { state: 'RECEIVED_AFTER_REFUND' },
          reimbursement: { state: 'NOT_REVIEWED', label: '尚未核查' },
        })
        expect(rows.r2).toMatchObject({ quantity: 2, disposition: { group: 'DAMAGED', raw: 'CUSTOMER_DAMAGED' }, refund: { state: 'NONE' }, receipt: { state: 'NO_REFUND' } })
        expect(rows.r3).toMatchObject({
          orderId: null,
          reason: null,
          reasonLabel: null,
          disposition: { group: 'UNKNOWN', label: '处置未知' },
          refund: { state: 'PENDING_DATA', amount: null },
          receipt: { state: 'PENDING_DATA' },
          licensePlateNumber: null,
        })
        expect(rows['r-old']).toBeUndefined()
        expect(rows['r-b']).toBeUndefined()
        expect(JSON.stringify(res.json)).not.toMatch(/secret comment|13800000000|customerComments/)
      })

      it('缺权限 403；未登录 401；别的租户只看到自己的', async () => {
        expect((await get(noPermission.token, '/returns')).status).toBe(403)
        expect((await h.call(null, 'GET', '/returns')).status).toBe(401)
        expect(await idsOf('', other.token)).toEqual(['r-b'])
      })

      it('游标分页稳定：两页无重复无遗漏；游标不能换条件复用；升序排序', async () => {
        const first = (await get(reader.token, '/returns?pageSize=2')).json.data
        expect(first.items).toHaveLength(2)
        expect(first.pageInfo.hasMore).toBe(true)
        const second = (await get(reader.token, `/returns?pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).json.data
        const third = (await get(reader.token, `/returns?pageSize=2&cursor=${encodeURIComponent(second.pageInfo.nextCursor)}`)).json.data
        const all = [...first.items, ...second.items, ...third.items].map((item: { id: string }) => item.id)
        expect(new Set(all).size).toBe(5)
        expect(third.pageInfo.hasMore).toBe(false)
        expect((await get(reader.token, `/returns?pageSize=2&asin=B000000001&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
        const asc = await idsOf('sort=returnDate:asc')
        expect(asc[asc.length - 1]).toBe('r4')
      })

      it('筛选：订单号前缀、退货件编号、ASIN、SKU、原因、处置分组、是否已退款', async () => {
        expect((await idsOf('q=111-R1')).sort()).toEqual(['r1', 'r1b'])
        expect(await idsOf('q=LPN-R1B')).toEqual(['r1b'])
        expect((await idsOf('asin=b000000002')).sort()).toEqual(['r1b', 'r2'])
        expect(await idsOf('sku=SKU-3')).toEqual(['r4'])
        expect(await idsOf('reason=defective')).toEqual(['r1'])
        expect((await idsOf('disposition=SELLABLE')).sort()).toEqual(['r1', 'r4'])
        expect(await idsOf('disposition=DAMAGED')).toEqual(['r2'])
        expect(await idsOf('disposition=DEFECTIVE')).toEqual(['r1b'])
        expect((await idsOf('refunded=true')).sort()).toEqual(['r1', 'r1b'])
        expect((await idsOf('refunded=false')).sort()).toEqual(['r2', 'r3', 'r4'])
        expect((await get(reader.token, '/returns?disposition=UNKNOWN')).status).toBe(422)
      })

      it('数据范围：只授权 seller-a2 的成员只看到该店铺的退货；范围外的详情是 404', async () => {
        expect(await idsOf('', scoped.token)).toEqual(['r4'])
        expect((await get(scoped.token, '/returns/r1')).status).toBe(404)
        expect((await get(scoped.token, '/returns/r4')).status).toBe(200)
      })

      it('日期范围：显式范围覆盖默认；范围内没有退货时说明原因', async () => {
        const wide = await idsOf(`from=${dayOf(250)}&to=${dayOf(0)}&pageSize=50`)
        expect(wide).toContain('r-old')
        const empty = (await get(reader.token, `/returns?from=${dayOf(400)}&to=${dayOf(380)}`)).json.data
        expect(empty).toMatchObject({ state: 'NO_DATA', items: [] })
        expect(empty.note).toContain('尚无退货')
      })
    })

    describe('详情', () => {
      it('订单、商品、原因、买家备注（只在详情）、处置、退款与费用、同单其他退货、时间线', async () => {
        const res = await get(reader.token, '/returns/r1')
        expect(res.status).toBe(200)
        const { data } = res.json
        expect(data.record).toMatchObject({ fnsku: 'X1', licensePlateNumber: 'LPN-R1', reportStatus: 'Unit returned to inventory' })
        expect(data.order).toMatchObject({ id: 'o-R1', amazonOrderId: '111-R1', amount: 30, statusLabel: expect.any(String) })
        // 买家备注只说“有、含电话、保留到何时”；明文只经 POST /pii/reveal（见 pii.db.test.ts）
        expect(data.buyerComments).toMatchObject({ state: 'AVAILABLE', kinds: ['PHONE'] })
        expect(JSON.stringify(res.json)).not.toMatch(/secret comment|13800000000|customerComments/)
        expect(data.refund).toMatchObject({ state: 'FULL', amount: 30 })
        expect(data.refund.items).toHaveLength(1)
        expect(data.receipt.state).toBe('RECEIVED_AFTER_REFUND')
        expect(data.siblings.map((item: { id: string }) => item.id)).toEqual(['r1b'])
        const kinds = data.timeline.map((item: { kind: string }) => item.kind)
        expect(kinds).toEqual(expect.arrayContaining(['ORDER', 'REFUND', 'RETURN_RECEIVED', 'IMPORTED']))
        const times = data.timeline.map((item: { at: string }) => item.at)
        expect([...times].sort()).toEqual(times)
      })

      it('没有订单与财务交易：订单号为空、退款是待财务交易；不存在或别的租户的编号是 404', async () => {
        const data = (await get(reader.token, '/returns/r3')).json.data
        expect(data.order).toMatchObject({ id: null, purchaseDate: null, amount: null })
        expect(data.refund).toMatchObject({ state: 'PENDING_DATA', amount: null, items: [] })
        expect(data.buyerComments).toEqual({ state: 'NONE', kinds: [], retainedUntil: null })
        expect((await get(reader.token, '/returns/not-exist')).status).toBe(404)
        expect((await get(reader.token, '/returns/r-b')).status).toBe(404)
        expect((await get(noPermission.token, '/returns/r1')).status).toBe(403)
      })
    })

    describe('退款后未收到退货', () => {
      it('只列退款已满 30 天且没有退货记录的订单；退款早的在前；退款未满 30 天与已有退货的订单不在清单里', async () => {
        const res = await get(reader.token, '/returns/awaiting')
        expect(res.status).toBe(200)
        const { data } = res.json
        expect(data.thresholdDays).toBe(30)
        expect(data.items.map((item: { amazonOrderId: string }) => item.amazonOrderId)).toEqual(['111-W1'])
        expect(data.items[0]).toMatchObject({ orderId: 'o-W1', refundAmount: 25, currency: 'USD' })
        expect(data.items[0].daysSinceRefund).toBeGreaterThanOrEqual(59)
        expect(data.truncated).toBe(false)
        expect(data.basis).toContain('待核实清单')
      })

      it('别的租户与数据范围外的成员看不到', async () => {
        expect((await get(other.token, '/returns/awaiting')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
        expect((await get(scoped.token, '/returns/awaiting')).json.data).toMatchObject({ state: 'NO_DATA', items: [] })
        expect((await get(noPermission.token, '/returns/awaiting')).status).toBe(403)
      })
    })

    describe('退货分析', () => {
      it('合计、按 ASIN 与按原因的排行；退货率 = 退货件数 ÷ 销售件数；没有销售汇总的 ASIN 退货率为空，不是 0', async () => {
        const res = await get(reader.token, '/returns/analysis')
        expect(res.status).toBe(200)
        const { data } = res.json
        // 90 天内共 1+2+1+1+1 = 6 件（r1、r2、r3、r4、r1b）
        expect(data.totals).toEqual({ returnedUnits: 6, soldUnits: 100, rate: 0.06 })
        const asin = Object.fromEntries(data.byAsin.map((row: { asin: string }) => [row.asin, row]))
        expect(asin.B000000001).toMatchObject({ returnedUnits: 2, soldUnits: 100, rate: 0.02, topReason: { code: 'DEFECTIVE' } })
        expect(asin.B000000002).toMatchObject({ returnedUnits: 3, soldUnits: null, rate: null })
        expect(asin.B000000003).toMatchObject({ returnedUnits: 1, soldUnits: null, rate: null })
        const reasons = Object.fromEntries(data.byReason.map((row: { reason: string; units: number }) => [row.reason, row.units]))
        expect(reasons).toMatchObject({ DEFECTIVE: 1, NOT_AS_DESCRIBED: 2, UNWANTED_ITEM: 1, WRONG_ITEM: 1, UNSPECIFIED: 1 })
        expect(data.byReason.reduce((sum: number, row: { share: number }) => sum + row.share, 0)).toBeCloseTo(1, 2)
        expect(data.bucket).toBe('WEEK')
        expect(data.trend.reduce((sum: number, point: { returnedUnits: number }) => sum + point.returnedUnits, 0)).toBe(6)
        expect(data.trend.some((point: { rate: number | null }) => point.rate === null)).toBe(true)
        expect(data.reviewCross.state).toBe('NOT_CONNECTED')
        expect(data.truncated).toBe(false)
      })

      it('没有销售汇总的租户：退货率为空；数据范围外：看不到别的店铺；别的租户只看自己', async () => {
        const mine = (await get(other.token, '/returns/analysis')).json.data
        expect(mine.totals).toEqual({ returnedUnits: 1, soldUnits: null, rate: null })
        const scopedData = (await get(scoped.token, '/returns/analysis')).json.data
        expect(scopedData.totals.returnedUnits).toBe(1)
        expect(scopedData.byAsin.map((row: { asin: string }) => row.asin)).toEqual(['B000000003'])
        expect((await get(noPermission.token, '/returns/analysis')).status).toBe(403)
      })

      it('范围内没有退货：NO_DATA，退货率为空', async () => {
        const data = (await get(reader.token, `/returns/analysis?from=${dayOf(400)}&to=${dayOf(380)}`)).json.data
        expect(data).toMatchObject({ state: 'NO_DATA', byAsin: [], byReason: [] })
        expect(data.totals.rate).toBeNull()
      })
    })
  })
})
