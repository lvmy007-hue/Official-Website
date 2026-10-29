import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import { DeadLetterService, DistributedLockManager, MemoryConcurrencyGate, MemoryDeadLetterStore, MemoryLockStore, NonRetryableError, RetryableError } from '@nova/workflow'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'
import { AuxHandlerRegistry, processAux } from './consumers'
import { describeFailure } from './failure'
import { runGuarded } from './job-runner'
import type { Reliability } from './reliability'

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function setup(options: { slots?: number } = {}) {
  const deadStore = new MemoryDeadLetterStore()
  const gate = new MemoryConcurrencyGate(options.slots ?? 2)
  const locks = new DistributedLockManager(new MemoryLockStore(), { renewEveryMs: 3_600_000 })
  const reliability = { ownerId: 'w1', gate, locks, deadLetters: new DeadLetterService(deadStore, async () => undefined) } as unknown as Reliability
  const job = (overrides: Partial<{ attemptsMade: number; attempts: number; data: Record<string, unknown>; name: string; queueName: string }> = {}) =>
    ({
      id: 'job-1',
      name: overrides.name ?? 'sync',
      queueName: overrides.queueName ?? 'sync-orders',
      data: overrides.data ?? { tenantId: 't1', syncJobId: 'sj1', traceparent: '00-abc' },
      attemptsMade: overrides.attemptsMade ?? 0,
      opts: { attempts: overrides.attempts ?? 5 },
      moveToDelayed: vi.fn(async () => undefined),
    }) as unknown as Job & { moveToDelayed: ReturnType<typeof vi.fn> }
  const spec = (execute: () => Promise<unknown>, extra: Record<string, unknown> = {}) => ({
    queue: 'sync-orders',
    tenantId: 't1',
    lockKey: 'sync:c1:orders',
    syncJobId: 'sj1',
    execute,
    onRetry: vi.fn(async () => undefined),
    onTerminal: vi.fn(async () => undefined),
    ...extra,
  })
  return { reliability, gate, locks, deadStore, job, spec }
}

describe('任务运行外壳：公平调度与互斥', () => {
  it('成功：返回结果并释放并发槽位与锁', async () => {
    const { reliability, gate, locks, job, spec } = setup()
    const j = job()
    expect(
      await runGuarded(
        j,
        'tok',
        reliability,
        spec(async () => 'ok'),
        logger,
      ),
    ).toBe('ok')
    expect(gate.active('t1')).toBe(0)
    expect(await locks.tryAcquire('t1', 'sync:c1:orders', 'other')).not.toBeNull() // 锁已释放
  })

  it('租户并发已满：任务延后（不执行、不算失败）', async () => {
    const { reliability, gate, job, spec } = setup({ slots: 1 })
    await gate.tryAcquire('t1')
    const j = job()
    const execute = vi.fn(async () => 'x')
    await expect(runGuarded(j, 'tok', reliability, spec(execute), logger)).rejects.toBeInstanceOf(DelayedError)
    expect(execute).not.toHaveBeenCalled()
    expect(j.moveToDelayed).toHaveBeenCalledTimes(1)
    expect(j.moveToDelayed.mock.calls[0][1]).toBe('tok')
  })

  it('同店铺同数据域的锁被占用：任务延后，且归还已占的并发槽位', async () => {
    const { reliability, gate, locks, job, spec } = setup()
    await locks.tryAcquire('t1', 'sync:c1:orders', 'someone-else')
    const j = job()
    const execute = vi.fn(async () => 'x')
    await expect(runGuarded(j, 'tok', reliability, spec(execute), logger)).rejects.toBeInstanceOf(DelayedError)
    expect(execute).not.toHaveBeenCalled()
    expect(gate.active('t1')).toBe(0)
  })
})

describe('任务运行外壳：失败分类', () => {
  it('可重试错误且还有机会：回写“将重试”，原样抛出让队列退避重试，不进死信', async () => {
    const { reliability, deadStore, job, spec } = setup()
    const s = spec(async () => {
      throw new UpstreamHttpError('SP_API_503', 503, undefined, 'api')
    })
    const error = await runGuarded(job({ attemptsMade: 1 }), 't', reliability, s, logger).catch(e => e)
    expect(error).toBeInstanceOf(UpstreamHttpError)
    expect(s.onRetry).toHaveBeenCalledWith({ failureCode: 'UPSTREAM_ERROR', attempt: 2, maxAttempts: 5 })
    expect(s.onTerminal).not.toHaveBeenCalled()
    expect(deadStore.rows.size).toBe(0)
  })

  it('重试用尽：限流转为 THROTTLE_EXHAUSTED，永久失败并写入死信（载荷去掉链路信息）', async () => {
    const { reliability, deadStore, gate, job, spec } = setup()
    const s = spec(async () => {
      throw new UpstreamHttpError('SP_API_429', 429, undefined, 'api')
    })
    const error = await runGuarded(job({ attemptsMade: 4 }), 't', reliability, s, logger).catch(e => e)
    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(error.message).toBe('THROTTLE_EXHAUSTED')
    expect(s.onTerminal).toHaveBeenCalledWith({ failureCode: 'THROTTLE_EXHAUSTED', retryable: true, attempt: 5 })
    const [entry] = [...deadStore.rows.values()]
    expect(entry).toMatchObject({ tenantId: 't1', queue: 'sync-orders', jobName: 'sync', errorCode: 'THROTTLE_EXHAUSTED', attempts: 5, syncJobId: 'sj1' })
    expect(JSON.parse(entry.payloadRef)).toEqual({ tenantId: 't1', syncJobId: 'sj1' })
    expect(gate.active('t1')).toBe(0)
  })

  it('授权失效（401）与缺少角色（403）不可重试：第一次就永久失败并进死信', async () => {
    for (const [status, code] of [
      [401, 'AUTH_EXPIRED'],
      [403, 'ROLE_MISSING'],
    ] as const) {
      const { reliability, deadStore, job, spec } = setup()
      const s = spec(async () => {
        throw new UpstreamHttpError(`SP_API_${status}`, status, undefined, 'api')
      })
      const error = await runGuarded(job(), 't', reliability, s, logger).catch(e => e)
      expect(error).toBeInstanceOf(UnrecoverableError)
      expect(s.onTerminal).toHaveBeenCalledWith({ failureCode: code, retryable: false, attempt: 1 })
      expect([...deadStore.rows.values()][0].errorCode).toBe(code)
    }
  })

  it('刷新令牌被授权服务拒绝：AUTH_EXPIRED；授权服务 5xx：可重试', () => {
    expect(describeFailure(new UpstreamHttpError('LWA_TOKEN_FAILED_400', 400, undefined, 'lwa'), false)).toMatchObject({ retryable: false, failureCode: 'AUTH_EXPIRED' })
    expect(describeFailure(new UpstreamHttpError('LWA_TOKEN_FAILED_503', 503, undefined, 'lwa'), false)).toMatchObject({ retryable: true, failureCode: 'UPSTREAM_ERROR' })
  })

  it('普通业务错误（程序/数据问题）不重试，失败码沿用错误信息', async () => {
    const { reliability, deadStore, job, spec } = setup()
    const s = spec(async () => {
      throw new Error('SELLER_ACCOUNT_NOT_BOUND')
    })
    await runGuarded(job(), 't', reliability, s, logger).catch(() => undefined)
    expect(s.onTerminal).toHaveBeenCalledWith({ failureCode: 'SELLER_ACCOUNT_NOT_BOUND', retryable: false, attempt: 1 })
    expect(deadStore.rows.size).toBe(1)
  })

  it('流程状态机抛出的带码错误按码处理；租约丢失可重试', () => {
    expect(describeFailure(new NonRetryableError('FBA_PLAN_NOT_FOUND', '计划不存在'), false)).toMatchObject({ retryable: false, failureCode: 'FBA_PLAN_NOT_FOUND' })
    expect(describeFailure(new RetryableError('LOCK_LOST', 'x'), false)).toMatchObject({ retryable: true, failureCode: 'LOCK_LOST' })
  })

  it('死信写入失败不会掩盖原始失败：仍抛出 UnrecoverableError 并释放资源', async () => {
    const { reliability, gate, job, spec } = setup()
    reliability.deadLetters.record = async () => {
      throw new Error('数据库不可用')
    }
    const error = await runGuarded(
      job(),
      't',
      reliability,
      spec(async () => {
        throw new Error('boom')
      }),
      logger,
    ).catch(e => e)
    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(gate.active('t1')).toBe(0)
  })

  it('任务内部主动不可恢复（如租户不一致）：原样抛出，不写死信', async () => {
    const { reliability, deadStore, job, spec } = setup()
    const error = await runGuarded(
      job(),
      't',
      reliability,
      spec(async () => {
        throw new UnrecoverableError('JOB_TENANT_MISMATCH')
      }),
      logger,
    ).catch(e => e)
    expect(error.message).toBe('JOB_TENANT_MISMATCH')
    expect(deadStore.rows.size).toBe(0)
  })
})

describe('报表 / 导出 / 通知队列消费者', () => {
  it('已注册处理器：执行并返回结果', async () => {
    const { reliability, job } = setup()
    const aux = new AuxHandlerRegistry()
    aux.register('exports', 'export', async (_job, ctx) => `done-${ctx.tenantId}`)
    expect(await processAux(job({ queueName: 'exports', name: 'export' }), 't', { reliability, logger, aux })).toBe('done-t1')
  })

  it('未注册处理器：如实失败并写入死信，不假装成功', async () => {
    const { reliability, deadStore, job } = setup()
    const error = await processAux(job({ queueName: 'notifications', name: 'push' }), 't', { reliability, logger, aux: new AuxHandlerRegistry() }).catch(e => e)
    expect(error).toBeInstanceOf(UnrecoverableError)
    expect(error.message).toBe('HANDLER_NOT_REGISTERED')
    expect([...deadStore.rows.values()][0]).toMatchObject({ queue: 'notifications', jobName: 'push', errorCode: 'HANDLER_NOT_REGISTERED' })
  })

  it('载荷缺少租户编号：直接永久失败', async () => {
    const { reliability, job } = setup()
    const error = await processAux(job({ queueName: 'reports', data: { foo: 1 } }), 't', { reliability, logger, aux: new AuxHandlerRegistry() }).catch(e => e)
    expect(error.message).toBe('JOB_TENANT_MISSING')
  })

  it('重复注册同一处理器会报错', () => {
    const aux = new AuxHandlerRegistry()
    aux.register('reports', 'r', async () => 1)
    expect(() => aux.register('reports', 'r', async () => 2)).toThrow('重复注册')
  })
})
