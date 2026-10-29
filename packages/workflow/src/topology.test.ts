import { describe, expect, it } from 'vitest'
import { ALL_SYNC_QUEUES, backoffStrategy, jobOptions, MAX_ATTEMPTS, PRIORITY, RetryableError, syncDomainOf, syncQueueName, syncSourceKey } from './index'

describe('队列拓扑', () => {
  it('同步任务类型映射到数据域，未知类型进 general', () => {
    expect(syncDomainOf('FBA_ORDERS')).toBe('orders')
    expect(syncDomainOf('FBA_INVENTORY')).toBe('inventory')
    expect(syncDomainOf('FBA_REPLENISHMENT')).toBe('inventory')
    expect(syncDomainOf('FBA_FINANCE')).toBe('finance')
    expect(syncDomainOf('FBA_ADS')).toBe('ads')
    expect(syncDomainOf('ADS_REPORT_CREATE')).toBe('ads')
    expect(syncDomainOf('FBA_INBOUND_CREATE')).toBe('inbound')
    expect(syncDomainOf('FBA_INBOUND_SYNC')).toBe('inbound')
    expect(syncDomainOf('FBA_REPORT_POLL')).toBe('reports')
    expect(syncDomainOf('SOMETHING_ELSE')).toBe('general')
    expect(syncDomainOf(undefined)).toBe('general')
  })

  it('队列名合法（不含冒号）且互不重复', () => {
    expect(new Set(ALL_SYNC_QUEUES).size).toBe(ALL_SYNC_QUEUES.length)
    for (const name of ALL_SYNC_QUEUES) expect(name).toMatch(/^sync-[a-z]+$/)
    expect(syncQueueName('orders')).toBe('sync-orders')
  })

  it('入队参数带优先级、尝试次数与自定义退避', () => {
    expect(jobOptions({ jobId: 'j1', priority: PRIORITY.USER_TRIGGERED })).toMatchObject({ jobId: 'j1', priority: 1, attempts: MAX_ATTEMPTS, backoff: { type: 'custom' } })
    expect(jobOptions().priority).toBe(PRIORITY.SCHEDULED)
    expect('jobId' in jobOptions()).toBe(false)
    expect(jobOptions({ delayMs: 30_000 }).delay).toBe(30_000)
  })

  it('退避策略：指数增长，遵守 Retry-After', () => {
    const strategy = backoffStrategy({ baseMs: 1000, jitter: 0, maxMs: 60_000 })
    expect([1, 2, 3].map(attempt => strategy(attempt))).toEqual([1000, 2000, 4000])
    expect(strategy(1, 'custom', new RetryableError('HTTP_429', '限流', 9000))).toBe(9000)
  })

  it('任务去重键由店铺授权、类型与细分参数组成', () => {
    expect(syncSourceKey('c1', 'FBA_ORDERS')).toBe('c1:FBA_ORDERS')
    expect(syncSourceKey('c1', 'FBA_REPORT_CREATE', 'GET_X', undefined, 'ATVPDKIKX0DER')).toBe('c1:FBA_REPORT_CREATE:GET_X:ATVPDKIKX0DER')
  })
})
