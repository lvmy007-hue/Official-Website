import { describe, expect, it, vi } from 'vitest'
import {
  DeriveRangeError,
  DeriveRegistry,
  DeriveTaskNotFoundError,
  deriveJobId,
  enqueueDerivedFor,
  runDerive,
  validateDeriveRange,
  type DerivePayload,
  type DeriveQueue,
  type DeriveTask,
} from './derive'

const task = (name: string, sources: string[], refresh = vi.fn(async () => ({ rows: 3 }))): DeriveTask => ({ name, sources, refresh })

describe('日期范围校验', () => {
  it('接受合法的闭区间', () => {
    expect(validateDeriveRange({ dateFrom: '2026-02-01', dateTo: '2026-02-28' })).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' })
    expect(validateDeriveRange({ dateFrom: '2026-02-01', dateTo: '2026-02-01' })).toBeTruthy()
  })
  it('拒绝不存在的日期、颠倒的区间与过长的区间', () => {
    expect(() => validateDeriveRange({ dateFrom: '2026-02-30', dateTo: '2026-03-01' })).toThrow(DeriveRangeError)
    expect(() => validateDeriveRange({ dateFrom: '2026-3-1', dateTo: '2026-03-02' })).toThrow(DeriveRangeError)
    expect(() => validateDeriveRange({ dateFrom: '2026-03-02', dateTo: '2026-03-01' })).toThrow(DeriveRangeError)
    expect(() => validateDeriveRange({ dateFrom: '2023-01-01', dateTo: '2026-12-31' })).toThrow(DeriveRangeError)
  })
  it('恰好 1100 天可以，1101 天不可以', () => {
    expect(() => validateDeriveRange({ dateFrom: '2024-01-01', dateTo: '2027-01-04' })).not.toThrow()
    expect(() => validateDeriveRange({ dateFrom: '2024-01-01', dateTo: '2027-01-05' })).toThrow(DeriveRangeError)
  })
})

describe('任务注册', () => {
  it('名称必须规范、不能重复、必须声明来源', () => {
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders']))
    expect(() => registry.register(task('daily_sales', ['orders']))).toThrow()
    expect(() => registry.register(task('Bad-Name', ['orders']))).toThrow()
    expect(() => registry.register(task('no_source', []))).toThrow()
  })
  it('按来源查找依赖任务', () => {
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders', 'finance']))
    registry.register(task('daily_ads', ['ads']))
    expect(registry.forSource('orders').map(item => item.name)).toEqual(['daily_sales'])
    expect(registry.forSource('inventory')).toEqual([])
  })
})

describe('提交刷新任务', () => {
  const change = { tenantId: 't1', source: 'orders', dateFrom: '2026-03-01', dateTo: '2026-03-03', requestId: 'r1' }
  const makeQueue = () => {
    const added: Array<{ data: DerivePayload; jobId: string }> = []
    const queue: DeriveQueue = {
      async add(_name, data, options) {
        added.push({ data, jobId: options.jobId })
        return undefined
      },
    }
    return { queue, added }
  }

  it('没有依赖任务时什么都不做', async () => {
    const { queue, added } = makeQueue()
    expect(await enqueueDerivedFor(queue, new DeriveRegistry(), change)).toEqual([])
    expect(added).toHaveLength(0)
  })
  it('为每个依赖任务提交一条，任务编号由租户、任务、范围决定', async () => {
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders']))
    registry.register(task('daily_units', ['orders']))
    const { queue, added } = makeQueue()
    expect(await enqueueDerivedFor(queue, registry, change)).toEqual(['daily_sales', 'daily_units'])
    expect(added.map(item => item.jobId)).toEqual(['derive_t1_daily_sales_2026-03-01_2026-03-03', 'derive_t1_daily_units_2026-03-01_2026-03-03'])
    expect(added[0].data).toEqual({ tenantId: 't1', task: 'daily_sales', requestId: 'r1', dateFrom: '2026-03-01', dateTo: '2026-03-03' })
  })
  it('同一变更重复提交得到相同的任务编号（由队列合并）', () => {
    const payload = { tenantId: 't1', task: 'daily_sales', dateFrom: '2026-03-01', dateTo: '2026-03-03' }
    expect(deriveJobId(payload)).toBe(deriveJobId({ ...payload }))
    expect(deriveJobId(payload)).not.toContain(':')
    expect(deriveJobId(payload)).not.toBe(deriveJobId({ ...payload, tenantId: 't2' }))
  })
  it('范围不合法时不提交任何任务', async () => {
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders']))
    const { queue, added } = makeQueue()
    await expect(enqueueDerivedFor(queue, registry, { ...change, dateTo: '2026-02-01' })).rejects.toThrow(DeriveRangeError)
    expect(added).toHaveLength(0)
  })
})

describe('执行刷新任务', () => {
  const payload: DerivePayload = { tenantId: 't1', task: 'daily_sales', dateFrom: '2026-03-01', dateTo: '2026-03-03', requestId: 'r1' }
  it('把租户与日期范围交给任务，并记录结果日志', async () => {
    const refresh = vi.fn(async () => ({ rows: 9 }))
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders'], refresh))
    const info = vi.fn()
    expect(await runDerive(registry, payload, { info })).toEqual({ rows: 9 })
    expect(refresh).toHaveBeenCalledWith({ tenantId: 't1', dateFrom: '2026-03-01', dateTo: '2026-03-03' })
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'derive_refreshed', rows: 9 }), expect.any(String))
  })
  it('任务未注册时报错，范围不合法时不执行任务', async () => {
    const refresh = vi.fn(async () => ({ rows: 0 }))
    const registry = new DeriveRegistry()
    registry.register(task('daily_sales', ['orders'], refresh))
    await expect(runDerive(registry, { ...payload, task: 'missing' }, { info: vi.fn() })).rejects.toThrow(DeriveTaskNotFoundError)
    await expect(runDerive(registry, { ...payload, dateTo: '2025-01-01' }, { info: vi.fn() })).rejects.toThrow(DeriveRangeError)
    expect(refresh).not.toHaveBeenCalled()
  })
})
