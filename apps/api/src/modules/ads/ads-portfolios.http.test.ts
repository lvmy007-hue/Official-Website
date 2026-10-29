import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告组合接口（P3-11）：未登录、权限、参数校验顺序与没有写接口。数据读取、数据范围与节奏计算的真实行为见 testing/ads-portfolios.db.test.ts（真实数据库）。

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

describe('广告组合接口：登录与权限', () => {
  it('列表与详情：未登录 401；没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/portfolios', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/portfolios/pf-1', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/portfolios')).status).toBe(403)
    expect((await harness.call('GET', '/ads/portfolios/pf-1')).status).toBe(403)
  })

  it('权限先于参数校验：没有权限的人带着不合法参数也只拿 403；有权限时不合法参数是 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/portfolios?sort=profit:desc&pace=LATE')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/portfolios?sort=profit:desc')).status).toBe(422)
    expect((await harness.call('GET', '/ads/portfolios?pace=LATE')).status).toBe(422)
    expect((await harness.call('GET', '/ads/portfolios?unknown=1')).status).toBe(422)
  })

  it('详情的编号不合法按不存在处理（404）', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', `/ads/portfolios/${encodeURIComponent('a b;drop')}`)).status).toBe(404)
  })

  it('没有写接口：新建组合与改预算、预算规则在 P3-17 之前不存在', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.campaign.write']))
    expect((await harness.call('POST', '/ads/portfolios', { body: { name: '新组合' } })).status).toBe(404)
    expect((await harness.call('PATCH', '/ads/portfolios/pf-1', { body: { budget: 100 } })).status).toBe(404)
  })
})
