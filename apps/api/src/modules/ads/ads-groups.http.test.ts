import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告组与投放对象详情接口（P3-08）：未登录与权限。数据读取与数据范围的真实行为见 testing/ads-groups.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const prismaFor = (permissions: string[]) => ({
  ...sessionStub(permissions),
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]) },
  tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
})

const GROUP_TABS = ['trend', 'targets', 'search-terms', 'products', 'negatives', 'hourly', 'history']
const TARGET_TABS = ['trend', 'search-terms', 'placements', 'hourly', 'bid-history', 'brand-analytics']
const PATHS = ['/ads/ad-groups/g1', ...GROUP_TABS.map(tab => `/ads/ad-groups/g1/${tab}`), '/ads/targets/t1', ...TARGET_TABS.map(tab => `/ads/targets/t1/${tab}`)]

describe('广告组与投放对象接口：登录与权限', () => {
  it('15 个只读接口：未登录一律 401，没有 ads.read 一律 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect(PATHS).toHaveLength(15)
    for (const path of PATHS) {
      expect((await harness.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await harness.call('GET', path)).status, path).toBe(403)
    }
  })

  it('权限先于参数校验：没有权限的人带着不合法参数也只拿 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/ad-groups/g1/targets?pageSize=99999')).status).toBe(403)
    expect((await harness.call('GET', '/ads/targets/t1/search-terms?cursor=%%%')).status).toBe(403)
  })

  it('写接口（P3-17）：没有对应的写权限 403；有权限但请求内容不合法 422（路径编号不能被请求体改掉）', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'AD_GROUP_BID', amount: 1 } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/targets/t1', { body: { kind: 'TARGET_BID', amount: 1 } })).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['ads.read', 'ads.bid.write']))
    expect((await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'AD_GROUP_BID', amount: 0 } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/ad-groups/g1', { body: { kind: 'TARGET_BID', amount: 1 } })).status).toBe(422) // 入口只接受自己这一层的写入类型
    expect((await harness.call('PATCH', '/ads/targets/t1', { body: { kind: 'AD_GROUP_BID', amount: 1 } })).status).toBe(422)
  })
})
