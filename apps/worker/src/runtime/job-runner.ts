import { DelayedError, UnrecoverableError, type Job } from 'bullmq'
import { MAX_ATTEMPTS, type LockLease } from '@nova/workflow'
import { describeFailure } from './failure'
import type { Reliability } from './reliability'

// 任务运行外壳（12.3）：任何队列任务都经过它——
//   租户公平并发（超限则延后，不占尝试次数）→ 分布式锁（抢不到则延后）→ 执行 → 失败分类：
//   可重试 → 抛给队列按退避重试；不可重试或重试用尽 → 标记失败、写入死信、停止重试。

export interface GuardedSpec {
  queue: string
  tenantId: string
  /** 互斥锁键（如同一店铺同一数据域）；不需要互斥的任务不传。 */
  lockKey?: string
  /** 写入死信的关联信息。 */
  syncJobId?: string
  /** 被公平调度或锁互斥延后时的等待时间。 */
  deferMs?: number
  execute(lease: LockLease | null): Promise<unknown>
  /** 将要重试：更新业务记录（例如任务状态回到等待并写明原因）。 */
  onRetry?(failure: { failureCode: string; attempt: number; maxAttempts: number }): Promise<void>
  /** 最终失败：更新业务记录为永久失败。 */
  onTerminal(failure: { failureCode: string; retryable: boolean; attempt: number }): Promise<void>
}

export interface RunnerLogger {
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

const jitter = (ms: number) => ms + Math.floor(Math.random() * ms * 0.5)

async function defer(job: Job, token: string | undefined, delayMs: number, reason: string, logger: RunnerLogger): Promise<never> {
  logger.info({ jobId: job.id, queue: job.queueName, reason, delayMs }, 'job deferred')
  await job.moveToDelayed(Date.now() + delayMs, token)
  throw new DelayedError()
}

export async function runGuarded(job: Job, token: string | undefined, reliability: Reliability, spec: GuardedSpec, logger: RunnerLogger): Promise<unknown> {
  const deferMs = jitter(spec.deferMs ?? 15_000)
  const releaseSlot = await reliability.gate.tryAcquire(spec.tenantId)
  if (!releaseSlot) return defer(job, token, deferMs, 'TENANT_CONCURRENCY_LIMIT', logger)

  let lease: LockLease | null = null
  try {
    if (spec.lockKey) {
      lease = await reliability.locks.tryAcquire(spec.tenantId, spec.lockKey, `${reliability.ownerId}:${job.id}`)
      if (!lease) return await defer(job, token, deferMs, 'LOCK_BUSY', logger)
    }
    return await spec.execute(lease)
  } catch (error) {
    if (error instanceof DelayedError || error instanceof UnrecoverableError) throw error
    const attempt = job.attemptsMade + 1
    const maxAttempts = job.opts.attempts ?? MAX_ATTEMPTS
    const exhausted = attempt >= maxAttempts
    const failure = describeFailure(error, exhausted)
    if (failure.retryable && !exhausted) {
      await spec.onRetry?.({ failureCode: failure.failureCode, attempt, maxAttempts })
      throw error
    }
    await spec.onTerminal({ failureCode: failure.failureCode, retryable: failure.retryable, attempt })
    await reliability.deadLetters
      .record({
        tenantId: spec.tenantId,
        queue: spec.queue,
        jobName: job.name,
        payload: stripTransient(job.data),
        errorCode: failure.failureCode,
        errorDetail: error instanceof Error ? error.message : String(error),
        attempts: attempt,
        syncJobId: spec.syncJobId,
      })
      .catch(recordError => logger.error({ jobId: job.id, error: recordError instanceof Error ? recordError.message : String(recordError) }, 'dead letter record failed'))
    throw new UnrecoverableError(failure.failureCode)
  } finally {
    await lease?.release().catch(() => undefined)
    await releaseSlot().catch(() => undefined)
  }
}

/** 重放时不需要旧的链路上下文；其余载荷原样保留。 */
function stripTransient(data: unknown) {
  if (!data || typeof data !== 'object') return data
  const { traceparent: _traceparent, ...rest } = data as Record<string, unknown>
  void _traceparent
  return rest
}
