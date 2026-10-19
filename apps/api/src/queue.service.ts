import { Injectable, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { Queue } from 'bullmq'
import IORedis from 'ioredis'
@Injectable()
export class QueueService implements OnModuleDestroy { private readonly connection: IORedis; private readonly queues = new Map<string, Queue>(); constructor(config: ConfigService) { this.connection = new IORedis(config.get<string>('REDIS_URL') ?? 'redis://localhost:6379', { maxRetriesPerRequest: null }) } private queue(name: string) { const existing = this.queues.get(name); if (existing) return existing; const queue = new Queue(name, { connection: this.connection }); this.queues.set(name, queue); return queue } async add(name: 'sync'|'reports'|'exports'|'notifications', data: Record<string, unknown>, jobId?: string) { return this.queue(name).add(name, data, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: 1000, removeOnFail: 2000 }) } async ping() { return this.connection.ping() } async onModuleDestroy() { await Promise.all([...this.queues.values()].map(queue => queue.close())); await this.connection.quit() } }
