import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 刊登表现接口（P4-09）：未登录与权限、权限先于参数校验、参数校验。
// 数据读取的真实行为见 testing/listing-performance.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) =>
  (harness = await createTestApp({
    ...sessionStub(permissions),
    sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '店铺 s1' }]) },
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
  }))

describe('刊登表现接口：登录与权限', () => {
  it('未登录 401；没有 listing.read 403，而且先于参数校验', async () => {
    const app = await open(['products.read'])
    expect((await app.call('GET', '/listings/performance', { auth: false })).status).toBe(401)
    expect((await app.call('GET', '/listings/performance')).status).toBe(403)
    expect((await app.call('GET', '/listings/performance?sort=password:asc&fulfillment=BAD')).status).toBe(403)
  })
})

describe('刊登表现接口：参数校验', () => {
  it('排序字段不在白名单、配送方式不认识、异常类型不是已接入的都是 422', async () => {
    const app = await open(['listing.read'])
    expect((await app.call('GET', '/listings/performance?sort=password:asc')).status).toBe(422)
    expect((await app.call('GET', '/listings/performance?fulfillment=OTHER')).status).toBe(422)
    expect((await app.call('GET', '/listings/performance?anomaly=OFFER_LOST')).status).toBe(422)
    expect((await app.call('GET', '/listings/performance?pageSize=0')).status).toBe(422)
  })

  it('游标被篡改是 400，不是 500', async () => {
    const app = await open(['listing.read'])
    const found = await app.call('GET', '/listings/performance?cursor=not-a-real-cursor')
    expect([400, 422]).toContain(found.status)
  })
})

describe('刊登质量与写入接口（P4-10）：登录与权限', () => {
  it('没有 listing.read 时读取与查询类接口 403，没有 listing.write 时写入类接口 403，而且先于参数校验', async () => {
    const app = await open(['products.read'])
    for (const path of ['/listings/quality?tab=BAD', '/listings/runs?kind=BAD', '/listings/runs/r1']) expect((await app.call('GET', path)).status, path).toBe(403)
    for (const path of ['/listings/validate', '/listings/patch', '/listings/batch', '/listings/restrictions']) {
      expect((await app.call('POST', path, { body: {} })).status, path).toBe(403)
      expect((await app.call('POST', path, { body: {}, auth: false })).status, path).toBe(401)
    }
  })

  it('只有 listing.read 可以读，但改动与批量、校验仍是 403', async () => {
    const app = await open(['listing.read'])
    for (const path of ['/listings/validate', '/listings/patch', '/listings/batch']) expect((await app.call('POST', path, { body: {} })).status, path).toBe(403)
  })
})

describe('刊登质量与写入接口（P4-10）：参数校验', () => {
  it('页签、状态、影响不认识，或排序字段不在白名单，是 422', async () => {
    const app = await open(['listing.read'])
    for (const query of ['tab=OTHER', 'severity=BAD', 'status=BAD', 'impact=BAD', 'sort=password:asc', 'pageSize=0'])
      expect((await app.call('GET', `/listings/quality?${query}`)).status, query).toBe(422)
    expect((await app.call('GET', '/listings/runs?kind=BAD')).status).toBe(422)
  })

  it('写入请求缺字段、改了禁止修改的属性、数量超限都是 422', async () => {
    const app = await open(['listing.read', 'listing.write'])
    expect((await app.call('POST', '/listings/validate', { body: {} })).status).toBe(422)
    expect((await app.call('POST', '/listings/patch', { body: { storeId: 's1', sku: 'A' } })).status).toBe(422)
    expect((await app.call('POST', '/listings/batch', { body: { storeId: 's1', items: [] } })).status).toBe(422)
    expect((await app.call('POST', '/listings/restrictions', { body: { storeId: 's1', asins: [], conditionType: 'new_new' } })).status).toBe(422)
    // 价格、库存、配送属性不能经由刊登质量页修改
    const blocked = { storeId: 's1', sku: 'A', productType: 'SHIRT', patches: [{ op: 'replace', attribute: 'list_price', values: ['9.99'] }] }
    expect((await app.call('POST', '/listings/validate', { body: blocked })).status).toBe(422)
  })
})
