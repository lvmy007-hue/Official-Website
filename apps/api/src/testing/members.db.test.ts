import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 成员与角色（P5-08，真实数据库 + 完整应用）：成员列表与详情、邀请（令牌只存哈希、越权、范围核对）、停用（吊销会话）、
// 改角色与改范围（不能改自己、不能管比自己高的人、不能授予自己没有的权限）、角色编辑器（复制、乐观锁、职责分离、字段三档）、
// 企业隔离、迁移的回滚与重放。

type Member = { userId: string; token: string; membershipId: string }
type Row = Record<string, any>

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261204010000_members_roles')
const MANAGER_PERMISSIONS = ['member.read', 'member.invite', 'member.manage', 'role.manage', 'audit.read', 'orders.read']

describe('成员与角色（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let owner: Member
  let owner2: Member
  let admin: Member
  let manager: Member
  let reader: Member
  let limited: Member
  let victim: Member
  let other: Member
  let otherTenantId: string
  let otherEntity: string
  let stepSeq = 0

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Row
  }
  // 高风险写操作需要再次验证身份：每次请求前给操作者一条有效的验证记录
  const stepUp = (member: Member, action: string, inTenant = tenantId) =>
    insertRow(h.client, 'StepUpVerification', { id: `su-${(stepSeq += 1)}`, tenantId: inTenant, userId: member.userId, action, method: 'PASSWORD', expiresAt: new Date(Date.now() + 600_000) })
  const write = async (member: Member, method: string, path: string, body: Row, action = 'member.manage') => {
    await stepUp(member, action, member === other ? otherTenantId : tenantId)
    return h.call(member.token, method, path, { body })
  }
  const memberRow = (id: string) => rows<Row>(`SELECT * FROM "Membership" WHERE id = $1`, [id]).then(list => list[0]!)
  const audits = (action: string) => rows<Row>(`SELECT * FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 ORDER BY "occurredAt"`, [action, tenantId])

  beforeAll(async () => {
    process.env.APP_PUBLIC_URL = 'https://app.example.com'
    h = await createDbTestApp({ database: 'members' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    otherEntity = b.legalEntityId
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = 'Store-1' WHERE id = $1`, [a.sellerAccountId])
    await insertRow(h.client, 'LegalEntity', { id: 'le-a2', tenantId, name: '主体乙', registeredCountry: '美国' })
    await insertRow(h.client, 'SellerAccount', { id: 'seller-a2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: 'Store-2' })
    owner = await h.createMember(tenantId, 'owner', [], { roleId: 'preset-owner' })
    owner2 = await h.createMember(tenantId, 'owner2', [], { roleId: 'preset-owner' })
    admin = await h.createMember(tenantId, 'admin', [], { roleId: 'preset-admin' })
    manager = await h.createMember(tenantId, 'manager', MANAGER_PERMISSIONS)
    reader = await h.createMember(tenantId, 'reader', ['member.read'])
    limited = await h.createMember(tenantId, 'limited', ['member.read', 'member.manage'], { scopes: [{ sellerAccountId: 'seller-a2' }] })
    victim = await h.createMember(tenantId, 'victim', [], { roleId: 'preset-ops' })
    other = await h.createMember(b.tenantId, 'other', [], { roleId: 'preset-owner' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('列表：姓名、角色、数据范围概括、最近登录；各状态条数；角色筛选项含预设角色与本企业自定义角色，不含别的企业的', async () => {
    const list = await get(owner, '/members')
    const byEmail = Object.fromEntries((list.items as Row[]).map(item => [item.email, item]))
    expect(Object.keys(byEmail)).not.toContain('member-other@example.com')
    expect(byEmail['member-victim@example.com']).toMatchObject({ roleName: '运营', roleSystem: true, status: 'ACTIVE', isSelf: false })
    expect(byEmail['member-victim@example.com'].scope).toMatchObject({ kind: 'ALL', label: '全部主体与店铺' })
    expect(byEmail['member-limited@example.com'].scope).toMatchObject({ kind: 'STORES', storeNames: ['Store-2'] })
    expect(byEmail['member-limited@example.com'].scope.label).toBe('指定店铺：Store-2')
    expect(byEmail['member-owner@example.com'].isSelf).toBe(true)
    // 造数时每个成员有一条会话，所以都有最近登录
    expect(byEmail['member-victim@example.com'].lastLoginAt).toEqual(expect.any(String))
    expect(list.summary).toMatchObject({ total: 7, active: 7, disabled: 0, pendingInvitations: 0 })
    expect(list).toMatchObject({ canInvite: true, canManage: true, inviteBlockedReason: null, manageBlockedReason: null })
    const roleNames = (list.roles as Row[]).map(role => role.name)
    expect(roleNames).toEqual(expect.arrayContaining(['所有者', '管理员', '运营', '财务', '只读', '角色manager']))
    expect(roleNames).not.toContain('角色other')
  })

  it('列表：搜索、状态与角色筛选、翻页；没有成员查看权限 403 且先于参数校验', async () => {
    expect(((await get(owner, '/members?q=victim')).items as Row[]).map(item => item.email)).toEqual(['member-victim@example.com'])
    expect(((await get(owner, '/members?roleId=preset-owner')).items as Row[]).map(item => item.email).sort()).toEqual(['member-owner2@example.com', 'member-owner@example.com'])
    expect((await get(owner, '/members?status=DISABLED')).items).toEqual([])
    const first = await get(owner, '/members?pageSize=3')
    expect(first).toMatchObject({ total: 7, pageSize: 3 })
    expect(first.items).toHaveLength(3)
    expect(((await get(owner, '/members?pageSize=3&page=2')).items as Row[])[0]!.id).not.toBe((first.items as Row[])[0]!.id)
    const none = await h.createMember(tenantId, 'noperm', ['orders.read'])
    expect((await h.call(none.token, 'GET', '/members?pageSize=abc')).status).toBe(403)
    expect((await h.call(owner.token, 'GET', '/members?pageSize=abc')).status).toBe(422)
    expect((await h.call(null, 'GET', '/members')).status).toBe(401)
  })

  it('列表：只读成员看得到列表但不能邀请与管理，并写明原因；受限范围成员不能管理', async () => {
    const asReader = await get(reader, '/members')
    expect(asReader).toMatchObject({ canInvite: false, canManage: false })
    expect(asReader.inviteBlockedReason).toContain('邀请成员')
    expect(asReader.manageBlockedReason).toContain('权限')
    const asLimited = await get(limited, '/members')
    expect(asLimited.canManage).toBe(false)
    expect(asLimited.manageBlockedReason).toContain('全部店铺')
  })

  it('选人列表：只需要成员查看权限，不含角色与范围；别的企业的成员不出现', async () => {
    const options = (await h.call(reader.token, 'GET', '/members/options')).json.data as Row[]
    expect(options.length).toBe(8)
    expect(options[0]).toEqual({ status: 'ACTIVE', user: { id: expect.any(String), displayName: expect.any(String), email: expect.any(String) } })
    expect(options.map(item => item.user.email)).not.toContain('member-other@example.com')
    const none = await h.createMember(tenantId, 'noperm2', ['orders.read'])
    expect((await h.call(none.token, 'GET', '/members/options')).status).toBe(403)
  })

  it('详情：角色与字段权限、授权记录、会话、与该成员有关的审计；没有审计查看权限时标记受限；别的企业的成员 404', async () => {
    const detail = await get(manager, `/members/${victim.membershipId}`)
    expect(detail.member).toMatchObject({ name: expect.any(String), roleName: '运营', status: 'ACTIVE', disabledAt: null })
    expect(detail.role).toMatchObject({ id: 'preset-ops', system: true, fields: { cost: 'HIDDEN', profit: 'VISIBLE', buyer: 'HIDDEN' } })
    expect(detail.grants).toEqual([expect.objectContaining({ kind: 'ALL', refId: null, name: '全部主体与店铺' })])
    expect(detail.roles).toEqual(
      expect.arrayContaining([
        { id: 'preset-ops', name: '运营' },
        { id: 'preset-owner', name: expect.any(String) },
      ]),
    )
    expect(detail.sessions).toEqual([expect.objectContaining({ state: 'ACTIVE' })])
    expect(detail.audit.state).toBe('OK')
    expect(detail.actions).toMatchObject({ disable: expect.stringContaining('权限高于你'), enable: expect.any(String), role: expect.any(String), scopes: expect.any(String) })
    const asReader = await get(reader, `/members/${victim.membershipId}`)
    expect(asReader.audit).toEqual({ state: 'RESTRICTED', items: [], truncated: false })
    expect(asReader.canManage).toBe(false)
    const asOwner = await get(owner, `/members/${victim.membershipId}`)
    expect(asOwner.actions).toMatchObject({ disable: null, enable: '这位成员正在使用中', role: null, scopes: null })
    const self = await get(owner, `/members/${owner.membershipId}`)
    expect(self.actions.disable).toContain('不能修改自己')
    await get(owner, `/members/${other.membershipId}`, 404)
  })

  it('邀请：令牌只存哈希、邮件通道未配置时链接只在响应里出现一次、审计不含令牌；范围写进快照；再次邀请作废上一封', async () => {
    const res = await write(
      owner,
      'POST',
      '/members/invite',
      { email: 'New.Hire@Example.com', roleId: 'preset-ops', scope: { all: false, legalEntityIds: ['le-a2'], sellerAccountIds: ['seller-a'] } },
      'member.invite',
    )
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    const result = res.json.data as Row
    expect(result).toMatchObject({ email: 'new.hire@example.com', emailed: false, replacedPrevious: 0, warnings: [] })
    expect(result.link).toMatch(/^https:\/\/app\.example\.com\/invite\/[A-Za-z0-9_-]{43}$/)
    const token = String(result.link).split('/').pop()!
    const [invitation] = await rows<Row>(`SELECT * FROM "MemberInvitation" WHERE id = $1`, [result.invitationId])
    expect(invitation).toMatchObject({ tenantId, email: 'new.hire@example.com', roleId: 'preset-ops', status: 'PENDING', invitedBy: owner.userId })
    expect(invitation!.tokenHash).not.toContain(token)
    expect(invitation!.scopeSnapshot).toEqual({ all: false, legalEntityIds: ['le-a2'], sellerAccountIds: ['seller-a'] })
    const [event] = await audits('MEMBER_INVITED')
    expect(JSON.stringify(event)).not.toContain(token)
    // 审计的快照由写入器统一脱敏：邮箱不以明文落库\n    expect(event!.afterJson).toMatchObject({ roleName: '运营' })\n    expect(JSON.stringify(event)).not.toContain('new.hire@example.com')

    const list = await get(owner, '/members')
    expect(list.summary.pendingInvitations).toBe(1)
    expect(list.invitations[0]).toMatchObject({ email: 'new.hire@example.com', roleName: '运营', invitedByName: expect.any(String) })
    expect(list.invitations[0].scopeLabel).toContain('指定主体与店铺')

    const again = await write(owner, 'POST', '/members/invite', { email: 'new.hire@example.com', roleId: 'preset-ops', scope: { all: true } }, 'member.invite')
    expect(again.json.data.replacedPrevious).toBe(1)
    expect((await rows<Row>(`SELECT status FROM "MemberInvitation" WHERE id = $1`, [result.invitationId]))[0]!.status).toBe('REVOKED')
    expect((await h.call(null, 'GET', `/auth/invitations/${token}`)).status).toBeGreaterThanOrEqual(400)
  })

  it('邀请：接受后成员按邀请时指定的主体与店铺获得数据范围（主体不再被当成“全部”）', async () => {
    const res = await write(
      owner,
      'POST',
      '/members/invite',
      { email: 'scoped.hire@example.com', roleId: 'preset-ops', scope: { all: false, legalEntityIds: ['le-a2'], sellerAccountIds: [] } },
      'member.invite',
    )
    const token = String(res.json.data.link).split('/').pop()!
    const accepted = await h.call(null, 'POST', `/auth/invitations/${token}/accept`, { body: { displayName: '新同事', password: 'Correct-Horse-Battery-9' }, idempotencyKey: false })
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(201)
    const scopes = await rows<Row>(
      `SELECT s."legalEntityId", s."sellerAccountId" FROM "MembershipScope" s JOIN "Membership" m ON m.id = s."membershipId" JOIN "User" u ON u.id = m."userId" WHERE u.email = 'scoped.hire@example.com'`,
    )
    expect(scopes).toEqual([{ legalEntityId: 'le-a2', sellerAccountId: null }])
    // 清理，不影响后面的人数断言
    await h.client.query(`DELETE FROM "User" WHERE email = 'scoped.hire@example.com'`)
  })

  it('邀请的拦截：已有账号的邮箱、不存在或别的企业的角色、别的企业的主体、授予自己没有的权限、所有者的范围', async () => {
    const taken = await write(owner, 'POST', '/members/invite', { email: 'member-reader@example.com', roleId: 'preset-ops', scope: { all: true } }, 'member.invite')
    expect(taken.status).toBe(409)
    expect(taken.json.error.fieldErrors.email).toBeDefined()
    const noRole = await write(owner, 'POST', '/members/invite', { email: 'a1@example.com', roleId: 'no-such-role', scope: { all: true } }, 'member.invite')
    expect(noRole.status).toBe(422)
    expect(noRole.json.error.fieldErrors.roleId).toBeDefined()
    const otherRole = await write(owner, 'POST', '/members/invite', { email: 'a2@example.com', roleId: 'role-other', scope: { all: true } }, 'member.invite')
    expect(otherRole.status).toBe(422)
    const foreignEntity = await write(owner, 'POST', '/members/invite', { email: 'a3@example.com', roleId: 'preset-ops', scope: { all: false, legalEntityIds: [otherEntity] } }, 'member.invite')
    expect(foreignEntity.status).toBe(422)
    expect(foreignEntity.json.error.fieldErrors.legalEntityIds).toBeDefined()
    const empty = await write(owner, 'POST', '/members/invite', { email: 'a4@example.com', roleId: 'preset-ops', scope: { all: false } }, 'member.invite')
    expect(empty.status).toBe(422)
    // 管理员不能邀请所有者；只有 7 个权限点的“经理”不能邀请拥有更多权限的管理员
    const toOwner = await write(admin, 'POST', '/members/invite', { email: 'a5@example.com', roleId: 'preset-owner', scope: { all: true } }, 'member.invite')
    expect(toOwner.status).toBe(403)
    expect(toOwner.json.error.message).toContain('所有者')
    const toAdmin = await write(manager, 'POST', '/members/invite', { email: 'a6@example.com', roleId: 'preset-admin', scope: { all: true } }, 'member.invite')
    expect(toAdmin.status).toBe(403)
    expect(toAdmin.json.error.message).toContain('不能授予你自己没有的权限点')
    const narrowOwner = await write(owner, 'POST', '/members/invite', { email: 'a7@example.com', roleId: 'preset-owner', scope: { all: false, sellerAccountIds: ['seller-a'] } }, 'member.invite')
    expect(narrowOwner.status).toBe(422)
    // 只读成员与受限范围成员不能邀请；没有登记任何失败邀请
    expect((await write(reader, 'POST', '/members/invite', { email: 'a8@example.com', roleId: 'preset-readonly', scope: { all: true } }, 'member.invite')).status).toBe(403)
    expect((await rows<Row>(`SELECT id FROM "MemberInvitation" WHERE email LIKE 'a_@example.com'`)).length).toBe(0)
  })

  it('邀请：成员数超过报价约定时给出提示但不阻止', async () => {
    await insertRow(h.client, 'TenantQuota', { id: 'quota-members', tenantId, quotaKey: 'members', limitValue: 3 })
    const res = await write(owner, 'POST', '/members/invite', { email: 'quota@example.com', roleId: 'preset-readonly', scope: { all: true } }, 'member.invite')
    expect(res.status).toBe(201)
    expect(res.json.data.warnings[0]).toContain('3 人')
    await h.client.query(`DELETE FROM "TenantQuota" WHERE id = 'quota-members'`)
  })

  it('改角色：写审计（前后对比）、同角色不变更；不能改自己、不能管权限比自己高的人、不能授予自己没有的权限；所有者要全部范围', async () => {
    const res = await write(owner, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-finance', reason: '转岗到财务' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ changed: true, member: { roleId: 'preset-finance', roleName: '财务' } })
    const [event] = await audits('MEMBER_ROLE_CHANGED')
    expect(event).toMatchObject({ resourceType: 'Membership', resourceId: victim.membershipId, reason: '转岗到财务', actorId: owner.userId })
    expect(event!.beforeJson).toMatchObject({ roleName: '运营' })
    expect(event!.afterJson).toMatchObject({ roleName: '财务' })
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-finance' })).json.data.changed).toBe(false)

    const self = await write(owner, 'POST', `/members/${owner.membershipId}/role`, { roleId: 'preset-admin' })
    expect(self.status).toBe(409)
    expect(self.json.error.message).toContain('不能修改自己')
    const aboveMe = await write(admin, 'POST', `/members/${owner2.membershipId}/role`, { roleId: 'preset-admin' })
    expect(aboveMe.status).toBe(403)
    const escalate = await write(admin, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-owner' })
    expect(escalate.status).toBe(403)
    const lacking = await write(manager, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-admin' })
    expect(lacking.status).toBe(403)
    const unknown = await write(owner, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'role-other' })
    expect(unknown.status).toBe(422)
    // 范围收窄的成员不能直接设为所有者
    await h.client.query(`DELETE FROM "MembershipScope" WHERE "membershipId" = $1`, [victim.membershipId])
    await insertRow(h.client, 'MembershipScope', { id: 'scope-victim-narrow', tenantId, membershipId: victim.membershipId, sellerAccountId: 'seller-a2', grantedBy: 'test' })
    const narrow = await write(owner, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-owner' })
    expect(narrow.status).toBe(409)
    expect(narrow.json.error.message).toContain('全部主体与店铺')
    await write(owner, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-ops' })
  })

  it('改范围：全部、指定主体、指定店铺；重复提交不变更；不合法的组合与别的企业的主体 422；所有者不能缩小；受限范围成员 403', async () => {
    const specific = await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: false, legalEntityIds: ['le-a2'], sellerAccountIds: ['seller-a'] }, reason: '负责美国站' })
    expect(specific.status, JSON.stringify(specific.json)).toBe(200)
    expect(specific.json.data.member.scope).toMatchObject({ kind: 'MIXED', entityNames: ['主体乙'], storeNames: ['Store-1'] })
    expect(await rows<Row>(`SELECT "legalEntityId", "sellerAccountId" FROM "MembershipScope" WHERE "membershipId" = $1 ORDER BY "legalEntityId" NULLS LAST`, [victim.membershipId])).toEqual([
      { legalEntityId: 'le-a2', sellerAccountId: null },
      { legalEntityId: null, sellerAccountId: 'seller-a' },
    ])
    const [event] = await audits('MEMBER_SCOPES_CHANGED')
    expect(event).toMatchObject({ resourceId: victim.membershipId, reason: '负责美国站' })
    expect(event!.afterJson.scope).toContain('指定主体与店铺')
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: false, legalEntityIds: ['le-a2'], sellerAccountIds: ['seller-a'] } })).json.data.changed).toBe(false)

    expect((await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: true, legalEntityIds: ['le-a2'] } })).status).toBe(422)
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: false } })).status).toBe(422)
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: false, legalEntityIds: [otherEntity] } })).status).toBe(422)
    expect((await write(owner, 'POST', `/members/${owner2.membershipId}/scopes`, { scope: { all: false, sellerAccountIds: ['seller-a'] } })).status).toBe(422)
    const denied = await write(limited, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: true } })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/scopes`, { scope: { all: true } })).json.data.changed).toBe(true)
  })

  it('停用：要写原因、吊销登录会话、记录停用人与时间；停用后原来的令牌立即失效；恢复后可再次使用；重复操作不变更', async () => {
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/disable`, {})).status).toBe(422)
    const res = await write(owner, 'POST', `/members/${victim.membershipId}/disable`, { reason: '已离职' })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ changed: true, member: { status: 'DISABLED' } })
    expect(await memberRow(victim.membershipId)).toMatchObject({ status: 'DISABLED', disabledReason: '已离职', disabledBy: owner.userId })
    expect((await rows<Row>(`SELECT "revokedAt" FROM "Session" WHERE "userId" = $1`, [victim.userId])).every(row => row.revokedAt !== null)).toBe(true)
    expect((await h.call(victim.token, 'GET', '/auth/me')).status).toBe(401)
    expect((await audits('MEMBER_DISABLED'))[0]).toMatchObject({ resourceId: victim.membershipId, reason: '已离职' })
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/disable`, { reason: '再来一次' })).json.data.changed).toBe(false)
    const detail = await get(owner, `/members/${victim.membershipId}`)
    expect(detail.member).toMatchObject({ status: 'DISABLED', disabledReason: '已离职' })
    expect(detail.sessions[0].state).toBe('REVOKED')
    expect(detail.actions).toMatchObject({ disable: '这位成员已经是停用状态', enable: null })

    const enabled = await write(owner, 'POST', `/members/${victim.membershipId}/enable`, {})
    expect(enabled.json.data).toMatchObject({ changed: true, member: { status: 'ACTIVE' } })
    expect(await memberRow(victim.membershipId)).toMatchObject({ status: 'ACTIVE', disabledAt: null, disabledReason: null, disabledBy: null })
    expect((await write(owner, 'POST', `/members/${victim.membershipId}/enable`, {})).json.data.changed).toBe(false)
    // 业务审计（带前后对比）只有真正变更的那一次；没有变更的重复请求只留拦截器的通用记录\n    expect((await audits('MEMBER_ENABLED')).filter(event => event.beforeJson !== null).length).toBe(1)
  })

  it('停用的拦截：不能停用自己、管理员不能停用所有者、受限范围与只读成员不能停用、别的企业的成员 404；没有再次验证 403', async () => {
    const self = await write(owner, 'POST', `/members/${owner.membershipId}/disable`, { reason: '测试自己' })
    expect(self.status).toBe(409)
    expect((await write(admin, 'POST', `/members/${owner.membershipId}/disable`, { reason: '想夺权' })).status).toBe(403)
    expect((await write(reader, 'POST', `/members/${admin.membershipId}/disable`, { reason: '没权限' })).status).toBe(403)
    expect((await write(limited, 'POST', `/members/${admin.membershipId}/disable`, { reason: '受限' })).status).toBe(403)
    expect((await write(owner, 'POST', `/members/${other.membershipId}/disable`, { reason: '跨企业' })).status).toBe(404)
    // 前面的 write 给 owner 留下了尚未过期的验证记录，先清掉再请求
    await h.client.query(`DELETE FROM "StepUpVerification" WHERE "userId" = $1`, [owner.userId])
    const really = await h.call(owner.token, 'POST', `/members/${victim.membershipId}/disable`, { body: { reason: '没验证' } })
    expect(really.status).toBe(403)
    expect(really.json.error.code).toBe('STEP_UP_REQUIRED')
    expect((await memberRow(victim.membershipId)).status).toBe('ACTIVE')
    // 被越权请求拒绝的操作不会改动任何数据
    expect((await memberRow(owner.membershipId)).status).toBe('ACTIVE')
    expect((await memberRow(admin.membershipId)).status).toBe('ACTIVE')
  })

  it('停用：用户在别的企业还有使用中的成员关系时，不吊销其登录会话（会话属于用户）', async () => {
    const dual = await h.createMember(tenantId, 'dual', [], { roleId: 'preset-readonly' })
    await insertRow(h.client, 'Membership', { id: 'membership-dual-b', tenantId: otherTenantId, userId: dual.userId, roleId: 'preset-readonly' })
    const res = await write(owner, 'POST', `/members/${dual.membershipId}/disable`, { reason: '调到另一家' })
    expect(res.json.data.changed).toBe(true)
    expect((await rows<Row>(`SELECT "revokedAt" FROM "Session" WHERE "userId" = $1`, [dual.userId])).every(row => row.revokedAt === null)).toBe(true)
    // 但在被停用的企业里，成员关系已停用，访问被拒绝
    expect((await h.call(dual.token, 'GET', '/members')).status).toBeGreaterThanOrEqual(401)
  })

  it('角色列表：预设与自定义、成员数与待接受邀请数、能不能改及原因（预设与旧版角色只能复制）', async () => {
    const roles = await get(owner, '/roles')
    const byId = Object.fromEntries((roles.items as Row[]).map(role => [role.id, role]))
    expect(byId['preset-owner']).toMatchObject({ name: '所有者', permissions: ['*'], system: true, canEdit: false, presetKey: 'owner', memberCount: 2 })
    expect(byId['preset-owner'].editBlockedReason).toContain('复制')
    expect(byId['preset-readonly'].fields).toEqual({ cost: 'HIDDEN', profit: 'HIDDEN', buyer: 'HIDDEN' })
    expect(byId['preset-finance'].fields).toEqual({ cost: 'VISIBLE', profit: 'VISIBLE', buyer: 'HIDDEN' })
    expect(byId['role-manager']).toMatchObject({ system: false, canEdit: false, memberCount: 1 })
    expect(byId['role-manager'].editBlockedReason).toContain('旧版')
    expect(byId['role-other']).toBeUndefined()
    expect(roles).toMatchObject({ canManage: true, customLimit: 50 })
    expect(roles.customCount).toBeGreaterThanOrEqual(3)
    expect((await h.call(reader.token, 'GET', '/roles')).status).toBe(403)
  })

  it('新建角色：可复制预设角色并覆盖字段权限；保存权限点与字段三档；写审计；同名 409；没有再次验证 403', async () => {
    const created = await write(owner, 'POST', '/roles', { name: '运营副本', description: '运营加成本', copyFromRoleId: 'preset-ops', fields: { cost: 'OWNER_ONLY' } }, 'role.manage')
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const role = created.json.data.role as Row
    expect(role).toMatchObject({ name: '运营副本', description: '运营加成本', system: false, version: 2, canEdit: true, memberCount: 0 })
    expect(role.fields).toEqual({ cost: 'OWNER_ONLY', profit: 'VISIBLE', buyer: 'HIDDEN' })
    expect(role.permissions.length).toBeGreaterThan(5)
    const [stored] = await rows<Row>(`SELECT * FROM "Role" WHERE id = $1`, [role.id])
    expect(stored).toMatchObject({ tenantId, system: false, version: 2 })
    expect(await rows<Row>(`SELECT "fieldKey", allowed, "ownerOnly" FROM "FieldPermission" WHERE "roleId" = $1 ORDER BY "fieldKey"`, [role.id])).toEqual([
      { fieldKey: 'buyer', allowed: false, ownerOnly: false },
      { fieldKey: 'cost', allowed: true, ownerOnly: true },
      { fieldKey: 'profit', allowed: true, ownerOnly: false },
    ])
    expect((await audits('ROLE_CREATED'))[0]).toMatchObject({ resourceId: role.id })
    expect((await write(owner, 'POST', '/roles', { name: '运营副本', copyFromRoleId: 'preset-ops' }, 'role.manage')).status).toBe(409)
    expect((await write(owner, 'POST', '/roles', { name: '运营', copyFromRoleId: 'preset-ops' }, 'role.manage')).status).toBe(409)
    await h.client.query(`DELETE FROM "StepUpVerification" WHERE "userId" = $1`, [owner.userId])
    expect((await h.call(owner.token, 'POST', '/roles', { body: { name: '无验证', copyFromRoleId: 'preset-ops' } })).json.error.code).toBe('STEP_UP_REQUIRED')

    // “仅负责人可见”的角色，成员的有效权限里只有 field.cost.own，没有 field.cost
    const holder = await h.createMember(tenantId, 'holder', [], { roleId: role.id })
    const me = (await get(holder, '/auth/me')).permissions as string[]
    expect(me).toContain('field.cost.own')
    expect(me).not.toContain('field.cost')
    expect(me).toContain('field.profit')
  })

  it('新建角色的校验：权限点、通配、不认识的点位、职责分离、字段、从角色复制、没有授权就不能给；越权 403', async () => {
    const post = (member: Member, body: Row) => write(member, 'POST', '/roles', body, 'role.manage')
    expect((await post(owner, { name: '空角色' })).status).toBe(422)
    expect((await post(owner, { name: '通配角色', permissions: ['*'] })).status).toBe(422)
    const unknown = await post(owner, { name: '未知点位', permissions: ['orders.read', 'no.such.permission'] })
    expect(unknown.status).toBe(422)
    expect(unknown.json.error.message).toContain('no.such.permission')
    const sod = await post(owner, { name: '自批自单', permissions: ['purchase.order.write', 'purchase.order.approve'] })
    expect(sod.status).toBe(422)
    expect(sod.json.error.message).toContain('职责分离')
    const buyerOwn = await post(owner, { name: '买家仅负责人', permissions: ['orders.read'], fields: { buyer: 'OWNER_ONLY' } })
    expect(buyerOwn.status).toBe(422)
    expect((await post(owner, { name: '复制不存在', copyFromRoleId: 'nope' })).status).toBe(422)
    // 经理自己没有 purchase.order.write 等点位：不能授予；也不能授予自己看不到的字段
    const lacks = await post(manager, { name: '越权角色', permissions: ['orders.read', 'purchase.order.write'] })
    expect(lacks.status).toBe(403)
    expect(lacks.json.error.message).toContain('purchase.order.write')
    const field = await post(manager, { name: '越权字段', permissions: ['orders.read'], fields: { cost: 'VISIBLE' } })
    expect(field.status).toBe(403)
    // 复制所有者：展开成全部权限点，但职责分离仍然拦下，提示拆开
    const ownerCopy = await post(owner, { name: '所有者副本', copyFromRoleId: 'preset-owner' })
    expect(ownerCopy.status).toBe(422)
    expect(ownerCopy.json.error.message).toContain('职责分离')
    expect((await rows<Row>(`SELECT id FROM "Role" WHERE name IN ('空角色','通配角色','未知点位','自批自单','越权角色','越权字段','所有者副本')`)).length).toBe(0)
  })

  it('修改角色：乐观锁与版本加一、字段三档、无变化不更新；预设与旧版角色不能改；越权 403', async () => {
    const [copy] = await rows<Row>(`SELECT id, version FROM "Role" WHERE name = '运营副本'`)
    const id = copy!.id as string
    const patch = (member: Member, body: Row, roleId = id) => write(member, 'PATCH', `/roles/${roleId}`, body, 'role.manage')
    const roleBefore = (await get(owner, '/roles')).items.find((item: Row) => item.id === id) as Row
    const updated = await patch(owner, {
      version: copy!.version,
      name: '运营（含成本）',
      permissions: roleBefore.permissions.slice(1),
      fields: { cost: 'VISIBLE', profit: 'OWNER_ONLY' },
      reason: '调整权限',
    })
    expect(updated.status, JSON.stringify(updated.json)).toBe(200)
    expect(updated.json.data).toMatchObject({ changed: true, role: { name: '运营（含成本）', version: 3, fields: { cost: 'VISIBLE', profit: 'OWNER_ONLY', buyer: 'HIDDEN' } } })
    expect(updated.json.data.role.permissions).toHaveLength(roleBefore.permissions.length - 1)
    const [event] = await audits('ROLE_UPDATED')
    expect(event).toMatchObject({ resourceId: id, reason: '调整权限' })
    expect(event!.beforeJson.name).toBe('运营副本')
    expect(event!.afterJson.name).toBe('运营（含成本）')

    const stale = await patch(owner, { version: copy!.version, name: '过期修改' })
    expect(stale.status).toBe(409)
    expect(stale.json.error.code).toBe('CONFLICT')
    expect(stale.json.error.details).toMatchObject({ currentVersion: 3 })
    const same = await patch(owner, { version: 3, name: '运营（含成本）' })
    expect(same.json.data.changed).toBe(false)
    expect((await rows<Row>(`SELECT version FROM "Role" WHERE id = $1`, [id]))[0]!.version).toBe(3)

    expect((await patch(owner, { version: 3, permissions: ['purchase.order.write', 'purchase.order.approve'] })).status).toBe(422)
    expect((await patch(owner, { version: 1, name: '改预设' }, 'preset-ops')).status).toBe(409)
    expect((await patch(owner, { version: 1, name: '改旧版' }, 'role-manager')).status).toBe(409)
    expect((await patch(owner, { version: 3, name: '跨企业' }, 'role-other')).status).toBe(404)
    // 经理没有成本字段权限：不能改含有他自己没有的点位的角色
    expect((await patch(manager, { version: 3, name: '经理改' })).status).toBe(409)
    expect((await patch(owner, { version: 3 })).status).toBe(422)
  })

  it('自定义角色数量有上限', async () => {
    await h.client.query(
      `INSERT INTO "Role" (id, "tenantId", name, permissions, "resourceScope", system, version, "updatedAt")
       SELECT 'bulk-' || g, $1, '批量' || g, '["orders.read"]'::jsonb, '{}'::jsonb, false, 2, now() FROM generate_series(1, 50) g`,
      [otherTenantId],
    )
    const res = await write(other, 'POST', '/roles', { name: '第五十一个', permissions: ['orders.read'] }, 'role.manage')
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('50')
  })

  it('企业隔离：别的企业的成员、角色、邀请在本企业看不到也改不了', async () => {
    const list = await get(other, '/members')
    expect((list.items as Row[]).map(item => item.email).sort()).toEqual(['member-dual@example.com', 'member-other@example.com'])
    expect(await rows<Row>(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND name = '运营副本'`, [otherTenantId])).toEqual([])
    expect((await get(other, '/roles')).items.some((role: Row) => role.name === '运营（含成本）')).toBe(false)
    expect((await write(other, 'PATCH', `/roles/role-manager`, { version: 1, name: '跨企业' }, 'role.manage')).status).toBe(404)
    expect((await write(other, 'POST', `/members/${victim.membershipId}/role`, { roleId: 'preset-ops' })).status).toBe(404)
  })

  it('迁移：回滚后新增列与约束移除，“仅负责人可见”回滚为不可见；重放后恢复，不认识的成员状态归一为已停用', async () => {
    const [ownerOnly] = await rows<Row>(`SELECT count(*)::int AS n FROM "FieldPermission" WHERE "ownerOnly"`)
    expect(ownerOnly!.n).toBeGreaterThan(0)
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    expect(await rows<Row>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FieldPermission' AND column_name = 'ownerOnly'`)).toEqual([])
    expect(await rows<Row>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Membership' AND column_name LIKE 'disabled%'`)).toEqual([])
    expect(await rows<Row>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'Role' AND column_name = 'description'`)).toEqual([])
    await h.client.query(`UPDATE "Membership" SET status = 'LEGACY' WHERE id = $1`, [reader.membershipId]) // 约束已删，旧数据里不认识的状态在重放时归一
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    expect((await memberRow(reader.membershipId)).status).toBe('DISABLED')
    await expect(h.client.query(`UPDATE "Membership" SET status = 'WEIRD' WHERE id = $1`, [reader.membershipId])).rejects.toThrow(/Membership_status_check/)
    expect((await rows<Row>(`SELECT count(*)::int AS n FROM "FieldPermission" WHERE "ownerOnly"`))[0]!.n).toBe(0)
  })

  it('列表与详情：没有任何数据范围授权的成员（与支持访问同理）也能看人，只是不能管理；角色列表同样', async () => {
    const ungranted = await h.createMember(tenantId, 'ungranted', ['member.read', 'role.manage'], { scopes: [] })
    const list = await get(ungranted, '/members')
    expect(list).toMatchObject({ canInvite: false, canManage: false })
    expect(list.manageBlockedReason).toContain('全部店铺')
    expect((await get(ungranted, `/members/${victim.membershipId}`)).canManage).toBe(false)
    expect((await get(ungranted, '/roles')).canManage).toBe(false)
  })
})
