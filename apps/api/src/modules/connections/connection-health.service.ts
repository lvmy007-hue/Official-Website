import { Injectable } from '@nestjs/common'
import { CONNECTION_HEALTH_JOB, type ConnectionHealthRequested } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'

// 健康检查入队：接口服务不能解密亚马逊令牌，所以检查只能是后台任务（apps/worker 的 connectors/connection-health.ts）。
// 同一连接已经有排队或运行中的检查时不再排第二个，直接返回它（连点“健康检查”不会堆积）。授权完成后也用它补一次检查。
@Injectable()
export class ConnectionHealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
  ) {}

  async request(tenantId: string, connectionId: string, requestId: string): Promise<ConnectionHealthRequested> {
    const meta = syncJobMeta(connectionId, CONNECTION_HEALTH_JOB)
    const active = await this.prisma.syncJob.findFirst({ where: { tenantId, sourceKey: meta.sourceKey, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { createdAt: 'desc' }, select: { id: true } })
    if (active) return { connectionId, syncJobId: active.id, alreadyRunning: true }
    const job = await this.prisma.syncJob.create({ data: { tenantId, connectionId, type: CONNECTION_HEALTH_JOB, status: 'PENDING', requestId, ...meta }, select: { id: true } })
    try {
      await this.queue.add('sync', { tenantId, syncJobId: job.id, requestId }, job.id, { type: CONNECTION_HEALTH_JOB, priority: meta.priority })
    } catch (error) {
      // 入队失败：不能留一条永远“排队中”的记录挡住以后的检查
      await this.prisma.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: new Date() } }).catch(() => undefined)
      throw error
    }
    return { connectionId, syncJobId: job.id, alreadyRunning: false }
  }
}
