import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 广告变更记录接口（P3-14）：未登录、权限先于参数校验、参数校验。数据读取、数据范围、对照、企业隔离与外部变更识别的真实行为见 testing/ads-changes.db.test.ts（真实数据库）。

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

describe('广告变更记录接口：登录与权限', () => {
  it('两个接口：未登录 401；没有 ads.read 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/changes', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/changes/c-1/compare', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/ads/changes')).status).toBe(403)
    expect((await harness.call('GET', '/ads/changes/c-1/compare')).status).toBe(403)
  })

  it('没有权限时先拿 403，不会先看到参数校验的 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/ads/changes?source=ROBOT')).status).toBe(403)
    expect((await harness.call('GET', '/ads/changes?from=2026-10-10')).status).toBe(403)
  })

  it('没有写入口：POST、PATCH、DELETE 都找不到', async () => {
    harness = await createTestApp(prismaFor(['ads.read', 'ads.rule.write']))
    expect((await harness.call('POST', '/ads/changes', { body: {} })).status).toBe(404)
    expect((await harness.call('PATCH', '/ads/changes/c-1', { body: {} })).status).toBe(404)
    expect((await harness.call('DELETE', '/ads/changes/c-1')).status).toBe(404)
  })
})

describe('广告变更记录接口：参数校验', () => {
  it('列表：来源、对象类型、排序字段、分页参数、日期范围不合法一律 422；未知参数也拒绝', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    const status = async (query: string) => (await harness!.call('GET', `/ads/changes?${query}`)).status
    expect(await status('source=ROBOT')).toBe(422)
    expect(await status('entityType=AD')).toBe(422)
    expect(await status('sort=entityLabel:asc')).toBe(422)
    expect(await status('pageSize=0')).toBe(422)
    expect(await status('pageSize=201')).toBe(422)
    expect(await status('from=2026-10-10')).toBe(422)
    expect(await status('unknown=1')).toBe(422)
  })

  it('对照：编号不合法按不存在处理', async () => {
    harness = await createTestApp(prismaFor(['ads.read']))
    expect((await harness.call('GET', `/ads/changes/${encodeURIComponent('a b;drop')}/compare`)).status).toBe(404)
  })
})
