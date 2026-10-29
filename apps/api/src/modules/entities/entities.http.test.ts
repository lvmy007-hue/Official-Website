import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 法律主体接口（P5-07）：列表（统计、数据范围、写入前置条件）、新增、详情（店铺、广告账户、被授权成员、变更记录）、修改（乐观锁、停用前置条件、无变化）。
// 权限先于参数校验；受限范围看不到范围外的主体，也不能改主体。真实库行为在 testing/entities.db.test.ts。

const NOW = new Date('2026-10-25T08:00:00Z')
const entity = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  tenantId: 'tenant-1',
  name: '主体甲',
  registeredCountry: '中国',
  registrationNo: '9144',
  status: 'ACTIVE',
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
})
const detailStore = (over: Record<string, unknown> = {}) => ({
  id: 's1',
  displayName: '美国主店',
  sellerId: 'SELLER1',
  logicalRegion: 'NA',
  connections: [{ provider: 'AMAZON_SP_API', state: 'AUTHORIZED' }],
  ...over,
})
const grant = (over: Record<string, unknown> = {}) => ({
  membershipId: 'm1',
  legalEntityId: null,
  sellerAccountId: null,
  membership: { status: 'ACTIVE', user: { displayName: '小李', email: 'l@example.com' }, role: { name: '运营' } },
  ...over,
})

function stub(permissions: string[], over: Record<string, unknown> = {}, restricted = false, grants: unknown[] = []) {
  const guards = createWriteGuardStubs()
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    membershipScope: {
      // 范围解析只选 legalEntityId、sellerAccountId；详情的“被授权成员”选了 membershipId
      findMany: vi
        .fn()
        .mockImplementation(async (args: { select: Record<string, unknown> }) =>
          args.select.membershipId ? grants : restricted ? [{ legalEntityId: null, sellerAccountId: 's1' }] : [{ legalEntityId: null, sellerAccountId: null }],
        ),
    },
    legalEntity: {
      findMany: vi.fn().mockResolvedValue([entity()]),
      findFirst: vi.fn().mockResolvedValue(entity()),
      count: vi.fn().mockResolvedValue(1),
      groupBy: vi.fn().mockResolvedValue([
        { status: 'ACTIVE', _count: { _all: 2 } },
        { status: 'INACTIVE', _count: { _all: 1 } },
      ]),
      create: vi.fn().mockResolvedValue(entity({ id: 'e2', name: '主体乙', registrationNo: null })),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    sellerAccount: {
      // 范围解析 select { id }；列表统计 select { id, legalEntityId }；详情 select 含 displayName
      findMany: vi
        .fn()
        .mockImplementation(async (args: { select: Record<string, unknown> }) =>
          args.select.displayName ? [detailStore()] : args.select.legalEntityId ? [{ id: 's1', legalEntityId: 'e1' }] : [{ id: 's1' }],
        ),
      count: vi.fn().mockResolvedValue(0),
    },
    adsProfile: {
      groupBy: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', _count: { _all: 2 } }]),
      findMany: vi.fn().mockResolvedValue([{ id: 'ap1', displayName: null, profileId: 'P1', countryCode: 'US', status: 'ACTIVE', bindingStatus: 'AUTO_MATCHED', sellerAccountId: 's1' }]),
      count: vi.fn().mockResolvedValue(0),
    },
    auditEvent: { ...guards.auditEvent, findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  }
  Object.assign(prisma.membership, { findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '管理员小李', email: 'a@example.com' } }]) })
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], over: Record<string, unknown> = {}, restricted = false, grants: unknown[] = []) => {
  const prisma = stub(permissions, over, restricted, grants)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const audits = (prisma: Record<string, any>) => prisma.auditEvent.create.mock.calls.map((call: [{ data: Record<string, any> }]) => call[0].data)

describe('列表', () => {
  it('未登录 401；没有 entity.read 403，且 403 先于参数校验', async () => {
    const { call } = await open(['entity.read'])
    expect((await call('GET', '/entities', { auth: false })).status).toBe(401)
    const none = await open(['seller.read'])
    expect((await none.call('GET', '/entities?pageSize=abc')).status).toBe(403)
    expect((await call('GET', '/entities?pageSize=abc')).status).toBe(422)
  })

  it('带店铺数、广告账户数与各状态条数；没有写权限时给出原因', async () => {
    const { prisma, call } = await open(['entity.read'])
    const res = await call('GET', '/entities')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toEqual([expect.objectContaining({ id: 'e1', name: '主体甲', status: 'ACTIVE', version: 1, storeCount: 1, adsAccountCount: 2 })])
    expect(res.json.data.summary).toEqual({ total: 3, active: 2, inactive: 1 })
    expect(res.json.data.canWrite).toBe(false)
    expect(res.json.data.writeBlockedReason).toContain('权限')
    expect(prisma.legalEntity.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1' })
  })

  it('筛选条件落到查询里；全部范围且有写权限可以写', async () => {
    const { prisma, call } = await open(['entity.read', 'entity.write'])
    const res = await call('GET', '/entities?status=INACTIVE&q=甲&page=2&pageSize=10')
    expect(res.json.data).toMatchObject({ canWrite: true, writeBlockedReason: null, page: 2, pageSize: 10 })
    const args = prisma.legalEntity.findMany.mock.calls[0][0]
    expect(args.where).toMatchObject({ tenantId: 'tenant-1', status: 'INACTIVE' })
    expect(args.where.OR[0]).toEqual({ name: { contains: '甲', mode: 'insensitive' } })
    expect(args).toMatchObject({ skip: 10, take: 10 })
  })

  it('受限范围：只看到名下有范围内店铺的主体，店铺统计也按范围收窄，不能写', async () => {
    const { prisma, call } = await open(['entity.read', 'entity.write'], {}, true)
    const res = await call('GET', '/entities')
    expect(prisma.legalEntity.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', sellerAccounts: { some: { id: { in: ['s1'] } } } })
    expect(prisma.sellerAccount.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({ id: { in: ['s1'] } })
    expect(res.json.data.canWrite).toBe(false)
    expect(res.json.data.writeBlockedReason).toContain('全部店铺')
  })
})

describe('新增', () => {
  it('需要 entity.write；返回 201 并写审计；参数不合法 422', async () => {
    const denied = await open(['entity.read'])
    expect((await denied.call('POST', '/entities', { body: { name: '主体乙', registeredCountry: '中国' } })).status).toBe(403)
    const { prisma, call } = await open(['entity.write'])
    const created = await call('POST', '/entities', { body: { name: '主体乙', registeredCountry: '中国' } })
    expect(created.status).toBe(201)
    expect(created.json.data).toMatchObject({ id: 'e2', name: '主体乙', version: 1, storeCount: 0, adsAccountCount: 0 })
    const done = audits(prisma).find((data: { action: string; result: string }) => data.action === 'LEGAL_ENTITY_CREATED' && data.result === 'SUCCEEDED')
    expect(done).toMatchObject({ resourceType: 'LegalEntity', resourceId: 'e2', tenantId: 'tenant-1' })
    expect(done.afterJson).toMatchObject({ name: '主体乙', registeredCountry: '中国', status: 'ACTIVE' })
    expect((await call('POST', '/entities', { body: { name: 'x' } })).status).toBe(422)
  })

  it('名称重复返回 409 并指到名称字段，不再是 500', async () => {
    const dup = Object.assign(new Error('unique'), { code: 'P2002' })
    const { call } = await open(['entity.write'], { legalEntity: { create: vi.fn().mockRejectedValue(dup) } })
    const res = await call('POST', '/entities', { body: { name: '主体甲', registeredCountry: '中国' } })
    expect(res.status).toBe(409)
    expect(res.json.error.fieldErrors.name).toBeDefined()
  })
})

describe('详情', () => {
  it('没有 entity.read 403；范围外或不存在 404', async () => {
    const none = await open(['seller.read'])
    expect((await none.call('GET', '/entities/e1')).status).toBe(403)
    const missing = await open(['entity.read'], { legalEntity: { findFirst: vi.fn().mockResolvedValue(null) } })
    expect((await missing.call('GET', '/entities/nope')).status).toBe(404)
  })

  it('受限范围按范围查主体与店铺', async () => {
    const { prisma, call } = await open(['entity.read'], {}, true)
    await call('GET', '/entities/e1')
    expect(prisma.legalEntity.findFirst.mock.calls[0][0].where).toEqual({ id: 'e1', tenantId: 'tenant-1', sellerAccounts: { some: { id: { in: ['s1'] } } } })
    expect(prisma.sellerAccount.findMany.mock.calls.at(-1)?.[0].where).toMatchObject({ legalEntityId: 'e1', id: { in: ['s1'] } })
  })

  it('店铺、广告账户（带所属店铺名）、授权状态都有；没有成员权限时成员一节标“无权查看”并且不查成员授权', async () => {
    const { prisma, call } = await open(['entity.read'])
    const res = await call('GET', '/entities/e1')
    expect(res.status).toBe(200)
    expect(res.json.data.stores).toEqual([{ id: 's1', displayName: '美国主店', sellerId: 'SELLER1', logicalRegion: 'NA', connectionState: 'AUTHORIZED' }])
    expect(res.json.data.adsAccounts).toEqual([expect.objectContaining({ id: 'ap1', displayName: 'P1', storeName: '美国主店', bindingStatus: 'AUTO_MATCHED' })])
    expect(res.json.data.members).toEqual({ state: 'RESTRICTED', items: [], truncated: false })
    const grantQueries = prisma.membershipScope.findMany.mock.calls.filter((call: [{ select: Record<string, unknown> }]) => call[0].select.membershipId)
    expect(grantQueries).toHaveLength(0)
  })

  it('被授权成员：全部范围、整个主体、指定店铺三种，与本主体无关的不出现', async () => {
    const grants = [
      grant({ membershipId: 'm1' }),
      grant({ membershipId: 'm2', legalEntityId: 'e1', membership: { status: 'ACTIVE', user: { displayName: '小王', email: 'w@example.com' }, role: { name: '财务' } } }),
      grant({ membershipId: 'm3', sellerAccountId: 's1', membership: { status: 'DISABLED', user: { displayName: '小张', email: 'z@example.com' }, role: { name: '只读' } } }),
      grant({ membershipId: 'm4', sellerAccountId: 'other' }),
    ]
    const { call } = await open(['entity.read', 'member.read'], {}, false, grants)
    const res = await call('GET', '/entities/e1')
    const members = res.json.data.members
    expect(members.state).toBe('OK')
    expect(members.items.map((item: { membershipId: string; access: string }) => [item.membershipId, item.access])).toEqual([
      ['m1', 'ALL'],
      ['m2', 'ENTITY'],
      ['m3', 'STORES'],
    ])
    expect(members.items.find((item: { membershipId: string }) => item.membershipId === 'm3')).toMatchObject({ storeNames: ['美国主店'], status: 'DISABLED', roleName: '只读' })
  })

  it('变更记录只取成功的审计，按快照算出变化，操作人显示名字', async () => {
    const event = {
      id: 'a1',
      actorId: 'user-1',
      action: 'LEGAL_ENTITY_UPDATED',
      reason: null,
      occurredAt: NOW,
      beforeJson: { name: '旧名', registeredCountry: '中国', registrationNo: null, status: 'ACTIVE' },
      afterJson: { name: '主体甲', registeredCountry: '中国', registrationNo: null, status: 'ACTIVE' },
    }
    const { prisma, call } = await open(['entity.read'], { auditEvent: { ...createWriteGuardStubs().auditEvent, findMany: vi.fn().mockResolvedValue([event]) } })
    const res = await call('GET', '/entities/e1')
    expect(prisma.auditEvent.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', resourceType: 'LegalEntity', resourceId: 'e1', result: 'SUCCEEDED' })
    expect(res.json.data.changes).toEqual([
      {
        id: 'a1',
        occurredAt: NOW.toISOString(),
        actor: '管理员小李',
        action: 'LEGAL_ENTITY_UPDATED',
        actionLabel: '修改资料',
        reason: null,
        changes: [{ field: 'name', label: '主体名称', before: '旧名', after: '主体甲' }],
      },
    ])
  })

  it('名下有店铺时不能停用并写明原因；没有店铺且有写权限时可以', async () => {
    const blocked = await open(['entity.read', 'entity.write'], { sellerAccount: { findMany: vi.fn().mockResolvedValue([detailStore()]), count: vi.fn().mockResolvedValue(1) } })
    const first = await blocked.call('GET', '/entities/e1')
    expect(first.json.data).toMatchObject({ canWrite: true, canDeactivate: false })
    expect(first.json.data.deactivateBlockedReason).toContain('1 个店铺')
    const free = await open(['entity.read', 'entity.write'], { sellerAccount: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) } })
    expect((await free.call('GET', '/entities/e1')).json.data).toMatchObject({ canDeactivate: true, deactivateBlockedReason: null })
  })
})

describe('修改', () => {
  it('没有 entity.write 403，且 403 先于参数校验；受限范围 403；未知字段与空修改 422', async () => {
    const none = await open(['entity.read'])
    expect((await none.call('PATCH', '/entities/e1', { body: { bad: true } })).status).toBe(403)
    const restricted = await open(['entity.write'], {}, true)
    const denied = await restricted.call('PATCH', '/entities/e1', { body: { version: 1, name: '主体乙' } })
    expect(denied.status).toBe(403)
    expect(denied.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    const { call } = await open(['entity.write'])
    expect((await call('PATCH', '/entities/e1', { body: { version: 1, name: '主体乙', bad: 1 } })).status).toBe(422)
    expect((await call('PATCH', '/entities/e1', { body: { version: 1 } })).status).toBe(422)
    expect((await call('PATCH', '/entities/e1', { body: { name: '主体乙' } })).status).toBe(422)
  })

  it('改名称与注册号：带版本更新、写前后快照；清空注册号传 null', async () => {
    const after = entity({ name: '主体乙', registrationNo: null, version: 2 })
    const { prisma, call } = await open(['entity.write'], {
      legalEntity: { findFirst: vi.fn().mockResolvedValueOnce(entity()).mockResolvedValue(after), updateMany: vi.fn().mockResolvedValue({ count: 1 }), create: vi.fn() },
    })
    const res = await call('PATCH', '/entities/e1', { body: { version: 1, name: '主体乙', registrationNo: null } })
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ changed: true, entity: { name: '主体乙', version: 2 } })
    expect(prisma.legalEntity.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: 'e1', tenantId: 'tenant-1', version: 1 }, data: { name: '主体乙', registrationNo: null } })
    const done = audits(prisma).find((data: { action: string; result: string }) => data.action === 'LEGAL_ENTITY_UPDATED' && data.result === 'SUCCEEDED')
    expect(done.beforeJson).toMatchObject({ name: '主体甲', registrationNo: '9144' })
    expect(done.afterJson).toMatchObject({ name: '主体乙', registrationNo: null })
  })

  it('没有任何变化：不写库、不写带前后快照的审计，返回 changed:false', async () => {
    const { prisma, call } = await open(['entity.write'])
    const res = await call('PATCH', '/entities/e1', { body: { version: 1, name: '主体甲', registrationNo: '9144' } })
    expect(res.status).toBe(200)
    expect(res.json.data.changed).toBe(false)
    expect(prisma.legalEntity.updateMany).not.toHaveBeenCalled()
    // 写接口拦截器会补一条不带前后快照的通用审计；服务自己不写带快照的业务审计
    expect(audits(prisma).filter((data: { afterJson?: unknown }) => data.afterJson !== undefined)).toHaveLength(0)
  })

  it('版本已过期：409 并带当前版本；主体不存在 404；名称重复 409', async () => {
    const stale = await open(['entity.write'], { legalEntity: { findFirst: vi.fn().mockResolvedValue(entity({ version: 5 })), updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    const res = await stale.call('PATCH', '/entities/e1', { body: { version: 1, name: '主体乙' } })
    expect(res.status).toBe(409)
    expect(res.json.error.details).toMatchObject({ currentVersion: 5, expectedVersion: 1 })
    const missing = await open(['entity.write'], { legalEntity: { findFirst: vi.fn().mockResolvedValue(null) } })
    expect((await missing.call('PATCH', '/entities/nope', { body: { version: 1, name: '主体乙' } })).status).toBe(404)
    const dup = Object.assign(new Error('unique'), { code: 'P2002' })
    const clash = await open(['entity.write'], { legalEntity: { findFirst: vi.fn().mockResolvedValue(entity()), updateMany: vi.fn().mockRejectedValue(dup) } })
    const clashed = await clash.call('PATCH', '/entities/e1', { body: { version: 1, name: '主体乙' } })
    expect(clashed.status).toBe(409)
    expect(clashed.json.error.fieldErrors.name).toBeDefined()
  })

  it('停用：名下有店铺 409；没有店铺要写原因，原因进审计；恢复使用不要原因', async () => {
    const withStores = await open(['entity.write'], { sellerAccount: { count: vi.fn().mockResolvedValue(2) } })
    const blocked = await withStores.call('PATCH', '/entities/e1', { body: { version: 1, status: 'INACTIVE', reason: '主体注销' } })
    expect(blocked.status).toBe(409)
    expect(blocked.json.error.message).toContain('2 个店铺')
    expect(withStores.prisma.legalEntity.updateMany).not.toHaveBeenCalled()

    const after = entity({ status: 'INACTIVE', version: 2 })
    const free = await open(['entity.write'], {
      legalEntity: { findFirst: vi.fn().mockResolvedValueOnce(entity()).mockResolvedValueOnce(entity()).mockResolvedValue(after), updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
    })
    const noReason = await free.call('PATCH', '/entities/e1', { body: { version: 1, status: 'INACTIVE' } })
    expect(noReason.status).toBe(422)
    expect(noReason.json.error.fieldErrors.reason).toBeDefined()
    const done = await free.call('PATCH', '/entities/e1', { body: { version: 1, status: 'INACTIVE', reason: '主体注销' } })
    expect(done.status).toBe(200)
    expect(audits(free.prisma).find((data: { action: string; result: string }) => data.action === 'LEGAL_ENTITY_UPDATED' && data.result === 'SUCCEEDED')).toMatchObject({ reason: '主体注销' })

    const inactive = entity({ status: 'INACTIVE', version: 2 })
    const back = await open(['entity.write'], {
      legalEntity: {
        findFirst: vi
          .fn()
          .mockResolvedValueOnce(inactive)
          .mockResolvedValue(entity({ version: 3 })),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
    })
    const restored = await back.call('PATCH', '/entities/e1', { body: { version: 2, status: 'ACTIVE' } })
    expect(restored.status).toBe(200)
    expect(back.prisma.legalEntity.updateMany.mock.calls[0][0].data).toMatchObject({ status: 'ACTIVE' })
  })
})
