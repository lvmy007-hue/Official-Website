import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 定价与购物车接口（P4-11）：未登录与权限、权限先于参数校验、参数校验、路由顺序（静态路径不被当成 SKU）。
// 数据读取、改价流程、护栏与规则的真实行为见 testing/pricing*.db.test.ts（真实数据库）。

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

const READ_PATHS = ['/pricing', '/pricing/guardrails', '/pricing/rules', '/pricing/rules/r1/runs', '/pricing/SKU-1?storeId=s1']

describe('定价接口：登录与权限', () => {
  it('未登录 401；没有 pricing.read 读取类接口 403，而且先于参数校验', async () => {
    const app = await open(['products.read'])
    for (const path of READ_PATHS) {
      expect((await app.call('GET', path, { auth: false })).status, path).toBe(401)
      expect((await app.call('GET', path)).status, path).toBe(403)
    }
    expect((await app.call('GET', '/pricing?sort=password:asc&health=BAD')).status).toBe(403)
    expect((await app.call('POST', '/pricing/SKU-1/simulation', { body: {} })).status).toBe(403)
  })

  it('只有 pricing.read 时：写入类与试运行都是 403', async () => {
    const app = await open(['pricing.read'])
    const writes: Array<[string, string]> = [
      ['PUT', '/pricing/guardrails'],
      ['POST', '/pricing/rules'],
      ['PATCH', '/pricing/rules/r1'],
      ['POST', '/pricing/rules/r1/dry-run'],
      ['POST', '/pricing/rule-runs/x1/dismiss'],
      ['POST', '/pricing/SKU-1/validate'],
      ['PATCH', '/pricing/SKU-1'],
    ]
    for (const [method, path] of writes) {
      expect((await app.call(method, path, { body: {} })).status, `${method} ${path}`).toBe(403)
      expect((await app.call(method, path, { body: {}, auth: false })).status, `${method} ${path}`).toBe(401)
    }
  })

  it('有 pricing.rule.write 但没有 pricing.price.write 时不能改价、校验或忽略建议', async () => {
    const app = await open(['pricing.read', 'pricing.rule.write'])
    for (const [method, path] of [
      ['POST', '/pricing/SKU-1/validate'],
      ['PATCH', '/pricing/SKU-1'],
      ['POST', '/pricing/rule-runs/x1/dismiss'],
    ] as const)
      expect((await app.call(method, path, { body: {} })).status, `${method} ${path}`).toBe(403)
  })
})

describe('定价接口：参数校验', () => {
  it('列表：排序字段不在白名单、健康状态不认识、页大小为 0 都是 422', async () => {
    const app = await open(['pricing.read'])
    for (const query of ['sort=password:asc', 'health=BAD', 'pageSize=0']) expect((await app.call('GET', `/pricing?${query}`)).status, query).toBe(422)
  })

  it('详情必须带店铺；模拟的价格必须是正数且不能带多余字段', async () => {
    const app = await open(['pricing.read'])
    expect((await app.call('GET', '/pricing/SKU-1')).status).toBe(422)
    for (const body of [{}, { storeId: 's1' }, { storeId: 's1', price: 0 }, { storeId: 's1', price: -1 }, { storeId: 's1', price: 9.99, extra: 1 }])
      expect((await app.call('POST', '/pricing/SKU-1/simulation', { body })).status, JSON.stringify(body)).toBe(422)
  })

  it('护栏：缺字段、最低价高于最高价、店铺级写了对象、一项限制都没设都是 422', async () => {
    const app = await open(['pricing.read', 'pricing.rule.write'])
    const bad = [
      {},
      { storeId: 's1', scope: 'STORE', minPrice: 10, maxPrice: 5 },
      { storeId: 's1', scope: 'STORE', scopeRef: 'SKU-1', minPrice: 5 },
      { storeId: 's1', scope: 'SKU', minPrice: 5 },
      { storeId: 's1', scope: 'STORE' },
      { storeId: 's1', scope: 'STORE', minMarginPct: 0.99 },
    ]
    for (const body of bad) expect((await app.call('PUT', '/pricing/guardrails', { body })).status, JSON.stringify(body)).toBe(422)
  })

  it('规则：缺字段、策略参数不完整、自动与手动之外的模式、范围为空都是 422', async () => {
    const app = await open(['pricing.read', 'pricing.rule.write'])
    const base = { storeId: 's1', name: 'R', mode: 'MANUAL', strategy: 'FOLLOW_EXPECTED', params: {}, scope: { all: true } }
    for (const body of [
      {},
      { ...base, mode: 'SEMI' },
      { ...base, strategy: 'TARGET_MARGIN', params: {} },
      { ...base, scope: { all: false, skus: [], asins: [] } },
      { ...base, maxChangePct: 0 },
      { ...base, dailyLimit: 0 },
      { ...base, name: '' },
    ])
      expect((await app.call('POST', '/pricing/rules', { body })).status, JSON.stringify(body)).toBe(422)
    expect((await app.call('PATCH', '/pricing/rules/r1', { body: {} })).status).toBe(422)
    expect((await app.call('PATCH', '/pricing/rules/r1', { body: { expectedVersion: 1, strategy: 'MATCH_LOWEST' } })).status).toBe(422)
    expect((await app.call('POST', '/pricing/rules/r1/dry-run', { body: { days: 99 } })).status).toBe(422)
  })

  it('改价：校验与提交缺字段、价格不是正数、预览编号缺失都是 422', async () => {
    const app = await open(['pricing.read', 'pricing.price.write'])
    for (const body of [{}, { storeId: 's1' }, { storeId: 's1', price: 0 }, { storeId: 's1', price: 9.99, productType: 'lower' }])
      expect((await app.call('POST', '/pricing/SKU-1/validate', { body })).status, JSON.stringify(body)).toBe(422)
    for (const body of [{}, { storeId: 's1', price: 9.99 }, { storeId: 's1', price: 9.99, previewRunId: '' }, { storeId: 's1', price: 9.99, previewRunId: 'p1', sku: 'OTHER' }])
      expect((await app.call('PATCH', '/pricing/SKU-1', { body })).status, JSON.stringify(body)).toBe(422)
  })

  it('执行记录列表：结果筛选不认识是 422', async () => {
    const app = await open(['pricing.read'])
    expect((await app.call('GET', '/pricing/rules/r1/runs?outcome=BAD')).status).toBe(422)
  })

  it('静态路径没有被当成 SKU：guardrails 与 rules 走各自的处理器', async () => {
    const app = await open(['pricing.read'])
    const guardrails = await app.call('GET', '/pricing/guardrails?storeId=')
    expect(guardrails.status).not.toBe(404)
  })
})
