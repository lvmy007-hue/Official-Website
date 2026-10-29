import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告活动接口（P3-07）：未登录与权限、权限先于参数校验、参数校验。数据读取与写入的真实行为见 testing/ads-campaigns.db.test.ts（真实数据库）。

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

const READ = ['ads.read']
const WRITE = ['ads.read', 'ads.campaign.write']
const open = async (permissions: string[]) => (harness = await createTestApp(prismaFor(permissions)))

const READ_PATHS = [
  '/ads/campaigns',
  '/ads/campaigns/c1',
  ...['trend', 'hourly', 'ad-groups', 'targets', 'search-terms', 'products', 'placements', 'creatives', 'audiences', 'history', 'forecast', 'recommendations', 'changes'].map(
    tab => `/ads/campaigns/c1/${tab}`,
  ),
]

describe('广告活动接口：登录与权限', () => {
  it('未登录一律 401；没有 ads.read 一律 403（列表、详情与全部页签）', async () => {
    const app = await open(['overview.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
  })

  it('写接口：没有 ads.campaign.write 返回 403，只读成员也一样', async () => {
    const app = await open(READ)
    const body = { items: [{ id: 'c1', version: 1 }], ownerId: null }
    expect((await app.call('PATCH', '/ads/campaigns/meta', { body })).status).toBe(403)
    expect((await app.call('POST', '/ads/recommendations/r1/dismiss', { body: { reason: '不适用于本活动' } })).status).toBe(403)
  })

  it('没有权限先于参数校验：参数不合法时无权限的人先拿 403，有权限的人才看到 422', async () => {
    const reader = await open(READ)
    expect((await reader.call('PATCH', '/ads/campaigns/meta', { body: {} })).status).toBe(403)
    await reader.close()
    const writer = await open(WRITE)
    expect((await writer.call('PATCH', '/ads/campaigns/meta', { body: {} })).status).toBe(422)
    expect((await writer.call('POST', '/ads/recommendations/r1/dismiss', { body: { reason: '短' } })).status).toBe(422)
  })
})

describe('广告活动接口：参数校验', () => {
  it('列表：排序字段不在白名单、日期范围倒置、广告产品不认识都是 422', async () => {
    const app = await open(READ)
    expect((await app.call('GET', '/ads/campaigns?sort=password:asc')).status).toBe(422)
    expect((await app.call('GET', '/ads/campaigns?from=2026-10-10&to=2026-10-01')).status).toBe(422)
    expect((await app.call('GET', '/ads/campaigns?adProduct=OTHER')).status).toBe(422)
  })

  it('批量设置：版本缺失、一次超过 200 个、模式不认识、多余字段都是 422', async () => {
    const app = await open(WRITE)
    const call = (body: unknown) => app.call('PATCH', '/ads/campaigns/meta', { body })
    expect((await call({ items: [{ id: 'c1' }], ownerId: null })).status).toBe(422)
    expect((await call({ items: Array.from({ length: 201 }, (_, i) => ({ id: `c${i}`, version: 1 })), ownerId: null })).status).toBe(422)
    expect((await call({ items: [{ id: 'c1', version: 1 }], tags: { mode: 'DROP', values: [] } })).status).toBe(422)
    expect((await call({ items: [{ id: 'c1', version: 1 }], ownerId: null, extra: true })).status).toBe(422)
  })
})
