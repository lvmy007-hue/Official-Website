import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SecretBoxService } from '../platform/security/secret-box.service'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 连接中心（P5-04，真实数据库 + 完整应用）：四类连接的总览、角色对照、数据范围与企业隔离；
// 健康检查（排后台任务、不重复排）、重新授权（沿用原连接、卖家账户必须一致、令牌换发后清除失败并补一次检查）、
// 断开（再次验证身份、要原因、清令牌、排队任务作废、写审计、重复断开 409）。

type Member = { userId: string; token: string }
const OLD_TOKEN = 'SEALED-OLD-TOKEN'

describe('连接中心（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeA2: string
  let legalEntityId: string
  let admin: Member
  let reader: Member
  let scopedA: Member
  let otherAdmin: Member
  const realFetch = globalThis.fetch

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const connectionRow = async (id: string) =>
    (
      await rows<{ state: string; encryptedRefreshToken: string | null; lastErrorCode: string | null }>(
        `SELECT state, "encryptedRefreshToken", "lastErrorCode" FROM "PlatformConnection" WHERE id = $1`,
        [id],
      )
    )[0]!
  const audits = (action: string) =>
    rows<{ resourceId: string; result: string; reason: string | null; actorId: string; detail: Record<string, any> }>(
      `SELECT "resourceId", result, reason, "actorId", detail FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 AND result = 'SUCCEEDED' ORDER BY "createdAt"`,
      [action, tenantId],
    )
  const overview = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/connections')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as {
      items: {
        id: string
        kind: string
        state: string
        connectionId: string | null
        hasToken: boolean
        failureCode: string | null
        actions: Record<string, { allowed: boolean; reason: string | null }> | null
        tokenExpiry: { state: string } | null
        storeId: string | null
      }[]
      summary: { total: number; byKind: Record<string, number>; authorized: number; attention: number }
      roles: { modules: { key: string; state: string; impact: string | null }[]; roles: { name: string; state: string }[]; storeCount: number }
      legalEntities: { id: string; name: string }[]
      canManage: boolean
    }
  }
  const byId = (data: Awaited<ReturnType<typeof overview>>, id: string) => data.items.find(item => item.id === id)!
  const post = (member: Member, path: string, body?: Record<string, unknown>) => h.call(member.token, 'POST', path, body ? { body } : {})
  const stepUp = (member: Member, inTenant = tenantId) =>
    insertRow(h.client, 'StepUpVerification', {
      id: `su-${member.userId}`,
      tenantId: inTenant,
      userId: member.userId,
      action: 'connection.disconnect',
      method: 'PASSWORD',
      expiresAt: new Date(Date.now() + 600_000),
    })

  beforeAll(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = '1'.repeat(64)
    Object.assign(process.env, {
      AMAZON_SP_REDIRECT_URI: 'https://app.example.com/api/v1/sp-api/oauth/callback',
      AMAZON_SP_API_APPROVED: 'true',
      AMAZON_SP_APPLICATION_ID: 'amzn1.sp.solution.test',
      AMAZON_SP_LWA_CLIENT_ID: 'sp-client',
      AMAZON_SP_LWA_CLIENT_SECRET: 'sp-secret',
      AMAZON_ADS_REDIRECT_URI: 'https://app.example.com/api/v1/ads/oauth/callback',
      AMAZON_ADS_CLIENT_ID: 'ads-client',
      AMAZON_ADS_CLIENT_SECRET: 'ads-secret',
      AMAZON_ADS_API_APPROVED: 'true',
    })
    h = await createDbTestApp({ database: 'conn_center' })
    await h.app.get(SecretBoxService).prepare() // 授权回调要加密保存刷新令牌：先备好数据密钥
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    legalEntityId = a.legalEntityId
    storeA2 = 'seller-a2'
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-A', "displayName" = '主店' WHERE id = $1`, [storeA])
    await insertRow(h.client, 'SellerAccount', { id: storeA2, tenantId, legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '二店' })
    await h.client.query(`UPDATE "LegalEntity" SET name = '星河贸易有限公司' WHERE id = $1`, [legalEntityId])

    const connection = (id: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'PlatformConnection', {
        id,
        tenantId,
        provider: 'AMAZON_SP_API',
        state: 'AUTHORIZED',
        encryptedRefreshToken: OLD_TOKEN,
        refreshTokenUpdatedAt: new Date('2025-01-01T00:00:00Z'),
        grantedScopes: JSON.stringify(['seller', 'fba']),
        ...over,
      })
    await connection('conn-a', { sellerAccountId: storeA, externalAccountId: 'SELLER-A', lastErrorCode: 'AUTH_EXPIRED' })
    await connection('conn-a2', { sellerAccountId: storeA2, externalAccountId: 'SELLER-A2' })
    await connection('conn-ads', { provider: 'AMAZON_ADS_API', grantedScopes: JSON.stringify(['advertising::campaign_management']) })
    await connection('conn-revoked', { sellerAccountId: storeA2, state: 'REVOKED', encryptedRefreshToken: null })
    await connection('conn-pending', { state: 'AUTHORIZING', encryptedRefreshToken: null, refreshTokenUpdatedAt: null, grantedScopes: '[]' })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-b',
      tenantId: otherTenantId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      sellerAccountId: b.sellerAccountId,
      encryptedRefreshToken: OLD_TOKEN,
    })
    await insertRow(h.client, 'ConnectionHealth', {
      id: 'health-a',
      connectionId: 'conn-a',
      status: 'UNHEALTHY',
      checks: JSON.stringify([{ key: 'token', label: '换取访问令牌', ok: false, message: 'AUTH_EXPIRED' }]),
      requestId: 'req-health',
      checkedAt: new Date('2026-10-19T00:00:00Z'),
    })
    // 支持案件缺角色、订单同步成功、品牌分析没有品牌备案
    const fresh = (sellerAccountId: string, sourceKey: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'DataFreshness', { id: `df-${sellerAccountId}-${sourceKey}`, tenantId, sellerAccountId, sourceKey, lastAttemptAt: new Date(), ...over })
    await fresh(storeA, 'support.api', { status: 'UNAUTHORIZED', lastErrorCode: 'SUP_ROLE_PENDING' })
    await fresh(storeA, 'orders.api', { status: 'NORMAL', lastSuccessAt: new Date('2026-10-19T00:00:00Z') })
    await fresh(storeA, 'rpt.ba.search-query', { status: 'FAILED', lastErrorCode: 'BA_NO_BRAND' })
    await insertRow(h.client, 'SyncJob', { id: 'job-pending-1', tenantId, connectionId: 'conn-a2', type: 'FBA_ORDERS', status: 'PENDING', requestId: 'r1' })
    await insertRow(h.client, 'SyncJob', { id: 'job-pending-2', tenantId, connectionId: 'conn-a2', type: 'FBA_INVENTORY', status: 'PENDING', requestId: 'r2' })
    await insertRow(h.client, 'SyncJob', { id: 'job-running', tenantId, connectionId: 'conn-a2', type: 'FBA_FINANCE', status: 'RUNNING', requestId: 'r3' })

    admin = await h.createMember(tenantId, 'admin', ['connection.read', 'connection.manage'])
    reader = await h.createMember(tenantId, 'reader', ['connection.read'])
    scopedA = await h.createMember(tenantId, 'scopeda', ['connection.read', 'connection.manage'], { scopes: [{ sellerAccountId: storeA }] })
    otherAdmin = await h.createMember(otherTenantId, 'otheradmin', ['connection.read', 'connection.manage'])
  })
  afterAll(async () => {
    vi.unstubAllGlobals()
    await h?.close()
  })

  it('总览：四类连接都在，卖家连接带授权主体、失败码与健康检查；令牌密文不出现；角色对照点名缺失的板块与页面', async () => {
    const data = await overview(admin)
    expect(JSON.stringify(data)).not.toContain(OLD_TOKEN)
    expect(data.canManage).toBe(true)
    expect(data.legalEntities).toEqual([{ id: legalEntityId, name: '星河贸易有限公司' }])
    expect(data.summary.byKind).toMatchObject({ SELLER: 4, ADS: 1, REPORT_ROLE: 2, BRAND_ANALYTICS: 2 }) // 已授权的卖家连接两条各出一组派生连接
    const sellerA = byId(data, 'conn-a') as ReturnType<typeof byId> & { subject: string; accountLabel: string; failureText: string; health: { status: string; checks: unknown[] } }
    expect(sellerA).toMatchObject({ kind: 'SELLER', state: 'AUTHORIZED', hasToken: true, subject: '星河贸易有限公司', accountLabel: '主店（SELLER-A）', failureCode: 'AUTH_EXPIRED' })
    expect(sellerA.health).toMatchObject({ status: 'UNHEALTHY' })
    expect(sellerA.health.checks).toHaveLength(1)
    expect(sellerA.failureText).toContain('重新授权')
    expect(byId(data, 'conn-pending')).toMatchObject({ state: 'AUTHORIZING', hasToken: false })
    expect(byId(data, 'conn-revoked')).toMatchObject({ state: 'REVOKED', hasToken: false })
    expect(byId(data, 'conn-ads')).toMatchObject({ kind: 'ADS', hasToken: true })

    expect(data.roles.modules.find(item => item.key === 'support')?.state).toBe('MISSING') // 主店缺角色、二店没有记录：没有任何成功的证据，按缺少角色
  })

  it('角色对照：缺失的板块说明影响的页面；没有同步记录的是尚未验证；品牌分析资格按来源给出不适用', async () => {
    const data = await overview(admin)
    const support = data.roles.modules.find(item => item.key === 'support')!
    expect(support.state).toBe('MISSING')
    expect(support.impact).toContain('“支持案件”')
    expect(data.roles.modules.find(item => item.key === 'orders')?.state).toBe('GRANTED')
    expect(data.roles.modules.find(item => item.key === 'pricing')?.state).toBe('UNVERIFIED')
    expect(data.roles.roles.find(item => item.name === 'Selling Partner Support (Restricted)')?.state).toBe('MISSING')
    expect(byId(data, 'BRAND_ANALYTICS:' + storeA).state).toBe('NOT_APPLICABLE')
    expect(data.roles.storeCount).toBe(2)
  })

  it('令牌预计失效：预警规则里设置了授权最长年龄就按它推算，没设置不推算', async () => {
    expect(byId(await overview(admin), 'conn-a').tokenExpiry?.state).toBe('NOT_ESTIMATED')
    await insertRow(h.client, 'AlertRule', {
      id: 'rule-auth',
      tenantId,
      code: 'SYS_AUTH_EXPIRING',
      domain: 'SYSTEM',
      name: '亚马逊授权失效或即将失效',
      conditionJson: JSON.stringify({ type: 'system.auth-expiring', params: { tokenMaxAgeDays: 365, warnBeforeDays: 30 } }),
      scopeJson: '{}',
    })
    expect(byId(await overview(admin), 'conn-a').tokenExpiry?.state).toBe('PASSED') // 2025-01-01 授权，365 天后早已过去
    await h.client.query(`DELETE FROM "AlertRule" WHERE id = 'rule-auth'`)
  })

  it('数据范围与企业隔离：只授权主店的人看不到二店与没有归属店铺的连接；别的企业只看到自己的', async () => {
    const scoped = await overview(scopedA)
    expect(scoped.items.filter(item => item.connectionId).map(item => item.id)).toEqual(['conn-a'])
    expect(scoped.roles.storeCount).toBe(1)
    expect(byId(scoped, 'conn-a').actions?.healthCheck.allowed).toBe(true)
    const readOnly = await overview(reader)
    expect(readOnly.canManage).toBe(false)
    expect(readOnly.legalEntities).toEqual([])
    expect(byId(readOnly, 'conn-a').actions?.disconnect.allowed).toBe(false)
    const other = await overview(otherAdmin)
    expect(other.items.filter(item => item.connectionId).map(item => item.id)).toEqual(['conn-b'])
    expect(JSON.stringify(other)).not.toContain('SELLER-A')
  })

  it('健康检查：排一个后台任务并立即返回；同一连接已有排队中的不再排第二个；写审计', async () => {
    h.queue.add.mockClear()
    const first = await post(admin, '/connections/conn-a/health-check')
    expect(first.status, JSON.stringify(first.json)).toBe(201)
    expect(first.json.data).toMatchObject({ connectionId: 'conn-a', alreadyRunning: false })
    const jobs = await rows<{ id: string; type: string; status: string; domain: string }>(`SELECT id, type, status, domain FROM "SyncJob" WHERE "connectionId" = 'conn-a'`)
    expect(jobs).toEqual([{ id: first.json.data.syncJobId, type: 'CONNECTION_HEALTH_CHECK', status: 'PENDING', domain: 'general' }])
    expect(h.queue.add).toHaveBeenCalledTimes(1)
    expect(h.queue.add.mock.calls[0]).toMatchObject(['sync', { tenantId, syncJobId: first.json.data.syncJobId }, first.json.data.syncJobId, { type: 'CONNECTION_HEALTH_CHECK' }])

    const again = await post(admin, '/connections/conn-a/health-check')
    expect(again.json.data).toMatchObject({ syncJobId: first.json.data.syncJobId, alreadyRunning: true })
    expect(h.queue.add).toHaveBeenCalledTimes(1)
    expect(await rows(`SELECT 1 FROM "SyncJob" WHERE "connectionId" = 'conn-a'`)).toHaveLength(1)
    const [audit] = await audits('CONNECTION_HEALTH_CHECK_REQUESTED')
    expect(audit).toMatchObject({ resourceId: 'conn-a', result: 'SUCCEEDED', actorId: admin.userId })
    expect(audit!.detail).toMatchObject({ provider: 'AMAZON_SP_API', syncJobId: first.json.data.syncJobId })
  })

  it('健康检查的拦截：只读权限 403、范围外 403、别的企业 404、授权未完成与已断开 409', async () => {
    expect((await post(reader, '/connections/conn-a/health-check')).status).toBe(403)
    const outside = await post(scopedA, '/connections/conn-a2/health-check')
    expect(outside.status).toBe(404) // 范围外的连接对他不可见，与不存在一样
    expect((await post(otherAdmin, '/connections/conn-a/health-check')).status).toBe(404)
    const pending = await post(admin, '/connections/conn-pending/health-check')
    expect(pending.status).toBe(409)
    expect(pending.json.error.code).toBe('CONNECTION_UNAVAILABLE')
    expect((await post(admin, '/connections/conn-revoked/health-check')).json.error.code).toBe('CONNECTION_UNAVAILABLE')
    expect(await rows(`SELECT 1 FROM "SyncJob" WHERE "connectionId" IN ('conn-pending', 'conn-revoked')`)).toHaveLength(0)
  })

  it('重新授权（卖家）：沿用原连接不新建，记下发起人与法律主体，写审计；没有归属店铺的连接只有全部范围的人能操作', async () => {
    const before = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "PlatformConnection" WHERE "tenantId" = $1`, [tenantId])
    const res = await post(admin, '/connections/conn-a/reauthorize')
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ connectionId: 'conn-a', provider: 'AMAZON_SP_API' })
    expect(res.json.data.authorizationUrl).toContain('application_id=amzn1.sp.solution.test')
    expect(await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "PlatformConnection" WHERE "tenantId" = $1`, [tenantId])).toEqual(before)
    const states = await rows<{ initiatedById: string; legalEntityId: string; consumedAt: Date | null }>(
      `SELECT "initiatedById", "legalEntityId", "consumedAt" FROM "OAuthState" WHERE "connectionId" = 'conn-a'`,
    )
    expect(states).toEqual([{ initiatedById: admin.userId, legalEntityId, consumedAt: null }])
    expect((await connectionRow('conn-a')).state).toBe('AUTHORIZED') // 发起授权不改状态：数据照常流动
    expect((await audits('CONNECTION_REAUTHORIZE_STARTED'))[0]).toMatchObject({ resourceId: 'conn-a', actorId: admin.userId })

    const ads = await post(admin, '/connections/conn-ads/reauthorize')
    expect(ads.status, JSON.stringify(ads.json)).toBe(201)
    expect(ads.json.data).toMatchObject({ connectionId: 'conn-ads', provider: 'AMAZON_ADS_API' })
    expect(ads.json.data.authorizationUrl).toContain('client_id=ads-client')
    const tenantLevel = await post(scopedA, '/connections/conn-ads/reauthorize')
    expect(tenantLevel.status).toBe(404) // 没有归属店铺的连接对只授权主店的人不可见
    expect((await post(reader, '/connections/conn-a/reauthorize')).status).toBe(403)
  })

  it('重新授权回来：换了卖家账户被拒绝（原连接不变）；同一卖家账户换发令牌、清掉失败码并补一次健康检查', async () => {
    const started = await post(admin, '/connections/conn-a2/reauthorize')
    const state = new URL(started.json.data.authorizationUrl).searchParams.get('state')!
    const mismatch = await h.call(null, 'GET', `/sp-api/oauth/callback?state=${state}&spapi_oauth_code=code-1&selling_partner_id=SELLER-SOMEONE-ELSE`)
    expect(mismatch.status).toBe(302)
    expect(mismatch.headers.get('location')).toContain('status=error&code=OAUTH_SELLER_MISMATCH')
    expect(await connectionRow('conn-a2')).toMatchObject({ state: 'AUTHORIZED', encryptedRefreshToken: OLD_TOKEN })
    expect(await rows(`SELECT 1 FROM "OAuthState" WHERE "connectionId" = 'conn-a2' AND "consumedAt" IS NOT NULL`)).toHaveLength(0)

    await h.client.query(`UPDATE "PlatformConnection" SET "lastErrorCode" = 'LWA_TOKEN_FAILED_400' WHERE id = 'conn-a2'`)
    vi.stubGlobal('fetch', (input: unknown, init?: unknown) =>
      String(input).startsWith('https://api.amazon.com')
        ? Promise.resolve(new Response(JSON.stringify({ refresh_token: 'Atzr|new-refresh-token' }), { status: 200 }))
        : realFetch(input as string, init as RequestInit),
    )
    h.queue.add.mockClear()
    const ok = await h.call(null, 'GET', `/sp-api/oauth/callback?state=${state}&spapi_oauth_code=code-2&selling_partner_id=SELLER-A2`)
    vi.unstubAllGlobals()
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toContain('status=connected')
    const after = await connectionRow('conn-a2')
    expect(after).toMatchObject({ state: 'AUTHORIZED', lastErrorCode: null })
    expect(after.encryptedRefreshToken).toBeTruthy()
    expect(after.encryptedRefreshToken).not.toBe(OLD_TOKEN)
    expect(after.encryptedRefreshToken).not.toContain('new-refresh-token') // 密文，不是明文
    expect((await rows<{ displayName: string }>(`SELECT "displayName" FROM "SellerAccount" WHERE id = $1`, [storeA2]))[0]!.displayName).toBe('二店') // 重新授权不改店铺名称
    expect(await rows(`SELECT 1 FROM "PlatformConnection" WHERE "tenantId" = $1 AND "externalAccountId" = 'SELLER-A2'`, [tenantId])).toHaveLength(1) // 没有新建重复连接
    expect(h.queue.add).toHaveBeenCalledTimes(1)
    expect(h.queue.add.mock.calls[0]![3]).toMatchObject({ type: 'CONNECTION_HEALTH_CHECK' })
    expect(await rows(`SELECT 1 FROM "SyncJob" WHERE "connectionId" = 'conn-a2' AND type = 'CONNECTION_HEALTH_CHECK'`)).toHaveLength(1)
  })

  it('断开：要再次验证身份与原因；通过后清令牌、状态已断开、排队的同步任务作废（运行中的不动）、写带原因与前后状态的审计', async () => {
    const noStep = await post(admin, '/connections/conn-a2/disconnect', { reason: '不再使用二店' })
    expect(noStep.status).toBe(403)
    expect(noStep.json.error.code).toBe('STEP_UP_REQUIRED')
    expect((await connectionRow('conn-a2')).state).toBe('AUTHORIZED')

    await stepUp(admin)
    expect((await post(admin, '/connections/conn-a2/disconnect', {})).status).toBe(422)
    expect((await post(admin, '/connections/conn-a2/disconnect', { reason: '不再使用二店' })).status).toBe(201)
    expect(await connectionRow('conn-a2')).toMatchObject({ state: 'REVOKED', encryptedRefreshToken: null, lastErrorCode: null })
    const jobs = await rows<{ id: string; status: string; failureCode: string | null }>(
      `SELECT id, status, "failureCode" FROM "SyncJob" WHERE "connectionId" = 'conn-a2' AND type <> 'CONNECTION_HEALTH_CHECK' ORDER BY id`,
    )
    expect(jobs).toEqual([
      { id: 'job-pending-1', status: 'FAILED_PERMANENT', failureCode: 'CONNECTION_DISCONNECTED' },
      { id: 'job-pending-2', status: 'FAILED_PERMANENT', failureCode: 'CONNECTION_DISCONNECTED' },
      { id: 'job-running', status: 'RUNNING', failureCode: null },
    ])
    const [audit] = await audits('CONNECTION_DISCONNECTED')
    expect(audit).toMatchObject({ resourceId: 'conn-a2', result: 'SUCCEEDED', reason: '不再使用二店', actorId: admin.userId })
    expect(audit!.detail).toMatchObject({ provider: 'AMAZON_SP_API', cancelledJobs: 3 }) // 两个同步任务 + 授权成功后排的那个健康检查任务

    const again = await post(admin, '/connections/conn-a2/disconnect', { reason: '重复点击' })
    expect(again.status).toBe(409)
    expect(again.json.error.code).toBe('CONNECTION_ALREADY_DISCONNECTED')
    const data = await overview(admin)
    expect(byId(data, 'conn-a2')).toMatchObject({ state: 'REVOKED', hasToken: false })
    expect(byId(data, 'conn-a2').actions).toMatchObject({ disconnect: { allowed: false }, healthCheck: { allowed: false }, reauthorize: { allowed: true } })
    expect(data.items.some(item => item.id === `BRAND_ANALYTICS:${storeA2}`)).toBe(false) // 断开后这个店铺不再出现派生连接
  })

  it('断开的拦截：只读 403、范围外 404、别的企业 404、没有归属店铺只有全部范围的人能断开；失败的尝试不改任何数据', async () => {
    await stepUp(scopedA)
    await stepUp(otherAdmin, otherTenantId)
    expect((await post(reader, '/connections/conn-a/disconnect', { reason: '试一试' })).status).toBe(403)
    expect((await post(scopedA, '/connections/conn-ads/disconnect', { reason: '试一试' })).status).toBe(404)
    expect((await post(scopedA, '/connections/conn-b/disconnect', { reason: '试一试' })).status).toBe(404)
    expect((await post(otherAdmin, '/connections/conn-a/disconnect', { reason: '试一试' })).status).toBe(404)
    expect(await connectionRow('conn-a')).toMatchObject({ state: 'AUTHORIZED', encryptedRefreshToken: OLD_TOKEN })
    expect(await connectionRow('conn-ads')).toMatchObject({ state: 'AUTHORIZED', encryptedRefreshToken: OLD_TOKEN })
    expect(await connectionRow('conn-b')).toMatchObject({ state: 'AUTHORIZED', encryptedRefreshToken: OLD_TOKEN })
  })
})
