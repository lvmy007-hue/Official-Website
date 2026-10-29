import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, createWriteGuardStubs, sessionStub } from '../../testing/harness'

// 广告账户与店铺绑定接口（P3-03）：清单（范围过滤、未绑定原因、能否绑定）、人工绑定（绑定、改绑、固定、解除、无变化、冲突、校验）、
// 权限先于参数校验、受限范围不能改、每次都写审计。自动匹配的规则在 worker 的 ads-binding.test.ts 里验证。

const NOW = new Date('2026-10-23T08:00:00Z')

const profile = (over: Record<string, unknown> = {}) => ({
  id: 'ap1',
  profileId: 'P1',
  displayName: '美国广告账户',
  countryCode: 'US',
  marketplaceId: 'ATVPDKIKX0DER',
  currencyCode: 'USD',
  status: 'ACTIVE',
  accountId: 'SELLER1',
  adsAccountId: null,
  bindingStatus: 'UNBOUND',
  boundBy: null,
  sellerAccountId: null,
  updatedAt: NOW,
  sellerAccount: null,
  ...over,
})
const store = (over: Record<string, unknown> = {}) => ({ id: 's1', displayName: '美国主店', sellerId: 'SELLER1', logicalRegion: 'NA', marketplaceIds: ['ATVPDKIKX0DER'], ...over })

function stub(permissions: string[], over: Record<string, unknown> = {}, restricted = false) {
  const guards = createWriteGuardStubs()
  const session = sessionStub(permissions)
  const prisma: Record<string, any> = {
    ...session,
    membershipScope: { findMany: vi.fn().mockResolvedValue(restricted ? [{ legalEntityId: null, sellerAccountId: 's1' }] : [{ legalEntityId: null, sellerAccountId: null }]) },
    sellerAccount: {
      // 受限范围解析用 select { id }，绑定清单的店铺下拉与校验用别的 select
      findMany: vi.fn().mockImplementation(async (args: { select: Record<string, boolean> }) => (args.select.logicalRegion ? [store()] : [{ id: 's1' }])),
      findFirst: vi.fn().mockResolvedValue(store()),
      groupBy: vi.fn().mockResolvedValue([{ sellerId: 'SELLER1', _count: { _all: 1 } }]),
    },
    adsProfile: {
      findMany: vi.fn().mockResolvedValue([profile()]),
      findFirst: vi.fn().mockResolvedValue(profile()),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    ...over,
  }
  Object.assign(prisma.membership, { findMany: vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '管理员小李', email: 'l@example.com' } }]) })
  prisma.auditEvent = guards.auditEvent
  prisma.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...guards, ...prisma })
  return prisma
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})
const open = async (permissions: string[], over: Record<string, unknown> = {}, restricted = false) => {
  const prisma = stub(permissions, over, restricted)
  harness = await createTestApp(prisma)
  return { prisma, call: harness.call }
}
const MANAGE = ['connection.read', 'ads.account.bind']

describe('权限与范围', () => {
  it('未登录 401；没有连接读取权限 403；没有绑定权限不能绑定，且 403 先于参数校验', async () => {
    const { call } = await open(['connection.read'])
    expect((await call('GET', '/connections/ads-accounts', { auth: false })).status).toBe(401)
    expect((await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })).status).toBe(403)
    expect((await call('POST', '/connections/ads-accounts/ap1/bind', { body: { bad: true } })).status).toBe(403)
    const none = await open([])
    expect((await none.call('GET', '/connections/ads-accounts')).status).toBe(403)
  })

  it('受限范围的成员：清单按绑定的店铺收窄、看不到未绑定的账户；不能绑定', async () => {
    const { prisma, call } = await open(MANAGE, {}, true)
    const list = await call('GET', '/connections/ads-accounts')
    expect(list.status).toBe(200)
    expect(prisma.adsProfile.findMany.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', sellerAccountId: { in: ['s1'] } })
    expect(list.json.data.canBind).toBe(false)
    expect(list.json.data.bindBlockedReason).toContain('全部店铺')
    expect(list.json.data.stores).toEqual([])
    const bind = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(bind.status).toBe(403)
    expect(bind.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')
    expect(prisma.adsProfile.updateMany).not.toHaveBeenCalled()
  })
})

describe('绑定清单', () => {
  it('全部范围：只带租户条件，先未绑定；店铺下拉与能否绑定；候选店铺数与未绑定原因', async () => {
    const rows = [
      profile({ id: 'a-none', accountId: null }),
      profile({ id: 'a-zero', accountId: 'NOBODY' }),
      profile({ id: 'a-many', accountId: 'DUP' }),
      profile({ id: 'a-auto', bindingStatus: 'AUTO_MATCHED', sellerAccountId: 's1', sellerAccount: { id: 's1', displayName: '美国主店', sellerId: 'SELLER1' } }),
      profile({ id: 'a-manual', bindingStatus: 'MANUAL', boundBy: 'user-1', sellerAccountId: 's1', sellerAccount: { id: 's1', displayName: '美国主店', sellerId: 'SELLER1' } }),
      profile({ id: 'a-gone', bindingStatus: 'MANUAL', boundBy: 'user-1', sellerAccountId: null }),
    ]
    const { prisma, call } = await open(MANAGE, {
      adsProfile: { findMany: vi.fn().mockResolvedValue(rows) },
      sellerAccount: {
        findMany: vi.fn().mockResolvedValue([store()]),
        groupBy: vi.fn().mockResolvedValue([
          { sellerId: 'DUP', _count: { _all: 2 } },
          { sellerId: 'SELLER1', _count: { _all: 1 } },
        ]),
      },
    })
    const res = await call('GET', '/connections/ads-accounts')
    expect(res.status).toBe(200)
    const args = prisma.adsProfile.findMany.mock.calls[0][0]
    expect(args.where).toEqual({ tenantId: 'tenant-1' })
    expect(args.orderBy[0]).toEqual({ bindingStatus: 'desc' })
    const data = res.json.data
    expect(data.canBind).toBe(true)
    expect(data.bindBlockedReason).toBeNull()
    expect(data.stores).toEqual([{ id: 's1', displayName: '美国主店', sellerId: 'SELLER1', logicalRegion: 'NA' }])
    expect(data.summary).toEqual({ total: 6, autoMatched: 1, manual: 2, unbound: 3 })
    const byId = Object.fromEntries(data.items.map((item: { id: string }) => [item.id, item]))
    expect(byId['a-none'].unboundReason).toBe('NO_SELLER_ID')
    expect(byId['a-zero'].unboundReason).toBe('NO_MATCHING_STORE')
    expect(byId['a-many'].unboundReason).toBe('MULTIPLE_STORES')
    expect(byId['a-many'].candidateCount).toBe(2)
    expect(byId['a-gone'].unboundReason).toBe('RELEASED')
    expect(byId['a-auto'].unboundReason).toBeNull()
    expect(byId['a-auto'].store.displayName).toBe('美国主店')
    expect(byId['a-auto'].boundBy).toBeNull()
    expect(byId['a-manual'].boundBy).toBe('管理员小李')
    expect(byId['a-manual'].bindingStatusLabel).toBe('人工绑定')
    expect(data.truncated).toBe(false)
  })

  it('没有任何广告账户时返回空清单，不查候选店铺', async () => {
    const { prisma, call } = await open(MANAGE, { adsProfile: { findMany: vi.fn().mockResolvedValue([]) } })
    const res = await call('GET', '/connections/ads-accounts')
    expect(res.json.data.items).toEqual([])
    expect(res.json.data.summary).toEqual({ total: 0, autoMatched: 0, manual: 0, unbound: 0 })
    expect(prisma.sellerAccount.groupBy).not.toHaveBeenCalled()
  })

  it('只有读取权限的人看得到清单但不能绑定，原因写明缺权限', async () => {
    const { call } = await open(['connection.read'])
    const res = await call('GET', '/connections/ads-accounts')
    expect(res.json.data.canBind).toBe(false)
    expect(res.json.data.bindBlockedReason).toContain('人工绑定')
    expect(res.json.data.stores).toEqual([])
  })
})

describe('人工绑定', () => {
  it('第一次绑定：带旧值更新为人工绑定并记录操作人，写审计，不要求原因', async () => {
    const { prisma, call } = await open(MANAGE)
    const res = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ id: 'ap1', change: 'BIND', changed: true, bindingStatus: 'MANUAL', sellerAccountId: 's1', warnings: [] })
    expect(prisma.adsProfile.updateMany).toHaveBeenCalledWith({
      where: { id: 'ap1', tenantId: 'tenant-1', sellerAccountId: null, bindingStatus: 'UNBOUND' },
      data: { sellerAccountId: 's1', bindingStatus: 'MANUAL', boundBy: 'user-1' },
    })
    const audits = prisma.auditEvent.create.mock.calls.map((call: [{ data: Record<string, any> }]) => call[0].data)
    const bound = audits.find((data: { action: string }) => data.action === 'ADS_ACCOUNT_BOUND')
    expect(bound).toMatchObject({ resourceType: 'AdsProfile', resourceId: 'ap1', result: 'SUCCEEDED' })
    expect(bound.detail.change).toBe('BIND')
    expect(bound.detail.storeName).toBe('美国主店')
    expect(audits.filter((data: { action: string }) => data.action === 'ADS_ACCOUNT_BOUND')).toHaveLength(1)
  })

  it('改绑必须写原因（422），写了才成功，审计里有原因与前后值', async () => {
    const current = profile({ bindingStatus: 'MANUAL', sellerAccountId: 's0', boundBy: 'user-1' })
    const { prisma, call } = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(current), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    const missing = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(missing.status).toBe(422)
    expect(missing.json.error.code).toBe('VALIDATION_FAILED')
    expect(prisma.adsProfile.updateMany).not.toHaveBeenCalled()
    const done = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1', reason: '原绑定的店铺已出售' } })
    expect(done.status).toBe(201)
    expect(done.json.data.change).toBe('REBIND')
    const bound = prisma.auditEvent.create.mock.calls.map((call: [{ data: Record<string, any> }]) => call[0].data).find((data: { action: string }) => data.action === 'ADS_ACCOUNT_BOUND')
    expect(bound.reason).toBe('原绑定的店铺已出售')
    expect(JSON.stringify(bound.detail.changes)).toContain('s0')
  })

  it('自动匹配的结果可以固定为人工绑定（不要求原因）；人工绑定选同一店铺没有变化，不写库也不写业务审计', async () => {
    const auto = profile({ bindingStatus: 'AUTO_MATCHED', sellerAccountId: 's1' })
    const first = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(auto), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    const pinned = await first.call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(pinned.json.data).toMatchObject({ change: 'PIN', changed: true, bindingStatus: 'MANUAL' })
    expect(first.prisma.adsProfile.updateMany.mock.calls[0][0].where).toMatchObject({ sellerAccountId: 's1', bindingStatus: 'AUTO_MATCHED' })
    await harness?.close()

    const manual = profile({ bindingStatus: 'MANUAL', sellerAccountId: 's1' })
    const second = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(manual), updateMany: vi.fn() } })
    const same = await second.call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(same.json.data).toMatchObject({ change: 'NONE', changed: false })
    expect(second.prisma.adsProfile.updateMany).not.toHaveBeenCalled()
    const actions = second.prisma.auditEvent.create.mock.calls.map((call: [{ data: { action: string } }]) => call[0].data.action)
    expect(actions).not.toContain('ADS_ACCOUNT_UNBOUND')
  })

  it('解除绑定：要写原因，回到未绑定并清空操作人，审计动作是 ADS_ACCOUNT_UNBOUND', async () => {
    const current = profile({ bindingStatus: 'AUTO_MATCHED', sellerAccountId: 's1' })
    const { prisma, call } = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(current), updateMany: vi.fn().mockResolvedValue({ count: 1 }) } })
    expect((await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: null } })).status).toBe(422)
    const res = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: null, reason: '这个广告账户不属于该店铺' } })
    expect(res.status).toBe(201)
    expect(res.json.data).toMatchObject({ change: 'UNBIND', bindingStatus: 'UNBOUND', sellerAccountId: null })
    expect(prisma.adsProfile.updateMany.mock.calls[0][0].data).toEqual({ sellerAccountId: null, bindingStatus: 'UNBOUND', boundBy: null })
    const actions = prisma.auditEvent.create.mock.calls.map((call: [{ data: { action: string } }]) => call[0].data.action)
    expect(actions).toContain('ADS_ACCOUNT_UNBOUND')
    expect(actions).not.toContain('ADS_ACCOUNT_BOUND')
  })

  it('读到之后被别人或自动匹配改过：更新不到行，返回 409，不写审计', async () => {
    const { prisma, call } = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(profile()), updateMany: vi.fn().mockResolvedValue({ count: 0 }) } })
    const res = await call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(res.status).toBe(409)
    expect(res.json.error.code).toBe('CONFLICT')
    const actions = prisma.auditEvent.create.mock.calls.map((call: [{ data: { action: string; result: string } }]) => `${call[0].data.action}:${call[0].data.result}`)
    expect(actions).not.toContain('ADS_ACCOUNT_BOUND:SUCCEEDED')
  })

  it('找不到广告账户 404；店铺不属于本企业 422；站点不一致只提醒不阻止', async () => {
    const missing = await open(MANAGE, { adsProfile: { findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn() } })
    expect((await missing.call('POST', '/connections/ads-accounts/nope/bind', { body: { sellerAccountId: 's1' } })).status).toBe(404)
    await harness?.close()

    const foreign = await open(MANAGE, { sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]), findFirst: vi.fn().mockResolvedValue(null) } })
    const bad = await foreign.call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 'other-tenant-store' } })
    expect(bad.status).toBe(422)
    expect(bad.json.error.fieldErrors?.sellerAccountId ?? bad.json.error.details?.fieldErrors?.sellerAccountId).toBeTruthy()
    expect(foreign.prisma.sellerAccount.findFirst.mock.calls[0][0].where).toEqual({ id: 'other-tenant-store', tenantId: 'tenant-1' })
    expect(foreign.prisma.adsProfile.updateMany).not.toHaveBeenCalled()
    await harness?.close()

    const eu = await open(MANAGE, { sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]), findFirst: vi.fn().mockResolvedValue(store({ marketplaceIds: ['A1F83G8C2ARO7P'] })) } })
    const warned = await eu.call('POST', '/connections/ads-accounts/ap1/bind', { body: { sellerAccountId: 's1' } })
    expect(warned.status).toBe(201)
    expect(warned.json.data.warnings[0]).toContain('站点')
  })

  it('请求体不合法返回 422：缺少店铺字段、多余字段、原因太短', async () => {
    const { prisma, call } = await open(MANAGE)
    for (const body of [{}, { sellerAccountId: 's1', extra: 1 }, { sellerAccountId: 's1', reason: '短' }, { sellerAccountId: '' }]) {
      expect((await call('POST', '/connections/ads-accounts/ap1/bind', { body })).status).toBe(422)
    }
    expect(prisma.adsProfile.updateMany).not.toHaveBeenCalled()
  })
})
