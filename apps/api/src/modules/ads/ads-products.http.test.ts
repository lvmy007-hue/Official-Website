import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告商品接口（P3-09）：未登录、权限、参数校验顺序与没有写接口。数据读取与数据范围的真实行为见 testing/ads-products.db.test.ts（真实数据库）。

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

describe('广告商品接口：登录与权限', () => {
  it('未登录 401；没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/products', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/products')).status).toBe(403)
  })

  it('权限先于参数校验：没有权限的人带着不合法参数也只拿 403；有权限时不合法参数是 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/products?sort=profit:desc&stock=LOW')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/products?sort=profit:desc')).status).toBe(422)
    expect((await harness.call('GET', '/ads/products?stock=LOW')).status).toBe(422)
    expect((await harness.call('GET', '/ads/products?unknown=1')).status).toBe(422)
  })

  it('没有写接口：冻结文档里的批量暂停与复制在 P3-17 之前不存在', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.campaign.write']))
    expect((await harness.call('PATCH', '/ads/products', { body: { asins: ['B0AAA'], state: 'PAUSED' } })).status).toBe(404)
    expect((await harness.call('POST', '/ads/products/copy', { body: { asin: 'B0AAA' } })).status).toBe(404)
  })
})
