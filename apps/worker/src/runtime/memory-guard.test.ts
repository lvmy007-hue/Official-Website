import { describe, expect, it, vi } from 'vitest'
import { MemoryGuard, budgetedConcurrency, memoryBudget, memoryGuardOptionsFromEnv, type MemorySample } from './memory-guard'

const MB = 1024 * 1024
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })
const sampleOf = (rssMb: number, heapMb = 100, limitMb = 1000): MemorySample => ({ rssBytes: rssMb * MB, heapUsedBytes: heapMb * MB, heapLimitBytes: limitMb * MB })

describe('内存守卫', () => {
  it('连续超限才触发，一次瞬时峰值不触发；回落后计数清零', () => {
    let current = sampleOf(100)
    const onExceeded = vi.fn()
    const guard = new MemoryGuard({ rssLimitMb: 500, consecutive: 3, sample: () => current, onExceeded, logger: logger() })
    current = sampleOf(900)
    guard.check()
    guard.check()
    current = sampleOf(100)
    guard.check()
    current = sampleOf(900)
    guard.check()
    guard.check()
    expect(onExceeded).not.toHaveBeenCalled()
    guard.check()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(onExceeded.mock.calls[0][0]).toMatchObject({ exceeded: true, reason: 'rss' })
  })

  it('触发后只回调一次，不会重复触发停机', () => {
    const onExceeded = vi.fn()
    const guard = new MemoryGuard({ rssLimitMb: 500, consecutive: 1, sample: () => sampleOf(900), onExceeded, logger: logger() })
    for (let index = 0; index < 5; index += 1) guard.check()
    expect(onExceeded).toHaveBeenCalledTimes(1)
    expect(guard.isTriggered).toBe(true)
  })

  it('堆占用比例超限同样触发，并说明原因', () => {
    const onExceeded = vi.fn()
    const guard = new MemoryGuard({ rssLimitMb: 5000, heapRatio: 0.8, consecutive: 1, sample: () => sampleOf(300, 900, 1000), onExceeded, logger: logger() })
    expect(guard.check()).toMatchObject({ exceeded: true, reason: 'heap' })
    expect(onExceeded.mock.calls[0][0].detail).toContain('堆占用')
  })

  it('周期性输出内存日志', () => {
    const log = logger()
    const guard = new MemoryGuard({ sample: () => sampleOf(100), onExceeded: vi.fn(), logger: log, reportEveryMs: 1000 })
    guard.check(1000)
    guard.check(1500)
    guard.check(2100)
    expect(log.info).toHaveBeenCalledTimes(2)
  })

  it('环境变量：上限与比例可配置，非法值回落默认', () => {
    expect(memoryGuardOptionsFromEnv({ WORKER_RSS_LIMIT_MB: '800', WORKER_HEAP_RATIO: '0.7' })).toEqual({ rssLimitMb: 800, heapRatio: 0.7 })
    expect(memoryGuardOptionsFromEnv({ WORKER_RSS_LIMIT_MB: 'abc', WORKER_HEAP_RATIO: '3' })).toEqual({ rssLimitMb: 1500, heapRatio: 0.85 })
  })
})

describe('并发按内存预算设定', () => {
  const requested = { orders: 2, inventory: 2, finance: 2, ads: 2, reports: 3 }

  it('预算充足时原样保留', () => {
    expect(budgetedConcurrency(requested, { WORKER_MEMORY_BUDGET_MB: '4096', JOB_MEMORY_MB: '64' })).toEqual(requested)
  })

  it('预算不足时按比例缩小，每个队列至少保留 1', () => {
    const scaled = budgetedConcurrency(requested, { WORKER_MEMORY_BUDGET_MB: '256', JOB_MEMORY_MB: '64' }) // 4 个并发槽位
    expect(Object.values(scaled).every(value => value >= 1)).toBe(true)
    expect(scaled.reports).toBeGreaterThanOrEqual(scaled.orders)
    expect(Object.values(scaled).reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(5)
  })

  it('默认预算取堆上限的 60%，单任务估算 64MB', () => {
    expect(memoryBudget({}, 2048 * MB)).toEqual({ budgetMb: 1228, perJobMb: 64 })
    expect(memoryBudget({ WORKER_MEMORY_BUDGET_MB: '300', JOB_MEMORY_MB: '30' }, 2048 * MB)).toEqual({ budgetMb: 300, perJobMb: 30 })
  })
})
