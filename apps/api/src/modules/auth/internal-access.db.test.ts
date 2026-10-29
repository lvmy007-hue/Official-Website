import { hashSync } from 'bcryptjs'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { insertRow } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'

const KEYS = [
  'INTERNAL_DIRECT_ACCESS',
  'INTERNAL_ACCESS_TENANT_ID',
  'INTERNAL_ACCESS_ROLE_ID',
  'INTERNAL_ACCESS_ALLOWED_CIDRS',
  'INTERNAL_ACCESS_GATEWAY_HEADER',
  'INTERNAL_ACCESS_GATEWAY_SECRET',
] as const

function configure(values: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) delete process.env[key]
  for (const [key, value] of Object.entries(values)) process.env[key] = value
}

// P1-18 内部访问模式（真实数据库 + 完整应用）：默认关闭；来源地址、代理信任与网关校验头；固定内部租户与最小权限角色；审计标注访问模式。
describe('内部访问模式（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })
  afterEach(() => configure({}))

  describe('直连部署', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof h.createTenant>>
    let other: Awaited<ReturnType<typeof h.createTenant>>
    const rows = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows
    const enable = (extra: Partial<Record<(typeof KEYS)[number], string>> = {}) =>
      configure({ INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_TENANT_ID: tenant.tenantId, INTERNAL_ACCESS_ALLOWED_CIDRS: '127.0.0.0/8', ...extra })

    beforeAll(async () => {
      configure({})
      h = await createDbTestApp({ db, database: 'internal_direct' })
      tenant = await h.createTenant('ia')
      other = await h.createTenant('ib')
      await insertRow(h.client, 'Role', {
        id: 'role-internal-write',
        tenantId: tenant.tenantId,
        name: '内部可写',
        permissions: JSON.stringify(['entity.read', 'entity.write']),
        resourceScope: '{}',
        version: 2,
      })
      await insertRow(h.client, 'Role', { id: 'role-other-tenant', tenantId: other.tenantId, name: '别家的角色', permissions: JSON.stringify(['entity.read']), resourceScope: '{}', version: 2 })
    })
    afterAll(async () => {
      await h?.close()
    })

    it('默认关闭：没有登录凭证一律 401；开启开关但不配置其他项时应用无法按内部访问处理', async () => {
      configure({})
      expect((await h.call(null, 'GET', '/entities')).status).toBe(401)
      expect((await h.call(null, 'GET', '/auth/me')).status).toBe(401)
      // 只有明确写 true 才开启
      configure({ INTERNAL_DIRECT_ACCESS: 'yes', INTERNAL_ACCESS_TENANT_ID: tenant.tenantId, INTERNAL_ACCESS_ALLOWED_CIDRS: '127.0.0.0/8' })
      expect((await h.call(null, 'GET', '/entities')).status).toBe(401)
    })

    it('开启后，允许地址段内的无登录请求按内部租户与只读角色访问；页面据 accessMode 显示横幅', async () => {
      enable()
      const me = await h.call(null, 'GET', '/auth/me')
      expect(me.status).toBe(200)
      expect(me.json.data.accessMode).toBe('INTERNAL_DIRECT')
      expect(me.json.data.tenant.id).toBe(tenant.tenantId)
      expect(me.json.data.permissions).toContain('entity.read')
      expect(me.json.data.permissions).not.toContain('entity.write')
      expect(me.json.data.user.displayName).toBe('内部访问')
      const list = await h.call(null, 'GET', '/entities')
      expect(list.status).toBe(200)
      expect(JSON.stringify(list.json.data)).toContain(tenant.legalEntityId)
      expect(JSON.stringify(list.json.data)).not.toContain(other.legalEntityId)
    })

    it('默认只读：写操作被拒绝；请求头指定其他租户无效；个人身份类操作一律不支持', async () => {
      enable()
      const write = await h.call(null, 'POST', '/entities', { body: { name: '内部访问不能新建', registeredCountry: 'US' } })
      expect(write.status).toBe(403)
      expect(write.json.error.code).toBe('TENANT_ACCESS_DENIED')
      expect((await rows(`SELECT 1 FROM "LegalEntity" WHERE name = '内部访问不能新建'`)).length).toBe(0)

      const foreign = await h.call(null, 'GET', '/auth/me', { headers: { 'x-tenant-context': other.tenantId } })
      expect(foreign.json.data.tenant.id).toBe(tenant.tenantId)

      for (const [method, path, body] of [
        ['POST', '/auth/logout', undefined],
        ['POST', '/auth/mfa/enroll', undefined],
        ['POST', '/auth/mfa/verify', { code: '123456' }],
        ['POST', '/auth/step-up', { action: 'role.manage', password: 'x' }],
        ['DELETE', '/auth/sessions/anything', undefined],
      ] as const) {
        const res = await h.call(null, method, path, { body })
        expect(res.status, `${method} ${path}`).toBe(403)
        expect(res.json.error.code, `${method} ${path}`).toBe('INTERNAL_ACCESS_UNSUPPORTED')
      }
    })

    it('内部访问主体：专用账号不能用密码登录，也不会产生会话或多因素因子', async () => {
      enable()
      await h.call(null, 'GET', '/auth/me')
      const [user] = await rows(`SELECT * FROM "User" WHERE email = $1`, [`internal-access+${tenant.tenantId}@internal.invalid`])
      expect(user.status).toBe('INTERNAL_ACCESS')
      const login = await h.call(null, 'POST', '/auth/login', { body: { email: user.email, password: 'any-password' } })
      expect(login.status).toBe(401)
      expect((await rows(`SELECT 1 FROM "Session" WHERE "userId" = $1`, [user.id])).length).toBe(0)
      expect((await rows(`SELECT 1 FROM "MfaFactor" WHERE "userId" = $1`, [user.id])).length).toBe(0)
      // 重复访问不会重复创建账号、成员关系与范围授权
      await h.call(null, 'GET', '/entities')
      expect((await rows(`SELECT 1 FROM "User" WHERE email = $1`, [user.email])).length).toBe(1)
      expect((await rows(`SELECT 1 FROM "Membership" WHERE "userId" = $1`, [user.id])).length).toBe(1)
      expect(
        (await rows(`SELECT 1 FROM "MembershipScope" WHERE "tenantId" = $1 AND "legalEntityId" IS NULL AND "sellerAccountId" IS NULL AND "grantedBy" = 'internal-access'`, [tenant.tenantId])).length,
      ).toBe(1)
    })

    it('绑定可写角色后写入成功，审计标注“内部直连”访问模式与来源地址', async () => {
      enable({ INTERNAL_ACCESS_ROLE_ID: 'role-internal-write' })
      const created = await h.call(null, 'POST', '/entities', { body: { name: '内部访问新建主体', registeredCountry: 'US' } })
      expect(created.status).toBe(201)
      const [audit] = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND "resourceId" = $2`, [tenant.tenantId, created.json.data.id])
      expect(audit.detail.accessMode).toBe('INTERNAL_DIRECT')
      expect(audit.ip).toMatch(/127\.0\.0\.1/)
      const [user] = await rows(`SELECT id FROM "User" WHERE email = $1`, [`internal-access+${tenant.tenantId}@internal.invalid`])
      expect(audit.actorId).toBe(user.id)
      // 对照：普通登录用户写入的审计标注为正常访问
      const member = await h.createMember(tenant.tenantId, 'normal', ['entity.read', 'entity.write'])
      const normal = await h.call(member.token, 'POST', '/entities', { body: { name: '普通登录新建主体', registeredCountry: 'US' } })
      const [normalAudit] = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND "resourceId" = $2`, [tenant.tenantId, normal.json.data.id])
      expect(normalAudit.detail.accessMode).toBe('NORMAL')
    })

    it('不在允许地址段内：与普通未登录完全一致（401），不暴露内部访问模式是否开启', async () => {
      enable({ INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8,192.168.0.0/16' })
      const res = await h.call(null, 'GET', '/entities')
      expect(res.status).toBe(401)
      expect(res.json.error.code).toBe('AUTH_REQUIRED')
      configure({})
      const normal = await h.call(null, 'GET', '/entities')
      expect(normal.json.error.message).toBe(res.json.error.message)
      // 健康检查等公开接口不受影响
      enable({ INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8' })
      expect((await h.call(null, 'GET', '/health')).status).toBe(200)
    })

    it('带着代理转发头但服务没有配置代理信任：即使连接地址在允许段内也拒绝（无法确认真实来源）', async () => {
      enable()
      const res = await h.call(null, 'GET', '/entities', { headers: { 'x-forwarded-for': '203.0.113.9' } })
      expect(res.status).toBe(401)
    })

    it('网关校验头：缺少或不匹配拒绝，匹配通过', async () => {
      enable({ INTERNAL_ACCESS_GATEWAY_HEADER: 'x-nova-gateway', INTERNAL_ACCESS_GATEWAY_SECRET: 'gateway-secret-0123456789' })
      expect((await h.call(null, 'GET', '/entities')).status).toBe(401)
      expect((await h.call(null, 'GET', '/entities', { headers: { 'x-nova-gateway': 'wrong-secret-0123456789' } })).status).toBe(401)
      expect((await h.call(null, 'GET', '/entities', { headers: { 'x-nova-gateway': 'gateway-secret-0123456789' } })).status).toBe(200)
    })

    it('带了登录凭证的请求始终走普通登录：令牌无效不会降级为内部访问；有效令牌的访问模式是正常', async () => {
      enable()
      const invalid = await h.call('not-a-valid-token', 'GET', '/auth/me')
      expect(invalid.status).toBe(401)
      const member = await h.createMember(tenant.tenantId, 'normal2', ['entity.read'])
      await h.client.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [hashSync('right-password', 4), member.userId])
      const me = await h.call(member.token, 'GET', '/auth/me')
      expect(me.status).toBe(200)
      expect(me.json.data.accessMode).toBe('NORMAL')
      expect(me.json.data.user.id).toBe(member.userId)
    })

    it('绑定的企业或角色不存在、角色属于别的企业：503 配置错误，不放行', async () => {
      enable({ INTERNAL_ACCESS_ROLE_ID: 'role-does-not-exist' })
      const noRole = await h.call(null, 'GET', '/entities')
      expect(noRole.status).toBe(503)
      expect(noRole.json.error.code).toBe('INTERNAL_ACCESS_NOT_CONFIGURED')
      enable({ INTERNAL_ACCESS_ROLE_ID: 'role-other-tenant' })
      expect((await h.call(null, 'GET', '/entities')).status).toBe(503)
      enable({ INTERNAL_ACCESS_TENANT_ID: 'tenant-does-not-exist' })
      expect((await h.call(null, 'GET', '/entities')).status).toBe(503)
    })
  })

  describe('经过网关（TRUST_PROXY=1）', () => {
    let h: DbTestApp
    beforeAll(async () => {
      process.env.TRUST_PROXY = '1'
      h = await createDbTestApp({ db, database: 'internal_proxy' })
      await h.createTenant('ip')
    })
    afterAll(async () => {
      delete process.env.TRUST_PROXY
      await h?.close()
    })

    it('按网关追加的真实客户端地址判断：内网地址放行，外网地址拒绝，伪造在前面的内网地址无效', async () => {
      configure({ INTERNAL_DIRECT_ACCESS: 'true', INTERNAL_ACCESS_TENANT_ID: 'tenant-ip', INTERNAL_ACCESS_ALLOWED_CIDRS: '10.0.0.0/8' })
      expect((await h.call(null, 'GET', '/auth/me', { headers: { 'x-forwarded-for': '10.1.2.3' } })).status).toBe(200)
      expect((await h.call(null, 'GET', '/auth/me', { headers: { 'x-forwarded-for': '203.0.113.9' } })).status).toBe(401)
      expect((await h.call(null, 'GET', '/auth/me', { headers: { 'x-forwarded-for': '10.1.2.3, 203.0.113.9' } })).status).toBe(401)
    })
  })
})
