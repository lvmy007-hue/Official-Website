import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 跟卖监控接口（P6-17）：未登录与权限、权限先于参数校验、参数校验。
// 数据读取、白名单增删、筛选、预警评估、数据范围与跨企业隔离见 testing/hijack.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const offerCompetitor = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) }
  const hijackWhitelist = { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0), create: vi.fn() }
  harness = await createTestApp({
    ...sessionStub(permissions),
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]), findFirst: vi.fn().mockResolvedValue({ id: 's1' }) },
    fbaProduct: { findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) },
    offerCompetitor,
    hijackWhitelist,
  })
  return { app: harness, offerCompetitor, hijackWhitelist }
}

const READ_PATHS = ['/tools/hijack', '/tools/hijack/whitelist']

describe('跟卖监控接口：登录与权限', () => {
  it('未登录 401；没有 tools.read 读取类接口 403，而且先于参数校验、也不读数据库', async () => {
    const { app, offerCompetitor, hijackWhitelist } = await open(['products.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/tools/hijack?sort=password:asc&status=BAD')).status).toBe(403)
    expect(offerCompetitor.findMany).not.toHaveBeenCalled()
    expect(hijackWhitelist.findMany).not.toHaveBeenCalled()
  })

  it('只有 tools.read 时：新增与删除白名单都是 403（未登录 401），参数校验在权限之后', async () => {
    const { app, hijackWhitelist } = await open(['tools.read'])
    for (const [method, path] of [
      ['POST', '/tools/hijack/whitelist'],
      ['DELETE', '/tools/hijack/whitelist/w1'],
    ] as const) {
      expect((await app.call(method, path, { body: {} })).status, `${method} ${path}`).toBe(403)
      expect((await app.call(method, path, { body: {}, auth: false })).status, `${method} ${path}`).toBe(401)
    }
    expect(hijackWhitelist.count).not.toHaveBeenCalled()
  })
})

describe('跟卖监控接口：参数校验', () => {
  it('列表：排序字段不在白名单、状态或白名单模式不认识、页大小为 0、多余参数都是 422', async () => {
    const { app } = await open(['tools.read'])
    for (const query of ['sort=password:asc', 'status=BAD', 'whitelist=BAD', 'pageSize=0', 'extra=1']) expect((await app.call('GET', `/tools/hijack?${query}`)).status, query).toBe(422)
  })

  it('白名单列表：排序字段不在白名单、页码不合法都是 422', async () => {
    const { app } = await open(['tools.read'])
    for (const query of ['sort=sellerId:asc', 'page=0', 'pageSize=0']) expect((await app.call('GET', `/tools/hijack/whitelist?${query}`)).status, query).toBe(422)
  })

  it('新增白名单：缺卖家编号、太短、带符号、备注过长、多余字段都是 422，不写库', async () => {
    const { app, hijackWhitelist } = await open(['tools.read', 'tools.manage'])
    const bad = [{}, { sellerId: 'A1B2' }, { sellerId: 'A1B2C3D4-E5' }, { sellerId: 'A1B2C3D4E5', note: 'x'.repeat(201) }, { sellerId: 'A1B2C3D4E5', extra: 1 }]
    for (const body of bad) expect((await app.call('POST', '/tools/hijack/whitelist', { body })).status, JSON.stringify(body)).toBe(422)
    expect(hijackWhitelist.create).not.toHaveBeenCalled()
  })
})
