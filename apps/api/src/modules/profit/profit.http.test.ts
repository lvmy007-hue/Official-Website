import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 利润分析接口（P2b-10）：权限先于参数校验、字段权限（利润与成本）、参数校验、没有数据时的空状态、查询条件里带企业与口径与日期范围。
// 数值口径、游标、数据范围在真实库测试 apps/api/src/testing/profit-analysis.db.test.ts 里逐条验证。

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

function stub(permissions: string[]) {
  const profitDaily = {
    aggregate: vi.fn().mockResolvedValue({ _sum: {}, _count: { _all: 0 }, _max: { refreshedAt: null } }),
    count: vi.fn().mockResolvedValue(0),
    groupBy: vi.fn().mockResolvedValue([]),
  }
  return {
    prisma: {
      ...sessionStub(permissions),
      tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) },
      sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1', displayName: '美国主店' }]) },
      dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
      fbaProduct: { findMany: vi.fn().mockResolvedValue([]) },
      costVersion: { groupBy: vi.fn().mockResolvedValue([]) },
      profitDaily,
      profitItem: { findMany: vi.fn().mockResolvedValue([]) },
      metricVersion: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    },
    profitDaily,
  }
}
const FULL = ['profit.read', 'field.profit', 'field.cost']
const RANGE = 'from=2026-10-01&to=2026-10-10'
const PATHS = ['overview', 'stores', 'asins', 'ads', 'bridge', 'cost-coverage']

async function call(permissions: string[], path: string) {
  const { prisma, profitDaily } = stub(permissions)
  harness = await createTestApp(prisma)
  const res = await harness.call('GET', path)
  return { res, profitDaily }
}

describe('权限', () => {
  it.each(PATHS)('%s：没有 profit.read 先拿 403，不会先看到参数校验细节', async path => {
    const { res, profitDaily } = await call(['orders.read'], `/profit/${path}?recognition=BAD`)
    expect(res.status).toBe(403)
    expect(profitDaily.aggregate).not.toHaveBeenCalled()
    expect(profitDaily.groupBy).not.toHaveBeenCalled()
  })

  it.each(PATHS.filter(path => path !== 'cost-coverage'))('%s：有 profit.read 但没有利润字段权限返回 403，并说明缺哪个字段权限', async path => {
    const { res, profitDaily } = await call(['profit.read'], `/profit/${path}?${RANGE}`)
    expect(res.status).toBe(403)
    expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
    expect(res.json.error.message).toContain('field.profit')
    expect(profitDaily.aggregate).not.toHaveBeenCalled()
  })

  it('成本覆盖全部是成本数据：只有利润字段权限也是 403；旧权限 finance.read 展开后有利润字段权限但没有成本字段权限', async () => {
    expect((await call(['profit.read', 'field.profit'], `/profit/cost-coverage?${RANGE}`)).res.status).toBe(403)
    expect((await call(['finance.read'], `/profit/cost-coverage?${RANGE}`)).res.status).toBe(403)
    expect((await call(['finance.read'], `/profit/overview?${RANGE}`)).res.status).toBe(200)
  })
})

describe('参数校验', () => {
  it.each([
    ['overview?recognition=BAD'],
    ['stores?recognition=x'],
    ['asins?by=NOPE'],
    ['asins?sort=bogus'],
    ['asins?pageSize=0'],
    ['ads?by=NOPE'],
    ['cost-coverage?pageSize=1000'],
    ['bridge?recognition=x'],
    ['overview?from=2026-10-10&to=2026-10-01'],
  ])('%s → 422', async path => {
    const { res } = await call(FULL, `/profit/${path}`)
    expect(res.status).toBe(422)
  })

  it('坏游标返回 400，不是 422', async () => {
    process.env.JWT_SECRET ??= 'x'.repeat(40)
    const { res } = await call(FULL, `/profit/asins?${RANGE}&cursor=forged.value`)
    expect(res.status).toBe(400)
    expect(res.json.error.code).toBe('CURSOR_INVALID')
  })
})

describe('没有数据', () => {
  it.each(['overview', 'stores', 'asins', 'ads', 'cost-coverage', 'bridge'])('%s：空状态说明，不是 0，不报错', async path => {
    const { res } = await call(FULL, `/profit/${path}?${RANGE}`)
    expect(res.status).toBe(200)
    const data = res.json.data
    expect(data).toMatchObject({ state: 'NO_DATA', recognition: 'ORDERED', currency: 'USD', range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false } })
    expect(data.note).toContain('尚无利润数据')
  })

  it('没选日期范围：默认最近 30 天并写明是默认；口径与企业条件带进查询', async () => {
    const { res, profitDaily } = await call(FULL, '/profit/overview?recognition=SETTLED')
    expect(res.json.data.range).toMatchObject({ days: 30, defaulted: true })
    const where = profitDaily.aggregate.mock.calls[0]![0].where
    expect(where).toMatchObject({ tenantId: 'tenant-1', basis: 'SETTLED' })
    expect(where.profitDate.gte).toBeInstanceOf(Date)
    expect(where.profitDate.lte).toBeInstanceOf(Date)
  })

  it('利润桥：没有数据时关税与汇兑损益仍是“尚未接入”，三项成本在没有成本字段权限时是“无权限”', async () => {
    const full = (await call(FULL, `/profit/overview?${RANGE}`)).res.json.data.bridge.items
    const state = (items: Array<{ key: string; state: string }>, key: string) => items.find(item => item.key === key)?.state
    expect(state(full, 'DUTY')).toBe('NO_DATA')
    expect(state(full, 'FX_GAIN_LOSS')).toBe('NOT_CONNECTED')
    expect(state(full, 'PRODUCT_COST')).toBe('NO_DATA')
    const limited = (await call(['profit.read', 'field.profit'], `/profit/overview?${RANGE}`)).res.json.data
    expect(state(limited.bridge.items, 'PRODUCT_COST')).toBe('RESTRICTED')
    expect(limited.summary).not.toHaveProperty('costCoverage')
  })
})
