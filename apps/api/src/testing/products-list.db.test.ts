import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 商品主数据（P4-07，真实数据库 + 完整应用）：列表的销售与利润汇总（近 30 天窗口、同 ASIN 共用、没有记录是 null 不是 0）、
// 排序空值在后、全部筛选与组合、偏移游标（改条件即失效）、库存风险筛选与权限、数据范围与企业隔离、
// 批量标签与负责人（乐观锁、整批全有或全无、审计与变更记录）、按店铺同步商品目录（去重与无连接）。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const US = 'ATVPDKIKX0DER'

describe('商品主数据（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let reader: Member
  let writer: Member
  let scopedB: Member
  let syncer: Member
  let outsider: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const patch = (member: Member, body: unknown) => h.call(member.token, 'PATCH', '/products/meta', { body })
  const post = (member: Member, body: unknown) => h.call(member.token, 'POST', '/products/sync', { body })
  const ids = (data: Record<string, any>) => (data.items as Array<{ id: string }>).map(item => item.id)
  const rowOf = (data: Record<string, any>, id: string) => (data.items as Array<Record<string, any>>).find(item => item.id === id)!
  const dbTags = async (id: string) => (await h.client.query(`SELECT "tagIds", "ownerUserId", "version" FROM "FbaProduct" WHERE id = $1`, [id])).rows[0]

  const product = (id: string, sku: string, asin: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: storeA, marketplaceId: US, sellerSku: sku, asin, title: `商品 ${sku}`, sourceUpdatedAt: new Date().toISOString(), ...values })
  const sales = (id: string, store: string, asin: string, date: string, units: number, amount: number, tenant = tenantId) =>
    insertRow(h.client, 'AsinDailySummary', { id, tenantId: tenant, sellerAccountId: store, summaryDate: date, asin, units, salesAmount: amount, metricVersion: 'p2a-01@1' })
  const profit = (id: string, store: string, sku: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'ProfitDaily', { id, tenantId, sellerAccountId: store, sku, profitDate: date, basis: 'ORDERED', costing: 'FIFO', metricVersion: 'p2b-09@1', ...values })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'products_list' })
    const a = await h.createTenant('pl-a')
    const b = await h.createTenant('pl-b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-pl-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PL-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)

    owner = await h.createMember(tenantId, 'pl-owner', ['*'])
    reader = await h.createMember(tenantId, 'pl-reader', ['products.read'])
    writer = await h.createMember(tenantId, 'pl-writer', ['products.read', 'catalog.meta.write'])
    scopedB = await h.createMember(tenantId, 'pl-scoped', ['products.read', 'catalog.meta.write', 'sync.manage'], { scopes: [{ sellerAccountId: storeB }] })
    syncer = await h.createMember(tenantId, 'pl-syncer', ['products.read', 'sync.manage'])
    outsider = await h.createMember(otherTenantId, 'pl-outsider', ['*'])

    // 商品：p1、p2 同 ASIN（共用销售）；p3 没有任何销售；p4 在店铺 B；别的企业也有同 ASIN 的商品
    await product('p1', 'SKU-A', 'B0AAAAAAAA', { fnsku: 'X0AAAAAAAA', brand: 'Acme', parentAsin: 'B0PARENT01', price: 20, categoryPath: 'Home > Kitchen', tagIds: ['热销'], ownerUserId: owner.userId })
    await product('p2', 'SKU-A2', 'B0AAAAAAAA', { brand: 'Acme', fulfillmentChannel: 'MFN', categoryPath: 'Home > Kitchen' })
    await product('p3', 'SKU-C', 'B0CCCCCCCC', { brand: 'Zeta', listingStatus: 'INACTIVE', title: '没有销售的商品', catalogStatus: 'NOT_FOUND' })
    await product('p4', 'SKU-D', 'B0DDDDDDDD', { sellerAccountId: storeB, brand: 'Acme', price: 5 })
    await insertRow(h.client, 'FbaProduct', {
      id: 'p-other',
      tenantId: otherTenantId,
      sellerAccountId: b.sellerAccountId,
      marketplaceId: US,
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAAA',
      title: '别的企业',
      sourceUpdatedAt: new Date().toISOString(),
    })

    // 销售：ASIN A 过去 95 天每天 10 件 20 美元（窗口 [今天-29, 今天] 内是 29 天 → 290 件、580 美元）；窗口外与别的企业不计入
    for (let day = 1; day <= 95; day += 1) await sales(`s-a-${day}`, storeA, 'B0AAAAAAAA', dayText(-day), 10, 20)
    await sales('s-d', storeB, 'B0DDDDDDDD', dayText(-1), 1, 10)
    await sales('s-o', b.sellerAccountId, 'B0AAAAAAAA', dayText(-1), 999, 9999, otherTenantId)

    // 利润：SKU-A 两天各收入 100、利润 25（25%）；SKU-C 缺成本；店铺级行不并入商品
    await profit('pd-1', storeA, 'SKU-A', dayText(-1), { asin: 'B0AAAAAAAA', units: 5, costedUnits: 5, revenue: 100, profit: 25 })
    await profit('pd-2', storeA, 'SKU-A', dayText(-2), { asin: 'B0AAAAAAAA', units: 5, costedUnits: 5, revenue: 100, profit: 25 })
    await profit('pd-3', storeA, 'SKU-C', dayText(-1), { asin: 'B0CCCCCCCC', units: 2, costedUnits: 0, revenue: 50, profit: null })
    await profit('pd-4', storeA, '__STORE__', dayText(-1), { revenue: 0, profit: -5 })

    // 库存与规则：SKU-A 可售 100 + 计入在途 30，日销 10 → 可售天数 13 < 提前期 30 → 高风险
    await insertRow(h.client, 'FbaInventoryRecord', {
      id: 'inv-a',
      tenantId,
      sellerAccountId: storeA,
      marketplaceId: US,
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAAA',
      fulfillableQuantity: 100,
      inboundWorkingQuantity: 10,
      inboundShippedQuantity: 20,
    })
    await insertRow(h.client, 'ReplenishmentPolicy', {
      id: 'rp-1',
      tenantId,
      versionNo: 1,
      leadTimeDays: 30,
      safetyDays: 14,
      coverageDays: 60,
      redundancyMultiplier: 1.5,
      effectiveFrom: '2026-01-01',
      changeReason: '测试',
      createdBy: owner.userId,
    })
    await insertRow(h.client, 'Watch', { id: 'w-1', tenantId, userId: owner.userId, entityType: 'ASIN', entityId: 'p1' })
  })

  afterAll(async () => {
    await h?.close()
  })

  describe('列表', () => {
    it('汇总：近 30 天销量与销售额、利润率、可售数量、负责人与标签；没有记录是 null 不是 0', async () => {
      const data = await get(owner, '/products')
      expect(ids(data).sort()).toEqual(['p1', 'p2', 'p3', 'p4'])
      expect(data).toMatchObject({ state: 'OK', currency: 'USD', canWrite: true, truncated: false, window: { days: 30 }, stock: { state: 'OK' }, profit: { state: 'OK' } })
      expect(rowOf(data, 'p1')).toMatchObject({
        sku: 'SKU-A',
        storeName: expect.any(String),
        sales30: 580,
        units30: 290,
        salesShared: true,
        margin30: 0.25,
        marginState: 'OK',
        sellable: 100,
        tags: ['热销'],
        ownerUserId: owner.userId,
        ownerName: expect.any(String),
        watched: true,
        version: 1,
        catalogState: 'NOT_SYNCED',
      })
      // 同 ASIN 的另一个 SKU 共用销售；没有自己的利润记录与库存记录
      expect(rowOf(data, 'p2')).toMatchObject({ sales30: 580, salesShared: true, margin30: null, marginState: 'NO_RECORD', sellable: null, watched: false })
      // 没有销售：销量与销售额是 null；缺成本：利润率 null 与原因
      expect(rowOf(data, 'p3')).toMatchObject({ sales30: null, units30: null, margin30: null, marginState: 'COST_MISSING', salesShared: false, catalogState: 'NOT_FOUND' })
      expect(rowOf(data, 'p4')).toMatchObject({ sales30: 10, units30: 1, salesShared: false })
      expect(data.filterOptions).toMatchObject({ brands: ['Acme', 'Zeta'], categories: ['Home > Kitchen'], statuses: ['ACTIVE', 'INACTIVE'], tags: ['热销'] })
      expect(data.members.length).toBeGreaterThanOrEqual(3)
      expect(data.freshness).toBeDefined()
    })

    it('排序：数值列没有值的永远在最后（升降序都一样）；字段不在白名单 422', async () => {
      const desc = ids(await get(owner, '/products?sort=sales30:desc'))
      expect(desc[desc.length - 1]).toBe('p3')
      expect(desc.slice(0, 2).sort()).toEqual(['p1', 'p2'])
      const asc = ids(await get(owner, '/products?sort=sales30:asc'))
      expect(asc[asc.length - 1]).toBe('p3')
      expect(asc[0]).toBe('p4')
      expect(ids(await get(owner, '/products?sort=sku:asc'))).toEqual(['p1', 'p2', 'p3', 'p4'])
      expect(ids(await get(owner, '/products?sort=price:desc'))).toEqual(['p1', 'p4', 'p2', 'p3'])
      expect((await h.call(owner.token, 'GET', '/products?sort=password:asc')).status).toBe(422)
    })

    it('筛选：搜索、品牌、状态、配送、标签、负责人、父 ASIN、类目、已关注，可以组合', async () => {
      expect(ids(await get(owner, '/products?q=sku-a'))).toEqual(expect.arrayContaining(['p1', 'p2']))
      expect(ids(await get(owner, '/products?q=没有销售')).sort()).toEqual(['p3'])
      expect(ids(await get(owner, '/products?q=B0DDDD')).sort()).toEqual(['p4'])
      expect(ids(await get(owner, '/products?brand=zeta'))).toEqual(['p3'])
      expect(ids(await get(owner, '/products?status=INACTIVE'))).toEqual(['p3'])
      expect(ids(await get(owner, '/products?fulfillment=MFN'))).toEqual(['p2'])
      expect(ids(await get(owner, '/products?tag=热销'))).toEqual(['p1'])
      expect(ids(await get(owner, `/products?ownerId=${owner.userId}`))).toEqual(['p1'])
      expect(ids(await get(owner, '/products?parentAsin=B0PARENT01'))).toEqual(['p1'])
      expect(ids(await get(owner, `/products?category=${encodeURIComponent('Home > Kitchen')}`)).sort()).toEqual(['p1', 'p2'])
      expect(ids(await get(owner, '/products?watched=true'))).toEqual(['p1'])
      expect(ids(await get(owner, '/products?watched=false')).sort()).toEqual(['p2', 'p3', 'p4'])
      expect(ids(await get(owner, '/products?brand=Acme&fulfillment=AFN')).sort()).toEqual(['p1', 'p4'])
      expect(ids(await get(owner, '/products?brand=Acme&fulfillment=AFN&watched=false'))).toEqual(['p4'])
      // 没有符合条件：有商品但被筛空，给出筛选提示而不是“未连接”
      const empty = await get(owner, '/products?brand=不存在')
      expect(empty).toMatchObject({ state: 'NO_DATA', items: [] })
      expect(empty.note).toContain('筛选')
    })

    it('偏移游标：逐页取全；改了筛选或排序再用旧游标是 400', async () => {
      const first = await get(owner, '/products?pageSize=3&sort=sku:asc')
      expect(first.pageInfo).toMatchObject({ hasMore: true })
      expect(ids(first)).toEqual(['p1', 'p2', 'p3'])
      const cursor = encodeURIComponent(first.pageInfo.nextCursor)
      const second = await get(owner, `/products?pageSize=3&sort=sku:asc&cursor=${cursor}`)
      expect(ids(second)).toEqual(['p4'])
      expect(second.pageInfo.hasMore).toBe(false)
      expect((await h.call(owner.token, 'GET', `/products?pageSize=3&sort=sku:desc&cursor=${cursor}`)).status).toBe(400)
      expect((await h.call(owner.token, 'GET', `/products?pageSize=3&sort=sku:asc&brand=Acme&cursor=${cursor}`)).status).toBe(400)
      expect((await h.call(outsider.token, 'GET', `/products?pageSize=3&sort=sku:asc&cursor=${cursor}`)).status).toBe(400)
      expect((await h.call(owner.token, 'GET', '/products?cursor=garbage')).status).toBe(400)
    })

    it('库存风险筛选：用库存健康页同一套规则；需要库存读取权限', async () => {
      expect(ids(await get(owner, '/products?risk=HIGH'))).toEqual(['p1'])
      expect(ids(await get(owner, '/products?risk=NORMAL'))).toEqual([])
      expect(ids(await get(owner, '/products?risk=HIGH&brand=Zeta'))).toEqual([])
      expect((await h.call(reader.token, 'GET', '/products?risk=HIGH')).status).toBe(403)
      expect((await h.call(owner.token, 'GET', '/products?risk=SEVERE')).status).toBe(422)
    })

    it('权限：只有商品读取权限时看不到库存与利润，列里没有这两项；没有读取权限 403', async () => {
      const data = await get(reader, '/products')
      expect(data).toMatchObject({ canWrite: false, members: [], stock: { state: 'RESTRICTED' }, profit: { state: 'RESTRICTED' } })
      const row = rowOf(data, 'p1')
      expect(row.sellable).toBeNull()
      expect(row).not.toHaveProperty('margin30')
      expect(row.sales30).toBe(580)
      const none = await h.createMember(tenantId, 'pl-none', ['overview.read'])
      expect((await h.call(none.token, 'GET', '/products?sort=bad')).status).toBe(403)
      expect((await h.call(null, 'GET', '/products')).status).toBe(401)
    })

    it('数据范围与企业隔离：只授权店铺 B 的成员只看到店铺 B；别的企业看不到本企业', async () => {
      const scoped = await get(scopedB, '/products')
      expect(ids(scoped)).toEqual(['p4'])
      const other = await get(outsider, '/products')
      expect(ids(other)).toEqual(['p-other'])
      expect(rowOf(other, 'p-other').sales30).toBe(9999)
      expect(other.filterOptions.brands).toEqual([])
    })
  })

  describe('批量设置负责人与标签', () => {
    it('没有变更权限 403（先于参数校验）；参数不合法 422', async () => {
      expect((await patch(reader, { items: [{ id: 'p1', version: 1 }], tags: { mode: 'ADD', values: ['x'] } })).status).toBe(403)
      expect((await patch(reader, {})).status).toBe(403)
      expect((await patch(writer, {})).status).toBe(422)
      expect((await patch(writer, { items: [{ id: 'p1', version: 1 }] })).status).toBe(422)
      expect((await patch(writer, { items: [{ id: 'p1' }], ownerId: null })).status).toBe(422)
      expect((await patch(writer, { items: [{ id: 'p1', version: 1 }], tags: { mode: 'DROP', values: [] } })).status).toBe(422)
    })

    it('标签含逗号、同一商品重复、负责人不是本企业成员：409，没有任何修改', async () => {
      expect((await patch(writer, { items: [{ id: 'p2', version: 1 }], tags: { mode: 'ADD', values: ['a,b'] } })).status).toBe(409)
      expect(
        (
          await patch(writer, {
            items: [
              { id: 'p2', version: 1 },
              { id: 'p2', version: 1 },
            ],
            ownerId: null,
          })
        ).status,
      ).toBe(409)
      expect((await patch(writer, { items: [{ id: 'p2', version: 1 }], ownerId: outsider.userId })).status).toBe(409)
      expect(await dbTags('p2')).toMatchObject({ tagIds: [], ownerUserId: null, version: 1 })
    })

    it('追加标签并指派负责人：版本加一，审计与变更记录各一条；列表可按新标签筛选，ASIN 360 变更页签能看到', async () => {
      const res = await patch(writer, {
        items: [
          { id: 'p2', version: 1 },
          { id: 'p3', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['新品', '促销'] },
        ownerId: writer.userId,
      })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.data).toMatchObject({ updated: 2, unchanged: 0 })
      expect(res.json.data.items.find((item: { id: string }) => item.id === 'p2')).toMatchObject({ version: 2, tags: ['新品', '促销'], ownerId: writer.userId })
      expect(await dbTags('p3')).toMatchObject({ tagIds: ['新品', '促销'], ownerUserId: writer.userId, version: 2 })
      const audits = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "action" = 'PRODUCT_META_UPDATED' AND "result" = 'SUCCEEDED' AND "tenantId" = $1`, [tenantId])
      expect(audits.rows[0].n).toBe(2)
      const events = await h.client.query(`SELECT "title", "sellerAccountId" FROM "EntityEvent" WHERE "entityType" = 'ASIN' AND "entityId" = 'p2' AND "kind" = 'product.meta'`)
      expect(events.rows).toHaveLength(1)
      expect(events.rows[0].title).toContain('新品')
      expect(events.rows[0].sellerAccountId).toBe(storeA)
      expect(ids(await get(owner, '/products?tag=新品')).sort()).toEqual(['p2', 'p3'])
      expect(ids(await get(owner, `/products?ownerId=${writer.userId}`)).sort()).toEqual(['p2', 'p3'])
      expect(rowOf(await get(owner, '/products?tag=新品'), 'p2').version).toBe(2)
      const changes = await get(owner, '/products/p2/changes')
      expect(JSON.stringify(changes)).toContain('负责人与标签')
    })

    it('版本已被推进：409，整批没有修改', async () => {
      const res = await patch(writer, {
        items: [
          { id: 'p1', version: 1 },
          { id: 'p2', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['冲突'] },
      })
      expect(res.status).toBe(409)
      expect(ids(await get(owner, '/products?tag=冲突'))).toEqual([])
      expect((await dbTags('p1')).version).toBe(1)
    })

    it('整批全有或全无：含范围外商品、别的企业的商品或不存在的商品时 404', async () => {
      const mixed = await patch(scopedB, {
        items: [
          { id: 'p4', version: 1 },
          { id: 'p1', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['越权'] },
      })
      expect(mixed.status).toBe(404)
      expect((await dbTags('p4')).tagIds).toEqual([])
      expect((await patch(writer, { items: [{ id: 'p-other', version: 1 }], tags: { mode: 'ADD', values: ['越权'] } })).status).toBe(404)
      expect((await patch(writer, { items: [{ id: 'nope', version: 1 }], tags: { mode: 'ADD', values: ['越权'] } })).status).toBe(404)
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "FbaProduct" WHERE 'xx' = ANY("tagIds") OR '越权' = ANY("tagIds")`)).rows[0].n).toBe(0)
    })

    it('移除标签、清空负责人、整体替换；没有变化的商品不涨版本', async () => {
      const unchanged = await patch(writer, { items: [{ id: 'p2', version: 2 }], tags: { mode: 'ADD', values: ['新品'] } })
      expect(unchanged.json.data).toMatchObject({ updated: 0, unchanged: 1 })
      expect(unchanged.json.data.items[0].version).toBe(2)
      const cleared = await patch(writer, { items: [{ id: 'p2', version: 2 }], tags: { mode: 'REMOVE', values: ['促销'] }, ownerId: null })
      expect(cleared.json.data.items[0]).toMatchObject({ version: 3, tags: ['新品'], ownerId: null })
      const replaced = await patch(writer, { items: [{ id: 'p2', version: 3 }], tags: { mode: 'SET', values: [] } })
      expect(replaced.json.data.items[0]).toMatchObject({ version: 4, tags: [] })
    })
  })

  describe('同步商品目录', () => {
    it('权限：没有同步管理权限 403，先于参数校验', async () => {
      expect((await post(writer, { storeIds: [storeA] })).status).toBe(403)
      expect((await post(writer, {})).status).toBe(403)
      expect((await post(syncer, {})).status).toBe(422)
      expect((await post(syncer, { storeIds: [] })).status).toBe(422)
    })

    it('店铺没有已授权的连接：跳过并说明原因，不创建任务', async () => {
      const res = await post(syncer, { storeIds: [storeA] })
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data.jobs).toEqual([])
      expect(res.json.data.skipped).toEqual([{ storeId: storeA, storeName: expect.any(String), reason: expect.stringContaining('没有已授权') }])
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "SyncJob" WHERE "type" = 'CATALOG_SYNC'`)).rows[0].n).toBe(0)
    })

    it('有授权连接：创建目录同步任务并入队；再点一次返回同一个任务（去重）', async () => {
      await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, sellerAccountId: storeA, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', grantedScopes: JSON.stringify([]) })
      const first = await post(syncer, { storeIds: [storeA, storeA] })
      expect(first.status, JSON.stringify(first.json)).toBe(201)
      expect(first.json.data.jobs).toHaveLength(1)
      expect(first.json.data.jobs[0]).toMatchObject({ storeId: storeA, jobId: expect.any(String) })
      const jobs = await h.client.query(`SELECT "id", "status", "connectionId" FROM "SyncJob" WHERE "type" = 'CATALOG_SYNC'`)
      expect(jobs.rows).toEqual([{ id: first.json.data.jobs[0].jobId, status: 'PENDING', connectionId: 'conn-a' }])
      const again = await post(syncer, { storeIds: [storeA] })
      expect(again.json.data.jobs[0].jobId).toBe(first.json.data.jobs[0].jobId)
      expect((await h.client.query(`SELECT count(*)::int AS n FROM "SyncJob" WHERE "type" = 'CATALOG_SYNC'`)).rows[0].n).toBe(1)
      const audits = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "action" = 'PRODUCT_CATALOG_SYNC_REQUESTED' AND "tenantId" = $1`, [tenantId])
      expect(audits.rows[0].n).toBeGreaterThanOrEqual(2)
    })

    it('范围外或不存在的店铺、别的企业的店铺一律 404，不发起任何同步', async () => {
      expect((await post(scopedB, { storeIds: [storeA] })).status).toBe(404)
      expect((await post(syncer, { storeIds: ['seller-nope'] })).status).toBe(404)
      expect((await post(syncer, { storeIds: [storeA, 'seller-pl-b'] })).status).toBe(404)
      expect((await post(outsider, { storeIds: [storeA] })).status).toBe(404)
    })
  })
})
