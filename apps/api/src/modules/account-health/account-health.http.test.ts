import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 账户健康接口（P5-02）：未登录与权限、权限先于参数校验、参数校验、路由顺序（issues 不被当成问题编号）。
// 数据读取、处理问题、数据范围与跨企业隔离见 testing/account-health.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const policyIssue = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), groupBy: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) }
  const accountHealthSnapshot = { findMany: vi.fn().mockResolvedValue([]), groupBy: vi.fn().mockResolvedValue([]) }
  harness = await createTestApp({
    ...sessionStub(permissions),
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
    policyIssue,
    accountHealthSnapshot,
    platformConnection: { findMany: vi.fn().mockResolvedValue([]) },
    dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
  })
  return { app: harness, policyIssue, accountHealthSnapshot }
}

const READ_PATHS = ['/account-health', '/account-health/issues', '/account-health/issues/abc']

describe('账户健康接口：登录与权限', () => {
  it('未登录 401；没有 account.health.read 读取类接口 403，而且先于参数校验、也不读数据库', async () => {
    const { app, policyIssue, accountHealthSnapshot } = await open(['products.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/account-health/issues?sort=password:asc&kind=BAD')).status).toBe(403)
    expect(policyIssue.findMany).not.toHaveBeenCalled()
    expect(accountHealthSnapshot.findMany).not.toHaveBeenCalled()
  })

  it('处理问题要 alerts.handle：只有读权限是 403（未登录 401），权限先于参数校验', async () => {
    const { app, policyIssue } = await open(['account.health.read'])
    expect((await app.call('PATCH', '/account-health/issues/abc', { body: { version: 1, handlingStatus: 'DONE' } })).status).toBe(403)
    expect((await app.call('PATCH', '/account-health/issues/abc', { body: {} })).status).toBe(403)
    expect((await app.call('PATCH', '/account-health/issues/abc', { body: {}, auth: false })).status).toBe(401)
    expect(policyIssue.findFirst).not.toHaveBeenCalled()
  })

  it('只有 alerts.handle 没有 account.health.read 也不能处理问题', async () => {
    const { app, policyIssue } = await open(['alerts.handle'])
    expect((await app.call('PATCH', '/account-health/issues/abc', { body: { version: 1, handlingStatus: 'DONE' } })).status).toBe(403)
    expect(policyIssue.findFirst).not.toHaveBeenCalled()
  })
})

describe('账户健康接口：参数校验', () => {
  it('问题列表：排序字段不在白名单、类型或状态不认识、页大小为 0 都是 422', async () => {
    const { app } = await open(['account.health.read'])
    for (const query of ['sort=password:asc', 'kind=BAD', 'status=BAD', 'handlingStatus=BAD', 'pageSize=0']) expect((await app.call('GET', `/account-health/issues?${query}`)).status, query).toBe(422)
  })

  it('处理问题：缺版本号、没有任何修改项、状态不认识、案件编号含空格、备注过长、多余字段都是 422', async () => {
    const { app } = await open(['account.health.read', 'alerts.handle'])
    const bad = [
      {},
      { handlingStatus: 'DONE' },
      { version: 1 },
      { version: 1, handlingStatus: 'NOPE' },
      { version: 1, amazonCaseId: 'a b' },
      { version: 1, handlingNote: 'x'.repeat(501) },
      { version: 1, handlingStatus: 'DONE', status: 'RESOLVED' },
    ]
    for (const body of bad) expect((await app.call('PATCH', '/account-health/issues/abc', { body })).status, JSON.stringify(body)).toBe(422)
  })

  it('问题不存在是 404（编号格式不对也是 404，不查库）', async () => {
    const { app, policyIssue } = await open(['account.health.read', 'alerts.handle'])
    expect((await app.call('GET', '/account-health/issues/abc')).status).toBe(404)
    expect((await app.call('PATCH', '/account-health/issues/abc', { body: { version: 1, handlingStatus: 'DONE' } })).status).toBe(404)
    const before = policyIssue.findFirst.mock.calls.length
    expect((await app.call('PATCH', '/account-health/issues/a%20b', { body: { version: 1, handlingStatus: 'DONE' } })).status).toBe(404)
    expect(policyIssue.findFirst.mock.calls.length).toBe(before)
  })
})

describe('账户健康接口：路由顺序与空数据', () => {
  it('issues 是静态路径，不会被当成问题编号；没有任何数据时总览给出每个店铺的“没数据”说明而不是 0', async () => {
    const { app } = await open(['account.health.read'])
    const list = await app.call('GET', '/account-health/issues')
    expect(list.status, JSON.stringify(list.json)).toBe(200)
    expect(list.json.data.items).toEqual([])
    const overview = await app.call('GET', '/account-health')
    expect(overview.status, JSON.stringify(overview.json)).toBe(200)
    expect(overview.json.data.stores[0]).toMatchObject({ sellerAccountId: 's1', state: 'NOT_CONNECTED' })
    expect(overview.json.data.push.state).toBe('NOT_CONNECTED')
  })
})
