import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

// 退货分析与原因映射接口的权限、参数校验与路由顺序（内存替身）；数据行为见 testing/returns-analysis.db.test.ts。

function analysisPrisma(permissions: string[], over: Record<string, unknown> = {}) {
  const none = () => vi.fn().mockResolvedValue([])
  return {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    fbaReturnCase: {
      findMany: none(),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: none(),
      aggregate: vi.fn().mockResolvedValue({ _sum: { quantity: null }, _count: { _all: 0 } }),
    },
    fbaProduct: { findMany: none() },
    asinDailySummary: { findMany: none(), groupBy: none() },
    sellerAccount: { findMany: none() },
    returnReasonMap: { findMany: none(), count: vi.fn().mockResolvedValue(0) },
    dataFreshness: { findMany: none() },
    ...over,
  }
}

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  vi.restoreAllMocks()
  await harness?.close()
  harness = undefined
})

const ANALYSIS_PATHS = ['/returns/analysis/summary', '/returns/analysis/cycle', '/returns/analysis/cross-month', '/returns/analysis/cohort', '/returns/analysis/disposition-matrix']
const item = { code: 'new_reason', labelZh: '新的原因', category: '其他原因' }

describe('退货分析接口：权限', () => {
  it('未登录 401；没有 returns.read 的五个分析接口与映射列表都是 403，且先于参数校验', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    expect((await harness.call('GET', '/returns/analysis/summary', { auth: false })).status).toBe(401)
    await harness.close()
    harness = await createTestApp(analysisPrisma(['seller.read']))
    for (const path of [...ANALYSIS_PATHS, '/returns/reason-map']) {
      const res = await harness.call('GET', `${path}?timeBasis=bad&pageSize=99999`)
      expect(res.status, path).toBe(403)
    }
  })

  it('保存原因映射要 settings.write：只有 returns.read 是 403，且先于参数校验', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    expect((await harness.call('PUT', '/returns/reason-map', { body: { items: [] } })).status).toBe(403)
    expect((await harness.call('PUT', '/returns/reason-map', { body: { items: [item] } })).status).toBe(403)
  })
})

describe('退货分析接口：参数校验', () => {
  it('时间口径、周期起点、切片维度不认识 422；天数段写错 422 并指出原因，不悄悄改成默认值', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    expect((await harness.call('GET', '/returns/analysis/summary?timeBasis=ship')).status).toBe(422)
    expect((await harness.call('GET', '/returns/analysis/cycle?anchor=refund')).status).toBe(422)
    expect((await harness.call('GET', '/returns/analysis/cycle?dimension=store')).status).toBe(422)
    const bounds = await harness.call('GET', '/returns/analysis/cycle?bounds=7,7,30')
    expect(bounds.status).toBe(422)
    expect(bounds.json.error.fieldErrors?.bounds?.join('')).toContain('从小到大')
    expect((await harness.call('GET', '/returns/analysis/cycle?bounds=0,5')).status).toBe(422)
    expect((await harness.call('GET', '/returns/analysis/cycle?bounds=1,2,3,4,5,6,7,8,9,10,11')).status).toBe(422)
  })

  it('退货周期可以只看一个 ASIN（ASIN 360 用）：格式不对 422，合法时筛选条件带上 ASIN；其他分析不接受 asin', async () => {
    const prisma = analysisPrisma(['returns.read'])
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', '/returns/analysis/cycle?asin=bad')).status).toBe(422)
    expect((await harness.call('GET', '/returns/analysis/summary?asin=B0TEST0001')).status).toBe(422)
    const res = await harness.call('GET', '/returns/analysis/cycle?asin=b0test0001')
    expect(res.status).toBe(200)
    expect(prisma.fbaReturnCase.findMany.mock.calls[0]?.[0].where).toMatchObject({ tenantId: 'tenant-1', asin: 'B0TEST0001' })
  })

  it('不适用的参数一律 422：概览不接受 anchor、bounds、dimension', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    for (const path of ANALYSIS_PATHS.filter(name => !name.endsWith('/cycle'))) {
      expect((await harness.call('GET', `${path}?anchor=ship`)).status, path).toBe(422)
      expect((await harness.call('GET', `${path}?bounds=7,14`)).status, path).toBe(422)
    }
  })

  it('保存原因映射：空列表、重复代码（大小写不分）、大类不在列表、释义过长、多余字段、一次超过 50 行都是 422', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read', 'settings.write']))
    const put = (items: unknown[], extra: Record<string, unknown> = {}) => harness!.call('PUT', '/returns/reason-map', { body: { items, ...extra } })
    expect((await put([])).status).toBe(422)
    const duplicate = await put([item, { ...item, code: 'NEW_REASON' }])
    expect(duplicate.status).toBe(422)
    expect(Object.keys(duplicate.json.error.fieldErrors ?? {}).join(',')).toContain('items')
    expect((await put([{ ...item, category: '随便写' }])).status).toBe(422)
    expect((await put([{ ...item, labelZh: '长'.repeat(61) }])).status).toBe(422)
    expect((await put([{ ...item, isSystem: true }])).status).toBe(422)
    expect((await put([item], { tenantId: 'other' })).status).toBe(422)
    expect((await put(Array.from({ length: 51 }, (_, index) => ({ ...item, code: `C${index}` })))).status).toBe(422)
  })

  it('原因映射列表：排序字段、大类筛选不认识 422', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    expect((await harness.call('GET', '/returns/reason-map?sort=bad')).status).toBe(422)
    expect((await harness.call('GET', '/returns/reason-map?category=随便写')).status).toBe(422)
  })
})

describe('退货分析接口：路由顺序与口径', () => {
  it('/returns/reason-map 与 /returns/analysis/* 先于 /returns/:id 匹配：预置原因可见，权限开关按 settings.write 给出', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    const res = await harness.call('GET', '/returns/reason-map?pageSize=200')
    expect(res.status).toBe(200)
    expect(res.json.data.total).toBeGreaterThanOrEqual(22)
    expect(res.json.data.canManage).toBe(false)
    expect(res.json.data.manageBlockedReason).toContain('权限')
    expect(res.json.data.items.find((row: { code: string }) => row.code === 'DEFECTIVE')).toMatchObject({ labelZh: '商品有缺陷', category: '商品质量', source: 'PRESET' })
    await harness.close()
    harness = await createTestApp(analysisPrisma(['returns.read', 'settings.write']))
    expect((await harness.call('GET', '/returns/reason-map')).json.data.canManage).toBe(true)
  })

  it('没有退货数据：五个分析接口都返回 NO_DATA 与说明，缺下单时间计数为 0（不是缺失）', async () => {
    harness = await createTestApp(analysisPrisma(['returns.read']))
    for (const path of ANALYSIS_PATHS) {
      const res = await harness.call('GET', path)
      expect(res.status, path).toBe(200)
      expect(res.json.data.state, path).toBe('NO_DATA')
      expect(res.json.data.note, path).toContain('尚无退货记录')
      expect(res.json.data.unknownOrderUnits, path).toBe(0)
      expect(res.json.data.timeBasis, path).toBeTruthy()
      expect(res.json.data.basis, path).toContain('退货')
    }
  })

  it('按下单时间统计：查询条件落在下单时间上，并单独数出缺下单时间的退货', async () => {
    const prisma = analysisPrisma(['returns.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/returns/analysis/summary?timeBasis=order')
    expect(res.status).toBe(200)
    expect(res.json.data.timeBasis).toBe('order')
    const where = JSON.stringify(prisma.fbaReturnCase.aggregate.mock.calls.map(call => call[0].where))
    expect(where).toContain('orderPurchasedAt')
    expect(JSON.stringify(prisma.fbaReturnCase.aggregate.mock.calls)).toContain('"orderPurchasedAt":null')
  })

  it('保存映射：企业映射已满 500 行时再新增一个新代码 409，并说明上限', async () => {
    const prisma = analysisPrisma(['returns.read', 'settings.write'], {
      returnReasonMap: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValue([{ code: 'NEW_REASON', labelZh: '新的原因', category: '其他原因', isSystem: false, updatedAt: new Date('2026-10-20T00:00:00Z') }]),
        count: vi.fn().mockResolvedValue(500),
        upsert: vi.fn().mockResolvedValue({}),
      },
    })
    // 内存替身没有事务：让事务回调直接用替身本身
    const withTransaction = Object.assign(prisma, { $transaction: async (run: (tx: unknown) => unknown) => run(prisma) })
    harness = await createTestApp(withTransaction)
    const res = await harness.call('PUT', '/returns/reason-map', { body: { items: [item] } })
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('500')
  })
})
