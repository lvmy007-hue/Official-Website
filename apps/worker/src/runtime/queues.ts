import { Queue } from 'bullmq'
import { assertQueuePayload, jobOptions, syncDomainOf, syncQueueName } from '@nova/workflow'
import type { RedisConnections } from './redis'

/** 后台任务进程自己往队列里放任务（轮询、定时同步、恢复）用的队列集合：连接队列实例，按名称缓存。 */
export class QueueRegistry {
  private readonly queues = new Map<string, Queue>()
  constructor(private readonly redis: RedisConnections) {}

  get = (name: string): Queue => {
    const existing = this.queues.get(name)
    if (existing) return existing
    const queue = new Queue(name, { connection: this.redis.queue })
    this.queues.set(name, queue)
    return queue
  }

  /** 同步任务入队：按任务类型进入对应数据域队列。 */
  addSync(type: string, data: Record<string, unknown>, options: { jobId: string; priority: number; delayMs?: number }) {
    assertQueuePayload(data) // 队列消息只存编号与参数（12.5）
    return this.get(syncQueueName(syncDomainOf(type))).add('sync', data, jobOptions(options))
  }

  async close() {
    await Promise.all([...this.queues.values()].map(queue => queue.close()))
  }
}
