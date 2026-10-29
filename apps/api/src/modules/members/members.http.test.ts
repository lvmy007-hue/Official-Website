import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'
import { sessionViews } from './members-detail.service'
import { assertNotLastOwner, assertRoleGrantable, resolveScopeGrants } from './members-guards'
import type { RoleWithFields } from './member-system.service'

// 成员与角色接口的权限分支与参数校验（P5-08）；写入规则、数据范围、审计与会话吊销的真实行为在 testing/members.db.test.ts。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[], stepUp = false) => {
  const prisma: Record<string, any> = { ...sessionStub(permissions), stepUpVerification: { findFirst: vi.fn().mockResolvedValue(stepUp ? { id: 'su-1' } : null), create: vi.fn() } }
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}

describe('成员与角色接口', () => {
  it('未登录 401；没有权限 403，并写明缺哪个权限点、指向角色编辑器；403 先于参数校验', async () => {
    const { call } = await open(['seller.read'])
    expect((await call('GET', '/members', { auth: false })).status).toBe(401)
    const denied = await call('GET', '/members?pageSize=abc')
    expect(denied.status).toBe(403)
    expect(denied.json.error.message).toContain('缺少权限点 member.read')
    expect(denied.json.error.message).toContain('角色编辑器')
    expect(denied.json.error.details).toMatchObject({ permission: 'member.read' })
    expect((await call('GET', '/members/options')).status).toBe(403)
    expect((await call('GET', '/members/m1')).status).toBe(403)
    expect((await call('GET', '/roles')).status).toBe(403)
  })

  it('写接口：没有对应权限点 403；需要再次验证身份的操作没有验证时 403 STEP_UP_REQUIRED', async () => {
    const readOnly = await open(['member.read'])
    expect((await readOnly.call('POST', '/members/invite', { body: { email: 'a@example.com', roleId: 'r', scope: { all: true } } })).status).toBe(403)
    expect((await readOnly.call('POST', '/members/m1/disable', { body: { reason: '离职' } })).status).toBe(403)
    expect((await readOnly.call('POST', '/roles', { body: { name: '新角色', permissions: ['orders.read'] } })).status).toBe(403)
    await harness?.close()
    const manager = await open(['member.manage', 'role.manage'])
    for (const [method, path, body] of [
      ['POST', '/members/m1/disable', { reason: '离职' }],
      ['POST', '/members/m1/enable', {}],
      ['POST', '/members/m1/role', { roleId: 'preset-ops' }],
      ['POST', '/members/m1/scopes', { scope: { all: true } }],
      ['POST', '/roles', { name: '新角色', permissions: ['orders.read'] }],
      ['PATCH', '/roles/r1', { version: 1, name: '改名' }],
    ] as const) {
      const res = await manager.call(method, path, { body })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect(res.json.error.code, `${method} ${path}`).toBe('STEP_UP_REQUIRED')
    }
  })

  it('写接口必须带幂等键；已验证身份后，不合法的请求体 422', async () => {
    const { call } = await open(['member.manage', 'member.invite', 'role.manage'], true)
    expect((await call('POST', '/members/m1/disable', { body: { reason: '离职' }, idempotencyKey: false })).status).toBe(400)
    expect((await call('POST', '/roles', { body: { name: 'x' } })).status).toBe(422)
    expect((await call('POST', '/roles', { body: { name: '空角色' } })).status).toBe(422)
    expect((await call('PATCH', '/roles/r1', { body: { version: 1 } })).status).toBe(422)
    expect((await call('POST', '/members/invite', { body: { email: '不是邮箱', roleId: 'r', scope: { all: true } } })).status).toBe(422)
    expect((await call('POST', '/members/invite', { body: { email: 'a@example.com', roleId: 'r', scope: { all: false } } })).status).toBe(422)
  })
})

const role = (permissions: string[]): RoleWithFields => ({
  id: 'r',
  tenantId: 't',
  name: '角色',
  permissions,
  resourceScope: {},
  system: false,
  version: 2,
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  fieldPermissions: [],
})

describe('写入前置条件', () => {
  it('不能授予自己没有的权限点；通配角色只有通配持有人能授予', () => {
    expect(() => assertRoleGrantable(['orders.read', 'returns.read'], role(['orders.read']))).not.toThrow()
    expect(() => assertRoleGrantable(['orders.read'], role(['orders.read', 'returns.read']))).toThrow(/returns\.read/)
    expect(() => assertRoleGrantable(['orders.read'], role(['*']))).toThrow(/所有者/)
    expect(() => assertRoleGrantable(['*'], role(['*']))).not.toThrow()
  })

  it('最后一位使用中的所有者不能被停用或换角色；还有别的所有者时可以', async () => {
    const count = vi.fn().mockResolvedValue(0)
    const prisma = { membership: { count } } as never
    await expect(assertNotLastOwner(prisma, 't', { id: 'm1', status: 'ACTIVE', roleId: 'preset-owner' })).rejects.toThrow('至少一位使用中的所有者')
    expect(count.mock.calls[0]?.[0].where).toMatchObject({ tenantId: 't', roleId: 'preset-owner', status: 'ACTIVE', id: { not: 'm1' } })
    count.mockResolvedValue(1)
    await expect(assertNotLastOwner(prisma, 't', { id: 'm1', status: 'ACTIVE', roleId: 'preset-owner' })).resolves.toBeUndefined()
    // 不是所有者、或已经停用的所有者：不需要检查
    await expect(assertNotLastOwner(prisma, 't', { id: 'm2', status: 'ACTIVE', roleId: 'preset-ops' })).resolves.toBeUndefined()
    await expect(assertNotLastOwner(prisma, 't', { id: 'm3', status: 'DISABLED', roleId: 'preset-owner' })).resolves.toBeUndefined()
  })

  it('数据范围：全部写成一行两列都空；具体的主体与店铺必须属于本企业，去重后各写一行', async () => {
    const prisma = {
      legalEntity: { findMany: vi.fn().mockResolvedValue([{ id: 'e1' }]) },
      sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
    } as never
    expect(await resolveScopeGrants(prisma, 't', { all: true, legalEntityIds: [], sellerAccountIds: [] })).toEqual([{ legalEntityId: null, sellerAccountId: null }])
    expect(await resolveScopeGrants(prisma, 't', { all: false, legalEntityIds: ['e1', 'e1'], sellerAccountIds: ['s1'] })).toEqual([
      { legalEntityId: 'e1', sellerAccountId: null },
      { legalEntityId: null, sellerAccountId: 's1' },
    ])
    await expect(resolveScopeGrants(prisma, 't', { all: false, legalEntityIds: ['e1', 'foreign'], sellerAccountIds: [] })).rejects.toThrow('不存在，或不属于本企业')
    await expect(resolveScopeGrants(prisma, 't', { all: false, legalEntityIds: [], sellerAccountIds: [] })).rejects.toThrow('至少选一个')
    await expect(resolveScopeGrants(prisma, 't', { all: true, legalEntityIds: ['e1'], sellerAccountIds: [] })).rejects.toThrow('就不要再选')
  })
})

describe('登录与会话记录', () => {
  const at = (iso: string) => new Date(iso)
  const row = (id: string, chain: string, created: string, over: Record<string, unknown> = {}) => ({
    id,
    rotationChainId: chain,
    createdAt: at(created),
    lastSeenAt: at(created),
    expiresAt: at('2026-12-01T00:00:00Z'),
    revokedAt: null,
    ipMasked: null,
    userAgent: null,
    ...over,
  })

  it('同一次登录的多个刷新行合并成一条：最早的创建时间为登录时间、最近的活动时间为最后活动', () => {
    const rows = [
      row('s2', 'c1', '2026-10-25T09:00:00Z', { lastSeenAt: at('2026-10-25T09:30:00Z'), ipMasked: '203.0.113.*', userAgent: 'Chrome', revokedAt: at('2026-10-25T09:00:01Z') }),
      row('s3', 'c1', '2026-10-25T09:00:02Z', { lastSeenAt: at('2026-10-25T10:00:00Z'), ipMasked: '203.0.113.*', userAgent: 'Chrome' }),
      row('s1', 'c1', '2026-10-25T08:00:00Z', { revokedAt: at('2026-10-25T09:00:00Z') }),
    ]
    const { items, truncated } = sessionViews(rows, at('2026-10-25T11:00:00Z'), 30)
    expect(items).toEqual([{ id: 's1', loginAt: '2026-10-25T08:00:00.000Z', lastSeenAt: '2026-10-25T10:00:00.000Z', ipMasked: '203.0.113.*', device: 'Chrome', state: 'ACTIVE' }])
    expect(truncated).toBe(false)
  })

  it('状态：全部吊销为已吊销、全部过期为已过期；按登录时间倒序；超过条数上限标记截断', () => {
    const rows = [
      row('a', 'c-revoked', '2026-10-01T00:00:00Z', { revokedAt: at('2026-10-02T00:00:00Z') }),
      row('b', 'c-expired', '2026-10-10T00:00:00Z', { expiresAt: at('2026-10-11T00:00:00Z') }),
      row('c', 'c-live', '2026-10-20T00:00:00Z'),
    ]
    const result = sessionViews(rows, at('2026-10-25T00:00:00Z'), 2)
    expect(result.items.map(item => [item.id, item.state])).toEqual([
      ['c', 'ACTIVE'],
      ['b', 'EXPIRED'],
    ])
    expect(result.truncated).toBe(true)
    expect(sessionViews(rows, at('2026-10-25T00:00:00Z'), 5).items.map(item => item.state)).toEqual(['ACTIVE', 'EXPIRED', 'REVOKED'])
  })

  it('设备只取前 120 个字符，不返回令牌与原始地址', () => {
    const [item] = sessionViews([row('a', 'c', '2026-10-01T00:00:00Z', { userAgent: 'U'.repeat(300) })], new Date('2026-10-02T00:00:00Z'), 30).items
    expect(item!.device).toHaveLength(120)
    expect(Object.keys(item!).sort()).toEqual(['device', 'id', 'ipMasked', 'lastSeenAt', 'loginAt', 'state'])
  })
})
