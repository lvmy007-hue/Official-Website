import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 预估与自定义费用接口（P6-20）：未登录与权限、权限先于参数校验、参数校验、回款漏斗的权限。
// 规则的新建、修改、删除、区间重叠、导入、利润重算与冲销见 testing/estimated-fees.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const estimatedFee = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn(), count: vi.fn().mockResolvedValue(0) }
  const profitItem = { findMany: vi.fn().mockResolvedValue([]) }
  const fbaFinancialTransaction = { aggregate: vi.fn(), findMany: vi.fn(), count: vi.fn(), groupBy: vi.fn() }
  harness = await createTestApp({ ...sessionStub(permissions), estimatedFee, profitItem, fbaFinancialTransaction })
  return { app: harness, estimatedFee, profitItem, fbaFinancialTransaction }
}

const valid = { itemId: 'i1', scopeType: 'STORE', scopeId: 's1', mode: 'FIXED', value: 100, period: 'MONTHLY', from: '2026-01-01' }

describe('预估费用接口：登录与权限', () => {
  it('未登录 401；没有 finance.read 读取是 403，且先于参数校验、不读数据库', async () => {
    const { app, estimatedFee } = await open(['products.read'])
    expect((await app.call('GET', '/finance/estimated-fees', { auth: false })).status).toBe(401)
    expect((await app.call('GET', '/finance/estimated-fees')).status).toBe(403)
    expect((await app.call('GET', '/finance/estimated-fees?sort=password:asc')).status).toBe(403)
    expect(estimatedFee.findMany).not.toHaveBeenCalled()
  })

  it('只有 finance.read 时新建、修改、删除、导入都是 403（未登录 401），先于参数校验', async () => {
    const { app, estimatedFee } = await open(['finance.read'])
    expect((await app.call('POST', '/finance/estimated-fees', { body: {} })).status).toBe(403)
    expect((await app.call('PUT', '/finance/estimated-fees', { body: {} })).status).toBe(403)
    expect((await app.call('DELETE', '/finance/estimated-fees')).status).toBe(403)
    expect((await app.call('POST', '/finance/estimated-fees/import', { body: {} })).status).toBe(403)
    for (const method of ['POST', 'PUT', 'DELETE'] as const) expect((await app.call(method, '/finance/estimated-fees', { body: {}, auth: false })).status).toBe(401)
    expect(estimatedFee.create).not.toHaveBeenCalled()
  })

  it('回款漏斗需要 finance.read：没有权限 403，未登录 401', async () => {
    const { app, fbaFinancialTransaction } = await open(['products.read'])
    expect((await app.call('GET', '/finance/cashflow/funnel', { auth: false })).status).toBe(401)
    expect((await app.call('GET', '/finance/cashflow/funnel')).status).toBe(403)
    expect(fbaFinancialTransaction.aggregate).not.toHaveBeenCalled()
  })
})

describe('预估费用接口：参数校验', () => {
  it('列表：排序字段不在白名单、页大小为 0、多余参数都是 422', async () => {
    const { app } = await open(['finance.read'])
    for (const query of ['sort=password:asc', 'pageSize=0', 'extra=1', 'scopeType=FOO']) expect((await app.call('GET', `/finance/estimated-fees?${query}`)).status, query).toBe(422)
  })

  it('新建：范围、方式、金额、比例、日期、多余字段不合法都是 422，不读数据库', async () => {
    const { app, estimatedFee, profitItem } = await open(['finance.read', 'finance.estimatedfee.write'])
    const bad = [
      {},
      { ...valid, scopeType: 'FOO' },
      { ...valid, mode: 'FOO' },
      { ...valid, period: 'WEEKLY' },
      { ...valid, value: 0 },
      { ...valid, value: -1 },
      { ...valid, mode: 'PERCENT_OF_SALES', value: 101 },
      { ...valid, from: '2026-1-1' },
      { ...valid, from: '2026-02-30' },
      { ...valid, to: '2025-12-31' },
      { ...valid, extra: 1 },
    ]
    for (const body of bad) expect((await app.call('POST', '/finance/estimated-fees', { body })).status, JSON.stringify(body)).toBe(422)
    expect(estimatedFee.create).not.toHaveBeenCalled()
    expect(profitItem.findMany).not.toHaveBeenCalled()
  })

  it('修改与删除：缺版本、缺编号都是 422', async () => {
    const { app, estimatedFee } = await open(['finance.read', 'finance.estimatedfee.write'])
    for (const body of [{}, { ...valid }, { ...valid, id: 'e1' }]) expect((await app.call('PUT', '/finance/estimated-fees', { body })).status, JSON.stringify(body)).toBe(422)
    for (const query of ['', '?id=e1', '?version=1', '?id=e1&version=0']) expect((await app.call('DELETE', `/finance/estimated-fees${query}`)).status, query).toBe(422)
    expect(estimatedFee.findFirst).not.toHaveBeenCalled()
  })

  it('导入：缺文件名、内容为空、多余字段都是 422', async () => {
    const { app } = await open(['finance.read', 'finance.estimatedfee.write'])
    for (const body of [{}, { fileName: 'a.csv' }, { fileName: 'a.csv', content: '' }, { fileName: 'a.csv', content: 'x', extra: 1 }]) {
      expect((await app.call('POST', '/finance/estimated-fees/import', { body })).status, JSON.stringify(body)).toBe(422)
    }
  })
})
