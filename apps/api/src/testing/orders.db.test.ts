import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Keyring, createMasterKeyProvider, prismaKeyStore } from '@nova/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SystemPrismaService } from '../platform/prisma.service'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { registerPiiSentinel } from './pii-response-guard'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2b-01 订单页（真实数据库）：列表筛选与游标分页、数据范围与租户隔离、字段权限（利润、买家）、
// 各页签的事实计算、查看买家信息（加密、理由、审计、明文不落地）、迁移升级与回滚。

const TARGET = '20261026010000_order_page'
const RANGE = 'from=2026-10-01&to=2026-10-31'
const PII = { buyerName: 'Alice Buyer', buyerEmail: 'alice@example.com', addressLine1: '1 Pike St', city: 'Seattle', state: 'WA', postalCode: '98101', country: 'US' }
// 邮编按完整数字匹配。请求号是十六进制，裸子串 98101 会撞上 req_45198101-… 这类编号。
const PLAINTEXT = /Alice|alice@example|Pike St|Seattle|\b98101\b/
// 登记明文哨兵：之后 call 经过的每个非 /pii/reveal 响应里出现它们都会直接让测试失败（P6-14 统一守卫）
registerPiiSentinel(PII.buyerName, PII.buyerEmail, PII.addressLine1)

describe('订单页（P2b-01，真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：新增列与索引，可回滚、可再次升级', () => {
    it('升级保留旧订单（programs 默认空数组、salesChannel 为空）；回滚后列与索引消失；可再次升级', async () => {
      await db.createDatabase('orders_upgrade')
      const client = await db.connect('orders_upgrade')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedTenant(client, 'u')
        await insertRow(client, 'Order', { id: 'old', tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, amazonOrderId: '111-1', purchaseDate: '2026-09-10T10:00:00Z' })
        await applyMigrations(client, { only: TARGET })
        const row = (await client.query(`SELECT "programs", "salesChannel" FROM "Order" WHERE id = 'old'`)).rows[0]
        expect(row).toEqual({ programs: [], salesChannel: null })
        const indexes = async () => (await client.query(`SELECT indexname FROM pg_indexes WHERE indexname IN ('Order_tenantId_replacedOrderId_idx')`)).rows.length
        expect(await indexes()).toBeGreaterThan(0)
        await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
        const columns = (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Order' AND column_name IN ('programs', 'salesChannel')`)).rows
        expect(columns).toEqual([])
        expect(await indexes()).toBe(0)
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT "programs" FROM "Order" WHERE id = 'old'`)).rows[0].programs).toEqual([])
      } finally {
        await client.end()
      }
    })
  })

  describe('接口', () => {
    let h: DbTestApp
    let a: Awaited<ReturnType<DbTestApp['createTenant']>>
    let b: Awaited<ReturnType<DbTestApp['createTenant']>>
    let full: { token: string; userId: string }
    let basic: { token: string }
    let scoped: { token: string }
    let other: { token: string }
    let reader: { token: string }

    async function seedOrder(tenantId: string, sellerAccountId: string, id: string, no: string, purchaseDate: string, extra: Record<string, unknown> = {}) {
      await insertRow(h.client, 'Order', { id, tenantId, sellerAccountId, amazonOrderId: no, purchaseDate, status: 'Shipped', fulfillmentStatus: 'Shipped', currency: 'USD', ...extra })
    }
    const finance = (id: string, order: string, type: string, status: string, amount: number, postedAt: string) =>
      insertRow(h.client, 'FbaFinancialTransaction', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        externalTransactionId: id,
        amazonOrderId: order,
        transactionType: type,
        transactionStatus: status,
        amount,
        postedAt,
      })
    const line = (id: string, order: string, path: string, amount: number, postedAt: string) =>
      insertRow(h.client, 'FbaFeeEvent', {
        id,
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        amazonOrderId: order,
        eventType: 'ShipmentEvent',
        description: path,
        sourceEventId: id,
        amount,
        postedAt,
      })

    beforeAll(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = '1'.repeat(64)
      h = await createDbTestApp({ database: 'orders_api', db })
      a = await h.createTenant('a')
      b = await h.createTenant('b')
      await insertRow(h.client, 'SellerAccount', { id: 'seller-a2', tenantId: a.tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2' })
      full = await h.createMember(a.tenantId, 'full', ['orders.read', 'finance.read', 'field.buyer', 'field.profit'])
      basic = await h.createMember(a.tenantId, 'basic', ['orders.read'])
      scoped = await h.createMember(a.tenantId, 'scoped', ['orders.read', 'field.buyer'], { scopes: [{ sellerAccountId: 'seller-a2' }] })
      reader = await h.createMember(a.tenantId, 'reader', ['member.read'])
      other = await h.createMember(b.tenantId, 'other', ['orders.read', 'finance.read', 'field.buyer'])

      const system = h.app.get(SystemPrismaService)
      const { provider, legacyRoot } = createMasterKeyProvider(process.env)
      const keyring = new Keyring({ store: prismaKeyStore(system.dataEncryptionKey), master: provider, legacyRoot, cacheTtlMs: 0 })
      const sealed = (await keyring.seal('buyer-pii', JSON.stringify(PII))).ciphertext
      const future = new Date(Date.now() + 20 * 86_400_000).toISOString()
      const past = new Date(Date.now() - 86_400_000).toISOString()

      // A1：发货、有包裹、财务交易已释放、收入与财务明细逐项一致、有买家信息
      await seedOrder(a.tenantId, a.sellerAccountId, 'order-A-1', '111-0000001-0000001', '2026-10-05T10:00:00Z', {
        amount: 49,
        piiCiphertext: sealed,
        piiExpiresAt: future,
        programs: ['PRIME'],
        salesChannel: 'Amazon.com',
      })
      await insertRow(h.client, 'OrderItem', {
        id: 'oi-1',
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        orderId: 'order-A-1',
        orderPurchaseDate: '2026-10-05T10:00:00Z',
        amazonOrderId: '111-0000001-0000001',
        orderItemId: 'I1',
        asin: 'B000000001',
        sellerSku: 'SKU-1',
        quantityOrdered: 2,
        itemPrice: 40,
        taxAmount: 4,
      })
      for (const [kind, key, amount] of [
        ['ITEM', 'Principal', 40],
        ['SHIPPING', 'Shipping', 5],
        ['TAX', 'Tax', 4],
      ] as const) {
        await insertRow(h.client, 'OrderCharge', {
          id: `c-${kind}`,
          tenantId: a.tenantId,
          sellerAccountId: a.sellerAccountId,
          orderId: 'order-A-1',
          orderItemId: 'I1',
          amazonOrderId: '111-0000001-0000001',
          purchaseDate: '2026-10-05T10:00:00Z',
          chargeKind: kind,
          componentKey: key,
          amount,
        })
      }
      await insertRow(h.client, 'OrderPackage', {
        id: 'pk-1',
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        orderId: 'order-A-1',
        orderPurchaseDate: '2026-10-05T10:00:00Z',
        packageId: 'S1',
        carrier: 'UPS',
        trackingNumber: 'T1',
        shipDate: '2026-10-06T08:00:00Z',
        shippingService: 'Standard',
      })
      await insertRow(h.client, 'OrderStatusHistory', {
        id: 'h-1',
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        orderId: 'order-A-1',
        orderPurchaseDate: '2026-10-05T10:00:00Z',
        status: 'Shipped',
        occurredAt: '2026-10-06T09:00:00Z',
        source: 'API',
      })
      await finance('t-A1', '111-0000001-0000001', 'Shipment', 'RELEASED', 39.8, '2026-10-06T12:00:00Z')
      for (const [i, path, amount] of [
        [1, 'ItemChargeList/Principal', 40],
        [2, 'ShippingCharge', 5],
        [3, 'ItemChargeList/Tax', 4],
        [4, 'ItemFeeList/Commission', -6],
        [5, 'ItemFeeList/FBAPerUnitFulfillmentFee', -3.2],
      ] as const) {
        await line(`t-A1:${i}`, '111-0000001-0000001', path, amount, '2026-10-06T12:00:00Z')
      }
      // A2：递延的销售交易 + 全额退款 + 一条退货
      await seedOrder(a.tenantId, a.sellerAccountId, 'order-A-2', '111-0000002-0000002', '2026-10-10T10:00:00Z', { amount: 20, piiCiphertext: sealed, piiExpiresAt: past })
      await finance('t-A2', '111-0000002-0000002', 'Shipment', 'DEFERRED', 17, '2026-10-11T12:00:00Z')
      await finance('t-A2r', '111-0000002-0000002', 'Refund', 'RELEASED', -20, '2026-10-14T12:00:00Z')
      await line('t-A2r:1', '111-0000002-0000002', 'ItemChargeList/Principal', -20, '2026-10-14T12:00:00Z')
      await insertRow(h.client, 'FbaReturnCase', {
        tenantId: a.tenantId,
        sellerAccountId: a.sellerAccountId,
        amazonOrderId: '111-0000002-0000002',
        asin: 'B000000001',
        sellerSku: 'SKU-1',
        quantity: 1,
        reason: 'DEFECTIVE',
        status: 'RECEIVED',
        returnDate: '2026-10-15T00:00:00Z',
      })
      // A3：A2 的替换订单，没有财务交易、没有买家信息
      await seedOrder(a.tenantId, a.sellerAccountId, 'order-A-3', '111-0000003-0000003', '2026-10-15T10:00:00Z', {
        amount: 0,
        isReplacement: true,
        replacedOrderId: '111-0000002-0000002',
        replacementReason: 'DAMAGED',
      })
      // A4：窗口之外
      await seedOrder(a.tenantId, a.sellerAccountId, 'order-A-4', '111-0000004-0000004', '2026-08-01T10:00:00Z')
      // B 租户的订单
      await insertRow(h.client, 'Order', {
        id: 'order-B-1',
        tenantId: b.tenantId,
        sellerAccountId: b.sellerAccountId,
        amazonOrderId: '111-0000009-0000009',
        purchaseDate: '2026-10-05T10:00:00Z',
        status: 'Shipped',
        piiCiphertext: sealed,
        piiExpiresAt: future,
      })
    })
    afterAll(async () => {
      await h?.close()
    })

    const get = (token: string, path: string) => h.call(token, 'GET', path)
    const idsOf = async (query: string, token = full.token) => (await get(token, `/orders?${RANGE}&${query}`)).json.data.items.map((item: { id: string }) => item.id)

    describe('列表', () => {
      it('只返回本租户窗口内的订单（倒序），带结算、退款、退货、风险；不含买家信息与密文', async () => {
        const res = await get(full.token, `/orders?${RANGE}&pageSize=50`)
        expect(res.status).toBe(200)
        const rows = Object.fromEntries(res.json.data.items.map((item: { id: string }) => [item.id, item]))
        expect(res.json.data.items.map((item: { id: string }) => item.id)).toEqual(['order-A-3', 'order-A-2', 'order-A-1'])
        expect(rows['order-A-1']).toMatchObject({
          storeName: expect.any(String),
          units: 2,
          carrier: 'UPS',
          trackingNumber: 'T1',
          refund: { state: 'NONE' },
          settlement: { state: 'RELEASED' },
          risks: [],
        })
        expect(rows['order-A-2']).toMatchObject({ refund: { state: 'FULL', amount: 20 }, returnCount: 1, settlement: { state: 'DEFERRED' } })
        expect(rows['order-A-2'].risks).toEqual(expect.arrayContaining(['REFUND', 'RETURN', 'REPLACEMENT']))
        expect(rows['order-A-3']).toMatchObject({ isReplacement: true, refund: { state: 'PENDING_DATA', amount: null }, settlement: { state: 'NONE' } })
        expect(res.json.data.items.every((item: { units: unknown }) => item.units === null || typeof item.units === 'number')).toBe(true)
        expect(JSON.stringify(res.json)).not.toMatch(/piiCiphertext|order-B-1|111-0000009|Alice/)
      })

      it('没有 field.profit 的成员看不到净收益字段；缺权限 403；未登录 401；别的租户只看到自己的', async () => {
        const row = (await get(basic.token, `/orders?${RANGE}`)).json.data.items[0]
        expect(row).not.toHaveProperty('netIncome')
        expect((await get(reader.token, '/orders')).status).toBe(403)
        expect((await h.call(null, 'GET', '/orders')).status).toBe(401)
        expect(await idsOf('', other.token)).toEqual(['order-B-1'])
      })

      it('游标分页稳定：两页无重复无遗漏；游标不能换条件复用', async () => {
        const first = (await get(full.token, `/orders?${RANGE}&pageSize=2`)).json.data
        expect(first.items.map((item: { id: string }) => item.id)).toEqual(['order-A-3', 'order-A-2'])
        expect(first.pageInfo).toMatchObject({ hasMore: true })
        const second = (await get(full.token, `/orders?${RANGE}&pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).json.data
        expect(second.items.map((item: { id: string }) => item.id)).toEqual(['order-A-1'])
        expect(second.pageInfo.hasMore).toBe(false)
        expect((await get(full.token, `/orders?${RANGE}&status=Shipped&pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
        const asc = (await get(full.token, `/orders?${RANGE}&sort=purchaseDate:asc`)).json.data.items.map((item: { id: string }) => item.id)
        expect(asc).toEqual(['order-A-1', 'order-A-2', 'order-A-3'])
      })

      it('筛选：退款、退货、替换、结算、商品、搜索、风险', async () => {
        expect(await idsOf('refunded=true')).toEqual(['order-A-2'])
        expect(await idsOf('refunded=false')).toEqual(['order-A-3', 'order-A-1'])
        expect(await idsOf('returned=true')).toEqual(['order-A-2'])
        expect(await idsOf('replacement=true')).toEqual(['order-A-3', 'order-A-2'])
        expect(await idsOf('replacement=false')).toEqual(['order-A-1'])
        expect(await idsOf('settlement=DEFERRED')).toEqual(['order-A-2'])
        expect(await idsOf('settlement=NONE')).toEqual(['order-A-3'])
        expect(await idsOf('settlement=RELEASED')).toEqual(['order-A-1'])
        expect(await idsOf('sku=SKU-1')).toEqual(['order-A-1'])
        expect(await idsOf('asin=b000000001')).toEqual(['order-A-1'])
        expect(await idsOf('q=111-0000002')).toEqual(['order-A-2'])
        expect(await idsOf('q=T1')).toEqual(['order-A-1'])
        expect(await idsOf('risk=REFUND')).toEqual(['order-A-2'])
        expect(await idsOf('risk=REPLACEMENT')).toEqual(['order-A-3', 'order-A-2'])
        expect((await get(full.token, `/orders?${RANGE}&risk=FINANCE_DIFF`)).status).toBe(422)
      })

      it('数据范围：只授权别的店铺的成员看不到这些订单，详情是 404；没有订单时说明原因', async () => {
        const list = (await get(scoped.token, `/orders?${RANGE}`)).json.data
        expect(list).toMatchObject({ state: 'NO_DATA', items: [] })
        expect(list.note).toContain('尚无订单')
        for (const path of ['', '/items', '/charges', '/timeline']) expect((await get(scoped.token, `/orders/order-A-1${path}`)).status, path).toBe(404)
        expect((await h.call(scoped.token, 'POST', '/pii/reveal', { body: { objectType: 'ORDER', objectId: 'order-A-1', fields: ['buyerName'], reason: '核对地址' } })).status).toBe(404)
      })
    })

    describe('详情', () => {
      it('身份区：系统编号与亚马逊订单号都能定位；别的租户的编号是 404', async () => {
        const byNo = (await get(full.token, '/orders/111-0000001-0000001')).json.data
        expect(byNo.order).toMatchObject({ id: 'order-A-1', programs: ['PRIME'], salesChannel: 'Amazon.com', units: 2, lineCount: 1, statusLabel: expect.any(String) })
        expect(byNo.buyerInfo).toMatchObject({ access: 'ALLOWED', state: 'AVAILABLE' })
        expect(byNo.netIncome).toMatchObject({ state: 'OK', value: 39.8 })
        expect(byNo.overview.basis).toMatchObject({ carriers: ['UPS'], services: ['Standard'] })
        expect((await get(basic.token, '/orders/order-A-1')).json.data.buyerInfo).toMatchObject({ access: 'RESTRICTED', state: 'NOT_SYNCED', expiresAt: null })
        expect((await get(basic.token, '/orders/order-A-1')).json.data).not.toHaveProperty('netIncome')
        expect((await get(full.token, '/orders/order-B-1')).status).toBe(404)
        expect((await get(full.token, '/orders/not-exist')).status).toBe(404)
        expect((await get(full.token, '/orders/order-A-2')).json.data.buyerInfo.state).toBe('EXPIRED')
        expect((await get(full.token, '/orders/order-A-3')).json.data.buyerInfo.state).toBe('NOT_SYNCED')
      })

      it('订单行、收入与费用（与财务交易逐项匹配）、包裹、时间线', async () => {
        const items = (await get(full.token, '/orders/order-A-1/items')).json.data
        expect(items.items[0]).toMatchObject({ sku: 'SKU-1', asin: 'B000000001', quantityOrdered: 2, itemPrice: 40, unitPrice: 20, productId: null })
        expect(items.associatedItems.state).toBe('NOT_CONNECTED')
        const charges = (await get(full.token, '/orders/order-A-1/charges')).json.data
        expect(charges.revenue).toEqual({ item: 40, shipping: 5, promotion: 0, tax: 4, other: 0, totalExTax: 45, total: 49 })
        expect(charges.fees.map((fee: { amount: number }) => fee.amount).sort((x: number, y: number) => x - y)).toEqual([-6, -3.2])
        expect(charges).toMatchObject({ feeTotal: -9.2, netIncome: { state: 'OK', value: 39.8 }, match: { state: 'MATCHED' } })
        expect((await get(basic.token, '/orders/order-A-1/charges')).json.data).not.toHaveProperty('netIncome')
        const noFinance = (await get(full.token, '/orders/order-A-3/charges')).json.data
        expect(noFinance).toMatchObject({ revenue: null, feeTotal: null, match: { state: 'NO_LINES' } })
        const packages = (await get(full.token, '/orders/order-A-1/packages')).json.data
        expect(packages.packages).toMatchObject([{ carrier: 'UPS', trackingNumber: 'T1', shipDate: '2026-10-06T08:00:00.000Z' }])
        expect(packages.tracking.state).toBe('NOT_CONNECTED')
        const timeline = (await get(full.token, '/orders/order-A-1/timeline')).json.data
        expect(timeline.items.map((item: { kind: string }) => item.kind)).toEqual(['PURCHASE', 'PACKAGE', 'STATUS'])
        expect(timeline.push.state).toBe('NOT_CONNECTED')
      })

      it('财务交易需要 finance.read；退款与退货含替换关系；风险带原因', async () => {
        expect((await get(basic.token, '/orders/order-A-1/transactions')).status).toBe(403)
        const tx = (await get(full.token, '/orders/order-A-2/transactions')).json.data
        expect(tx).toMatchObject({ total: -3, truncated: false, settlement: { state: 'DEFERRED' } })
        expect(tx.items.map((item: { externalTransactionId: string }) => item.externalTransactionId)).toEqual(['t-A2', 't-A2r'])
        const returns = (await get(full.token, '/orders/order-A-2/returns')).json.data
        expect(returns).toMatchObject({ refund: { state: 'FULL', amount: 20 }, refundTotal: 20 })
        expect(returns.refunds).toHaveLength(1)
        expect(returns.returns).toMatchObject([{ reason: 'DEFECTIVE', status: 'RECEIVED', quantity: 1 }])
        expect(returns.replacement.replacedBy).toMatchObject([{ id: 'order-A-3', amazonOrderId: '111-0000003-0000003' }])
        const replacement = (await get(full.token, '/orders/order-A-3/returns')).json.data.replacement
        expect(replacement).toMatchObject({ isReplacement: true, reason: 'DAMAGED', original: { id: 'order-A-2', amazonOrderId: '111-0000002-0000002' } })
        const risks = (await get(basic.token, '/orders/order-A-2/risks')).json.data.items
        expect(risks.map((risk: { kind: string }) => risk.kind)).toEqual(expect.arrayContaining(['REFUND', 'RETURN', 'REPLACEMENT']))
        expect(risks.every((risk: { reason: string }) => risk.reason.length > 0)).toBe(true)
      })

      it('读接口的任何响应都不含买家信息明文或密文', async () => {
        const paths = ['', '/items', '/charges', '/packages', '/returns', '/transactions', '/timeline', '/risks']
        const bodies = await Promise.all(paths.map(async path => JSON.stringify((await get(full.token, `/orders/order-A-1${path}`)).json)))
        bodies.push(JSON.stringify((await get(full.token, `/orders?${RANGE}`)).json))
        for (const body of bodies) expect(body).not.toMatch(PLAINTEXT)
        for (const body of bodies) expect(body).not.toMatch(/piiCiphertext|\.[A-Za-z0-9+/=]{20,}\./)
      })
    })

    // 买家信息明文只经统一出口 POST /pii/reveal（P6-14）；这里验证订单对象的行为，三类对象的通用规则在 pii.db.test.ts
    describe('查看买家信息（统一出口）', () => {
      const reason = '客户来电核对收货地址'
      const FIELDS = ['buyerName', 'buyerEmail', 'buyerPhone', 'addressLine1', 'city', 'state', 'postalCode', 'country']
      const reveal = (token: string, objectId: string, body: Record<string, unknown> = {}) =>
        h.call(token, 'POST', '/pii/reveal', { body: { objectType: 'ORDER', objectId, fields: FIELDS, reason, ...body } })
      const audits = async () => (await h.client.query(`SELECT * FROM "AuditEvent" WHERE action = 'PII_REVEALED' ORDER BY "occurredAt"`)).rows

      it('没有 field.buyer：403；没有理由：422；都不留“已查看”审计', async () => {
        expect((await reveal(basic.token, 'order-A-1')).status).toBe(403)
        expect((await reveal(full.token, 'order-A-1', { reason: undefined })).status).toBe(422)
        expect((await reveal(full.token, 'order-A-1', { reason: ' ' })).status).toBe(422)
        expect((await audits()).filter(row => row.result === 'SUCCEEDED')).toHaveLength(0)
      })

      it('成功：解密返回，审计记录理由与订单号但没有明文；幂等记录与审计里都没有明文', async () => {
        const res = await reveal(full.token, 'order-A-1')
        expect(res.status).toBe(200)
        expect(res.json.data).toMatchObject({ state: 'OK', values: { buyerName: 'Alice Buyer', buyerEmail: 'alice@example.com', city: 'Seattle', country: 'US', buyerPhone: null } })
        const rows = (await audits()).filter(row => row.result === 'SUCCEEDED')
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ tenantId: a.tenantId, actorId: full.userId, resourceType: 'Order', resourceId: 'order-A-1', reason: '客户来电核对收货地址' })
        expect(rows[0].detail).toMatchObject({ amazonOrderId: '111-0000001-0000001', outcome: 'OK' })
        // 只记看到了哪些字段（字段名），没有内容的字段（这里是电话）不记；审计中心的“个人信息明文查看”据此显示
        expect(rows[0].detail.fields).toEqual(expect.arrayContaining(['buyerName', 'buyerEmail', 'city', 'country']))
        expect(rows[0].detail.fields).not.toContain('buyerPhone')
        expect(rows[0]).toMatchObject({ source: 'API' })
        expect(JSON.stringify(rows)).not.toMatch(PLAINTEXT)
        const idem = await h.client.query(`SELECT * FROM "IdempotencyRecord"`)
        expect(JSON.stringify(idem.rows)).not.toMatch(PLAINTEXT)
        const stored = (await h.client.query(`SELECT "piiCiphertext" FROM "Order" WHERE id = 'order-A-1'`)).rows[0].piiCiphertext as string
        expect(stored).not.toMatch(PLAINTEXT)
      })

      it('已过保留期、从未同步：如实说明且仍留审计；别的租户的订单是 404', async () => {
        const before = (await audits()).length
        const expired = (await reveal(full.token, 'order-A-2')).json.data
        expect(expired).toMatchObject({ state: 'EXPIRED', values: {} })
        const never = (await reveal(full.token, 'order-A-3')).json.data
        expect(never).toMatchObject({ state: 'NOT_SYNCED', values: {} })
        expect((await audits()).length).toBe(before + 2)
        expect((await reveal(other.token, 'order-A-1')).status).toBe(404)
        const own = (await reveal(other.token, 'order-B-1')).json.data
        expect(own.state).toBe('OK')
      })
    })
  })
})
