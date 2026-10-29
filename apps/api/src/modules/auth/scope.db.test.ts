import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'

const TARGET = '20261021040000_membership_scope'

// P1-12 数据范围权限（真实数据库）：请求携带未授权的店铺时，不返回该店铺的数据。
describe('数据范围权限（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('接口：成员只能看到授权范围内的店铺数据', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof seedTenant>>
    const tokens: Record<string, string> = {}

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'scope_api' })
      tenant = await h.createTenant('a')
      const other = await h.createTenant('b')
      // 主体 le-a 下两家店（seller-a、seller-a2），第二个主体 le-a2 下一家店（seller-a3）
      const entity2 = await insertRow(h.client, 'LegalEntity', { id: 'le-a2', tenantId: tenant.tenantId, name: '第二法律主体' })
      const stores = [
        { id: 'seller-a2', entity: tenant.legalEntityId },
        { id: 'seller-a3', entity: entity2.id as string },
      ]
      for (const store of stores) {
        await insertRow(h.client, 'SellerAccount', { id: store.id, tenantId: tenant.tenantId, legalEntityId: store.entity, sellerId: `SID-${store.id}`, logicalRegion: 'NA' })
      }
      const orderStores: [string, string, string][] = [
        [tenant.tenantId, tenant.sellerAccountId, 'A1'],
        [tenant.tenantId, 'seller-a2', 'A2'],
        [tenant.tenantId, 'seller-a3', 'A3'],
        [other.tenantId, other.sellerAccountId, 'B1'],
      ]
      for (const [tenantId, sellerAccountId, label] of orderStores) {
        await insertRow(h.client, 'Order', {
          id: `order-${label}`,
          tenantId,
          sellerAccountId,
          amazonOrderId: `111-0000000-${label}`,
          // 订单列表未选日期范围时默认只看最近 30 天（P2b-01），造数取三天前
          purchaseDate: new Date(Date.now() - 3 * 86400000).toISOString(),
          marketplaceId: 'ATVPDKIKX0DER',
        })
      }
      // 三个广告账户：绑定 seller-a、绑定 seller-a3、未绑定
      const profiles: [string, string | null][] = [
        ['ap-a', tenant.sellerAccountId],
        ['ap-a3', 'seller-a3'],
        ['ap-none', null],
      ]
      for (const [id, sellerAccountId] of profiles) {
        await insertRow(h.client, 'AdsProfile', { id, tenantId: tenant.tenantId, profileId: `P-${id}`, sellerAccountId, bindingStatus: sellerAccountId ? 'MANUAL' : 'UNBOUND' })
        await insertRow(h.client, 'AdsCampaign', {
          id: `camp-${id}`,
          tenantId: tenant.tenantId,
          adsProfileId: id,
          externalCampaignId: `C-${id}`,
          adProduct: 'SPONSORED_PRODUCTS',
          sourceUpdatedAt: '2026-03-01T00:00:00Z',
        })
      }
      const perms = ['orders.read', 'seller.read', 'ads.read']
      tokens.full = (await h.createMember(tenant.tenantId, 'full', perms)).token
      tokens.store = (await h.createMember(tenant.tenantId, 'store', perms, { scopes: [{ sellerAccountId: tenant.sellerAccountId }] })).token
      tokens.entity = (await h.createMember(tenant.tenantId, 'entity', perms, { scopes: [{ legalEntityId: tenant.legalEntityId }] })).token
      tokens.none = (await h.createMember(tenant.tenantId, 'none', perms, { scopes: [] })).token
    })
    afterAll(async () => {
      await h?.close()
    })

    const orderIds = (res: { json: any }) => res.json.data.items.map((item: any) => item.id).sort()

    it('全部范围：看到本租户全部店铺，不含别的租户；可用 storeIds 主动收窄', async () => {
      const res = await h.call(tokens.full, 'GET', '/orders')
      expect(orderIds(res)).toEqual(['order-A1', 'order-A2', 'order-A3'])
      expect(orderIds(await h.call(tokens.full, 'GET', '/orders?storeIds=seller-a3'))).toEqual(['order-A3'])
      expect(orderIds(await h.call(tokens.full, 'GET', '/orders?legalEntityIds=le-a2'))).toEqual(['order-A3'])
    })

    it('指定店铺授权：只看到该店铺；请求别的店铺得到 403 且没有数据', async () => {
      expect(orderIds(await h.call(tokens.store, 'GET', '/orders'))).toEqual(['order-A1'])
      const denied = await h.call(tokens.store, 'GET', '/orders?storeIds=seller-a3')
      expect(denied.status).toBe(403)
      expect(denied.json.error.code).toBe('SCOPE_EMPTY')
      expect(JSON.stringify(denied.json)).not.toContain('order-A3')
    })

    it('请求里混有未授权店铺时，未授权的被静默剔除', async () => {
      const res = await h.call(tokens.store, 'GET', `/orders?storeIds=${tenant.sellerAccountId},seller-a3`)
      expect(res.status).toBe(200)
      expect(orderIds(res)).toEqual(['order-A1'])
      expect(res.json.data.items).toHaveLength(1)
    })

    it('按主体授权：看到该主体下全部店铺，看不到其他主体', async () => {
      expect(orderIds(await h.call(tokens.entity, 'GET', '/orders'))).toEqual(['order-A1', 'order-A2'])
      expect((await h.call(tokens.entity, 'GET', '/orders?legalEntityIds=le-a2')).status).toBe(403)
    })

    it('没有任何授权：403 SCOPE_NOT_GRANTED（不默认放开）', async () => {
      const res = await h.call(tokens.none, 'GET', '/orders')
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('SCOPE_NOT_GRANTED')
    })

    it('别的租户的店铺编号不会带出数据', async () => {
      const res = await h.call(tokens.full, 'GET', '/orders?storeIds=seller-b')
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('SCOPE_EMPTY')
    })

    it('订单明细：范围外的订单与不存在一样返回 404', async () => {
      expect((await h.call(tokens.store, 'GET', '/orders/order-A1/items')).status).toBe(200)
      expect((await h.call(tokens.store, 'GET', '/orders/order-A3/items')).status).toBe(404)
      expect((await h.call(tokens.full, 'GET', '/orders/order-A3/items')).status).toBe(200)
    })

    it('站点只支持亚马逊美国站：其他站点 422', async () => {
      expect((await h.call(tokens.full, 'GET', '/orders?marketplaceId=A2EUQ1WTGCTBG2')).status).toBe(422)
      expect((await h.call(tokens.full, 'GET', '/orders?marketplaceId=ATVPDKIKX0DER')).status).toBe(200)
    })

    it('广告数据经广告账户绑定的店铺过滤；未绑定的广告账户只有“全部范围”的成员可见', async () => {
      const campaigns = (res: { json: any }) => res.json.data.items.map((item: any) => item.id).sort()
      expect(campaigns(await h.call(tokens.full, 'GET', '/ads/campaigns'))).toEqual(['camp-ap-a', 'camp-ap-a3', 'camp-ap-none'])
      expect(campaigns(await h.call(tokens.store, 'GET', '/ads/campaigns'))).toEqual(['camp-ap-a'])
      expect(campaigns(await h.call(tokens.entity, 'GET', '/ads/campaigns'))).toEqual(['camp-ap-a'])
      const profiles = await h.call(tokens.store, 'GET', '/ads/profiles')
      expect(profiles.json.data.map((item: any) => item.id)).toEqual(['ap-a'])
    })

    it('范围栏可选项（P1-04）：只列出被授权的主体与店铺，没有授权时 granted 为 false', async () => {
      const names = (res: { json: any }, key: 'entities' | 'stores') => res.json.data[key].map((item: any) => item.id).sort()
      const full = await h.call(tokens.full, 'GET', '/scope/options')
      expect(full.status).toBe(200)
      expect(full.json.data.granted).toBe(true)
      expect(full.json.data.unrestricted).toBe(true)
      expect(names(full, 'stores')).toEqual([tenant.sellerAccountId, 'seller-a2', 'seller-a3'].sort())
      expect(names(full, 'entities')).toEqual([tenant.legalEntityId, 'le-a2'].sort())
      expect(full.json.data.marketplace.id).toBe('ATVPDKIKX0DER')

      const store = await h.call(tokens.store, 'GET', '/scope/options')
      expect(names(store, 'stores')).toEqual([tenant.sellerAccountId])
      expect(names(store, 'entities')).toEqual([tenant.legalEntityId])

      const entity = await h.call(tokens.entity, 'GET', '/scope/options')
      expect(names(entity, 'stores')).toEqual([tenant.sellerAccountId, 'seller-a2'].sort())
      expect(names(entity, 'entities')).toEqual([tenant.legalEntityId])
      // 别的租户的店铺与主体不会出现
      expect(JSON.stringify(entity.json)).not.toContain('seller-b')

      const none = await h.call(tokens.none, 'GET', '/scope/options')
      expect(none.status).toBe(200)
      expect(none.json.data).toMatchObject({ granted: false, entities: [], stores: [] })
    })

    it('权限仍然先于范围：没有权限点的人得到 403 而不是范围错误', async () => {
      const reader = await h.createMember(tenant.tenantId, 'reader', ['member.read'], { scopes: [] })
      const res = await h.call(reader.token, 'GET', '/orders')
      expect(res.status).toBe(403)
      expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
    })
  })

  describe('迁移 M-P1-12：保数据、自动匹配与回滚', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>

    beforeAll(async () => {
      await db.createDatabase('scope_migration')
      client = await db.connect('scope_migration')
      await applyMigrations(client, { before: TARGET })
      ids = await seedTenant(client, 'm')
      const role = await insertRow(client, 'Role', { id: 'role-m', tenantId: ids.tenantId, name: '角色', permissions: '[]', resourceScope: '{}' })
      await insertRow(client, 'Membership', { id: 'membership-m', tenantId: ids.tenantId, userId: ids.userId, roleId: role.id })
      await client.query('UPDATE "SellerAccount" SET "sellerId" = $1 WHERE id = $2', ['SELLER-ONE', ids.sellerAccountId])
      // 第二、三家店共用同一个卖家编号 → 候选不唯一，不得自动匹配
      for (const id of ['dup-1', 'dup-2']) {
        await insertRow(client, 'SellerAccount', { id, tenantId: ids.tenantId, legalEntityId: ids.legalEntityId, sellerId: 'SELLER-DUP', logicalRegion: id })
      }
      await insertRow(client, 'AdsProfile', { id: 'ap-match', tenantId: ids.tenantId, profileId: 'p1', accountId: 'SELLER-ONE' })
      await insertRow(client, 'AdsProfile', { id: 'ap-dup', tenantId: ids.tenantId, profileId: 'p2', accountId: 'SELLER-DUP' })
      await insertRow(client, 'AdsProfile', { id: 'ap-none', tenantId: ids.tenantId, profileId: 'p3', accountId: null })
      await applyMigrations(client, { only: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('已有成员回填一条“全部范围”授权，访问不变', async () => {
      const { rows } = await client.query('SELECT "legalEntityId", "sellerAccountId", "grantedBy" FROM "MembershipScope" WHERE "membershipId" = $1', ['membership-m'])
      expect(rows).toEqual([{ legalEntityId: null, sellerAccountId: null, grantedBy: 'system:migration' }])
    })

    it('广告账户：唯一匹配的自动绑定，候选重复或无卖家编号的保持未绑定', async () => {
      const { rows } = await client.query('SELECT id, "sellerAccountId", "bindingStatus" FROM "AdsProfile" ORDER BY id')
      expect(rows).toEqual([
        { id: 'ap-dup', sellerAccountId: null, bindingStatus: 'UNBOUND' },
        { id: 'ap-match', sellerAccountId: ids.sellerAccountId, bindingStatus: 'AUTO_MATCHED' },
        { id: 'ap-none', sellerAccountId: null, bindingStatus: 'UNBOUND' },
      ])
    })

    it('绑定状态受检查约束保护', async () => {
      await expect(client.query(`UPDATE "AdsProfile" SET "bindingStatus" = 'WHATEVER' WHERE id = 'ap-none'`)).rejects.toThrow(/AdsProfile_bindingStatus_check/)
    })

    it('回滚脚本可执行：移除新表与新列，原有广告账户数据保留', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      const table = await client.query(`SELECT to_regclass('"MembershipScope"') AS t`)
      expect(table.rows[0].t).toBeNull()
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'AdsProfile' AND column_name IN ('sellerAccountId', 'bindingStatus', 'boundBy')`)
      expect(columns.rows).toHaveLength(0)
      const profiles = await client.query('SELECT count(*)::int AS n FROM "AdsProfile"')
      expect(profiles.rows[0].n).toBe(3)
    })
  })
})
