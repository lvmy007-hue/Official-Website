import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 利润项目字典接口（P6-18）：未登录与权限、权限先于参数校验、参数校验。
// 首次生成、读取、保存的版本冲突、映射重算、关账不受影响等见 testing/profit-items.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const metricVersion = { findFirst: vi.fn().mockResolvedValue(null), createMany: vi.fn() }
  const profitItem = { findMany: vi.fn().mockResolvedValue([]), createMany: vi.fn() }
  harness = await createTestApp({ ...sessionStub(permissions), metricVersion, profitItem, profitItemMapping: { findMany: vi.fn().mockResolvedValue([]) } })
  return { app: harness, metricVersion, profitItem }
}

describe('利润项目字典接口：登录与权限', () => {
  it('未登录 401；没有 finance.read 读取类接口 403，而且先于参数校验、也不读数据库', async () => {
    const { app, metricVersion } = await open(['products.read'])
    for (const path of ['/finance/profit-items', '/finance/profit-items/unmapped']) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/finance/profit-items/unmapped?sort=password:asc')).status).toBe(403)
    expect(metricVersion.findFirst).not.toHaveBeenCalled()
  })

  it('只有 finance.read 时保存是 403（未登录 401），参数校验在权限之后', async () => {
    const { app, metricVersion } = await open(['finance.read'])
    expect((await app.call('PUT', '/finance/profit-items', { body: {} })).status).toBe(403)
    expect((await app.call('PUT', '/finance/profit-items', { body: {}, auth: false })).status).toBe(401)
    expect(metricVersion.findFirst).not.toHaveBeenCalled()
  })
})

describe('利润项目字典接口：参数校验', () => {
  it('未映射列表：排序字段不在白名单、页大小为 0、多余参数都是 422', async () => {
    const { app } = await open(['finance.read'])
    for (const query of ['sort=password:asc', 'pageSize=0', 'extra=1']) expect((await app.call('GET', `/finance/profit-items/unmapped?${query}`)).status, query).toBe(422)
  })

  it('保存：缺版本、名称为空或过长、多余字段、没有项目都是 422，不读数据库', async () => {
    const { app, metricVersion } = await open(['finance.read', 'finance.profititem.manage'])
    const item = { id: 'a', parentId: null, name: '项目', sort: 1 }
    const bad = [
      {},
      { items: [item], mappings: [] },
      { version: 1, items: [], mappings: [] },
      { version: 1, items: [{ ...item, name: '' }], mappings: [] },
      { version: 1, items: [{ ...item, name: 'x'.repeat(41) }], mappings: [] },
      { version: 1, items: [{ ...item, extra: 1 }], mappings: [] },
      { version: 1, items: [item], mappings: [], extra: 1 },
    ]
    for (const body of bad) expect((await app.call('PUT', '/finance/profit-items', { body })).status, JSON.stringify(body)).toBe(422)
    expect(metricVersion.findFirst).not.toHaveBeenCalled()
  })
})
