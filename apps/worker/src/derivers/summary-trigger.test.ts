import { describe, expect, it, vi } from 'vitest'
import { DERIVE_QUEUE_NAME, DeriveRegistry } from './derive'
import { SUMMARY_TASKS, createSummaryTasks, registerSummaryTasks, summaryTasksForSource } from './summary-tasks'
import { derivedSourceOfDomain, enqueueSummariesAfterSync, RECENT_DAYS, summaryRangeFor } from './trigger'

const NOW = new Date('2026-10-22T12:00:00Z')

describe('同步后触发日汇总（P2a-01）', () => {
  it('数据域对应的原始数据来源：订单、财务、广告有派生数据', () => {
    expect(derivedSourceOfDomain('orders')).toBe('orders')
    expect(derivedSourceOfDomain('finance')).toBe('finance')
    expect(derivedSourceOfDomain('ads')).toBe('ads')
    for (const domain of ['inventory', 'listings', '', null, undefined]) expect(derivedSourceOfDomain(domain)).toBeNull()
  })

  it('刷新范围：有时间窗用时间窗并两端各放宽一天；没有就取最近 16 天到明天', () => {
    expect(summaryRangeFor({ window: { after: '2026-03-10T00:00:00Z', before: '2026-03-20T00:00:00Z' } }, NOW)).toEqual({ dateFrom: '2026-03-09', dateTo: '2026-03-21' })
    const recent = { dateFrom: '2026-10-07', dateTo: '2026-10-23' }
    expect(RECENT_DAYS).toBe(16)
    for (const context of [null, undefined, {}, { window: {} }, { window: { after: 'x', before: 'y' } }, { window: { after: '2026-03-20T00:00:00Z', before: '2026-03-10T00:00:00Z' } }]) {
      expect(summaryRangeFor(context, NOW)).toEqual(recent)
    }
  })

  it('订单同步提交两个日汇总加利润日表，财务同步提交经营日汇总加利润日表，广告同步提交经营日汇总、广告日汇总与利润日表；任务编号按租户、任务、范围去重', async () => {
    const add = vi.fn().mockResolvedValue({})
    const queues = { get: vi.fn().mockReturnValue({ add }) }
    const orders = await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'orders', context: null, requestId: 'r1', now: NOW })
    expect(orders).toEqual(['store_daily_summary', 'asin_daily_summary', 'profit_daily'])
    expect(queues.get).toHaveBeenCalledWith(DERIVE_QUEUE_NAME)
    expect(add.mock.calls[0][1]).toMatchObject({ tenantId: 't1', task: 'store_daily_summary', dateFrom: '2026-10-07', dateTo: '2026-10-23', requestId: 'r1' })
    expect(add.mock.calls[0][2].jobId).toBe('derive_t1_store_daily_summary_2026-10-07_2026-10-23')

    add.mockClear()
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'finance', context: null, requestId: 'r2', now: NOW })).toEqual(['store_daily_summary', 'profit_daily'])
    expect(add).toHaveBeenCalledTimes(2)
    add.mockClear()
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'ads', context: null, requestId: 'r3', now: NOW })).toEqual(['store_daily_summary', 'ads_daily_summary', 'profit_daily'])
    expect(add.mock.calls[1][2].jobId).toBe('derive_t1_ads_daily_summary_2026-10-07_2026-10-23')
    expect(add.mock.calls[1][1]).toMatchObject({ tenantId: 't1', task: 'ads_daily_summary', dateFrom: '2026-10-07', dateTo: '2026-10-23', requestId: 'r3' })
  })

  it('没有汇总的数据域不提交；队列出错时吞掉错误，不影响同步结果', async () => {
    const add = vi.fn().mockRejectedValue(new Error('redis down'))
    const queues = { get: () => ({ add }) }
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'inventory', context: null, requestId: 'r', now: NOW })).toEqual([])
    expect(add).not.toHaveBeenCalled()
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'orders', context: null, requestId: 'r', now: NOW })).toEqual([])
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'ads', context: null, requestId: 'r', now: NOW })).toEqual([])
  })
})

describe('日汇总的派生任务登记（P2a-01）', () => {
  it('任务登记到注册表，来源决定触发', () => {
    const registry = new DeriveRegistry()
    registerSummaryTasks(registry, { $transaction: vi.fn(), tenant: {} } as never)
    expect(registry.list().map(task => task.name)).toEqual(SUMMARY_TASKS.map(task => task.name))
    expect(registry.forSource('orders').map(task => task.name)).toEqual(['store_daily_summary', 'asin_daily_summary'])
    expect(registry.forSource('finance').map(task => task.name)).toEqual(['store_daily_summary'])
    expect(registry.forSource('ads').map(task => task.name)).toEqual(['store_daily_summary', 'ads_daily_summary'])
    expect(summaryTasksForSource.forSource('finance').map(task => task.name)).toEqual(['store_daily_summary'])
    expect(summaryTasksForSource.forSource('ads').map(task => task.name)).toEqual(['store_daily_summary', 'ads_daily_summary'])
  })

  it('任务执行：把租户与日期范围交给刷新函数，返回写入行数', async () => {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(3) }
    const db = { tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'Asia/Shanghai' }) }, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) }
    const [store] = createSummaryTasks(db as never)
    expect(await store.refresh({ tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-02' })).toEqual({ rows: 3 })
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(2)
    expect(tx.$executeRawUnsafe.mock.calls[0].slice(1)).toEqual(['t1', '2026-10-01', '2026-10-02'])
    expect(tx.$executeRawUnsafe.mock.calls[1].slice(1, 5)).toEqual(['t1', '2026-10-01', '2026-10-02', 'Asia/Shanghai'])
  })

  it('广告日汇总任务：先删后写，写入口径只取活动级行，不读企业时区', async () => {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValueOnce(9).mockResolvedValueOnce(4) }
    const db = { tenant: { findFirst: vi.fn() }, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) }
    const ads = createSummaryTasks(db as never).find(task => task.name === 'ads_daily_summary')
    expect(ads?.sources).toEqual(['ads'])
    expect(await ads?.refresh({ tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-02' })).toEqual({ rows: 4 })
    expect(tx.$executeRawUnsafe.mock.calls[0][0]).toMatch(/^DELETE FROM "AdsDailySummary"/)
    expect(tx.$executeRawUnsafe.mock.calls[0].slice(1)).toEqual(['t1', '2026-10-01', '2026-10-02'])
    expect(tx.$executeRawUnsafe.mock.calls[1][0]).toContain(`"entityType" = 'CAMPAIGN'`)
    expect(tx.$executeRawUnsafe.mock.calls[1].slice(1)).toEqual(['t1', '2026-10-01', '2026-10-02', 'p3-04@1'])
    expect(db.tenant.findFirst).not.toHaveBeenCalled()
  })
})
