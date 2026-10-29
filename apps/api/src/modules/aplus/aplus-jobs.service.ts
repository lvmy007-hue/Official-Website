import { Injectable } from '@nestjs/common'
import { APLUS_WRITE_JOB } from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import type { PlatformConnection, Prisma, SyncJob } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'

// A+ 内容写入后台任务的创建与入队（P4-14，写法同刊登写入）：写入记录、任务与审计在同一个事务里，入队在事务提交之后。
// 入队失败时这条写入记录标为失败（原因 QUEUE_UNAVAILABLE），用户可以重新提交，不留“排队中”的假象。

@Injectable()
export class AplusJobService {
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

  /** 在调用方的事务里建任务；任务编号由调用方预先分配（写入记录建的时候就要带上它）。去重来源键含写入记录编号，每条写入一个任务。 */
  createJob(tx: Prisma.TransactionClient, input: { id: string; tenantId: string; connectionId: string; requestId: string; runId: string; storeId: string }): Promise<SyncJob> {
    return tx.syncJob.create({
      data: {
        id: input.id,
        tenantId: input.tenantId,
        connectionId: input.connectionId,
        type: APLUS_WRITE_JOB,
        status: 'PENDING',
        requestId: input.requestId,
        context: { aplusRunId: input.runId, storeId: input.storeId },
        ...syncJobMeta(input.connectionId, APLUS_WRITE_JOB, [input.runId]),
      },
    })
  }

  /** 事务提交之后：登记流程并入队；失败时把写入记录与任务标为失败，返回 false。 */
  async dispatch(req: RequestWithContext, job: SyncJob, input: { tenantId: string; connectionId: string; runId: string }): Promise<boolean> {
    try {
      await this.workflow.registerWriteRun(req, {
        tenantId: input.tenantId,
        kind: WORKFLOW_KINDS.APLUS_WRITE,
        dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.APLUS_WRITE, input.runId, job.id),
        intent: { tenantId: input.tenantId, connectionId: input.connectionId, aplusRunId: input.runId } satisfies WriteRunIntent,
        syncJobId: job.id,
        priority: job.priority,
      })
      await this.queue.add('sync', { tenantId: input.tenantId, syncJobId: job.id, requestId: req.requestId, aplusRunId: input.runId }, job.id, { type: APLUS_WRITE_JOB, priority: job.priority })
      return true
    } catch {
      const now = new Date()
      await this.prisma.aplusWriteRun.updateMany({ where: { id: input.runId, tenantId: input.tenantId }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      await this.prisma.syncJob.updateMany({ where: { id: job.id, tenantId: input.tenantId }, data: { status: 'FAILED_PERMANENT', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: now } })
      return false
    }
  }
}
