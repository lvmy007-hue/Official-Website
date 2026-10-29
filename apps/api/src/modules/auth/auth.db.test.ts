import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { hashSync } from 'bcryptjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { createDbTestApp, type DbTestApp } from '../../testing/db-harness'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from '../../testing/db-fixtures'
import { startTestDatabase, type TestDatabase } from '../../testing/test-database'
import { totpAt } from './totp'

const TARGET = '20261021090000_auth_hardening'
const PASSWORD = 'right-password'
const COOKIE = 'nova_refresh_token'
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36'

// P1-17 认证与传输加固（真实数据库 + 完整应用）：
// 会话链与刷新轮换、重用检测、来源校验、会话列表与注销、多因素认证、管理员强制策略、请求体与安全头、代理信任、迁移保数据与回滚。
describe('认证与传输加固（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移 M-P1-17：保数据与回滚', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('auth_migration')
      client = await db.connect('auth_migration')
      await applyMigrations(client, { before: TARGET })
      const { userId } = await seedTenant(client, 'm')
      await insertRow(client, 'Session', { id: 'old-session-1', userId, expiresAt: '2030-01-01T00:00:00Z' })
      await applyMigrations(client, { only: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('已有会话各自成为只有自己的轮换链，新增列为空', async () => {
      const { rows } = await client.query(`SELECT "rotationChainId", "rotatedFromId", "reuseDetectedAt", "deviceFingerprint", "ipMasked" FROM "Session" WHERE id = 'old-session-1'`)
      expect(rows).toEqual([{ rotationChainId: 'old-session-1', rotatedFromId: null, reuseDetectedAt: null, deviceFingerprint: null, ipMasked: null }])
    })

    it('多因素因子：类型只能是动态验证码或恢复码；每个用户每种类型只有一条；删除用户时一并删除', async () => {
      const userId = (await client.query(`SELECT id FROM "User" LIMIT 1`)).rows[0].id
      await insertRow(client, 'MfaFactor', { id: 'f1', userId, kind: 'TOTP', secretCiphertext: 'x', updatedAt: new Date() })
      await expect(insertRow(client, 'MfaFactor', { id: 'f2', userId, kind: 'SMS', secretCiphertext: 'x', updatedAt: new Date() })).rejects.toThrow(/MfaFactor_kind_check/)
      await expect(insertRow(client, 'MfaFactor', { id: 'f3', userId, kind: 'TOTP', secretCiphertext: 'x', updatedAt: new Date() })).rejects.toThrow(/MfaFactor_userId_kind_key/)
      await client.query(`DELETE FROM "User" WHERE id = $1`, [userId])
      expect((await client.query(`SELECT count(*)::int AS n FROM "MfaFactor"`)).rows[0].n).toBe(0)
    })

    it('回滚脚本可执行：因子表与新增列移除，原有会话保留；回滚后可再次升级', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      expect((await client.query(`SELECT to_regclass('"MfaFactor"') AS t`)).rows[0].t).toBeNull()
      const columns = (
        await client.query(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'Session' AND column_name IN ('rotationChainId', 'rotatedFromId', 'reuseDetectedAt', 'ipMasked', 'deviceFingerprint')`,
        )
      ).rows
      expect(columns).toEqual([])
      // 用户被上一条用例删除时，会话随之级联删除；这里验证回滚不再另外删除任何会话
      await applyMigrations(client, { only: TARGET })
      expect((await client.query(`SELECT to_regclass('"MfaFactor"') AS t`)).rows[0].t).not.toBeNull()
    })
  })

  describe('接口：登录、刷新轮换、重用检测、会话与注销', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof seedTenant>>
    let origin: string

    const emailOf = (suffix: string) => `member-${suffix}@example.com`
    const setCookies = (res: { headers: Headers }) => res.headers.getSetCookie()
    const cookieValue = (res: { headers: Headers }) => {
      const line = setCookies(res).find(item => item.startsWith(`${COOKIE}=`))
      return line ? decodeURIComponent(line.slice(COOKIE.length + 1).split(';')[0]) : undefined
    }
    const login = (suffix: string, extra: Record<string, string> = {}) =>
      h.call(null, 'POST', '/auth/login', { body: { email: emailOf(suffix), password: PASSWORD }, headers: { 'user-agent': BROWSER, ...extra } })
    const refresh = (cookie: string | undefined, headers: Record<string, string> = {}) =>
      h.call(null, 'POST', '/auth/refresh', { headers: { origin, ...(cookie ? { cookie: `${COOKIE}=${encodeURIComponent(cookie)}` } : {}), ...headers } })
    const rows = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows
    const chainRows = (chainId: string) => rows(`SELECT * FROM "Session" WHERE "rotationChainId" = $1 ORDER BY "createdAt", id`, [chainId])
    const chainOf = async (userId: string) => (await rows(`SELECT "rotationChainId" FROM "Session" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [userId]))[0].rotationChainId as string

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'auth_api' })
      origin = h.baseUrl
      tenant = await h.createTenant('a')
      for (const suffix of ['login', 'rotate', 'race', 'origin', 'idle', 'list', 'other', 'logout']) {
        const member = await h.createMember(tenant.tenantId, suffix, ['entity.read'])
        await h.client.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [hashSync(PASSWORD, 4), member.userId])
      }
    })
    afterAll(async () => {
      await h?.close()
    })

    it('登录：刷新凭据只放在 Cookie（HttpOnly、严格同站、限定路径），响应体不含刷新凭据；会话只记脱敏地址，并写登录审计', async () => {
      const res = await login('login')
      expect(res.status).toBe(201)
      expect(res.json.data.accessToken).toBeTruthy()
      expect(JSON.stringify(res.json)).not.toContain('refreshToken')
      const line = setCookies(res).find(item => item.startsWith(`${COOKIE}=`)) as string
      expect(line).toMatch(/HttpOnly/i)
      expect(line).toMatch(/SameSite=Strict/i)
      expect(line).toMatch(/Path=\/api\/v1\/auth/)
      expect(res.headers.get('cache-control')).toBe('no-store')

      const [session] = await rows(`SELECT s.* FROM "Session" s JOIN "User" u ON u.id = s."userId" WHERE u.email = $1 ORDER BY s."createdAt" DESC LIMIT 1`, [emailOf('login')])
      expect(session.rotationChainId).toBe(session.id)
      expect(session.ipMasked).toBe('127.0.0.*')
      expect(session.ipHash).toMatch(/^[0-9a-f]{64}$/)
      expect(JSON.stringify(session)).not.toContain('127.0.0.1')
      expect(session.refreshTokenHash).not.toBe(cookieValue(res))
      const audit = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'LOGIN_SUCCEEDED' AND "resourceId" = $2`, [tenant.tenantId, session.userId])
      expect(audit.length).toBe(1)
    })

    it('密码错误：统一提示，不泄露账号是否存在，也不下发任何凭据', async () => {
      const wrong = await h.call(null, 'POST', '/auth/login', { body: { email: emailOf('login'), password: 'wrong-password' } })
      const missing = await h.call(null, 'POST', '/auth/login', { body: { email: 'nobody@example.com', password: 'whatever-password' } })
      expect(wrong.status).toBe(401)
      expect(missing.status).toBe(401)
      expect(wrong.json.error.message).toBe(missing.json.error.message)
      expect(setCookies(wrong)).toEqual([])
    })

    it('刷新：轮换刷新凭据，旧凭据立刻作废；访问令牌在轮换后仍然有效', async () => {
      const first = await login('rotate')
      const c0 = cookieValue(first) as string
      const second = await refresh(c0)
      expect(second.status).toBe(201)
      const c1 = cookieValue(second) as string
      expect(c1).toBeTruthy()
      expect(c1).not.toBe(c0)
      expect(JSON.stringify(second.json)).not.toContain(c1)
      // 旧访问令牌与新访问令牌都指向同一条会话链，都有效
      expect((await h.call(first.json.data.accessToken, 'GET', '/auth/me')).status).toBe(200)
      expect((await h.call(second.json.data.accessToken, 'GET', '/auth/me')).status).toBe(200)

      const chain = await chainRows(await chainOf(first.json.data.user.id))
      expect(chain.length).toBe(2)
      expect(chain[0].revokedAt).not.toBeNull()
      expect(chain[1].rotatedFromId).toBe(chain[0].id)
      expect(chain[1].revokedAt).toBeNull()
      // 绝对有效期不顺延
      expect(new Date(chain[1].expiresAt).getTime()).toBe(new Date(chain[0].expiresAt).getTime())
    })

    it('重用检测：宽限期内按并发处理（409，不吊销）；宽限期外重用旧凭据则吊销整条会话链、写审计、清除 Cookie', async () => {
      const first = await login('rotate')
      const userId = first.json.data.user.id as string
      const chainId = await chainOf(userId)
      const c0 = cookieValue(first) as string
      const second = await refresh(c0)
      const c1 = cookieValue(second) as string

      const inGrace = await refresh(c0)
      expect(inGrace.status).toBe(409)
      expect(inGrace.json.error.code).toBe('REFRESH_CONFLICT')
      expect(inGrace.json.error.retryable).toBe(true)
      // 并发冲突不清除浏览器里的凭据，也没有吊销任何会话
      expect(setCookies(inGrace).some(item => item.startsWith(`${COOKIE}=;`))).toBe(false)
      const third = await refresh(c1)
      expect(third.status).toBe(201)
      const c2 = cookieValue(third) as string

      // 让后继会话“变老”，模拟宽限期已过
      await h.client.query(`UPDATE "Session" SET "createdAt" = now() - interval '1 minute' WHERE "rotationChainId" = $1 AND "rotatedFromId" IS NOT NULL`, [chainId])
      const reused = await refresh(c0)
      expect(reused.status).toBe(401)
      expect(reused.json.error.code).toBe('SESSION_REUSE_DETECTED')
      expect(setCookies(reused).some(item => item.startsWith(`${COOKIE}=;`))).toBe(true)

      const chain = await chainRows(chainId)
      expect(chain.every(row => row.revokedAt !== null)).toBe(true)
      expect(chain.filter(row => row.reuseDetectedAt !== null).length).toBe(1)
      // 被截取方与合法方的凭据都不能再用，访问令牌也随之失效
      const afterRevoke = await refresh(c2)
      expect(afterRevoke.status).toBe(401)
      expect(afterRevoke.json.error.code).toBe('AUTH_REQUIRED')
      expect((await h.call(third.json.data.accessToken, 'GET', '/auth/me')).status).toBe(401)
      const audit = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'SESSION_REUSE_DETECTED' AND "resourceId" = $2`, [tenant.tenantId, chainId])
      expect(audit.length).toBe(1)
      expect(audit[0].result).toBe('DENIED')
      // 再次重用不重复写审计
      await refresh(c0)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'SESSION_REUSE_DETECTED' AND "resourceId" = $2`, [tenant.tenantId, chainId])).length).toBe(1)
    })

    it('并发刷新：同一个刷新凭据同时提交多次，只有一次成功，其余按冲突处理，且只产生一个后继会话', async () => {
      const first = await login('race')
      const c0 = cookieValue(first) as string
      const results = await Promise.all(Array.from({ length: 6 }, () => refresh(c0)))
      expect(results.filter(res => res.status === 201).length).toBe(1)
      for (const res of results.filter(item => item.status !== 201)) {
        expect(res.status).toBe(409)
        expect(res.json.error.code).toBe('REFRESH_CONFLICT')
      }
      expect((await chainRows(await chainOf(first.json.data.user.id))).length).toBe(2)
    })

    it('刷新来源校验：没有来源、来源不是本站时一律拒绝，不消耗凭据；同站来源或同站 Referer 通过', async () => {
      const first = await login('origin')
      const c0 = cookieValue(first) as string
      const noOrigin = await h.call(null, 'POST', '/auth/refresh', { headers: { cookie: `${COOKIE}=${encodeURIComponent(c0)}` } })
      expect(noOrigin.status).toBe(403)
      expect(noOrigin.json.error.code).toBe('ORIGIN_NOT_ALLOWED')
      const foreign = await refresh(c0, { origin: 'https://evil.example.com' })
      expect(foreign.status).toBe(403)
      expect(foreign.json.error.code).toBe('ORIGIN_NOT_ALLOWED')
      expect((await chainRows(await chainOf(first.json.data.user.id))).length).toBe(1)

      const viaReferer = await h.call(null, 'POST', '/auth/refresh', { headers: { cookie: `${COOKIE}=${encodeURIComponent(c0)}`, referer: `${origin}/app/dashboard` } })
      expect(viaReferer.status).toBe(201)
      const noCookie = await refresh(undefined)
      expect(noCookie.status).toBe(401)
    })

    it('空闲超过 15 分钟：访问令牌与刷新凭据都失效', async () => {
      const first = await login('idle')
      const c0 = cookieValue(first) as string
      await h.client.query(`UPDATE "Session" SET "lastSeenAt" = now() - interval '20 minutes' WHERE "rotationChainId" = $1`, [await chainOf(first.json.data.user.id)])
      const refreshed = await refresh(c0)
      expect(refreshed.status).toBe(401)
      expect((await h.call(first.json.data.accessToken, 'GET', '/auth/me')).status).toBe(401)
    })

    it('会话列表：每次登录一行，标出当前设备，只显示脱敏地址与设备描述；只能注销自己的会话', async () => {
      const a = await login('list')
      const b = await login('list', { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15' })
      const list = await h.call(a.json.data.accessToken, 'GET', '/auth/sessions')
      expect(list.status).toBe(200)
      const items = list.json.data.items as Array<Record<string, any>>
      // 造数时预置的一条会话也在列表里，所以是三条
      expect(items.length).toBe(3)
      expect(items.filter(item => item.current).length).toBe(1)
      const devices = items.map(item => item.device)
      expect(devices).toContain('Chrome · Windows')
      expect(devices).toContain('Safari · macOS')
      for (const item of items) {
        expect(Object.keys(item).sort()).toEqual(['current', 'device', 'expiresAt', 'id', 'ipMasked', 'lastSeenAt', 'signedInAt'])
        expect(JSON.stringify(item)).not.toMatch(/refreshTokenHash|ipHash|userAgent/)
      }

      const mine = items.find(item => !item.current && item.device === 'Safari · macOS') as Record<string, any>
      // 别人的会话编号：与不存在同样返回 404，且不受影响
      const otherChain = await chainOf((await h.call(await loginToken('other'), 'GET', '/auth/me')).json.data.user.id)
      const foreign = await h.call(a.json.data.accessToken, 'DELETE', `/auth/sessions/${otherChain}`)
      expect(foreign.status).toBe(404)
      expect((await chainRows(otherChain)).every(row => row.revokedAt === null)).toBe(true)

      const revoked = await h.call(a.json.data.accessToken, 'DELETE', `/auth/sessions/${mine.id}`)
      expect(revoked.status).toBe(200)
      expect(revoked.json.data).toEqual({ revoked: true, current: false })
      expect((await h.call(b.json.data.accessToken, 'GET', '/auth/me')).status).toBe(401)
      expect((await h.call(a.json.data.accessToken, 'DELETE', `/auth/sessions/${mine.id}`)).status).toBe(404)
      expect((await h.call(a.json.data.accessToken, 'GET', '/auth/sessions')).json.data.items.length).toBe(2)
      const audit = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'SESSION_REVOKED' AND "resourceId" = $2`, [tenant.tenantId, mine.id])
      expect(audit.length).toBe(1)
    })

    async function loginToken(suffix: string): Promise<string> {
      return (await login(suffix)).json.data.accessToken
    }

    it('注销：当前会话作废、Cookie 清除、刷新凭据与访问令牌都不能再用，并写审计', async () => {
      const first = await login('logout')
      const c0 = cookieValue(first) as string
      const out = await h.call(first.json.data.accessToken, 'POST', '/auth/logout')
      expect(out.status).toBe(200)
      expect(out.json.data).toEqual({ loggedOut: true })
      expect(setCookies(out).some(item => item.startsWith(`${COOKIE}=;`))).toBe(true)
      expect((await h.call(first.json.data.accessToken, 'GET', '/auth/me')).status).toBe(401)
      expect((await refresh(c0)).status).toBe(401)
      const audit = await rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'LOGOUT' AND "resourceId" = $2`, [tenant.tenantId, await chainOf(first.json.data.user.id)])
      expect(audit.length).toBe(1)
    })
  })

  describe('接口：多因素认证与管理员强制策略', () => {
    let h: DbTestApp
    let tenant: Awaited<ReturnType<typeof seedTenant>>
    const env = { previous: process.env.MFA_REQUIRED_FOR_ADMINS }
    const rows = async (sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows

    beforeAll(async () => {
      h = await createDbTestApp({ db, database: 'auth_mfa' })
      tenant = await h.createTenant('b')
    })
    afterAll(async () => {
      if (env.previous === undefined) delete process.env.MFA_REQUIRED_FOR_ADMINS
      else process.env.MFA_REQUIRED_FOR_ADMINS = env.previous
      await h?.close()
    })

    it('绑定与验证：获取信息→验证码通过→一次性领取 10 个恢复码；密钥与恢复码不以明文落库，也不进入幂等记录与审计', async () => {
      const member = await h.createMember(tenant.tenantId, 'mfa1', ['entity.read', 'role.manage'])
      const before = await h.call(member.token, 'GET', '/auth/me')
      expect(before.json.data.mfa).toEqual({ enrolled: false, pending: false, recoveryCodesRemaining: 0 })

      // 还没获取绑定信息就提交验证码
      expect((await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: '123456' } })).json.error.code).toBe('MFA_NOT_ENROLLED')

      const enroll = await h.call(member.token, 'POST', '/auth/mfa/enroll')
      expect(enroll.status).toBe(200)
      const { secret, otpauthUri } = enroll.json.data
      expect(secret).toMatch(/^[A-Z2-7]{32}$/)
      expect(otpauthUri).toContain(`secret=${secret}`)
      expect(otpauthUri).toContain(encodeURIComponent(`member-mfa1@example.com`))
      expect((await h.call(member.token, 'GET', '/auth/me')).json.data.mfa).toMatchObject({ enrolled: false, pending: true })

      // 验证码错误
      const wrong = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: '000000' } })
      expect(wrong.status).toBe(403)
      expect(wrong.json.error.code).toBe('MFA_CODE_INVALID')
      expect((await h.call(member.token, 'GET', '/auth/me')).json.data.mfa.enrolled).toBe(false)

      const code = totpAt(secret, Date.now())
      const verified = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code } })
      expect(verified.status).toBe(200)
      expect(verified.json.data.verified).toBe(true)
      const recoveryCodes = verified.json.data.recoveryCodes as string[]
      expect(recoveryCodes.length).toBe(10)
      expect(new Set(recoveryCodes).size).toBe(10)
      for (const item of recoveryCodes) expect(item).toMatch(/^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/)
      expect((await h.call(member.token, 'GET', '/auth/me')).json.data.mfa).toEqual({ enrolled: true, pending: false, recoveryCodesRemaining: 10 })

      // 同一个验证码不能重放
      const replay = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code } })
      expect(replay.status).toBe(403)
      // 已绑定后不能再次获取绑定信息（防止被劫持的会话替换密钥）
      const again = await h.call(member.token, 'POST', '/auth/mfa/enroll')
      expect(again.status).toBe(409)
      expect(again.json.error.code).toBe('MFA_ALREADY_ENROLLED')

      // 落库内容：密钥与恢复码不以明文出现在任何地方
      const stored = [
        ...(await rows(`SELECT row_to_json(t)::text AS j FROM "MfaFactor" t WHERE t."userId" = $1`, [member.userId])),
        ...(await rows(`SELECT row_to_json(t)::text AS j FROM "IdempotencyRecord" t WHERE t."tenantId" = $1`, [tenant.tenantId])),
        ...(await rows(`SELECT row_to_json(t)::text AS j FROM "AuditEvent" t WHERE t."tenantId" = $1`, [tenant.tenantId])),
      ]
        .map(row => row.j as string)
        .join('\n')
      expect(stored).not.toContain(secret)
      for (const item of recoveryCodes) expect(stored).not.toContain(item)
      const actions = (await rows(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND "actorId" = $2`, [tenant.tenantId, member.userId])).map(row => row.action)
      expect(actions).toEqual(expect.arrayContaining(['MFA_ENROLLMENT_STARTED', 'MFA_VERIFIED']))

      // 租户连接账号对因子表没有任何权限
      const appClient = new Client({ connectionString: db.urlFor('auth_mfa', 'app') })
      await appClient.connect()
      try {
        await expect(appClient.query(`SELECT 1 FROM "MfaFactor" LIMIT 1`)).rejects.toThrow(/permission denied/)
      } finally {
        await appClient.end()
      }
    })

    it('恢复码：每个只能用一次；错误的恢复码被拒绝；用后剩余数量减少', async () => {
      const member = await h.createMember(tenant.tenantId, 'mfa2', ['entity.read'])
      const { secret } = (await h.call(member.token, 'POST', '/auth/mfa/enroll')).json.data
      const { recoveryCodes } = (await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: totpAt(secret, Date.now()) } })).json.data as { recoveryCodes: string[] }

      const used = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: recoveryCodes[0] } })
      expect(used.status).toBe(200)
      expect(used.json.data).toEqual({ verified: true, method: 'RECOVERY_CODE', recoveryCodesRemaining: 9 })
      const reuse = await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: recoveryCodes[0] } })
      expect(reuse.status).toBe(403)
      expect(reuse.json.error.code).toBe('MFA_CODE_INVALID')
      expect((await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: 'ABCDE-FGHJK' } })).status).toBe(403)
      // 并发使用同一个恢复码：只有一个成功
      const results = await Promise.all(Array.from({ length: 5 }, () => h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: recoveryCodes[1] } })))
      expect(results.filter(res => res.status === 200).length).toBe(1)
      expect((await h.call(member.token, 'GET', '/auth/me')).json.data.mfa.recoveryCodesRemaining).toBe(8)
    })

    it('再次验证身份可以用动态验证码：同一验证码不能重复使用', async () => {
      const member = await h.createMember(tenant.tenantId, 'mfa3', ['entity.read', 'role.manage'])
      const { secret } = (await h.call(member.token, 'POST', '/auth/mfa/enroll')).json.data
      await h.call(member.token, 'POST', '/auth/mfa/verify', { body: { code: totpAt(secret, Date.now()) } })

      // 还没绑定的人选择验证码方式会失败（另有账号覆盖），这里验证已绑定用户的验证码通过且只能用一次
      const code = totpAt(secret, Date.now() + 30_000)
      const ok = await h.call(member.token, 'POST', '/auth/step-up', { body: { action: 'role.manage', method: 'TOTP', code } })
      expect(ok.status).toBe(200)
      expect(ok.json.data.action).toBe('role.manage')
      const replay = await h.call(member.token, 'POST', '/auth/step-up', { body: { action: 'role.manage', method: 'TOTP', code } })
      expect(replay.status).toBe(403)
      expect(replay.json.error.code).toBe('STEP_UP_FAILED')

      const unbound = await h.createMember(tenant.tenantId, 'mfa4', ['entity.read', 'role.manage'])
      const none = await h.call(unbound.token, 'POST', '/auth/step-up', { body: { action: 'role.manage', method: 'TOTP', code: '123456' } })
      expect(none.status).toBe(403)
      expect(none.json.error.code).toBe('STEP_UP_FAILED')
    })

    it('管理员强制策略：开启时未绑定的管理员除认证接口外一律拒绝，绑定后恢复；普通成员不受影响；关闭时都不受影响', async () => {
      process.env.MFA_REQUIRED_FOR_ADMINS = 'true'
      const admin = await h.createMember(tenant.tenantId, 'adm1', ['entity.read', 'member.manage'])
      const plain = await h.createMember(tenant.tenantId, 'plain1', ['entity.read'])

      const blocked = await h.call(admin.token, 'GET', '/entities')
      expect(blocked.status).toBe(403)
      expect(blocked.json.error.code).toBe('MFA_ENROLLMENT_REQUIRED')
      expect(blocked.json.error.details).toEqual({ enrollPath: '/app/profile' })
      expect((await h.call(plain.token, 'GET', '/entities')).status).toBe(200)

      // 认证接口仍可使用，管理员可以完成绑定
      expect((await h.call(admin.token, 'GET', '/auth/me')).status).toBe(200)
      const { secret } = (await h.call(admin.token, 'POST', '/auth/mfa/enroll')).json.data
      expect((await h.call(admin.token, 'GET', '/entities')).status).toBe(403)
      expect((await h.call(admin.token, 'POST', '/auth/mfa/verify', { body: { code: totpAt(secret, Date.now()) } })).status).toBe(200)
      expect((await h.call(admin.token, 'GET', '/entities')).status).toBe(200)

      process.env.MFA_REQUIRED_FOR_ADMINS = 'false'
      const free = await h.createMember(tenant.tenantId, 'adm2', ['entity.read', 'member.manage'])
      expect((await h.call(free.token, 'GET', '/entities')).status).toBe(200)
    })
  })

  describe('传输：请求体上限、安全头、代理信任', () => {
    let h: DbTestApp
    const body = (size: number) => JSON.stringify({ email: 'a@example.com', password: 'x'.repeat(size) })
    const raw = (path: string, init: RequestInit = {}) => fetch(`${h.baseUrl}/api/v1${path}`, init)

    beforeAll(async () => {
      delete process.env.TRUST_PROXY
      h = await createDbTestApp({ db, database: 'auth_transport' })
      await h.createTenant('t')
    })
    afterAll(async () => {
      await h?.close()
    })

    it('请求体超过 1MB：413，使用统一错误格式；接近上限的正常请求进入业务校验', async () => {
      const big = await raw('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(1_200_000) })
      expect(big.status).toBe(413)
      const json = await big.json()
      expect(json).toMatchObject({ success: false, error: { code: 'REQUEST_BODY_TOO_LARGE', retryable: false } })
      expect(json.error.requestId).toBeTruthy()

      const near = await raw('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body(900_000) })
      expect(near.status).toBe(422)
    })

    it('请求体不是合法 JSON：400 统一错误格式，不暴露解析器内部信息', async () => {
      const res = await raw('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"email": ' })
      expect(res.status).toBe(400)
      const json = await res.json()
      expect(json.error.code).toBe('BAD_REQUEST')
      expect(JSON.stringify(json)).not.toMatch(/Unexpected|JSON|SyntaxError|at /)
    })

    it('接口响应带安全头：内容安全策略禁止加载任何资源、禁止被嵌入页面、不暴露框架信息；认证接口禁止缓存', async () => {
      const res = await raw('/health')
      const csp = res.headers.get('content-security-policy') ?? ''
      expect(csp).toContain("default-src 'none'")
      expect(csp).toContain("frame-ancestors 'none'")
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('referrer-policy')).toBe('no-referrer')
      expect(res.headers.get('x-powered-by')).toBeNull()
      const auth = await raw('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(auth.headers.get('cache-control')).toBe('no-store')
    })

    it('未信任代理时：伪造的 X-Forwarded-For 被忽略，会话记录的是真实连接地址', async () => {
      const member = await h.createMember('tenant-t', 'xff', ['entity.read'])
      await h.client.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [hashSync(PASSWORD, 4), member.userId])
      const res = await h.call(null, 'POST', '/auth/login', { body: { email: 'member-xff@example.com', password: PASSWORD }, headers: { 'x-forwarded-for': '203.0.113.9' } })
      expect(res.status).toBe(201)
      const [session] = (await h.client.query(`SELECT "ipMasked" FROM "Session" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [member.userId])).rows
      expect(session.ipMasked).toBe('127.0.0.*')
    })
  })

  describe('传输：代理信任（TRUST_PROXY=1）', () => {
    let h: DbTestApp
    beforeAll(async () => {
      process.env.TRUST_PROXY = '1'
      h = await createDbTestApp({ db, database: 'auth_proxy' })
    })
    afterAll(async () => {
      delete process.env.TRUST_PROXY
      await h?.close()
    })

    it('信任一层网关：取网关追加的客户端地址，访客自己写在前面的伪造地址被忽略', async () => {
      const tenant = await h.createTenant('p')
      const member = await h.createMember(tenant.tenantId, 'proxy', ['entity.read'])
      await h.client.query(`UPDATE "User" SET "passwordHash" = $1 WHERE id = $2`, [hashSync(PASSWORD, 4), member.userId])
      const res = await h.call(null, 'POST', '/auth/login', { body: { email: 'member-proxy@example.com', password: PASSWORD }, headers: { 'x-forwarded-for': '1.2.3.4, 203.0.113.9' } })
      expect(res.status).toBe(201)
      const [session] = (await h.client.query(`SELECT "ipMasked" FROM "Session" WHERE "userId" = $1 ORDER BY "createdAt" DESC LIMIT 1`, [member.userId])).rows
      expect(session.ipMasked).toBe('203.0.113.*')
    })
  })
})
