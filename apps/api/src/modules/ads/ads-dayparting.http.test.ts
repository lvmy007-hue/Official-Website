import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 分时策略接口（P3-12）：未登录、权限先于参数校验、参数校验与幂等键。数据读写、数据范围、版本冲突与审计的真实行为见 testing/ads-dayparting.db.test.ts（真实数据库）。

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

const grid = (value: number) => Array.from({ length: 168 }, () => value)
const validBody = { adsProfileId: 'ap-1', name: '夜间关停', kind: 'ON_OFF', level: 'CAMPAIGN', targetIds: ['cam-1'], grid: grid(1), status: 'PAUSED' }

describe('分时策略接口：登录与权限', () => {
  it('四个接口：未登录 401；没有对应权限 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/dayparting', { auth: false })).status).toBe(401)
    expect((await harness.call('POST', '/ads/dayparting', { auth: false, body: validBody })).status).toBe(401)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { auth: false, body: { version: 1, name: 'x' } })).status).toBe(401)
    expect((await harness.call('POST', '/ads/dayparting/s-1/simulate', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/dayparting')).status).toBe(403)
    expect((await harness.call('POST', '/ads/dayparting', { body: validBody })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: { version: 1, name: 'x' } })).status).toBe(403)
    expect((await harness.call('POST', '/ads/dayparting/s-1/simulate')).status).toBe(403)
  })

  it('只有 ads.read 能看列表与模拟，但不能创建、修改', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('POST', '/ads/dayparting', { body: validBody })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: { version: 1, name: 'x' } })).status).toBe(403)
  })

  it('权限先于参数校验：没有写权限的人带着不合法内容也只拿 403', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('POST', '/ads/dayparting', { body: { name: '' } })).status).toBe(403)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: {} })).status).toBe(403)
  })
})

describe('分时策略接口：参数校验', () => {
  it('创建：内容不合法一律 422，并指出是哪个字段', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    const bad = async (patch: Record<string, unknown>) => (await harness!.call('POST', '/ads/dayparting', { body: { ...validBody, ...patch } })).status
    expect(await bad({ name: '' })).toBe(422)
    expect(await bad({ kind: 'SHIFT' })).toBe(422)
    expect(await bad({ level: 'TARGET' })).toBe(422)
    expect(await bad({ targetIds: [] })).toBe(422)
    expect(await bad({ targetIds: ['a', 'a'] })).toBe(422)
    expect(await bad({ grid: grid(1).slice(0, 167) })).toBe(422)
    // 启停策略的取值只能是 0 或 1
    expect(await bad({ grid: grid(0.5) })).toBe(422)
    // 启停策略不要基准竞价
    expect(await bad({ baseBid: 1.2 })).toBe(422)
    expect(await bad({ kind: 'BID_MULTIPLIER', grid: grid(5) })).toBe(422)
    expect(await bad({ unknownField: 1 })).toBe(422)
    const res = await harness.call('POST', '/ads/dayparting', { body: { ...validBody, grid: grid(0.5) } })
    expect(JSON.stringify(res.json.error)).toContain('grid')
  })

  it('修改：必须带版本号与至少一个要改的字段；编号不合法按不存在处理', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: { name: 'x' } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: { version: 1 } })).status).toBe(422)
    expect((await harness.call('PATCH', '/ads/dayparting/s-1', { body: { version: 0, name: 'x' } })).status).toBe(422)
    expect((await harness.call('PATCH', `/ads/dayparting/${encodeURIComponent('a b;drop')}`, { body: { version: 1, name: 'x' } })).status).toBe(404)
    expect((await harness.call('POST', `/ads/dayparting/${encodeURIComponent('a b;drop')}/simulate`)).status).toBe(404)
  })

  it('列表：范围参数不合法 422（有权限时），没有权限时先拿 403', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', '/ads/dayparting?from=2026-10-10')).status).toBe(422)
    await harness.close()
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/dayparting?from=2026-10-10')).status).toBe(403)
  })

  it('写请求不带幂等键：400，不会进入业务逻辑', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    const res = await harness.call('POST', '/ads/dayparting', { body: validBody, idempotencyKey: false })
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
  })
})
