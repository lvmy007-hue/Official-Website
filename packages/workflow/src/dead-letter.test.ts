import { describe, expect, it } from 'vitest'
import { assertSafePayload, DeadLetterService, GracefulShutdown, MemoryDeadLetterStore, sanitizeErrorDetail } from './index'

const base = { tenantId: 't1', queue: 'sync', jobName: 'sync', payload: { tenantId: 't1', syncJobId: 'j1' }, errorCode: 'HTTP_400', errorDetail: '参数错误', attempts: 3 }

function setup(enqueue?: (target: any) => Promise<void>) {
  const store = new MemoryDeadLetterStore()
  const enqueued: any[] = []
  const service = new DeadLetterService(
    store,
    enqueue ??
      (async target => {
        enqueued.push(target)
      }),
    () => new Date('2026-10-21T00:00:00Z'),
  )
  return { store, service, enqueued }
}

describe('死信', () => {
  it('记录完整现场并可按租户列出', async () => {
    const { service, store } = setup()
    await service.record({ ...base, syncJobId: 'j1' })
    await service.record({ ...base, tenantId: 't2', payload: { tenantId: 't2' } })
    const list = await store.list('t1', {})
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ queue: 'sync', jobName: 'sync', errorCode: 'HTTP_400', attempts: 3, syncJobId: 'j1' })
    expect(JSON.parse(list[0].payloadRef)).toEqual({ tenantId: 't1', syncJobId: 'j1' })
  })

  it('载荷含令牌/个人信息字段时拒绝写入', async () => {
    const { service } = setup()
    await expect(service.record({ ...base, payload: { refreshToken: 'x' } })).rejects.toThrow('敏感')
    await expect(service.record({ ...base, payload: { a: { buyerEmail: 'a@b.c' } } })).rejects.toThrow('敏感')
    expect(() => assertSafePayload({ tenantId: 't', syncJobId: 'j' })).not.toThrow()
  })

  it('错误详情去敏并截断', () => {
    const detail = sanitizeErrorDetail('调用失败 Authorization: Bearer abc.def-123 且 Atzr|IwEBIAbCdEf0123456789 以及 ' + 'x'.repeat(5000))
    expect(detail).not.toContain('abc.def-123')
    expect(detail).not.toContain('IwEBIAbCdEf')
    expect(detail.length).toBeLessThanOrEqual(1500)
  })

  it('重放只会成功一次：入队使用固定的 jobId，二次与并发重放被拒绝', async () => {
    const { service, enqueued } = setup()
    const entry = await service.record(base)
    const results = await Promise.all([service.replay('t1', entry.id, 'u1'), service.replay('t1', entry.id, 'u2'), service.replay('t1', entry.id, 'u3')])
    expect(results.filter(Boolean)).toHaveLength(1)
    expect(enqueued).toHaveLength(1)
    expect(enqueued[0]).toMatchObject({ queue: 'sync', jobName: 'sync', jobId: `replay-${entry.id}`, payload: { tenantId: 't1', syncJobId: 'j1' } })
    expect(results.find(Boolean)).toMatchObject({ replayedBy: expect.any(String) })
  })

  it('不能重放别的租户的死信', async () => {
    const { service, enqueued } = setup()
    const entry = await service.record(base)
    expect(await service.replay('t2', entry.id, 'u1')).toBeNull()
    expect(enqueued).toHaveLength(0)
  })

  it('入队失败：回退标记，之后仍可重放', async () => {
    let fail = true
    const enqueued: any[] = []
    const { service, store } = setup(async target => {
      if (fail) throw new Error('队列不可用')
      enqueued.push(target)
    })
    const entry = await service.record(base)
    await expect(service.replay('t1', entry.id, 'u1')).rejects.toThrow('队列不可用')
    expect((await store.get('t1', entry.id))!.replayedAt).toBeNull()
    fail = false
    expect(await service.replay('t1', entry.id, 'u1')).not.toBeNull()
    expect(enqueued).toHaveLength(1)
  })
})

describe('优雅停机', () => {
  it('按注册的相反顺序执行，重复触发只执行一次，单步失败不影响其余步骤', async () => {
    const order: string[] = []
    const shutdown = new GracefulShutdown({ timeoutMs: 1000 })
    shutdown.register('关闭数据库', async () => {
      order.push('db')
    })
    shutdown.register('停止消费者', async () => {
      order.push('worker')
      throw new Error('出错')
    })
    shutdown.register('停止定时器', async () => {
      order.push('timer')
    })
    const [first, second] = await Promise.all([shutdown.run(), shutdown.run()])
    expect(order).toEqual(['timer', 'worker', 'db'])
    expect(first).toBe(true)
    expect(second).toBe(true)
  })

  it('超时则放弃等待并返回 false', async () => {
    const errors: string[] = []
    const shutdown = new GracefulShutdown({ timeoutMs: 30, logger: { info: () => undefined, error: message => errors.push(message) } })
    shutdown.register('卡住的任务', () => new Promise<void>(() => undefined))
    expect(await shutdown.run()).toBe(false)
    expect(errors.some(message => message.includes('强制退出'))).toBe(true)
  })
})
