import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const prismaFor = (permissions: string[], over: Record<string, any> = {}) => ({
  ...sessionStub(permissions),
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }, { id: 's2' }]) },
  dataFreshness: { findMany: vi.fn().mockResolvedValue([]) },
  ...over,
})

describe('数据源健康表接口', () => {
  it('需要 overview.read：没有该权限 403，未登录 401', async () => {
    harness = await createTestApp(prismaFor(['products.read']))
    expect((await harness.call('GET', '/overview/source-health')).status).toBe(403)
    expect((await harness.call('GET', '/overview/source-health', { auth: false })).status).toBe(401)
  })

  it('没有任何同步记录：已登记来源显示“尚无记录”，未交付来源显示“尚未接入”，推送类显示“未接入”，不出现任何时间', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    const res = await harness.call('GET', '/overview/source-health')
    expect(res.status).toBe(200)
    const rows = res.json.data.rows as Array<{ label: string; statusLabel: string; state: string; lastSuccessAt: string | null }>
    expect(rows.map(row => [row.label, row.statusLabel])).toEqual([
      ['订单', '尚无记录'],
      ['库存', '尚无记录'],
      ['入仓计划', '尚无记录'],
      ['财务交易', '尚无记录'],
      ['报告', '尚未接入'],
      ['数据中心', '尚未接入'],
      ['广告', '尚未接入'],
      ['营销数据流', '未接入'],
      ['品牌分析', '尚未接入'],
      ['消息推送', '未接入'],
    ])
    expect(rows.every(row => row.lastSuccessAt === null)).toBe(true)
    expect(res.json.data.storeCount).toBe(2)
  })

  it('有记录时返回真实的最近成功时间、覆盖店铺数与中文失败原因；受限成员只看到被授权店铺', async () => {
    const now = Date.now()
    const prisma = prismaFor(['overview.read'], { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 's1' }]) } })
    prisma.sellerAccount.findMany.mockResolvedValue([{ id: 's1' }])
    prisma.dataFreshness.findMany.mockResolvedValue([
      {
        sellerAccountId: 's1',
        sourceKey: 'orders.api',
        lastAttemptAt: new Date(now - 60_000),
        lastSuccessAt: new Date(now - 60_000),
        dataThrough: new Date(now - 60_000),
        status: 'NORMAL',
        lastErrorCode: null,
      },
      { sellerAccountId: 's1', sourceKey: 'inventory.api', lastAttemptAt: new Date(now - 60_000), lastSuccessAt: null, dataThrough: null, status: 'UNAUTHORIZED', lastErrorCode: 'AUTH_EXPIRED' },
    ])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/overview/source-health')
    expect(res.status).toBe(200)
    expect(res.json.data.rows[0]).toMatchObject({ label: '订单', state: 'LIVE', status: 'NORMAL', coverage: { total: 1, fresh: 1 } })
    expect(res.json.data.rows[1]).toMatchObject({ label: '库存', status: 'UNAUTHORIZED', errorMessage: '亚马逊授权已失效，请重新授权', lastSuccessAt: null })
    expect(prisma.dataFreshness.findMany.mock.calls[0][0].where.sellerAccountId).toEqual({ in: ['s1'] })
  })

  it('没有任何数据授权返回 403；站点不是美国站返回 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read'], { membershipScope: { findMany: vi.fn().mockResolvedValue([]) } }))
    expect((await harness.call('GET', '/overview/source-health')).status).toBe(403)
    await harness.close()
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/overview/source-health?marketplaceId=A1F83G8C2ARO7P')).status).toBe(422)
  })
})

const ENDPOINTS = ['kpis', 'trend', 'attribution?date=2026-10-01', 'store-compare', 'asin-rank', 'volatility', 'ad-anomalies', 'inventory-risk', 'growth-waterfall', 'cash']
const withTenant = (permissions: string[]) => prismaFor(permissions, { tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) } })

describe('经营控制台接口（P2a-02）：权限与参数', () => {
  it.each(ENDPOINTS)('%s：未登录 401，没有 overview.read 403', async path => {
    harness = await createTestApp(withTenant(['products.read']))
    expect((await harness.call('GET', `/overview/${path}`, { auth: false })).status).toBe(401)
    expect((await harness.call('GET', `/overview/${path}`)).status).toBe(403)
  })

  it('广告异常、库存风险尚未接入：如实返回“尚未接入”与负责的工作包，不含任何数字', async () => {
    harness = await createTestApp(withTenant(['overview.read']))
    const ads = await harness.call('GET', '/overview/ad-anomalies')
    expect(ads.status).toBe(200)
    expect(ads.json.data).toMatchObject({ state: 'NOT_CONNECTED', workPackage: 'P3' })
    const stock = await harness.call('GET', '/overview/inventory-risk')
    expect(stock.json.data).toMatchObject({ state: 'NOT_CONNECTED', workPackage: 'P2a-06' })
    expect(Object.keys(stock.json.data).sort()).toEqual(['note', 'state', 'workPackage'])
  })

  it('参数不合法返回 422：粒度、指标、排序方式、日期缺失或不存在', async () => {
    harness = await createTestApp(withTenant(['overview.read']))
    for (const path of ['trend?granularity=year', 'trend?metric=gmv', 'asin-rank?rankBy=color', 'attribution', 'attribution?date=2026-02-30', 'attribution?date=yesterday']) {
      expect((await harness.call('GET', `/overview/${path}`)).status, path).toBe(422)
    }
  })

  it('站点不是美国站、日期范围倒置：422', async () => {
    harness = await createTestApp(withTenant(['overview.read']))
    expect((await harness.call('GET', '/overview/kpis?marketplaceId=A1F83G8C2ARO7P')).status).toBe(422)
    expect((await harness.call('GET', '/overview/kpis?from=2026-10-10&to=2026-10-01')).status).toBe(422)
  })

  it('现金视角没有 finance.read：状态为受限，不查询任何财务表（替身里没有这些表，调用即报错）', async () => {
    harness = await createTestApp(withTenant(['overview.read']))
    const res = await harness.call('GET', '/overview/cash')
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ state: 'RESTRICTED', released: null, deferred: null, nextPayoutDate: null })
  })
})

// 目标达成横幅（P2a-04 消费方）：kpis 接口首行
const SUM_ROW = { orders: 10, units: 20, salesAmount: { toString: () => '3000' }, refundAmount: null, feeAmount: null, adsSpend: null, adsSales: null, profit: null, sessions: null }
const kpisPrisma = (over: Record<string, any> = {}) => ({
  ...withTenant(['overview.read']),
  alertInstance: { groupBy: vi.fn().mockResolvedValue([]) },
  businessTarget: { findMany: vi.fn().mockResolvedValue([]) },
  storeDailySummary: {
    groupBy: vi.fn(async ({ by }: { by: string[] }) => (by[0] === 'sellerAccountId' ? [{ sellerAccountId: 's1', _sum: SUM_ROW }] : [])),
    aggregate: vi.fn().mockResolvedValue({ _sum: SUM_ROW, _count: { _all: 0 } }),
    findFirst: vi.fn().mockResolvedValue(null),
  },
  ...over,
})

describe('经营控制台目标达成横幅（P2a-04）', () => {
  it('范围内没有店铺设置当月整店销售额目标：尚未接入', async () => {
    harness = await createTestApp(kpisPrisma())
    const res = await harness.call('GET', '/overview/kpis?from=2026-10-01&to=2026-10-15')
    expect(res.status).toBe(200)
    expect(res.json.data.target).toEqual({ state: 'NOT_CONNECTED', note: '所选范围内还没有店铺设置当月整店销售额目标' })
  })

  it('查询区间跨多个自然月：无法定位唯一的月度目标，尚未接入', async () => {
    harness = await createTestApp(kpisPrisma())
    const res = await harness.call('GET', '/overview/kpis?from=2026-09-20&to=2026-10-05')
    expect(res.status).toBe(200)
    expect(res.json.data.target.state).toBe('NOT_CONNECTED')
  })

  it('已设置目标且有销售数据：按天均摊算达成率与到期节奏，只覆盖已设置目标的店铺', async () => {
    harness = await createTestApp(kpisPrisma({ businessTarget: { findMany: vi.fn().mockResolvedValue([{ sellerAccountId: 's1', targetValue: { toString: () => '10000' } }]) } }))
    const res = await harness.call('GET', '/overview/kpis?from=2026-10-01&to=2026-10-15')
    expect(res.status).toBe(200)
    expect(res.json.data.target).toMatchObject({
      state: 'OK',
      metric: 'sales',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      targetValue: 10000,
      actualValue: 3000,
      storesCovered: 1,
      storesTotal: 2,
      note: '范围内 2 个店铺中有 1 个已设置目标，达成率只统计这些店铺',
    })
    expect(res.json.data.target.achievementRatio).toBeCloseTo(0.3)
    expect(res.json.data.target.expectedToDateRatio).toBeCloseTo(15 / 31)
  })
})
