import { Injectable } from '@nestjs/common'
import { INBOUND_OP_JOB, INBOUND_SWITCH_OF_OP, inboundPlanActions, isInboundStage, type InboundAction, type InboundActionResponse, type InboundOp } from '@nova/api-contracts'
import { WORKFLOW_KINDS, writeRunDedupeKey, type WriteRunIntent } from '@nova/workflow'
import { Prisma, type FbaInboundPlan, type InboundOperation, type PlatformConnection, type SyncJob } from '@prisma/client'
import { appError, RequestWithContext, type ApiContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { QueueService } from '../../platform/queue.service'
import { syncJobMeta } from '../../platform/sync-job-meta'
import { WorkflowService } from '../../platform/workflow'
import { ActionGuardService, AuditWriter, updateWithVersion } from '../../platform/write'
import { INBOUND_WRITE, singlePlanRow } from './inbound-common'

/** 不走流程状态机的操作：只读调用（资格预检、取标签），直接由后台任务执行。 */
const DIRECT_OPS: readonly InboundOp[] = ['ELIGIBILITY', 'LABELS']

export interface EnqueueInput {
  action: InboundAction
  operation: InboundOp
  params?: Record<string, unknown>
  version: number | null
  audit: { action: string; reason?: string }
  /** 创建操作记录之外要在同一个事务里写的内容（如标签打印任务）。 */
  inTransaction?: (tx: Prisma.TransactionClient, plan: FbaInboundPlan, op: InboundOperation) => Promise<void>
}

// 入仓计划后台操作的创建与入队：先过动作守卫（权限 → 连接 → 写入开关，服务端执行前再判断一次），
// 通过后在一个事务里把计划标为“处理中”、写操作记录与任务记录与审计，入队在事务提交之后；入队失败时任务保持“等待”，由恢复扫描兜底。
@Injectable()
export class InboundJobsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly workflow: WorkflowService,
    private readonly guard: ActionGuardService,
    private readonly audit: AuditWriter,
  ) {}

  /** 店铺对应的已授权卖家连接（调用亚马逊用）。 */
  async connectionOf(tenantId: string, sellerAccountId: string): Promise<PlatformConnection> {
    const connection = await this.prisma.platformConnection.findFirst({ where: { tenantId, provider: 'AMAZON_SP_API', sellerAccountId, state: 'AUTHORIZED', encryptedRefreshToken: { not: null } } })
    if (!connection) throw appError('CONNECTION_UNAVAILABLE', '这个店铺尚未完成卖家授权，或授权已失效', { details: { step: 'CONNECTION', remedyPath: '/app/connections' } })
    return connection
  }

  async enqueue(req: RequestWithContext, context: ApiContext, plan: FbaInboundPlan, input: EnqueueInput): Promise<InboundActionResponse> {
    const stage = isInboundStage(plan.stage) ? plan.stage : 'DRAFT'
    const state = inboundPlanActions({ stage, pendingOp: plan.pendingOp, voidDeadlineAt: plan.voidDeadlineAt })[input.action]
    if (!state.allowed) throw appError('CONFLICT', state.reason ?? '当前状态不允许这个操作', { details: { stage, pendingOp: plan.pendingOp } })
    const switchKey = INBOUND_SWITCH_OF_OP[input.operation]
    await this.guard.assert(context, { permission: INBOUND_WRITE, connection: { provider: 'AMAZON_SP_API', sellerAccountId: plan.sellerAccountId }, ...(switchKey ? { switchKey } : {}) })
    const connection = await this.connectionOf(context.tenantId, plan.sellerAccountId)
    const { updated, op, job } = await this.prisma.$transaction(async tx => {
      const claim = { pendingOp: input.operation, lastErrorCode: null, lastErrorMessage: null }
      let next: FbaInboundPlan
      if (input.version === null) {
        // 取标签不要求版本号（只读调用）：只要没有别的操作在处理就占住“处理中”
        const claimed = await tx.fbaInboundPlan.updateMany({ where: { id: plan.id, tenantId: plan.tenantId, pendingOp: null }, data: { ...claim, version: { increment: 1 } } })
        if (claimed.count === 0) throw appError('CONFLICT', '这个计划有操作正在处理中，请等处理完成后再试')
        next = (await tx.fbaInboundPlan.findFirst({ where: { id: plan.id, tenantId: plan.tenantId } })) as FbaInboundPlan
      } else {
        next = await updateWithVersion(tx.fbaInboundPlan, { id: plan.id, tenantId: plan.tenantId }, input.version, claim, { label: '入仓计划' })
      }
      const created = await tx.inboundOperation.create({
        data: {
          tenantId: plan.tenantId,
          planId: plan.id,
          sellerAccountId: plan.sellerAccountId,
          operation: input.operation,
          status: 'QUEUED',
          paramsJson: (input.params ?? {}) as Prisma.InputJsonValue,
          requestedBy: context.userId,
        },
      })
      const queued: SyncJob = await tx.syncJob.create({
        data: {
          tenantId: plan.tenantId,
          connectionId: connection.id,
          type: INBOUND_OP_JOB,
          status: 'PENDING',
          requestId: req.requestId,
          context: { inboundOpId: created.id },
          ...syncJobMeta(connection.id, INBOUND_OP_JOB, [created.id]),
        },
      })
      const linked: InboundOperation = await tx.inboundOperation.update({ where: { id: created.id }, data: { syncJobId: queued.id } })
      if (input.inTransaction) await input.inTransaction(tx, next, linked)
      await this.audit.record(
        req,
        {
          action: input.audit.action,
          resourceType: 'FbaInboundPlan',
          resourceId: plan.id,
          before: { stage: plan.stage, pendingOp: plan.pendingOp },
          after: { stage: next.stage, pendingOp: next.pendingOp },
          detail: { operation: input.operation, inboundOperationId: linked.id },
          ...(input.audit.reason ? { reason: input.audit.reason } : {}),
        },
        { client: tx },
      )
      return { updated: next, op: linked, job: queued }
    })
    await this.dispatch(req, op, job, connection.id)
    return { plan: await singlePlanRow(this.prisma, updated), state: 'QUEUED', jobId: job.id, operationId: op.id }
  }

  /** 先登记流程（审计据此指向真正执行的流程），再入队；后台任务用同一个去重键续上它。 */
  private async dispatch(req: RequestWithContext, op: InboundOperation, job: SyncJob, connectionId: string): Promise<void> {
    if (!DIRECT_OPS.includes(op.operation as InboundOp)) {
      await this.workflow.registerWriteRun(req, {
        tenantId: op.tenantId,
        kind: WORKFLOW_KINDS.INBOUND_PLAN_OP,
        dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.INBOUND_PLAN_OP, op.id, job.id),
        intent: { tenantId: op.tenantId, connectionId, inboundOpId: op.id } satisfies WriteRunIntent,
        syncJobId: job.id,
        priority: job.priority,
      })
    }
    await this.queue.add('sync', { tenantId: op.tenantId, syncJobId: job.id, requestId: req.requestId, inboundOpId: op.id }, job.id, { type: INBOUND_OP_JOB, priority: job.priority })
  }
}
