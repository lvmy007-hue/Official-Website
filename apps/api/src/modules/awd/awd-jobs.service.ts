import { Injectable } from '@nestjs/common'
import { AWD_LABELS_JOB, AWD_WRITE_JOB, type AwdPendingAction } from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { Prisma, PlatformConnection, SyncJob } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'

// 上游仓储后台任务的创建与入队：写入（创建、更新、确认、取消、运输信息）走流程状态机，取标签只是读取。
// 任务记录与订单状态在同一个事务里写入，入队在事务提交之后；入队失败时任务保持“等待”，由恢复扫描兜底重新入队。

@Injectable()
export class AwdJobService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly workflow: WorkflowService,
  ) {}

  /** 店铺对应的已授权卖家连接（调用亚马逊用）。 */
  async connectionOf(tenantId: string, sellerAccountId: string): Promise<PlatformConnection> {
    const connection = await this.prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_SP_API', sellerAccountId, state: 'AUTHORIZED', encryptedRefreshToken: { not: null } } })
    if (!connection) throw appError('CONNECTION_UNAVAILABLE', '这个店铺尚未完成卖家授权，或授权已失效', { details: { step: 'CONNECTION', remedyPath: '/app/connections' } })
    return connection
  }

  createJob(tx: Prisma.TransactionClient, input: { tenantId: string; connectionId: string; type: string; requestId: string; objectId: string; context: Record<string, string> }): Promise<SyncJob> {
    return tx.syncJob.create({
      data: {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        type: input.type,
        status: 'PENDING',
        requestId: input.requestId,
        context: input.context,
        ...syncJobMeta(input.connectionId, input.type, [input.objectId]),
      },
    })
  }

  /** 写入任务：先登记流程（审计据此指向真正执行的流程），再入队；后台任务用同一个去重键续上它。 */
  async dispatchWrite(req: RequestWithContext, job: SyncJob, input: { tenantId: string; connectionId: string; awdOrderId: string; awdAction: AwdPendingAction }): Promise<void> {
    if (job.type !== AWD_WRITE_JOB) throw new Error('dispatchWrite 只用于写入任务')
    await this.workflow.registerWriteRun(req, {
      tenantId: input.tenantId,
      kind: WORKFLOW_KINDS.AWD_ORDER_WRITE,
      dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.AWD_ORDER_WRITE, input.awdOrderId, job.id),
      intent: { tenantId: input.tenantId, connectionId: input.connectionId, awdOrderId: input.awdOrderId, awdAction: input.awdAction } satisfies WriteRunIntent,
      syncJobId: job.id,
      priority: job.priority,
    })
    await this.queue.add('sync', { tenantId: input.tenantId, syncJobId: job.id, requestId: req.requestId, awdOrderId: input.awdOrderId, awdAction: input.awdAction }, job.id, {
      type: AWD_WRITE_JOB,
      priority: job.priority,
    })
  }

  async dispatchLabels(req: RequestWithContext, job: SyncJob, input: { tenantId: string; awdShipmentId: string }): Promise<void> {
    if (job.type !== AWD_LABELS_JOB) throw new Error('dispatchLabels 只用于取标签任务')
    await this.queue.add('sync', { tenantId: input.tenantId, syncJobId: job.id, requestId: req.requestId, awdShipmentId: input.awdShipmentId }, job.id, {
      type: AWD_LABELS_JOB,
      priority: job.priority,
    })
  }
}
