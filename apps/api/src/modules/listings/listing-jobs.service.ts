import { Injectable } from '@nestjs/common'
import { LISTING_WRITE_JOB } from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { PlatformConnection, Prisma, SyncJob } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'

// 刊登写入与查询后台任务的创建与入队（P4-10）。记录与任务在同一个事务里写入，入队在事务提交之后；
// 修改刊登与批量任务（真正改亚马逊的数据）先登记流程再入队，校验预览与刊登限制查询（只读）直接入队。
// 入队失败时这条记录标为失败（原因 QUEUE_UNAVAILABLE），用户可以重新提交，不留“排队中”的假象。

@Injectable()
export class ListingJobService {
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

  createJob(tx: Prisma.TransactionClient, input: { tenantId: string; connectionId: string; requestId: string; runId: string }): Promise<SyncJob> {
    return tx.syncJob.create({
      data: {
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        type: LISTING_WRITE_JOB,
        status: 'PENDING',
        requestId: input.requestId,
        context: { listingRunId: input.runId },
        ...syncJobMeta(input.connectionId, LISTING_WRITE_JOB, [input.runId]),
      },
    })
  }

  /** 事务提交之后：登记流程（只对会改亚马逊数据的两种）并入队；失败时把记录与任务标为失败。 */
  async dispatch(req: RequestWithContext, job: SyncJob, input: { tenantId: string; connectionId: string; runId: string; writesAmazon: boolean }): Promise<boolean> {
    try {
      if (input.writesAmazon) {
        await this.workflow.registerWriteRun(req, {
          tenantId: input.tenantId,
          kind: WORKFLOW_KINDS.LISTING_WRITE,
          dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.LISTING_WRITE, input.runId, job.id),
          intent: { tenantId: input.tenantId, connectionId: input.connectionId, listingRunId: input.runId } satisfies WriteRunIntent,
          syncJobId: job.id,
          priority: job.priority,
        })
      }
      await this.queue.add('sync', { tenantId: input.tenantId, syncJobId: job.id, requestId: req.requestId, listingRunId: input.runId }, job.id, { type: LISTING_WRITE_JOB, priority: job.priority })
      return true
    } catch {
      const now = new Date()
      await this.prisma.listingWriteRun.updateMany({ where: { id: input.runId, tenantId: input.tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      await this.prisma.syncJob.updateMany({ where: { id: job.id, tenantId: input.tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      return false
    }
  }
}
