import { Injectable } from '@nestjs/common'
import { SOLICITATION_SEND_JOB } from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { Prisma, PlatformConnection, SyncJob } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'

// 请求评价后台任务的创建与入队（写法与上游仓储的任务服务一致，模块之间只能经 index 引用，所以这里留一份很小的实现）：
// 任务记录与请求记录在同一个事务里写入，入队在事务提交之后；入队失败时任务保持“等待”，由恢复扫描兜底重新入队。

@Injectable()
export class ReviewsJobService {
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

  /** 在调用方的事务里建任务；`id` 由调用方预先分配（批次编号与任务编号相同，任务上下文里才带得上批次编号）。 */
  createJob(tx: Prisma.TransactionClient, input: { id: string; tenantId: string; connectionId: string; requestId: string; context: Record<string, string> }): Promise<SyncJob> {
    return tx.syncJob.create({
      data: {
        id: input.id,
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        type: SOLICITATION_SEND_JOB,
        status: 'PENDING',
        requestId: input.requestId,
        context: input.context,
        ...syncJobMeta(input.connectionId, SOLICITATION_SEND_JOB, [input.id]),
      },
    })
  }

  /** 写入任务：先登记流程（审计据此指向真正执行的流程），再入队；后台任务用同一个去重键续上它。 */
  async dispatchSend(req: RequestWithContext, job: SyncJob, input: { tenantId: string; connectionId: string; solicitationBatchId: string }): Promise<void> {
    if (job.type !== SOLICITATION_SEND_JOB) throw new Error('dispatchSend 只用于请求评价任务')
    await this.workflow.registerWriteRun(req, {
      tenantId: input.tenantId,
      kind: WORKFLOW_KINDS.SOLICITATION_SEND,
      dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.SOLICITATION_SEND, input.solicitationBatchId, job.id),
      intent: { tenantId: input.tenantId, connectionId: input.connectionId, solicitationBatchId: input.solicitationBatchId } satisfies WriteRunIntent,
      syncJobId: job.id,
      priority: job.priority,
    })
    await this.queue.add('sync', { tenantId: input.tenantId, syncJobId: job.id, requestId: req.requestId, solicitationBatchId: input.solicitationBatchId }, job.id, {
      type: SOLICITATION_SEND_JOB,
      priority: job.priority,
    })
  }
}
