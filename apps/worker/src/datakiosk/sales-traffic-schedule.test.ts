import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDeps } from '../listeners/schedule-jobs'
import { planSalesTrafficQueries, scheduleSalesTrafficQueries, type SalesTrafficPresence } from './sales-traffic-schedule'

// 销售与流量的定时查询（P4-01）：查询计划（各粒度有无数据决定回补或重拉）、按数据集判断进行中任务、只在生产环境跑。

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

const none: SalesTrafficPresence = { date: { DAY: false, WEEK: false, MONTH: false }, asin: { PARENT: false, CHILD: false, SKU: false }, trends: false }
const all: SalesTrafficPresence = { date: { DAY: true, WEEK: true, MONTH: true }, asin: { PARENT: true, CHILD: true, SKU: true }, trends: true }

describe('查询计划', () => {
  it('第一次拉取：日 90 天、周 5 周、月 3 月；ASIN 三个粒度各回补 7 天；趋势 90 天', () => {
    const plans = planSalesTrafficQueries('2026-10-24', none)
    const date = plans.filter(plan => plan.dataset === 'dk.sales-traffic-by-date')
    expect(date.map(plan => plan.params)).toEqual([
      { granularity: 'DAY', startDate: '2026-07-26', endDate: '2026-10-23' },
      { granularity: 'WEEK', startDate: '2026-09-13', endDate: '2026-10-17' },
      { granularity: 'MONTH', startDate: '2026-07-01', endDate: '2026-09-30' },
    ])
    expect(plans.filter(plan => plan.dataset === 'dk.sales-traffic-by-asin')).toHaveLength(21)
    expect(plans.find(plan => plan.dataset === 'dk.sales-traffic-trends')?.params).toEqual({ startDate: '2026-07-26', endDate: '2026-10-23' })
  })

  it('已有数据：日重拉 7 天；ASIN 每个粒度只查最近 3 天；趋势 7 天', () => {
    const plans = planSalesTrafficQueries('2026-10-24', all)
    expect(plans.find(plan => plan.params.granularity === 'DAY')?.params).toEqual({ granularity: 'DAY', startDate: '2026-10-17', endDate: '2026-10-23' })
    const asin = plans.filter(plan => plan.dataset === 'dk.sales-traffic-by-asin')
    expect(asin).toHaveLength(9)
    expect(asin.filter(plan => plan.params.asinGranularity === 'CHILD').map(plan => plan.params.date)).toEqual(['2026-10-23', '2026-10-22', '2026-10-21'])
    expect(plans.find(plan => plan.dataset === 'dk.sales-traffic-trends')?.params).toEqual({ startDate: '2026-10-17', endDate: '2026-10-23' })
  })

  it('各粒度的有无数据互不影响；任务键各不相同', () => {
    const plans = planSalesTrafficQueries('2026-10-24', { ...all, date: { DAY: true, WEEK: false, MONTH: true } })
    expect(plans.find(plan => plan.params.granularity === 'WEEK')?.params.startDate).toBe('2026-09-13')
    const keys = plans.map(plan => `${plan.dataset}:${plan.key}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

function setup(running: Record<string, number> = {}) {
  const created: Array<{ dataset: string; params: Record<string, string>; sourceKey: string }> = []
  const prisma = {
    tenant: { findFirst: vi.fn(async () => ({ timezone: 'UTC' })) },
    salesTrafficDaily: { findFirst: vi.fn(async () => null) },
    salesTrafficAsinDaily: { findFirst: vi.fn(async () => null) },
    syncJob: {
      count: vi.fn(async ({ where }: { where: { context: { equals: string } } }) => running[where.context.equals] ?? 0),
      create: vi.fn(async ({ data }: { data: { sourceKey: string; context: { dataset: string; params: Record<string, string> } } }) => {
        created.push({ ...data.context, sourceKey: data.sourceKey })
        return { id: `sj-${created.length}` }
      }),
    },
  }
  const systemPrisma = { platformConnection: { findMany: vi.fn(async () => [{ id: 'c1', tenantId: 't1', sellerAccountId: 'sa1' }]) } }
  const queues = { addSync: vi.fn(async () => undefined) }
  process.env.APP_MODE = 'production'
  delete process.env.MOCK_CONNECTOR
  return { created, queues, prisma, deps: { prisma, systemPrisma, queues } as unknown as ScheduleDeps }
}

describe('定时排队', () => {
  it('每个店铺建全部任务并按任务编号入队：3 个店铺日期 + 21 个 ASIN + 1 个趋势；参数带店铺', async () => {
    const { deps, created, queues } = setup()
    await scheduleSalesTrafficQueries(deps, new Date('2026-10-24T12:00:00Z'))
    expect(created).toHaveLength(25)
    expect(created.every(item => item.params.sellerAccountId === 'sa1')).toBe(true)
    expect(new Set(created.map(item => item.sourceKey)).size).toBe(25)
    expect(queues.addSync).toHaveBeenCalledTimes(25)
    expect(queues.addSync).toHaveBeenCalledWith('DATA_KIOSK_QUERY', expect.objectContaining({ tenantId: 't1', syncJobId: 'sj-1' }), expect.objectContaining({ jobId: 'sj-1' }))
  })

  it('某个数据集还有进行中的任务：本轮这一整组跳过，其他数据集照常排', async () => {
    const { deps, created } = setup({ 'dk.sales-traffic-by-asin': 2 })
    await scheduleSalesTrafficQueries(deps, new Date('2026-10-24T12:00:00Z'))
    expect(new Set(created.map(item => item.dataset))).toEqual(new Set(['dk.sales-traffic-by-date', 'dk.sales-traffic-trends']))
  })

  it('非生产环境与模拟模式不建任务', async () => {
    const { deps, created } = setup()
    process.env.APP_MODE = 'development'
    await scheduleSalesTrafficQueries(deps)
    process.env.APP_MODE = 'production'
    process.env.MOCK_CONNECTOR = 'true'
    await scheduleSalesTrafficQueries(deps)
    expect(created).toEqual([])
  })
})
