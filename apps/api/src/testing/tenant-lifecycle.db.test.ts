import { JwtService } from '@nestjs/jwt'
import { PrismaClient } from '@prisma/client'
import { createObjectStorage, TenantObjectStore } from '@nova/storage'
import { hash } from 'bcryptjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateTotpSecret, platformJwtSecret, totpAt } from '../modules/auth'
import { SecretBoxService } from '../platform/security/secret-box.service'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 租户注册与生命周期的端到端测试（P1-19）：真实数据库 + 完整应用 + 真实 HTTP。
// 走通“平台开通 → 邀请 → 激活 → 初始化向导 → 首次同步”，再验证暂停、支持访问、停用、注销（含删除结果与删除证明）。

const PLATFORM_PASSWORD = 'Platform#Pass12345'
const OWNER_PASSWORD = 'Owner#Strong2026x'

// 注销处理器在后台任务进程里；这里按路径动态加载，让接口服务的编译范围不包含后台任务代码（测试专用）
type CloseRunner = (deps: unknown, tenantId: string) => Promise<{ status: string }>
const loadCloseRunner = async (): Promise<CloseRunner> => (await import(/* @vite-ignore */ String('../../../worker/src/lifecycle/tenant-close'))).runTenantClose

describe('租户注册与生命周期（真实数据库）', () => {
  let harness: DbTestApp
  let jwt: JwtService
  let storageDir: string
  const platform: Record<string, { token: string; secret: string }> = {}
  const state: { tenantId?: string; inviteToken?: string; ownerToken?: string; ownerId?: string; supportAccessId?: string; supportToken?: string; fileKey?: string } = {}

  const as = (role: string) => platform[role].token
  const post = (token: string | null, path: string, body?: unknown) => harness.call(token, 'POST', path, { body: body ?? {} })
  const audit = async (action: string) => (await harness.client.query('SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = $2', [state.tenantId, action])).rows

  async function createPlatformAdmin(role: string, key: string) {
    const secrets = harness.app.get(SecretBoxService)
    const secret = generateTotpSecret()
    const sealed = await secrets.sealMfa(secret)
    const row = await insertRow(harness.client, 'PlatformAdmin', {
      id: `pa-${key}`,
      email: `${key}@platform.test`,
      name: `平台${key}`,
      role,
      passwordHash: await hash(PLATFORM_PASSWORD, 4),
      mfaSecretCiphertext: sealed.ciphertext,
      mfaKeyVersion: sealed.keyVersion,
      mfaVerifiedAt: new Date(),
    })
    platform[key] = { token: await jwt.signAsync({ typ: 'platform', adminId: row.id }, { secret: platformJwtSecret() }), secret }
  }

  beforeAll(async () => {
    storageDir = mkdtempSync(join(tmpdir(), 'nova-close-'))
    process.env.STORAGE_LOCAL_DIR = storageDir
    harness = await createDbTestApp({ database: 'lifecycle' })
    jwt = harness.app.get(JwtService)
    await createPlatformAdmin('PLATFORM_OWNER', 'owner')
    await createPlatformAdmin('PLATFORM_OPS', 'ops')
    await createPlatformAdmin('PLATFORM_SUPPORT', 'support')
    await createPlatformAdmin('PLATFORM_SUPPORT', 'support2')
  }, 120_000)

  afterAll(async () => {
    await harness?.close()
    if (storageDir) rmSync(storageDir, { recursive: true, force: true })
  })

  it('平台账号：成员令牌不能访问平台接口；支持角色只能查看，不能开通企业', async () => {
    const member = await harness.createMember((await harness.createTenant('other')).tenantId, 'other-admin', ['*'])
    expect((await harness.call(member.token, 'GET', '/platform/tenants')).status).toBe(401)
    expect((await harness.call(null, 'GET', '/platform/tenants')).status).toBe(401)
    expect((await harness.call(as('support'), 'GET', '/platform/tenants')).status).toBe(200)
    const denied = await post(as('support'), '/platform/tenants', { name: '不应成功', slug: 'denied-co', adminEmail: 'x@denied.test' })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('PLATFORM_PERMISSION_DENIED')
  })

  it('开通企业：建企业、三项配额、向导与一次性邀请；库里只存令牌哈希；写入企业审计', async () => {
    const response = await post(as('ops'), '/platform/tenants', { name: '星河贸易', slug: 'xinghe', adminEmail: 'boss@xinghe.test', localTimezone: 'Asia/Shanghai' })
    expect(response.status).toBe(201)
    const { tenant, invitation } = response.json.data
    state.tenantId = tenant.id
    expect(invitation.emailed).toBe(false)
    expect(invitation.link).toMatch(/\/invite\/[A-Za-z0-9_-]{43}$/)
    state.inviteToken = invitation.link.split('/invite/')[1]

    const row = (await harness.client.query('SELECT * FROM "Tenant" WHERE "id" = $1', [tenant.id])).rows[0]
    expect(row).toMatchObject({ lifecycleStatus: 'ACTIVE', timezone: 'America/Los_Angeles', localTimezone: 'Asia/Shanghai', defaultCurrency: 'USD' })
    expect((await harness.client.query('SELECT "quotaKey", "limitValue" FROM "TenantQuota" WHERE "tenantId" = $1 ORDER BY "quotaKey"', [tenant.id])).rows).toEqual([
      { quotaKey: 'backfillDays', limitValue: 730 },
      { quotaKey: 'members', limitValue: 10 },
      { quotaKey: 'stores', limitValue: 5 },
    ])
    expect((await harness.client.query('SELECT 1 FROM "TenantOnboarding" WHERE "tenantId" = $1', [tenant.id])).rowCount).toBe(1)
    const invite = (await harness.client.query('SELECT * FROM "TenantInvitation" WHERE "tenantId" = $1', [tenant.id])).rows[0]
    expect(JSON.stringify(invite)).not.toContain(state.inviteToken)
    expect(invite.tokenHash).toMatch(/^[a-f0-9]{64}$/)
    const created = await audit('TENANT_CREATED')
    expect(created).toHaveLength(1)
    expect(created[0].detail).toMatchObject({ accessMode: 'PLATFORM', platformRole: 'PLATFORM_OPS' })

    expect((await post(as('ops'), '/platform/tenants', { name: '重名', slug: 'xinghe', adminEmail: 'other@xinghe.test' })).json.error.code).toBe('TENANT_SLUG_TAKEN')
  })

  it('接受邀请：预览只给企业名与邮箱；弱密码拒绝；成功后绑定所有者角色与全部范围；令牌只能用一次', async () => {
    const preview = await harness.call(null, 'GET', `/auth/invitations/${state.inviteToken}`)
    expect(preview.json.data).toEqual({ tenantName: '星河贸易', email: 'boss@xinghe.test', firstAdmin: true })
    expect((await harness.call(null, 'GET', '/auth/invitations/not-a-valid-token')).status).toBe(404)

    const weak = await post(null, `/auth/invitations/${state.inviteToken}/accept`, { password: 'password1234', displayName: '老板' })
    expect(weak.status).toBe(422)
    expect(weak.json.error.code).toBe('PASSWORD_TOO_WEAK')

    const accepted = await post(null, `/auth/invitations/${state.inviteToken}/accept`, { password: OWNER_PASSWORD, displayName: '老板' })
    expect(accepted.status).toBe(201)
    expect(accepted.json.data).toMatchObject({ email: 'boss@xinghe.test', tenantName: '星河贸易', mfaEnrollmentRequired: true })
    const again = await post(null, `/auth/invitations/${state.inviteToken}/accept`, { password: OWNER_PASSWORD, displayName: '老板' })
    expect(again.status).toBe(404)
    expect(again.json.error.code).toBe('INVITATION_INVALID')

    const membership = (await harness.client.query('SELECT m.* FROM "Membership" m JOIN "User" u ON u."id" = m."userId" WHERE u."email" = $1', ['boss@xinghe.test'])).rows[0]
    expect(membership).toMatchObject({ roleId: 'preset-owner', tenantId: state.tenantId, status: 'ACTIVE' })
    const scopes = (await harness.client.query('SELECT * FROM "MembershipScope" WHERE "membershipId" = $1', [membership.id])).rows
    expect(scopes).toHaveLength(1)
    expect(scopes[0]).toMatchObject({ legalEntityId: null, sellerAccountId: null })
    expect(await audit('FIRST_ADMIN_ACTIVATED')).toHaveLength(1)
  })

  it('登录后向导未完成；必填步骤不能跳过；前置条件缺失、版本过期都会拒绝', async () => {
    const login = await post(null, '/auth/login', { email: 'boss@xinghe.test', password: OWNER_PASSWORD })
    expect(login.status).toBe(201)
    state.ownerToken = login.json.data.accessToken
    const me = await harness.call(state.ownerToken!, 'GET', '/auth/me')
    expect(me.json.data.tenant).toMatchObject({ lifecycleStatus: 'ACTIVE', onboardingCompleted: false, timezone: 'America/Los_Angeles' })

    const board = (await harness.call(state.ownerToken!, 'GET', '/onboarding')).json.data
    expect(board.steps).toHaveLength(8)
    expect(board).toMatchObject({ completed: false, currentStep: 'PROFILE', version: 1 })

    const patch = (body: unknown) => harness.call(state.ownerToken!, 'PATCH', '/onboarding', { body })
    expect((await patch({ step: 'PROFILE', action: 'SKIP', version: 1 })).json.error.code).toBe('ONBOARDING_STEP_NOT_SKIPPABLE')
    expect((await patch({ step: 'ENTITIES', action: 'COMPLETE', version: 1 })).json.error.code).toBe('ONBOARDING_PREREQUISITE_MISSING')
    expect((await patch({ step: 'ADS_AUTH', action: 'SKIP', version: 99 })).json.error.code).toBe('CONFLICT')
    expect((await patch({ step: 'PROFILE', action: 'COMPLETE', version: 1, data: { name: 'x' } })).json.error.code).toBe('ONBOARDING_STEP_INVALID')
  })

  it('走完向导：企业资料写入、成员邀请只返回一次链接、完成后按分段触发首次同步', async () => {
    const patch = async (step: string, action: string, data?: unknown) => {
      const current = (await harness.call(state.ownerToken!, 'GET', '/onboarding')).json.data
      const result = await harness.call(state.ownerToken!, 'PATCH', '/onboarding', { body: { step, action, data, version: current.version } })
      expect(result.status, `${step} ${action}: ${JSON.stringify(result.json)}`).toBe(200)
      return result.json.data
    }
    await patch('PROFILE', 'COMPLETE', { name: '星河贸易有限公司', timezone: 'America/Los_Angeles', localTimezone: 'Asia/Shanghai', defaultCurrency: 'USD' })
    expect((await harness.client.query('SELECT "name" FROM "Tenant" WHERE "id" = $1', [state.tenantId])).rows[0].name).toBe('星河贸易有限公司')

    // 法律主体、店铺与卖家授权由对应页面完成；这里直接造数模拟“已经完成”
    const entity = await insertRow(harness.client, 'LegalEntity', { id: 'le-xinghe', tenantId: state.tenantId })
    const seller = await insertRow(harness.client, 'SellerAccount', { id: 'seller-xinghe', tenantId: state.tenantId, legalEntityId: entity.id })
    await insertRow(harness.client, 'PlatformConnection', {
      id: 'conn-xinghe',
      tenantId: state.tenantId,
      sellerAccountId: seller.id,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'cipher',
      grantedScopes: '[]',
    })

    await patch('ENTITIES', 'COMPLETE')
    await patch('SELLER_AUTH', 'COMPLETE')
    await patch('ADS_AUTH', 'SKIP')
    await patch('SYNC_SCOPE', 'COMPLETE', { domains: ['ORDERS', 'INVENTORY', 'FINANCE'], backfillDays: 400 })
    await patch('FX_COST', 'COMPLETE', { costMethod: 'WEIGHTED_AVERAGE', fxPolicy: 'AUTO_DAILY' })
    const invited = await patch('MEMBERS', 'COMPLETE', { invites: [{ email: 'ops@xinghe.test', roleId: 'preset-ops', sellerAccountIds: [] }] })
    expect(invited.invitations).toHaveLength(1)
    const memberLink: string = invited.invitations[0].link
    expect(memberLink).toMatch(/\/invite\//)
    const stored = (await harness.client.query('SELECT "tokenHash" FROM "MemberInvitation" WHERE "tenantId" = $1', [state.tenantId])).rows[0]
    expect(stored.tokenHash).not.toContain(memberLink.split('/invite/')[1])

    const done = await patch('WRITE_SWITCHES', 'COMPLETE')
    expect(done).toMatchObject({ completed: true, currentStep: 'DONE' })
    // 400 天：订单每段 90 天 5 段、财务每段 180 天 3 段、库存 1 次
    expect(done.firstSync).toMatchObject({ segments: 9, jobs: 9 })
    const jobs = (await harness.client.query('SELECT "type", "priority", "context" FROM "SyncJob" WHERE "tenantId" = $1', [state.tenantId])).rows
    const count = (type: string) => jobs.filter(job => job.type === type).length
    expect([count('FBA_ORDERS'), count('FBA_FINANCE'), count('FBA_INVENTORY')]).toEqual([5, 3, 1])
    expect(jobs.every(job => job.priority === 4)).toBe(true)
    expect(jobs.filter(job => job.type === 'FBA_ORDERS').every(job => job.context.window?.after && job.context.window?.before)).toBe(true)
    const queued = harness.queue.add.mock.calls.filter(call => call[1]?.tenantId === state.tenantId && call[1]?.window)
    expect(queued).toHaveLength(8)

    expect((await harness.call(state.ownerToken!, 'GET', '/auth/me')).json.data.tenant.onboardingCompleted).toBe(true)
    expect((await harness.call(state.ownerToken!, 'PATCH', '/onboarding', { body: { step: 'PROFILE', action: 'SAVE', version: done.version } })).status).toBe(422)

    // 成员接受邀请：绑定所选角色
    const memberToken = memberLink.split('/invite/')[1]
    expect((await post(null, `/auth/invitations/${memberToken}/accept`, { password: 'Member#Strong2026y', displayName: '运营小王' })).status).toBe(201)
    const member = (await harness.client.query('SELECT m."roleId" FROM "Membership" m JOIN "User" u ON u."id" = m."userId" WHERE u."email" = $1', ['ops@xinghe.test'])).rows[0]
    expect(member.roleId).toBe('preset-ops')
  })

  it('配额：平台设置、企业只读查看，超出只提示不阻断', async () => {
    const set = await harness.call(as('ops'), 'PUT', `/platform/tenants/${state.tenantId}/quota`, { body: { quotas: { stores: 1, members: 1 }, reason: '按新报价调整配额' } })
    expect(set.status).toBe(200)
    const quotas = (await harness.call(state.ownerToken!, 'GET', '/settings/quotas')).json.data.items
    expect(quotas.find((item: { key: string }) => item.key === 'stores')).toMatchObject({ limit: 1, used: 1, exceeded: false })
    expect(quotas.find((item: { key: string }) => item.key === 'members')).toMatchObject({ limit: 1, used: 2, exceeded: true })
    const usage = (await harness.call(as('support'), 'GET', `/platform/tenants/${state.tenantId}/usage`)).json.data
    expect(usage.connections).toBe(1)
    const list = (await harness.call(as('support'), 'GET', '/platform/tenants?q=xinghe')).json.data
    expect(list.items[0]).toMatchObject({ slug: 'xinghe', status: 'ACTIVE', stores: 1, members: 2, onboardingCompleted: true })
  })

  it('暂停：企业只读（查看正常、写入 403 TENANT_SUSPENDED），恢复后放开', async () => {
    expect((await post(as('ops'), `/platform/tenants/${state.tenantId}/suspend`, { reason: '欠费催缴测试' })).status).toBe(200)
    expect((await harness.call(state.ownerToken!, 'GET', '/entities')).status).toBe(200)
    const blocked = await post(state.ownerToken!, '/entities', {})
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('TENANT_SUSPENDED')
    expect((await post(as('ops'), `/platform/tenants/${state.tenantId}/suspend`, { reason: '重复暂停应该被拒绝' })).json.error.code).toBe('TENANT_TRANSITION_INVALID')
    expect((await post(as('ops'), `/platform/tenants/${state.tenantId}/resume`, { reason: '已补缴费用，恢复服务' })).status).toBe(200)
    expect((await post(state.ownerToken!, '/entities', {})).status).toBe(422)
    const events = (await harness.client.query('SELECT "fromStatus", "toStatus" FROM "TenantLifecycleEvent" WHERE "tenantId" = $1 ORDER BY "createdAt"', [state.tenantId])).rows
    expect(events.map(item => `${item.fromStatus}>${item.toStatus}`)).toEqual(['ACTIVE>ACTIVE', 'ACTIVE>SUSPENDED', 'SUSPENDED>ACTIVE'])
  })

  it('支持访问：所有者授权（再次验证）→ 平台领取（动态验证码、独占、防重放）→ 只读且逐请求审计 → 撤销即失效', async () => {
    expect((await post(state.ownerToken!, '/settings/support-access', { hours: 2, reason: '协助排查同步问题' })).json.error.code).toBe('STEP_UP_REQUIRED')
    expect((await post(state.ownerToken!, '/auth/step-up', { action: 'support.access', method: 'PASSWORD', password: OWNER_PASSWORD })).status).toBe(200)
    const grant = await post(state.ownerToken!, '/settings/support-access', { hours: 2, reason: '协助排查同步问题' })
    expect(grant.status).toBe(201)
    state.supportAccessId = grant.json.data.id

    const code = totpAt(platform.support.secret, Date.now())
    const claimed = await post(as('support'), '/platform/support-access', { accessId: state.supportAccessId, code })
    expect(claimed.status).toBe(200)
    state.supportToken = claimed.json.data.accessToken
    // 同一个验证码不能重复使用；另一位支持人员不能领取已被领取的授权
    expect((await post(as('support'), '/platform/support-access', { accessId: state.supportAccessId, code })).json.error.code).toBe('STEP_UP_FAILED')
    const other = await post(as('support2'), '/platform/support-access', { accessId: state.supportAccessId, code: totpAt(platform.support2.secret, Date.now()) })
    expect(other.json.error.code).toBe('SUPPORT_ACCESS_CLAIMED')

    const me = (await harness.call(state.supportToken!, 'GET', '/auth/me')).json.data
    expect(me).toMatchObject({ accessMode: 'SUPPORT', user: { displayName: '平台支持人员（只读）', email: '' } })
    expect((await harness.call(state.supportToken!, 'GET', '/members')).status).toBe(200)
    // 法律主体列表自 P5-07 起按数据范围过滤；支持访问没有成员授权记录，与其他按范围过滤的页面一致返回 403
    expect((await harness.call(state.supportToken!, 'GET', '/entities')).json.error.code).toBe('SCOPE_NOT_GRANTED')
    const write = await post(state.supportToken!, '/entities', {})
    expect(write.json.error.code).toBe('SUPPORT_ACCESS_READ_ONLY')
    const trail = await audit('SUPPORT_ACCESS_REQUEST')
    expect(trail.length).toBeGreaterThanOrEqual(3)
    expect(trail[0].detail).toMatchObject({ platformAdminId: 'pa-support' })
    expect(JSON.stringify(trail)).not.toContain('boss@xinghe.test')

    expect((await harness.call(state.ownerToken!, 'DELETE', `/settings/support-access/${state.supportAccessId}`)).status).toBe(200)
    const revoked = await harness.call(state.supportToken!, 'GET', '/entities')
    expect(revoked.status).toBe(403)
    expect(revoked.json.error.code).toBe('SUPPORT_ACCESS_NOT_GRANTED')
  })

  it('停用：成员无法登录也无法继续访问；注销需要企业标识确认与动态验证码', async () => {
    expect((await post(as('ops'), `/platform/tenants/${state.tenantId}/deactivate`, { reason: '合同到期，停用保留数据', retentionDays: 30 })).status).toBe(200)
    const login = await post(null, '/auth/login', { email: 'boss@xinghe.test', password: OWNER_PASSWORD })
    expect(login.status).toBe(403)
    expect(login.json.error.code).toBe('TENANT_INACTIVE')
    expect((await harness.call(state.ownerToken!, 'GET', '/entities')).json.error.code).toBe('TENANT_INACTIVE')
    expect((await post(as('ops'), `/platform/tenants/${state.tenantId}/invite`, { email: 'new@xinghe.test' })).json.error.code).toBe('TENANT_INACTIVE')

    const close = (body: unknown, who = 'owner') => post(as(who), `/platform/tenants/${state.tenantId}/close`, body)
    const reason = '客户确认注销并已取得导出包'
    expect((await close({ reason, confirmSlug: 'wrong-slug', code: totpAt(platform.owner.secret, Date.now()) })).json.error.code).toBe('TENANT_CLOSE_CONFIRMATION_MISMATCH')
    expect((await close({ reason, confirmSlug: 'xinghe', code: '000000' })).json.error.code).toBe('STEP_UP_FAILED')
    expect((await post(as('support'), `/platform/tenants/${state.tenantId}/close`, { reason, confirmSlug: 'xinghe', code: '123456' })).status).toBe(403)
  })

  it('注销：导出 → 撤销授权 → 删令牌 → 删买家信息 → 删业务数据与文件 → 删除证明；其他企业不受影响', async () => {
    const other = (await harness.client.query(`SELECT "id" FROM "Tenant" WHERE "slug" = 'tenant-other'`)).rows[0].id as string
    const otherEntities = (await harness.client.query('SELECT count(*)::int AS n FROM "LegalEntity" WHERE "tenantId" = $1', [other])).rows[0].n
    expect(otherEntities).toBeGreaterThan(0)

    // 造一个原始报告文件（对象存储里真实存在）
    const storage = createObjectStorage({ STORAGE_DRIVER: 'local', STORAGE_LOCAL_DIR: storageDir }, { signs: false })
    const store = new TenantObjectStore(storage, state.tenantId!)
    const stored = await store.put({ domain: 'raw-files', name: 'orders.csv' }, Buffer.from('order-id,amount\n1,10\n'))
    state.fileKey = stored.key
    await insertRow(harness.client, 'RawReportFile', { id: 'raw-xinghe', tenantId: state.tenantId, objectKey: stored.key, sizeBytes: 21 })

    const accepted = await post(as('owner'), `/platform/tenants/${state.tenantId}/close`, {
      reason: '客户确认注销并已取得导出包',
      confirmSlug: 'xinghe',
      code: totpAt(platform.owner.secret, Date.now()),
    })
    expect(accepted.status).toBe(202)
    expect(accepted.json.data.status).toBe('CLOSING')
    const queued = harness.queue.add.mock.calls.find(call => call[0] === 'lifecycle')
    expect(queued?.[1]).toMatchObject({ tenantId: state.tenantId, kind: 'tenant-close' })

    // 后台任务：直接运行注销处理器（系统连接）
    const system = new PrismaClient({ datasourceUrl: harness.db.urlFor('lifecycle', 'system') })
    const logs: unknown[] = []
    const runTenantClose = await loadCloseRunner()
    const result = await runTenantClose({ db: system, storage, logger: { info: (obj: object) => logs.push(obj), warn: (obj: object) => logs.push(obj) } }, state.tenantId!)
    expect(result.status).toBe('CLOSED')
    // 重复投递安全：已注销的任务直接结束
    expect((await runTenantClose({ db: system, storage, logger: { info: () => undefined, warn: () => undefined } }, state.tenantId!)).status).toBe('SKIPPED')

    const tenant = (await harness.client.query('SELECT * FROM "Tenant" WHERE "id" = $1', [state.tenantId])).rows[0]
    expect(tenant).toMatchObject({ lifecycleStatus: 'CLOSED' })
    expect(tenant.closedAt).not.toBeNull()
    const closeState = tenant.closeStateJson
    expect(Object.values(closeState.steps).every(step => (step as { state: string }).state === 'DONE')).toBe(true)
    expect(closeState.proof.tables.LegalEntity).toBe(1)
    expect(closeState.proof.files).toBe(1)
    expect(closeState.proof.authorizationsRevokedLocally).toBe(1)

    // 业务数据全部删除，只保留审计、生命周期事件与配额
    const leftovers = (
      await harness.client.query(`SELECT c.relname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r','p') AND NOT c.relispartition`)
    ).rows.map(row => row.relname as string)
    const kept = new Set(['AuditEvent', 'TenantLifecycleEvent', 'TenantQuota'])
    for (const table of leftovers.filter(name => !kept.has(name))) {
      const remaining = (await harness.client.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [state.tenantId])).rows[0].n
      expect(remaining, table).toBe(0)
    }
    expect((await harness.client.query('SELECT count(*)::int AS n FROM "AuditEvent" WHERE "tenantId" = $1', [state.tenantId])).rows[0].n).toBeGreaterThan(5)
    expect((await harness.client.query(`SELECT count(*)::int AS n FROM "User" WHERE "email" IN ('boss@xinghe.test', 'ops@xinghe.test')`)).rows[0].n).toBe(0)
    expect(await store.stat(state.fileKey!)).toBeNull()
    expect((await harness.client.query('SELECT "toStatus" FROM "TenantLifecycleEvent" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1', [state.tenantId])).rows[0].toStatus).toBe('CLOSED')
    expect((await harness.client.query('SELECT count(*)::int AS n FROM "LegalEntity" WHERE "tenantId" = $1', [other])).rows[0].n).toBe(otherEntities)

    // 导出包：能解压，清单正确，且不含密文与令牌
    const chunks: Buffer[] = []
    for await (const chunk of await store.read(closeState.export.key)) chunks.push(chunk as Buffer)
    const lines = gunzipSync(Buffer.concat(chunks))
      .toString('utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line))
    expect(lines[0].manifest.tenantId).toBe(state.tenantId)
    expect(lines.length - 1).toBe(closeState.export.rows)
    expect(JSON.stringify(lines)).not.toMatch(/encryptedRefreshToken|cipher|passwordHash/)
    expect(lines.some(line => line.t === 'LegalEntity')).toBe(true)
    expect(lines.filter(line => line.t === '_Members')).toHaveLength(2)

    // 平台可取得短时下载链接；注销后企业再也不能登录
    const download = await harness.call(as('owner'), 'GET', `/platform/tenants/${state.tenantId}/close-export`)
    expect(download.status).toBe(200)
    expect(download.json.data.sha256).toBe(closeState.export.sha256)
    expect((await post(null, '/auth/login', { email: 'boss@xinghe.test', password: OWNER_PASSWORD })).status).toBe(401)
    await system.$disconnect()
  }, 120_000)
})
