import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 费用分摊规则接口（P6-19）：未登录与权限、权限先于参数校验、参数校验。
// 分摊规则的新建与修改、冲突、关账锁定、预览不落库等见 testing/allocation-rules.db.test.ts（真实数据库）。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const open = async (permissions: string[]) => {
  const allocationRule = { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() }
  const profitItem = { findMany: vi.fn().mockResolvedValue([]) }
  harness = await createTestApp({ ...sessionStub(permissions), allocationRule, profitItem })
  return { app: harness, allocationRule, profitItem }
}

describe('费用分摊规则接口：登录与权限', () => {
  it('未登录 401；没有 finance.read 读取与预览都是 403，且先于参数校验、不读数据库', async () => {
    const { app, allocationRule } = await open(['products.read'])
    expect((await app.call('GET', '/finance/allocation-rules', { auth: false })).status).toBe(401)
    expect((await app.call('GET', '/finance/allocation-rules')).status).toBe(403)
    expect((await app.call('GET', '/finance/allocation-rules?sort=password:asc')).status).toBe(403)
    expect((await app.call('POST', '/finance/allocation-rules/preview', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/finance/allocation-rules/preview', { body: {}, auth: false })).status).toBe(401)
    expect(allocationRule.findMany).not.toHaveBeenCalled()
  })

  it('只有 finance.read 时新建与修改是 403（未登录 401），先于参数校验', async () => {
    const { app, allocationRule } = await open(['finance.read'])
    expect((await app.call('POST', '/finance/allocation-rules', { body: {} })).status).toBe(403)
    expect((await app.call('PUT', '/finance/allocation-rules', { body: {} })).status).toBe(403)
    expect((await app.call('POST', '/finance/allocation-rules', { body: {}, auth: false })).status).toBe(401)
    expect((await app.call('PUT', '/finance/allocation-rules', { body: {}, auth: false })).status).toBe(401)
    expect(allocationRule.create).not.toHaveBeenCalled()
  })
})

describe('费用分摊规则接口：参数校验', () => {
  it('列表：排序字段不在白名单、页大小为 0、多余参数都是 422', async () => {
    const { app } = await open(['finance.read'])
    for (const query of ['sort=password:asc', 'pageSize=0', 'extra=1']) expect((await app.call('GET', `/finance/allocation-rules?${query}`)).status, query).toBe(422)
  })

  it('新建：依据不合法、月份格式错、手动比例缺失或与依据不一致、多余字段都是 422，不读数据库', async () => {
    const { app, allocationRule, profitItem } = await open(['finance.read', 'finance.policy.write'])
    const base = { feeItemId: 'f1', basis: 'SALES_AMOUNT', effectiveMonth: '2026-07' }
    const bad = [
      {},
      { ...base, basis: 'FOO' },
      { ...base, effectiveMonth: '2026-7' },
      { ...base, effectiveMonth: '2026-07-01' },
      { ...base, basis: 'MANUAL' },
      { ...base, basis: 'MANUAL', manualWeights: { A: -1 } },
      { ...base, manualWeights: { A: 1 } },
      { ...base, extra: 1 },
    ]
    for (const body of bad) expect((await app.call('POST', '/finance/allocation-rules', { body })).status, JSON.stringify(body)).toBe(422)
    expect(allocationRule.create).not.toHaveBeenCalled()
    expect(profitItem.findMany).not.toHaveBeenCalled()
  })

  it('修改：缺版本、带上不能改的字段都是 422', async () => {
    const { app, allocationRule } = await open(['finance.read', 'finance.policy.write'])
    const bad = [{}, { id: 'r1', basis: 'SALES_UNITS' }, { id: 'r1', version: 1, basis: 'SALES_UNITS', effectiveMonth: '2026-07' }, { id: 'r1', version: 1, basis: 'MANUAL' }]
    for (const body of bad) expect((await app.call('PUT', '/finance/allocation-rules', { body })).status, JSON.stringify(body)).toBe(422)
    expect(allocationRule.findFirst).not.toHaveBeenCalled()
  })

  it('预览：月份或规则不合法是 422', async () => {
    const { app } = await open(['finance.read'])
    const bad = [
      {},
      { month: '2026-7', rule: { feeItemId: 'f1', basis: 'SALES_UNITS' } },
      { month: '2026-07', rule: { feeItemId: 'f1', basis: 'MANUAL' } },
      { month: '2026-07', rule: { basis: 'SALES_UNITS' } },
    ]
    for (const body of bad) expect((await app.call('POST', '/finance/allocation-rules/preview', { body })).status, JSON.stringify(body)).toBe(422)
  })
})
