import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 商品主数据接口（P4-07）：未登录与权限、权限先于参数校验、参数校验。
// 数据读取与写入的真实行为见 testing/products-list.db.test.ts（真实数据库）。

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
const open = async (permissions: string[]) => (harness = await createTestApp(prismaFor(permissions)))

describe('商品主数据接口：登录与权限', () => {
  it('未登录 401；没有 products.read 403，而且先于参数校验', async () => {
    const app = await open(['overview.read'])
    expect((await app.call('GET', '/products', { auth: false })).status).toBe(401)
    expect((await app.call('GET', '/products')).status).toBe(403)
    expect((await app.call('GET', '/products?sort=password:asc&fulfillment=BAD')).status).toBe(403)
  })

  it('写接口：只读成员改标签、同步目录都是 403；坏参数下无权限的人先拿 403，有权限的人才看到 422', async () => {
    const reader = await open(['products.read'])
    expect((await reader.call('PATCH', '/products/meta', { body: { items: [{ id: 'p1', version: 1 }], ownerId: null } })).status).toBe(403)
    expect((await reader.call('PATCH', '/products/meta', { body: {} })).status).toBe(403)
    expect((await reader.call('POST', '/products/sync', { body: {} })).status).toBe(403)
    await reader.close()
    const writer = await open(['products.read', 'catalog.meta.write', 'sync.manage'])
    expect((await writer.call('PATCH', '/products/meta', { body: {} })).status).toBe(422)
    expect((await writer.call('POST', '/products/sync', { body: {} })).status).toBe(422)
  })
})

describe('商品主数据接口：参数校验', () => {
  it('列表：排序字段不在白名单、配送方式或风险等级不认识都是 422；风险筛选没有库存权限是 403', async () => {
    const app = await open(['products.read'])
    expect((await app.call('GET', '/products?sort=password:asc')).status).toBe(422)
    expect((await app.call('GET', '/products?fulfillment=OTHER')).status).toBe(422)
    expect((await app.call('GET', '/products?risk=HIGH')).status).toBe(403)
  })

  it('批量设置：版本缺失、一次超过 200 个、模式不认识、多余字段、编号格式不对都是 422', async () => {
    const app = await open(['products.read', 'catalog.meta.write'])
    const call = (body: unknown) => app.call('PATCH', '/products/meta', { body })
    expect((await call({ items: [{ id: 'p1' }], ownerId: null })).status).toBe(422)
    expect((await call({ items: Array.from({ length: 201 }, (_, i) => ({ id: `p${i}`, version: 1 })), ownerId: null })).status).toBe(422)
    expect((await call({ items: [{ id: 'p1', version: 1 }], tags: { mode: 'DROP', values: [] } })).status).toBe(422)
    expect((await call({ items: [{ id: 'p1', version: 1 }], ownerId: null, extra: true })).status).toBe(422)
    expect((await call({ items: [{ id: 'bad id!', version: 1 }], ownerId: null })).status).toBe(422)
  })

  it('同步目录：店铺为空、超过 50 个、多余字段都是 422', async () => {
    const app = await open(['products.read', 'sync.manage'])
    const call = (body: unknown) => app.call('POST', '/products/sync', { body })
    expect((await call({ storeIds: [] })).status).toBe(422)
    expect((await call({ storeIds: Array.from({ length: 51 }, (_, i) => `s${i}`) })).status).toBe(422)
    expect((await call({ storeIds: ['s1'], extra: 1 })).status).toBe(422)
  })
})
