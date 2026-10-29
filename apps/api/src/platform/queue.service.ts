import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { AUXILIARY_QUEUES, assertQueuePayload, jobOptions, PRIORITY, redisClientOptions, redisUrls, syncDomainOf, syncQueueName } from '@nova/workflow'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
import { currentTraceparent } from './observability/tracing'

export type QueueName = 'sync' | 'reports' | 'exports' | 'notifications' | 'lifecycle'

export interface AddOptions {
  /** 同步任务类型（SyncJob.type）：决定进入哪个数据域队列。name 为 sync 时必须提供。 */
  type?: string
  /** 优先级 1..4（见 PRIORITY）：用户触发 > 推送增量 > 定时 > 历史回补；缺省按用户触发处理（接口发起的任务都是人点出来的）。 */
  priority?: number
  delayMs?: number
}

/** 队列实例：队列用单独的 Redis（QUEUE_REDIS_URL，不淘汰、开持久化）；没配置时退回 REDIS_URL（仅开发与测试）。 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly connection: IORedis
  private readonly queues = new Map<string, Queue>()

  constructor(config: ConfigService) {
    const url = redisUrls({ REDIS_URL: config.get<string>('REDIS_URL'), QUEUE_REDIS_URL: config.get<string>('QUEUE_REDIS_URL') }).queue
    this.connection = new IORedis(url, redisClientOptions(url, process.env))
  }

  private queue(name: string) {
    const existing = this.queues.get(name)
    if (existing) return existing
    const queue = new Queue(name, { connection: this.connection })
    this.queues.set(name, queue)
    return queue
  }

  /** 实际入队的队列名：同步任务按数据域拆分，其余沿用原名。 */
  queueNameFor(name: QueueName, options: AddOptions = {}) {
    return name === 'sync' ? syncQueueName(syncDomainOf(options.type)) : name
  }

  async add(name: QueueName, data: Record<string, unknown>, jobId?: string, options: AddOptions = {}) {
    // 把当前请求的链路上下文带给后台任务，使“接口 → 队列 → 任务”在同一条链路上（没有链路时不添加）。
    const traceparent = currentTraceparent()
    assertQueuePayload(data) // 队列消息只存编号与参数（12.5）
    return this.queue(this.queueNameFor(name, options)).add(
      name,
      traceparent ? { ...data, traceparent } : data,
      jobOptions({ jobId, priority: options.priority ?? PRIORITY.USER_TRIGGERED, delayMs: options.delayMs }),
    )
  }

  /** 死信重放：按原队列名与任务名原样入队（只允许报表、导出、通知这类辅助队列；同步任务走重试流程）。 */
  async addRaw(queueName: string, jobName: string, data: Record<string, unknown>, jobId: string, priority: number = PRIORITY.USER_TRIGGERED) {
    if (!(AUXILIARY_QUEUES as readonly string[]).includes(queueName)) throw new Error(`不支持直接重放到队列 ${queueName}`)
    assertQueuePayload(data)
    return this.queue(queueName).add(jobName, data, jobOptions({ jobId, priority }))
  }

  /** 各队列里等待（含按优先级排的）、执行、延后、失败的任务数：整个平台的合计，队列本身不区分企业（同步中心的队列监控用）。 */
  async counts(names: readonly string[]): Promise<Record<string, { waiting: number; active: number; delayed: number; failed: number }>> {
    const entries = await Promise.all(
      names.map(async name => {
        const raw = await this.queue(name).getJobCounts('waiting', 'prioritized', 'active', 'delayed', 'failed')
        return [name, { waiting: (raw.waiting ?? 0) + (raw.prioritized ?? 0), active: raw.active ?? 0, delayed: raw.delayed ?? 0, failed: raw.failed ?? 0 }] as const
      }),
    )
    return Object.fromEntries(entries)
  }

  async ping() {
    return this.connection.ping()
  }

  async onModuleDestroy() {
    await Promise.all([...this.queues.values()].map(queue => queue.close()))
    await this.connection.quit()
  }
}
