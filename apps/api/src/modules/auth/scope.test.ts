import { describe, expect, it, vi } from 'vitest'
import { AppError } from '../../platform/http'
import { assertStoreInScope, assertUnrestricted, adsProfileWhere, adsRelationWhere, connectionWhere, storeWhere, type ResolvedScope } from './scope'
import { ScopeService } from './scope.service'

const all: ResolvedScope = { unrestricted: true, sellerAccountIds: [] }
const two: ResolvedScope = { unrestricted: false, sellerAccountIds: ['s1', 's2'] }
const context = { userId: 'u', sessionId: 's', tenantId: 't1', membershipId: 'm1', permissions: [] }

describe('范围条件构造', () => {
  it('全部范围不加店铺条件；受限时按店铺列表过滤', () => {
    expect(storeWhere(all)).toEqual({})
    expect(storeWhere(two)).toEqual({ sellerAccountId: { in: ['s1', 's2'] } })
    expect(storeWhere(two, 'x')).toEqual({ x: { in: ['s1', 's2'] } })
  })
  it('广告表经广告账户关联过滤，未绑定店铺的广告账户对受限成员不可见', () => {
    expect(adsProfileWhere(all)).toEqual({})
    expect(adsProfileWhere(two)).toEqual({ sellerAccountId: { in: ['s1', 's2'] } })
    expect(adsRelationWhere(two)).toEqual({ adsProfile: { sellerAccountId: { in: ['s1', 's2'] } } })
    expect(adsRelationWhere(all)).toEqual({})
  })
  it('连接条件同时覆盖卖家连接与广告连接', () => {
    expect(connectionWhere(all)).toEqual({})
    expect(connectionWhere(two)).toEqual({
      OR: [{ sellerAccountId: { in: ['s1', 's2'] } }, { adsProfile: { sellerAccountId: { in: ['s1', 's2'] } } }],
    })
  })
  it('店铺断言与租户级断言', () => {
    expect(() => assertStoreInScope(all, 'any')).not.toThrow()
    expect(() => assertStoreInScope(two, 's1')).not.toThrow()
    expect(() => assertStoreInScope(two, 's9')).toThrowError(expect.objectContaining({ status: 403, code: 'SCOPE_STORE_FORBIDDEN' }))
    expect(() => assertUnrestricted(all)).not.toThrow()
    expect(() => assertUnrestricted(two)).toThrowError(expect.objectContaining({ status: 403, code: 'SCOPE_TENANT_LEVEL_ONLY' }))
  })
})

describe('范围解析（ScopeService）', () => {
  function service(grants: { legalEntityId: string | null; sellerAccountId: string | null }[], stores: { id: string }[] = []) {
    const prisma = {
      membershipScope: { findMany: vi.fn().mockResolvedValue(grants) },
      sellerAccount: { findMany: vi.fn().mockResolvedValue(stores) },
    }
    return { prisma, service: new ScopeService(prisma as never) }
  }

  it('没有任何授权：403，且不去查店铺', async () => {
    const { prisma, service: s } = service([])
    await expect(s.resolve(context, {})).rejects.toMatchObject({ status: 403, code: 'SCOPE_NOT_GRANTED' })
    expect(prisma.sellerAccount.findMany).not.toHaveBeenCalled()
  })
  it('授权全部且请求未收窄：不受限，不查店铺（避免大列表）', async () => {
    const { prisma, service: s } = service([{ legalEntityId: null, sellerAccountId: null }])
    expect(await s.resolve(context, {})).toEqual({ unrestricted: true, sellerAccountIds: [], marketplaceId: undefined })
    expect(prisma.sellerAccount.findMany).not.toHaveBeenCalled()
  })
  it('授权只在本租户内、本成员内查询', async () => {
    const { prisma, service: s } = service([{ legalEntityId: null, sellerAccountId: 's1' }], [{ id: 's1' }])
    await s.resolve(context, {})
    expect(prisma.membershipScope.findMany).toHaveBeenCalledWith({ where: { tenantId: 't1', membershipId: 'm1' }, select: { legalEntityId: true, sellerAccountId: true } })
    expect(prisma.sellerAccount.findMany.mock.calls[0][0].where.tenantId).toBe('t1')
  })
  it('授权部分店铺：请求所选与授权取交集（查询条件同时含请求与授权）', async () => {
    const { prisma, service: s } = service(
      [
        { legalEntityId: 'e1', sellerAccountId: null },
        { legalEntityId: null, sellerAccountId: 's9' },
      ],
      [{ id: 's1' }],
    )
    const scope = await s.resolve(context, { storeIds: 's1,s2', legalEntityIds: 'e1' })
    expect(scope).toEqual({ unrestricted: false, sellerAccountIds: ['s1'], marketplaceId: undefined })
    expect(prisma.sellerAccount.findMany.mock.calls[0][0].where).toEqual({
      tenantId: 't1',
      AND: [{ id: { in: ['s1', 's2'] }, legalEntityId: { in: ['e1'] } }, { OR: [{ legalEntityId: { in: ['e1'] } }, { id: { in: ['s9'] } }] }],
    })
  })
  it('交集为空：403，不放开到全部', async () => {
    const { service: s } = service([{ legalEntityId: null, sellerAccountId: 's1' }], [])
    await expect(s.resolve(context, { storeIds: 's2' })).rejects.toMatchObject({ status: 403, code: 'SCOPE_EMPTY' })
  })
  it('授权全部但请求指定店铺：只按请求收窄', async () => {
    const { prisma, service: s } = service([{ legalEntityId: null, sellerAccountId: null }], [{ id: 's2' }])
    expect((await s.resolve(context, { storeIds: 's2' })).sellerAccountIds).toEqual(['s2'])
    expect(prisma.sellerAccount.findMany.mock.calls[0][0].where.AND[1]).toEqual({})
  })
  it('站点只接受亚马逊美国站，其他站点校验失败；店铺编号格式不合法也被拒绝', async () => {
    const { service: s } = service([{ legalEntityId: null, sellerAccountId: null }])
    await expect(s.resolve(context, { marketplaceId: 'A2EUQ1WTGCTBG2' })).rejects.toThrow()
    await expect(s.resolve(context, { storeIds: "a'; DROP TABLE x" })).rejects.toThrow()
    expect((await s.resolve(context, { marketplaceId: 'ATVPDKIKX0DER' })).unrestricted).toBe(true)
  })
  it('AppError 抛出的状态码是业务错误而不是 500', async () => {
    const { service: s } = service([])
    await expect(s.resolve(context, {})).rejects.toBeInstanceOf(AppError)
  })
})
