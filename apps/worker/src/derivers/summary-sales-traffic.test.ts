import { describe, expect, it, vi } from 'vitest'
import { DeriveRegistry } from './derive'
import { METRIC_VERSION } from './summary-sql'
import { createSummaryTasks, registerSummaryTasks } from './summary-tasks'
import { derivedSourceOf, enqueueSummariesAfterSync, summaryRangeFor } from './trigger'

// 官方销售与流量（P4-01）接入日汇总：数据中心查询（数据域 general）按数据集判断来源，刷新范围取查询参数里的日期，不放宽；
// 汇总 SQL 用官方数据覆盖订单估算（实际覆盖结果由真实数据库测试 sales-traffic.db.test.ts 验证）。

const NOW = new Date('2026-10-24T12:00:00Z')
const window = { dataset: 'dk.sales-traffic-by-date', params: { startDate: '2026-10-17', endDate: '2026-10-23', granularity: 'DAY', sellerAccountId: 'sa1' } }

describe('销售与流量触发日汇总', () => {
  it('销售与流量的三个数据集来源是 sales-traffic，不管数据域；其他数据中心数据集与没有数据集的任务回到按数据域判断', () => {
    for (const dataset of ['dk.sales-traffic-by-date', 'dk.sales-traffic-by-asin', 'dk.sales-traffic-trends']) expect(derivedSourceOf('general', { dataset })).toBe('sales-traffic')
    expect(derivedSourceOf('general', { dataset: 'dk.economics' })).toBeNull()
    expect(derivedSourceOf('orders', null)).toBe('orders')
    expect(derivedSourceOf('general', undefined)).toBeNull()
  })

  it('刷新范围：窗口查询取起止日，单日 ASIN 查询取那一天；参数不合法才回到最近 16 天', () => {
    expect(summaryRangeFor(window, NOW)).toEqual({ dateFrom: '2026-10-17', dateTo: '2026-10-23' })
    expect(summaryRangeFor({ dataset: 'dk.sales-traffic-by-asin', params: { date: '2026-10-21', asinGranularity: 'CHILD' } }, NOW)).toEqual({ dateFrom: '2026-10-21', dateTo: '2026-10-21' })
    expect(summaryRangeFor({ dataset: 'dk.sales-traffic-by-date', params: { startDate: 'bad', endDate: '2026-10-23' } }, NOW)).toEqual({ dateFrom: '2026-10-09', dateTo: '2026-10-25' })
    expect(summaryRangeFor({ dataset: 'dk.sales-traffic-by-date', params: { startDate: '2026-10-23', endDate: '2026-10-17' } }, NOW)).toEqual({ dateFrom: '2026-10-09', dateTo: '2026-10-25' })
    // 其他数据集的参数里有日期也不影响
    expect(summaryRangeFor({ dataset: 'dk.economics', params: { startDate: '2026-01-01', endDate: '2026-01-02' } }, NOW)).toEqual({ dateFrom: '2026-10-09', dateTo: '2026-10-25' })
  })

  it('销售与流量同步后只提交经营日汇总与 ASIN 日汇总（利润日表不读它）', async () => {
    const add = vi.fn().mockResolvedValue({})
    const queues = { get: vi.fn().mockReturnValue({ add }) }
    const tasks = await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'general', context: window, requestId: 'r1', now: NOW })
    expect(tasks).toEqual(['store_daily_summary', 'asin_daily_summary'])
    expect(add.mock.calls[0][1]).toMatchObject({ tenantId: 't1', task: 'store_daily_summary', dateFrom: '2026-10-17', dateTo: '2026-10-23' })
    expect(add.mock.calls[0][2].jobId).toBe('derive_t1_store_daily_summary_2026-10-17_2026-10-23')
    add.mockClear()
    expect(await enqueueSummariesAfterSync(queues, { tenantId: 't1', domain: 'general', context: { dataset: 'dk.economics' }, requestId: 'r2', now: NOW })).toEqual([])
    expect(add).not.toHaveBeenCalled()
  })

  it('派生任务登记：来源 sales-traffic 触发两张汇总表', () => {
    const registry = new DeriveRegistry()
    registerSummaryTasks(registry, { $transaction: vi.fn(), tenant: {} } as never)
    expect(registry.forSource('sales-traffic').map(task => task.name)).toEqual(['store_daily_summary', 'asin_daily_summary'])
  })
})

describe('汇总 SQL 的官方数据口径', () => {
  async function sqlOf(index: number) {
    const tx = { $executeRawUnsafe: vi.fn().mockResolvedValue(0) }
    const db = { tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'UTC' }) }, $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)) }
    await createSummaryTasks(db as never)[index].refresh({ tenantId: 't1', dateFrom: '2026-10-01', dateTo: '2026-10-02' })
    return { insert: String(tx.$executeRawUnsafe.mock.calls[1][0]), args: tx.$executeRawUnsafe.mock.calls[1].slice(1) as unknown[] }
  }

  it('口径版本升到 p4-01@1，作为最后一个参数写进汇总行', async () => {
    expect(METRIC_VERSION).toBe('p4-01@1')
    expect((await sqlOf(0)).args.at(-1)).toBe(METRIC_VERSION)
    expect((await sqlOf(1)).args.at(-1)).toBe(METRIC_VERSION)
  })

  it('经营日汇总：官方日粒度、美元、数据中心优先；销售额与件数覆盖订单估算，订单数仍取订单表，会话数只来自官方', async () => {
    const { insert } = await sqlOf(0)
    expect(insert).toContain('"SalesTrafficDaily"')
    expect(insert).toContain(`"granularity" = 'DAY'`)
    expect(insert).toContain(`"currency" = 'USD'`)
    expect(insert).toContain('(st."orderedSales" IS NULL), st."source"') // 有销售额的行优先，再数据中心优先
    expect(insert).toContain('COALESCE(w."units", a."units", 0), COALESCE(w."sales", a."sales", 0)')
    expect(insert).toContain('COALESCE(a."orders", 0)')
    expect(insert).toContain('w."sessions"')
    expect(insert).toContain(`CASE WHEN w."sales" IS NOT NULL THEN w."source" ELSE 'ORDERS' END`)
  })

  it('ASIN 日汇总：只取子体粒度、SKU 为空串的官方行；官方有而订单没有的 ASIN 也生成行', async () => {
    const { insert } = await sqlOf(1)
    expect(insert).toContain('"SalesTrafficAsinDaily"')
    expect(insert).toContain(`"asinGranularity" = 'CHILD' AND st."sku" = ''`)
    expect(insert).toContain('FULL OUTER JOIN')
    for (const column of ['"sessions"', '"pageViews"', '"buyBoxPct"']) expect(insert).toContain(column)
  })

  it('官方日期范围用参数传入，不拼进 SQL 文本', async () => {
    const { insert, args } = await sqlOf(0)
    expect(args.slice(0, 3)).toEqual(['t1', '2026-10-01', '2026-10-02'])
    expect(insert).not.toContain('2026-10-01')
  })
})
