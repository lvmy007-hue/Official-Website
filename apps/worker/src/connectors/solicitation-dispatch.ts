import { SOLICITATION_SEND_JOB, SOLICITATION_SWITCH_KEY } from '@nova/api-contracts'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import type { ProductionDeps, ProductionRun } from './dispatch'

// 请求评价任务分发（P4-13，importers.md I-16）：一个任务 = 一批订单，走写操作流程（runtime/solicitation-workflow.ts），受写入开关“请求评价”控制。
// 任务类型 SOLICITATION_SEND 落在 general 队列；失败的处置在 markSolicitationFailed。

export const SOLICITATION_JOB_TYPES: readonly string[] = [SOLICITATION_SEND_JOB]

type SolicitationRow = { tenantId: string; connection: { id: string } }

export async function processSolicitation(deps: ProductionDeps, row: SolicitationRow, sellerAccountId: string, payload: SyncPayload, run: ProductionRun) {
  const { prisma, reliability, writeWorkflows } = deps
  const batchId = payload.solicitationBatchId
  if (!batchId) throw new NonRetryableError('SOLICITATION_CONTEXT_MISSING', '请求评价任务缺少批次编号')
  // 批次必须属于这个店铺：行级安全已经把别的企业的行挡在外面，这里再核对店铺
  if ((await prisma.solicitationRequest.count({ where: { tenantId: row.tenantId, sellerAccountId, batchId } })) === 0)
    throw new NonRetryableError('SOLICITATION_BATCH_NOT_FOUND', '请求评价的批次不存在')
  const result = await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.solicitationSend, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.SOLICITATION_SEND, batchId, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, solicitationBatchId: batchId },
  })
  await recordSwitchOutcome(prisma, row.tenantId, SOLICITATION_SWITCH_KEY, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return result
}

// 流程失败码有两种来源：我们自己的 SP_API_<状态码>，以及运行时对未识别 HTTP 错误的分类 HTTP_<状态码>；LWA 换令牌失败也算调用了亚马逊
const CALL_FAILURE = /^(SP_API_|HTTP_|LWA_TOKEN_FAILED_)/
const AUTH_FAILURE = /^(SP_API_(401|403)|HTTP_(401|403)|LWA_TOKEN_FAILED_(400|401))/

/** 失败码只留“来源 + 状态码”（SP_API_400）：亚马逊返回的原文不进请求评价记录；开关关闭记 SOL_SWITCH_OFF。 */
export function solicitationFailureCode(code: string): string {
  if (code === 'SWITCH_DISABLED') return 'SOL_SWITCH_OFF'
  const status = /^(?:SP_API_|HTTP_)(\d{3})/.exec(code)?.[1]
  return status ? `SP_API_${status}` : code.slice(0, 60)
}

/**
 * 请求评价任务永久失败后的处置（由监听器在任务进入死信时调用）：这一批仍是“处理中”（QUEUED）的订单改为“发送失败”并记下失败码，之后可以再次受理；
 * 已经有结果的订单不动。只有真正调用了亚马逊的失败才计入开关的连续失败次数，授权失效立即关闭开关。
 */
export async function markSolicitationFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.solicitationBatchId) return
  await db.solicitationRequest.updateMany({
    where: { tenantId, batchId: payload.solicitationBatchId, status: 'QUEUED' },
    data: { status: 'FAILED', failureCode: solicitationFailureCode(failureCode) },
  })
  if (CALL_FAILURE.test(failureCode))
    await recordSwitchOutcome(db, tenantId, SOLICITATION_SWITCH_KEY, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
}
