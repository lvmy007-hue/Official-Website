import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 竞品监控接口（P4-12）：未登录与权限、权限先于参数校验、参数校验、路由顺序（candidates 不被当成 ASIN）。
// 数据读取、关注与取消、候选、详情、数据范围与跨企业隔离见 testing/competitors.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const watchedAsin = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) }
  harness = await createTestApp({
    ...sessionStub(permissions),
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    watchedAsin,
    brandSearchTerm: { findMany: vi.fn().mockResolvedValue([]) },
    brandSearchQueryPerformance: { findMany: vi.fn().mockResolvedValue([]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
  })
  return { app: harness, watchedAsin }
}

const READ_PATHS = ['/competitors', '/competitors/candidates', '/competitors/B0COMPET01?storeId=s1']

describe('竞品监控接口：登录与权限', () => {
  it('未登录 401；没有 competitors.read 读取类接口 403，而且先于参数校验、也不读数据库', async () => {
    const { app, watchedAsin } = await open(['products.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/competitors?sort=password:asc&reason=BAD')).status).toBe(403)
    expect(watchedAsin.findMany).not.toHaveBeenCalled()
  })

  it('只有 competitors.read 时：关注与取消都是 403（未登录 401），参数校验在权限之后', async () => {
    const { app, watchedAsin } = await open(['competitors.read'])
    for (const [method, path] of [
      ['POST', '/competitors'],
      ['DELETE', '/competitors/B0COMPET01?storeId=s1'],
    ] as const) {
      expect((await app.call(method, path, { body: {} })).status, `${method} ${path}`).toBe(403)
      expect((await app.call(method, path, { body: {}, auth: false })).status, `${method} ${path}`).toBe(401)
    }
    expect(watchedAsin.count).not.toHaveBeenCalled()
  })
})

describe('竞品监控接口：参数校验', () => {
  it('列表：排序字段不在白名单、来源不认识、页大小为 0 都是 422', async () => {
    const { app } = await open(['competitors.read'])
    for (const query of ['sort=password:asc', 'reason=BAD', 'pageSize=0']) expect((await app.call('GET', `/competitors?${query}`)).status, query).toBe(422)
  })

  it('详情必须带店铺；回看天数超出范围、带多余参数都是 422', async () => {
    const { app } = await open(['competitors.read'])
    for (const query of ['', '?storeId=s1&days=6', '?storeId=s1&days=181', '?storeId=s1&extra=1']) expect((await app.call('GET', `/competitors/B0COMPET01${query}`)).status, query).toBe(422)
  })

  it('关注：缺字段、ASIN 不合法、竞品等于我方对应 ASIN、多余字段、备注过长都是 422', async () => {
    const { app } = await open(['competitors.read', 'competitors.write'])
    const bad = [
      {},
      { storeId: 's1' },
      { storeId: 's1', asin: 'short' },
      { storeId: 's1', asin: 'B0COMPET01', ownAsin: 'B0COMPET01' },
      { storeId: 's1', asin: 'B0COMPET01', reason: 'OTHER' },
      { storeId: 's1', asin: 'B0COMPET01', extra: 1 },
      { storeId: 's1', asin: 'B0COMPET01', note: 'x'.repeat(201) },
    ]
    for (const body of bad) expect((await app.call('POST', '/competitors', { body })).status, JSON.stringify(body)).toBe(422)
  })

  it('取消关注必须带店铺', async () => {
    const { app } = await open(['competitors.read', 'competitors.write'])
    expect((await app.call('DELETE', '/competitors/B0COMPET01')).status).toBe(422)
  })
})

describe('竞品监控接口：路由顺序', () => {
  it('candidates 是静态路径，不会被当成 ASIN（没有 storeId 也不报 422）', async () => {
    const { app } = await open(['competitors.read'])
    const res = await app.call('GET', '/competitors/candidates')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.state).toBe('NO_DATA')
  })
})
