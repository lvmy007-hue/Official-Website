import { Worker, UnrecoverableError, type Job } from 'bullmq'
import { AUXILIARY_QUEUES, DOMAIN_CONCURRENCY, LEGACY_SYNC_QUEUE, NonRetryableError, SYNC_DOMAINS, backoffStrategy, syncQueueName, type AuxiliaryQueue } from '@nova/workflow'
import { runGuarded, type RunnerLogger } from './job-runner'
import type { Reliability } from './reliability'
import type { RedisConnections } from './redis'

// 队列消费者（12.3）：
// - 同步任务：每个数据域一个队列、一个消费者，并发各自限制；旧的 sync 队列继续消费升级前入队的消息；
// - 报表、导出、通知：各有独立队列与消费者。具体处理器由对应的工作包注册；
//   没有注册处理器就收到任务时，如实记为失败并写入死信（HANDLER_NOT_REGISTERED），绝不假装处理成功。

export type AuxHandler = (job: Job, context: { tenantId: string }) => Promise<unknown>

export class AuxHandlerRegistry {
  private readonly handlers = new Map<string, AuxHandler>()
  register(queue: AuxiliaryQueue, jobName: string, handler: AuxHandler) {
    const key = `${queue}:${jobName}`
    if (this.handlers.has(key)) throw new Error(`处理器重复注册：${key}`)
    this.handlers.set(key, handler)
  }
  find(queue: string, jobName: string) {
    return this.handlers.get(`${queue}:${jobName}`)
  }
}

export interface ConsumerDeps {
  redis: RedisConnections
  reliability: Reliability
  logger: RunnerLogger & { error(obj: object, msg?: string): void }
  /** 同步任务入口（已含租户归属校验、锁与失败处理）。 */
  processSync(job: Job, token: string | undefined): Promise<unknown>
  aux: AuxHandlerRegistry
  /** 各队列的并发（已按内存预算缩放，键为队列名）；缺省时用各队列的默认值。 */
  concurrency?: Record<string, number>
}

/** 各队列期望的并发（缩放前）：同步按数据域、旧同步队列 2、辅助队列各 2。 */
export function requestedConcurrency(): Record<string, number> {
  const requested: Record<string, number> = {}
  for (const domain of SYNC_DOMAINS) requested[syncQueueName(domain)] = DOMAIN_CONCURRENCY[domain]
  requested[LEGACY_SYNC_QUEUE] = 2
  for (const queue of AUXILIARY_QUEUES) requested[queue] = 2
  return requested
}

const workerSettings = { backoffStrategy: backoffStrategy(), stalledInterval: 30_000, maxStalledCount: 2 }

/** 辅助队列的任务：载荷必须带租户编号；经过与同步任务相同的运行外壳。 */
export async function processAux(job: Job, token: string | undefined, deps: Pick<ConsumerDeps, 'reliability' | 'logger' | 'aux'>): Promise<unknown> {
  const tenantId = (job.data as { tenantId?: unknown } | undefined)?.tenantId
  if (typeof tenantId !== 'string' || !tenantId) throw new UnrecoverableError('JOB_TENANT_MISSING')
  return runGuarded(
    job,
    token,
    deps.reliability,
    {
      queue: job.queueName,
      tenantId,
      execute: async () => {
        const handler = deps.aux.find(job.queueName, job.name)
        if (!handler) throw new NonRetryableError('HANDLER_NOT_REGISTERED', `队列 ${job.queueName} 的任务 ${job.name} 没有注册处理器`)
        return handler(job, { tenantId })
      },
      onTerminal: async () => undefined,
    },
    deps.logger,
  )
}

export function startConsumers(deps: ConsumerDeps): Worker[] {
  const workers: Worker[] = []
  const requested = requestedConcurrency()
  const concurrencyOf = (queue: string) => deps.concurrency?.[queue] ?? requested[queue] ?? 1
  const attach = (worker: Worker) => {
    worker.on('failed', (job, error) => deps.logger.error({ queue: worker.name, jobId: job?.id, error: error.message }, 'queue job failed'))
    worker.on('error', error => deps.logger.error({ queue: worker.name, error: error.message }, 'queue worker error'))
    workers.push(worker)
  }
  for (const domain of SYNC_DOMAINS) {
    attach(
      new Worker(syncQueueName(domain), (job, token) => deps.processSync(job, token), { connection: deps.redis.queue, concurrency: concurrencyOf(syncQueueName(domain)), settings: workerSettings }),
    )
  }
  attach(new Worker(LEGACY_SYNC_QUEUE, (job, token) => deps.processSync(job, token), { connection: deps.redis.queue, concurrency: concurrencyOf(LEGACY_SYNC_QUEUE), settings: workerSettings }))
  for (const queue of AUXILIARY_QUEUES) {
    attach(new Worker(queue, (job, token) => processAux(job, token, deps), { connection: deps.redis.queue, concurrency: concurrencyOf(queue), settings: workerSettings }))
  }
  return workers
}
