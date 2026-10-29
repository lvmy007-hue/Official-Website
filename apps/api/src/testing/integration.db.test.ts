import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { SampleDataService } from '../platform/sample-data'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 接口集成测试（真实数据库）：租户隔离、权限、买家信息不外泄、审计写入分区表、样例文件加载规则。
describe('接口集成测试（真实数据库）', () => {
  let h: DbTestApp
  let a: Awaited<ReturnType<DbTestApp['createTenant']>>
  let b: Awaited<ReturnType<DbTestApp['createTenant']>>
  let memberA: { userId: string; token: string }
  let memberB: { userId: string; token: string }
  let reader: { userId: string; token: string }

  beforeAll(async () => {
    h = await createDbTestApp()
    a = await h.createTenant('a', { mode: 'TEST' })
    b = await h.createTenant('b')
    memberA = await h.createMember(a.tenantId, 'a', ['orders.read', 'audit.read', 'member.read', 'connection.manage', 'entity.read', 'entity.write'])
    memberB = await h.createMember(b.tenantId, 'b', ['orders.read', 'audit.read', 'member.read'])
    reader = await h.createMember(a.tenantId, 'reader', ['member.read'])

    for (const [tenant, seller, label, count] of [
      [a.tenantId, a.sellerAccountId, 'A', 3],
      [b.tenantId, b.sellerAccountId, 'B', 2],
    ] as const) {
      for (let i = 1; i <= count; i += 1) {
        await insertRow(h.client, 'Order', {
          id: `order-${label}-${i}`,
          tenantId: tenant,
          sellerAccountId: seller,
          amazonOrderId: `111-000000${i}-${label}`,
          purchaseDate: `2026-03-0${i}T10:00:00Z`,
          marketplaceId: 'ATVPDKIKX0DER',
          piiCiphertext: `SECRET-CIPHERTEXT-${label}`,
        })
      }
    }
    await insertRow(h.client, 'AuditEvent', { id: 'audit-b-1', tenantId: b.tenantId, action: 'B_ONLY_EVENT', occurredAt: '2026-03-05T00:00:00Z' })
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('租户隔离', () => {
    it('订单列表只返回本租户数据，且不含买家信息', async () => {
      const res = await h.call(memberA.token, 'GET', '/orders?pageSize=50&from=2026-03-01&to=2026-03-31')
      expect(res.status).toBe(200)
      expect(res.json.data.items).toHaveLength(3)
      expect(res.json.data.items.map((item: any) => item.id).sort()).toEqual(['order-A-1', 'order-A-2', 'order-A-3'])
      expect(JSON.stringify(res.json)).not.toContain('SECRET-CIPHERTEXT')
      expect(res.json.data.items.every((item: any) => !('piiCiphertext' in item))).toBe(true)
    })

    it('另一个租户看到的是它自己的数据', async () => {
      const res = await h.call(memberB.token, 'GET', '/orders?from=2026-03-01&to=2026-03-31')
      expect(res.json.data.items.map((item: any) => item.id).sort()).toEqual(['order-B-1', 'order-B-2'])
    })

    it('指定别的租户作为访问范围会被拒绝', async () => {
      const res = await h.call(memberA.token, 'GET', '/orders', { headers: { 'x-tenant-context': b.tenantId } })
      expect(res.status).toBe(403)
    })

    it('用别的租户的订单编号读取明细得到 404，而不是数据或 403（不暴露存在性）', async () => {
      const res = await h.call(memberA.token, 'GET', '/orders/order-B-1/items')
      expect(res.status).toBe(404)
    })

    it('审计列表看不到别的租户的事件', async () => {
      const res = await h.call(memberA.token, 'GET', '/audit?pageSize=200')
      expect(res.status).toBe(200)
      expect(JSON.stringify(res.json)).not.toContain('B_ONLY_EVENT')
    })

    it('成员列表只含本租户成员', async () => {
      const res = await h.call(memberA.token, 'GET', '/members')
      expect(res.status).toBe(200)
      const ids = res.json.data.items.map((item: any) => item.userId)
      expect(ids).toContain(memberA.userId)
      expect(ids).not.toContain(memberB.userId)
    })
  })

  describe('权限与参数', () => {
    it('缺少权限点得到 403，未登录得到 401', async () => {
      expect((await h.call(reader.token, 'GET', '/orders')).status).toBe(403)
      expect((await h.call(null, 'GET', '/orders')).status).toBe(401)
    })

    it('页大小上限 200：200 可以，201 为 422', async () => {
      expect((await h.call(memberA.token, 'GET', '/orders?pageSize=200')).status).toBe(200)
      expect((await h.call(memberA.token, 'GET', '/orders?pageSize=201')).status).toBe(422)
    })

    it('游标分页在真实分区表上稳定：按下单时间倒序，两页不重复不遗漏', async () => {
      const base = '/orders?from=2026-03-01&to=2026-03-31&pageSize=2'
      const first = await h.call(memberA.token, 'GET', base)
      expect(first.json.data.items.map((item: any) => item.id)).toEqual(['order-A-3', 'order-A-2'])
      expect(first.json.data.pageInfo.hasMore).toBe(true)
      const second = await h.call(memberA.token, 'GET', `${base}&cursor=${encodeURIComponent(first.json.data.pageInfo.nextCursor)}`)
      expect(second.json.data.items.map((item: any) => item.id)).toEqual(['order-A-1'])
      expect(second.json.data.pageInfo.hasMore).toBe(false)
    })
  })

  describe('写入与审计', () => {
    it('创建法律主体：数据写入，审计事件落入对应月份的分区，并带请求编号与操作人', async () => {
      const res = await h.call(memberA.token, 'POST', '/entities', { body: { name: '测试主体有限公司', registeredCountry: 'US' }, headers: { 'x-request-id': 'req-integration-0001' } })
      expect(res.status).toBe(201)
      const { rows } = await h.client.query(`SELECT "tenantId", "actorId", "action", "requestId", tableoid::regclass::text AS part FROM "AuditEvent" WHERE "requestId" = 'req-integration-0001'`)
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ tenantId: a.tenantId, actorId: memberA.userId, action: 'LEGAL_ENTITY_CREATED' })
      const month = new Date().toISOString().slice(0, 7).replace('-', '')
      expect(rows[0].part).toContain(month)
    })

    it('无权限的人带着不合法的内容也只得到 403', async () => {
      const res = await h.call(reader.token, 'POST', '/entities', { body: { nonsense: true } })
      expect(res.status).toBe(403)
    })
  })

  describe('样例文件加载规则（生产租户代码层拒绝）', () => {
    it('测试租户可以加载（样例清单为空时结果为空）', async () => {
      const service = h.app.get(SampleDataService)
      await expect(service.load(a.tenantId, { env: { APP_MODE: 'test' } as NodeJS.ProcessEnv })).resolves.toEqual([])
    })

    it('正式租户被拒绝', async () => {
      const service = h.app.get(SampleDataService)
      await expect(service.load(b.tenantId, { env: { APP_MODE: 'test' } as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: 'SAMPLE_DATA_FORBIDDEN' })
    })

    it('生产环境下，连测试租户也被拒绝', async () => {
      const service = h.app.get(SampleDataService)
      await expect(service.load(a.tenantId, { env: { APP_MODE: 'production' } as NodeJS.ProcessEnv })).rejects.toMatchObject({ code: 'SAMPLE_DATA_FORBIDDEN' })
    })
  })
})
