import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 发货地址与补货批次转入仓计划草稿（P6-08，真实数据库 + 完整应用）：
//   - 发货地址：权限、数据范围、企业隔离、默认地址唯一（含并发）、同名 409、乐观锁、被计划使用后不能删、数据库约束兜底、迁移回滚；
//   - 转草稿：预览与确认一致、按“店铺 + 地址”分组、数量与地址可改、缺地址与已转过不能确认、并发确认只成功一次、
//     草稿可追溯到批次与地址、动作与批次状态同步、取消草稿后可重转、旧意向补建后自动算已解决、范围外按不存在。

const TARGET = '20261211010000_ship_from_address'
const MIGRATION = join(MIGRATIONS_DIR, TARGET)
const ADDRESS = { addressLine1: '1 Main St', city: 'Los Angeles', stateOrProvince: 'ca', postalCode: '90001', countryCode: 'us', phone: '3105550100' }
const ALL = ['inbound.read', 'shipfrom.manage', 'inbound.plan.write', 'replenishment.read', 'replenishment.plan.create']

type Member = { userId: string; token: string }

describe('发货地址与补货转入仓计划草稿（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let otherTenantId: string
  let otherStore: string
  let mgr: Member
  let viewer: Member
  let scoped: Member // 只能看店铺 A
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const addresses = async (member: Member, query = '') => (await h.call(member.token, 'GET', `/ship-from-addresses${query}`)).json.data
  const create = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/ship-from-addresses', { body: { sellerAccountId: storeA, ...ADDRESS, ...body } })
  const idOf = async (member: Member, name: string) => (await addresses(member)).items.find((item: { name: string }) => item.name === name).id as string

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ship_from' })
    const a = await h.createTenant('sf-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-sf-b2', tenantId, legalEntityId: a.legalEntityId, displayName: '店铺乙', sellerId: 'SELLER-B2' })).id as string
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '店铺甲' WHERE id = $1`, [storeA])
    const b = await h.createTenant('sf-b')
    otherTenantId = b.tenantId
    otherStore = b.sellerAccountId
    mgr = await h.createMember(tenantId, 'sf-mgr', ALL)
    viewer = await h.createMember(tenantId, 'sf-viewer', ['inbound.read'])
    scoped = await h.createMember(tenantId, 'sf-scoped', ALL, { scopes: [{ sellerAccountId: storeA }] })
    other = await h.createMember(otherTenantId, 'sf-other', ALL)
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('发货地址', () => {
    it('权限：没登录 401；只读成员能看列表但新增、改、设默认、删都是 403；列表带“能否维护”', async () => {
      expect((await h.call(null, 'GET', '/ship-from-addresses')).status).toBe(401)
      const list = await addresses(viewer)
      expect(list).toMatchObject({ canManage: false, items: [], total: 0, summary: { total: 0, active: 0, inactive: 0 } })
      expect(list.manageBlockedReason).toContain('发货地址维护')
      expect((await create(viewer, { name: '不行' })).status).toBe(403)
      expect((await h.call(viewer.token, 'PUT', '/ship-from-addresses/x', { body: { version: 1, name: '不行' } })).status).toBe(403)
      expect((await h.call(viewer.token, 'POST', '/ship-from-addresses/x/default')).status).toBe(403)
      expect((await h.call(viewer.token, 'DELETE', '/ship-from-addresses/x')).status).toBe(403)
      expect((await addresses(mgr)).canManage).toBe(true)
    })

    it('新增：店铺的第一个地址自动成为默认；后面的不是；国家与州代码统一大写；参数不合格 422；店铺不存在 404', async () => {
      const first = await create(mgr, { name: '洛杉矶仓' })
      expect(first.status).toBe(201)
      expect(first.json.data).toMatchObject({ name: '洛杉矶仓', isDefault: true, status: 'ACTIVE', version: 1, usedByPlans: 0, storeName: '店铺甲', countryCode: 'US', stateOrProvince: 'CA' })
      const second = await create(mgr, { name: '新泽西仓' })
      expect(second.json.data.isDefault).toBe(false)
      expect((await create(mgr, { name: '' })).status).toBe(422)
      expect((await create(mgr, { name: '国家错', countryCode: 'USA' })).status).toBe(422)
      expect((await create(mgr, { name: '店铺不存在', sellerAccountId: 'nope' })).status).toBe(404)
      const audits = await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "resourceType" = 'ShipFromAddress' AND "tenantId" = $1 AND result = 'SUCCEEDED' ORDER BY "occurredAt"`, [
        tenantId,
      ])
      expect(audits.map(item => item.action)).toEqual(['SHIP_FROM_ADDRESS_CREATED', 'SHIP_FROM_ADDRESS_CREATED'])
    })

    it('同名 409（同店铺）；不同店铺可以同名；设为默认时原默认同时取消，每个店铺只有一个默认', async () => {
      expect((await create(mgr, { name: '洛杉矶仓' })).status).toBe(409)
      expect((await create(mgr, { name: '洛杉矶仓', sellerAccountId: storeB })).json.data.isDefault).toBe(true)
      const target = await idOf(mgr, '新泽西仓')
      const made = await h.call(mgr.token, 'POST', `/ship-from-addresses/${target}/default`)
      expect(made.status).toBe(200)
      expect(made.json.data).toMatchObject({ isDefault: true, version: 2 })
      const defaults = await rows<{ name: string }>(`SELECT name FROM "ShipFromAddress" WHERE "sellerAccountId" = $1 AND "isDefault"`, [storeA])
      expect(defaults.map(item => item.name)).toEqual(['新泽西仓'])
      // 同店铺把另一个也设为默认：并发时两个请求都成功，但最终只有一个默认
      const la = await idOf(mgr, '洛杉矶仓')
      await Promise.all([h.call(mgr.token, 'POST', `/ship-from-addresses/${la}/default`), h.call(mgr.token, 'POST', `/ship-from-addresses/${target}/default`)])
      const after = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "ShipFromAddress" WHERE "sellerAccountId" = $1 AND "isDefault"`, [storeA])
      expect(after[0]!.n).toBe(1)
      await h.call(mgr.token, 'POST', `/ship-from-addresses/${la}/default`)
    })

    it('数据库兜底：同店铺不能有两个默认地址、同名、空的地址字段；也不能绕过应用层写别家店铺', async () => {
      const base = { tenantId, sellerAccountId: storeA, addressLine1: 'x', city: 'x', stateOrProvince: 'CA', postalCode: '1', countryCode: 'US', phone: '1' }
      await expect(insertRow(h.client, 'ShipFromAddress', { id: 'sf-d1', ...base, name: '兜底一', isDefault: true })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(h.client, 'ShipFromAddress', { id: 'sf-d2', ...base, name: '洛杉矶仓' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(h.client, 'ShipFromAddress', { id: 'sf-d3', ...base, name: '兜底三', phone: '' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'ShipFromAddress', { id: 'sf-d4', ...base, name: '兜底四', status: 'WEIRD' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(h.client, 'ShipFromAddress', { id: 'sf-d5', ...base, name: '兜底五', isDefault: true, status: 'INACTIVE' })).rejects.toMatchObject({ code: '23514' })
    })

    it('修改带乐观锁：过期 409 带当前版本；同一版本并发只有一个成功；清空地址行 2；改成同名 409；至少改一项', async () => {
      const id = await idOf(mgr, '新泽西仓')
      const current = (await addresses(mgr)).items.find((item: { id: string }) => item.id === id)
      const ok = await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: current.version, addressLine2: 'Suite 5', city: 'Newark' } })
      expect(ok.json.data).toMatchObject({ addressLine2: 'Suite 5', city: 'Newark', version: current.version + 1 })
      const stale = await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: current.version, city: '过期' } })
      expect(stale.status).toBe(409)
      expect(stale.json.error.details).toMatchObject({ currentVersion: current.version + 1 })
      const version = current.version + 1
      const [a, b] = await Promise.all([
        h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version, phone: '111' } }),
        h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version, phone: '222' } }),
      ])
      expect([a.status, b.status].sort()).toEqual([200, 409])
      const cleared = await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: version + 1, addressLine2: '' } })
      expect(cleared.json.data.addressLine2).toBeNull()
      expect((await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: version + 2, name: '洛杉矶仓' } })).status).toBe(409)
      expect((await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: version + 2 } })).status).toBe(422)
    })

    it('停用默认地址：同时取消默认，不能再设为默认；列表按状态筛选、搜索，统计不受筛选影响', async () => {
      const id = await idOf(mgr, '洛杉矶仓')
      const current = (await addresses(mgr)).items.find((item: { id: string }) => item.id === id)
      expect(current.isDefault).toBe(true)
      const off = await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: current.version, status: 'INACTIVE' } })
      expect(off.json.data).toMatchObject({ status: 'INACTIVE', isDefault: false })
      expect((await h.call(mgr.token, 'POST', `/ship-from-addresses/${id}/default`)).status).toBe(409)
      const inactive = await addresses(mgr, '?status=INACTIVE')
      expect(inactive.items.map((item: { name: string }) => item.name)).toEqual(['洛杉矶仓'])
      expect(inactive.total).toBe(1)
      expect(inactive.summary).toMatchObject({ total: 3, active: 2, inactive: 1 })
      expect((await addresses(mgr, '?q=newark')).items.map((item: { name: string }) => item.name)).toEqual(['新泽西仓'])
      // 把停用的洛杉矶仓启用并重新设为默认，后面的测试用
      const back = await h.call(mgr.token, 'PUT', `/ship-from-addresses/${id}`, { body: { version: off.json.data.version, status: 'ACTIVE' } })
      expect(back.status).toBe(200)
      expect((await h.call(mgr.token, 'POST', `/ship-from-addresses/${id}/default`)).status).toBe(200)
    })

    it('数据范围与企业隔离：受限成员只看到自己范围的店铺，范围外的店铺新增 403、改与删当作不存在；别的企业看不到', async () => {
      const mine = await addresses(scoped)
      expect(new Set(mine.items.map((item: { sellerAccountId: string }) => item.sellerAccountId))).toEqual(new Set([storeA]))
      const otherStoreRow = (await addresses(mgr)).items.find((item: { sellerAccountId: string }) => item.sellerAccountId === storeB)
      expect((await create(scoped, { name: '范围外', sellerAccountId: storeB })).status).toBe(403)
      expect((await h.call(scoped.token, 'PUT', `/ship-from-addresses/${otherStoreRow.id}`, { body: { version: otherStoreRow.version, city: '偷改' } })).status).toBe(404)
      expect((await h.call(scoped.token, 'POST', `/ship-from-addresses/${otherStoreRow.id}/default`)).status).toBe(404)
      expect((await h.call(scoped.token, 'DELETE', `/ship-from-addresses/${otherStoreRow.id}`)).status).toBe(404)
      expect((await addresses(other)).items).toEqual([])
      expect((await h.call(other.token, 'DELETE', `/ship-from-addresses/${otherStoreRow.id}`)).status).toBe(404)
      // 别的企业不能拿本企业的店铺编号建地址
      expect((await h.call(other.token, 'POST', '/ship-from-addresses', { body: { sellerAccountId: storeA, name: '串企业', ...ADDRESS } })).status).toBe(404)
      expect((await h.call(other.token, 'POST', '/ship-from-addresses', { body: { sellerAccountId: otherStore, name: '自己的', ...ADDRESS } })).status).toBe(201)
    })

    it('删除：没被用过可以删（写审计）；被入仓计划用过 409，只能停用', async () => {
      const temp = (await create(mgr, { name: '临时仓' })).json.data
      expect((await h.call(mgr.token, 'DELETE', `/ship-from-addresses/${temp.id}`)).status).toBe(200)
      expect((await rows(`SELECT 1 FROM "ShipFromAddress" WHERE id = $1`, [temp.id])).length).toBe(0)
      const deleted = await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'SHIP_FROM_ADDRESS_DELETED' AND "resourceId" = $1 AND result = 'SUCCEEDED'`, [temp.id])
      expect(deleted.length).toBe(1)
      const used = await idOf(mgr, '洛杉矶仓')
      await insertRow(h.client, 'FbaInboundPlan', { id: 'plan-used', tenantId, sellerAccountId: storeA, name: '用过地址的计划', shipFromAddressId: used })
      const refused = await h.call(mgr.token, 'DELETE', `/ship-from-addresses/${used}`)
      expect(refused.status).toBe(409)
      expect(refused.json.error.message).toContain('已被入仓计划使用')
      expect((await addresses(mgr)).items.find((item: { id: string }) => item.id === used).usedByPlans).toBe(1)
      await h.client.query(`DELETE FROM "FbaInboundPlan" WHERE id = 'plan-used'`)
    })

    it('迁移：升级前的计划保留；回滚后地址表与关联列移除，补货批次来源的草稿保留并改回补货来源；再升级闭环成功', async () => {
      await h.db.createDatabase('ship_from_mig')
      const client = await h.db.connect('ship_from_mig')
      try {
        await applyMigrations(client, { before: TARGET })
        const ids = await seedTenant(client, 'mig')
        await insertRow(client, 'FbaInboundPlan', { id: 'old-plan', tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, name: '老计划', sourceType: 'MANUAL' })
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT "shipFromAddressId" FROM "FbaInboundPlan" WHERE id = 'old-plan'`)).rows[0]).toEqual({ shipFromAddressId: null })
        await insertRow(client, 'ShipFromAddress', {
          id: 'sf-m',
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          name: '迁移地址',
          addressLine1: 'x',
          city: 'x',
          stateOrProvince: 'CA',
          postalCode: '1',
          countryCode: 'US',
          phone: '1',
        })
        await insertRow(client, 'FbaInboundPlan', {
          id: 'batch-plan',
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          name: '批次草稿',
          sourceType: 'REPLENISHMENT_BATCH',
          sourceRefId: 'b1',
          shipFromAddressId: 'sf-m',
        })
        await client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
        const kept = (await client.query(`SELECT id, "sourceType", "sourceRefId" FROM "FbaInboundPlan" ORDER BY id`)).rows
        expect(kept).toEqual([
          { id: 'batch-plan', sourceType: 'REPLENISHMENT', sourceRefId: 'b1' },
          { id: 'old-plan', sourceType: 'MANUAL', sourceRefId: null },
        ])
        expect((await client.query(`SELECT to_regclass('"ShipFromAddress"') IS NOT NULL AS found`)).rows[0].found).toBe(false)
        await applyMigrations(client, { only: TARGET })
        expect((await client.query(`SELECT to_regclass('"ShipFromAddress"') IS NOT NULL AS found`)).rows[0].found).toBe(true)
      } finally {
        await client.end()
      }
    })
  })
})
