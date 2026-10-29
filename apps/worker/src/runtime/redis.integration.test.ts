import { Queue, Worker, type Job } from 'bullmq'
import IORedis from 'ioredis'
import { DeadLetterService, DistributedLockManager, MemoryDeadLetterStore, MemoryLockStore, PRIORITY, RedisConcurrencyGate, RedisRateLimiter, backoffStrategy, jobOptions } from '@nova/workflow'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'
import { runGuarded } from './job-runner'
import type { Reliability } from './reliability'

// 真实 Redis 下的故障注入（P1-20）：限速桶与并发槽位的多进程共享、队列重试与退避、死信、停滞任务接管（崩溃恢复）、公平延后、优先级。
// 需要一个可用的 Redis：设置 TEST_REDIS_URL 才会运行（例如 docker run -p 26379:6379 redis:7-alpine，然后 TEST_REDIS_URL=redis://127.0.0.1:26379）。
// 没有设置时整组跳过，并在测试报告里显示为“跳过”，不会静默通过。
const url = process.env.TEST_REDIS_URL
const logger = { info: () => undefined, warn: () => undefined, error: () => undefined }
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const unique = () => Math.random().toString(36).slice(2, 10)

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, label = '条件') {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await check()) return
    await sleep(50)
  }
  throw new Error(`等待超时：${label}`)
}

describe.skipIf(!url)('真实 Redis：限速、并发槽位与队列故障注入', () => {
  let redis: IORedis
  const tag = unique()
  const closers: Array<() => Promise<unknown>> = []

  beforeAll(() => {
    redis = new IORedis(url!, { maxRetriesPerRequest: null })
    closers.push(() => redis.quit())
  })
  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => undefined)
  })

  describe('店铺级令牌桶（多个进程共享同一个桶）', () => {
    const defaults = { ratePerSecond: 2, burst: 2, minRatePerSecond: 0.1, maxRatePerSecond: 10 }

    it('两个进程共用同一个桶：突发量被共同消耗', async () => {
      let now = 1_000_000
      const a = new RedisRateLimiter(redis as never, { prefix: `rl-${tag}-a`, defaults, now: () => now })
      const b = new RedisRateLimiter(redis as never, { prefix: `rl-${tag}-a`, defaults, now: () => now })
      expect(await a.acquire('shop')).toBe(0)
      expect(await b.acquire('shop')).toBe(0)
      expect(await a.acquire('shop')).toBe(500)
      now += 500
      expect(await b.acquire('shop')).toBe(0)
    })

    it('按响应头调整速率；429 降速并冻结', async () => {
      let now = 2_000_000
      const limiter = new RedisRateLimiter(redis as never, { prefix: `rl-${tag}-b`, defaults, now: () => now })
      await limiter.acquire('shop')
      await limiter.report('shop', { status: 200, limitPerSecond: 0.5 })
      const [rate] = await redis.hmget(`rl-${tag}-b:shop`, 'rate')
      expect(Number(rate)).toBe(0.5)
      await limiter.report('shop', { status: 429, retryAfterMs: 4000 })
      expect(Number((await redis.hmget(`rl-${tag}-b:shop`, 'rate'))[0])).toBe(0.25)
      expect(await limiter.acquire('shop')).toBe(4000)
      now += 4000
      expect(await limiter.acquire('shop')).toBeGreaterThanOrEqual(0)
    })

    it('并发申请时令牌不会超发', async () => {
      const limiter = new RedisRateLimiter(redis as never, { prefix: `rl-${tag}-c`, defaults: { ...defaults, burst: 5, ratePerSecond: 0.1 }, now: () => 3_000_000 })
      const results = await Promise.all(Array.from({ length: 20 }, () => limiter.acquire('shop')))
      expect(results.filter(wait => wait === 0)).toHaveLength(5)
    })
  })

  describe('租户公平并发槽位', () => {
    it('槽位在多个进程之间共享；释放后可再占；租约到期自动回收（崩溃的进程不会永久占坑）', async () => {
      let now = 10_000
      const make = () => new RedisConcurrencyGate(redis as never, { limit: 2, leaseMs: 1000, prefix: `slots-${tag}`, now: () => now })
      const a = make()
      const b = make()
      const r1 = await a.tryAcquire('t1')
      const r2 = await b.tryAcquire('t1')
      expect(r1 && r2).toBeTruthy()
      expect(await a.tryAcquire('t1')).toBeNull()
      expect(await a.tryAcquire('t2')).not.toBeNull()
      await r1!()
      expect(await b.tryAcquire('t1')).not.toBeNull()
      // r2 对应的进程“崩溃”不释放：租约到期后槽位自动回收
      now += 1500
      expect(await a.tryAcquire('t1')).not.toBeNull()
    })
  })

  describe('队列：重试、退避、死信、崩溃接管、公平延后、优先级', () => {
    const fastBackoff = backoffStrategy({ baseMs: 50, jitter: 0, maxMs: 200 })

    function fakeReliability(options: { slots?: number } = {}) {
      const deadStore = new MemoryDeadLetterStore()
      const gate = new RedisConcurrencyGate(redis as never, { limit: options.slots ?? 5, prefix: `slots-${tag}-${unique()}` })
      const locks = new DistributedLockManager(new MemoryLockStore(), { renewEveryMs: 3_600_000 })
      const reliability = { ownerId: 'w', gate, locks, deadLetters: new DeadLetterService(deadStore, async () => undefined) } as unknown as Reliability
      return { reliability, deadStore, gate }
    }

    async function startQueue(processor: (job: Job, token?: string) => Promise<unknown>, workerOptions: Record<string, unknown> = {}) {
      const name = `t-${tag}-${unique()}`
      const queue = new Queue(name, { connection: redis })
      const worker = new Worker(name, processor, { connection: new IORedis(url!, { maxRetriesPerRequest: null }), settings: { backoffStrategy: fastBackoff }, concurrency: 1, ...workerOptions })
      closers.push(async () => {
        await worker.close(true)
        await queue.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      })
      return { name, queue, worker }
    }

    it('可重试错误：按退避重试后成功；尝试次数与等待符合预期', async () => {
      const { reliability, deadStore } = fakeReliability()
      const attempts: number[] = []
      const stamps: number[] = []
      const { queue } = await startQueue(job =>
        runGuarded(
          job,
          undefined,
          reliability,
          {
            queue: job.queueName,
            tenantId: 't1',
            syncJobId: 's1',
            onTerminal: async () => undefined,
            execute: async () => {
              attempts.push(job.attemptsMade)
              stamps.push(Date.now())
              if (attempts.length < 3) throw new UpstreamHttpError('SP_API_503', 503, undefined, 'api')
              return 'ok'
            },
          },
          logger,
        ),
      )
      const job = await queue.add('sync', { tenantId: 't1', syncJobId: 's1' }, jobOptions({ jobId: `j-${unique()}` }))
      await waitFor(async () => (await job.getState()) === 'completed', 15_000, '任务完成')
      expect(attempts).toEqual([0, 1, 2])
      expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(45) // 第一次退避 50 毫秒
      expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(95) // 第二次退避翻倍
      expect(deadStore.rows.size).toBe(0)
    })

    it('不可重试错误：只执行一次，直接失败并进死信', async () => {
      const { reliability, deadStore } = fakeReliability()
      let calls = 0
      const { queue } = await startQueue(job =>
        runGuarded(
          job,
          undefined,
          reliability,
          {
            queue: job.queueName,
            tenantId: 't1',
            syncJobId: 's2',
            onTerminal: async () => undefined,
            execute: async () => {
              calls++
              throw new UpstreamHttpError('SP_API_403', 403, undefined, 'api')
            },
          },
          logger,
        ),
      )
      const job = await queue.add('sync', { tenantId: 't1', syncJobId: 's2' }, jobOptions({ jobId: `j-${unique()}` }))
      await waitFor(async () => (await job.getState()) === 'failed', 15_000, '任务失败')
      expect(calls).toBe(1)
      expect([...deadStore.rows.values()][0]).toMatchObject({ errorCode: 'ROLE_MISSING', attempts: 1, syncJobId: 's2' })
    })

    it('重试用尽：执行 attempts 次后失败，进死信，失败码为 THROTTLE_EXHAUSTED', async () => {
      const { reliability, deadStore } = fakeReliability()
      let calls = 0
      const { queue } = await startQueue(job =>
        runGuarded(
          job,
          undefined,
          reliability,
          {
            queue: job.queueName,
            tenantId: 't1',
            syncJobId: 's3',
            onTerminal: async () => undefined,
            execute: async () => {
              calls++
              throw new UpstreamHttpError('SP_API_429', 429, undefined, 'api')
            },
          },
          logger,
        ),
      )
      const job = await queue.add('sync', { tenantId: 't1', syncJobId: 's3' }, jobOptions({ jobId: `j-${unique()}`, attempts: 3 }))
      await waitFor(async () => (await job.getState()) === 'failed', 20_000, '任务失败')
      expect(calls).toBe(3)
      expect([...deadStore.rows.values()]).toHaveLength(1)
      expect([...deadStore.rows.values()][0]).toMatchObject({ errorCode: 'THROTTLE_EXHAUSTED', attempts: 3 })
    })

    it('崩溃恢复：进程在任务执行中猝死，别的进程通过停滞检测接管并完成', async () => {
      const { reliability } = fakeReliability()
      const executions: string[] = []
      const name = `t-${tag}-${unique()}`
      const queue = new Queue(name, { connection: redis })
      const opts = { lockDuration: 1000, stalledInterval: 500, maxStalledCount: 2, concurrency: 1, settings: { backoffStrategy: fastBackoff } }
      const crashing = new Worker(
        name,
        async () => {
          executions.push('worker-1')
          await new Promise(() => undefined)
        },
        { connection: new IORedis(url!, { maxRetriesPerRequest: null }), ...opts },
      )
      closers.push(async () => {
        await crashing.close(true).catch(() => undefined)
        await queue.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      })
      const job = await queue.add('sync', { tenantId: 't1', syncJobId: 's4' }, jobOptions({ jobId: `j-${unique()}` }))
      await waitFor(() => executions.length === 1, 10_000, '第一个进程开始执行')
      await crashing.close(true) // 强制关闭：不等待任务、不释放锁，等同进程猝死
      const survivor = new Worker(
        name,
        job2 =>
          runGuarded(
            job2,
            undefined,
            reliability,
            {
              queue: name,
              tenantId: 't1',
              syncJobId: 's4',
              onTerminal: async () => undefined,
              execute: async () => {
                executions.push('worker-2')
                return 'done'
              },
            },
            logger,
          ),
        { connection: new IORedis(url!, { maxRetriesPerRequest: null }), ...opts },
      )
      closers.push(() => survivor.close(true))
      await waitFor(async () => (await job.getState()) === 'completed', 20_000, '接管后任务完成')
      expect(executions).toEqual(['worker-1', 'worker-2'])
    })

    it('租户并发已满：任务被延后，槽位释放后自动执行（不算失败、不消耗尝试次数）', async () => {
      const { reliability, gate } = fakeReliability({ slots: 1 })
      const hold = await gate.tryAcquire('t1')
      let executed = 0
      const { queue } = await startQueue(job =>
        runGuarded(
          job,
          undefined,
          reliability,
          {
            queue: job.queueName,
            tenantId: 't1',
            syncJobId: 's5',
            deferMs: 200,
            onTerminal: async () => undefined,
            execute: async () => {
              executed++
              return 'ok'
            },
          },
          logger,
        ),
      )
      const job = await queue.add('sync', { tenantId: 't1', syncJobId: 's5' }, jobOptions({ jobId: `j-${unique()}` }))
      await waitFor(async () => (await job.getState()) === 'delayed', 10_000, '任务被延后')
      expect(executed).toBe(0)
      await hold!()
      await waitFor(async () => (await job.getState()) === 'completed', 15_000, '释放后完成')
      expect(executed).toBe(1)
      expect((await queue.getJob(job.id!))!.attemptsMade).toBe(1)
    })

    it('优先级：用户触发先于定时先于历史回补', async () => {
      const order: string[] = []
      const name = `t-${tag}-${unique()}`
      const queue = new Queue(name, { connection: redis })
      await queue.pause()
      for (const [label, priority] of [
        ['回补', PRIORITY.BACKFILL],
        ['定时', PRIORITY.SCHEDULED],
        ['用户', PRIORITY.USER_TRIGGERED],
        ['推送', PRIORITY.PUSH_INCREMENT],
      ] as const) {
        await queue.add('sync', { label }, jobOptions({ jobId: `p-${label}-${unique()}`, priority }))
      }
      const worker = new Worker(
        name,
        async job => {
          order.push((job.data as { label: string }).label)
        },
        { connection: new IORedis(url!, { maxRetriesPerRequest: null }), concurrency: 1, settings: { backoffStrategy: fastBackoff } },
      )
      closers.push(async () => {
        await worker.close(true)
        await queue.obliterate({ force: true }).catch(() => undefined)
        await queue.close()
      })
      await queue.resume()
      await waitFor(() => order.length === 4, 10_000, '全部执行')
      expect(order).toEqual(['用户', '推送', '定时', '回补'])
    })
  })
})
