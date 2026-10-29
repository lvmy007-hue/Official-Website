import { APLUS_SWITCH_KEY, APLUS_WRITE_JOB } from '@nova/api-contracts'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { aplusSwitchOn } from '../runtime/aplus-workflow'
import { parseAplusRequest } from '../runtime/aplus-request'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import type { ProductionDeps, ProductionRun } from './dispatch'

// A+ 写入任务分发（P4-14，importers.md I-18）：任务类型 APLUS_WRITE，一条任务对应一条 AplusWriteRun（接口服务先建好记录、再入队），
// 按记录的类型（创建、保存修改、关联 ASIN、提交审核、上传图片）走写操作流程（runtime/aplus-workflow.ts），受写入开关“A+ 内容提交”控制。
// 任务与 A+ 同步同属 general 域、同店铺互斥（读写不并发）。流程：
//   1. 按 aplusRunId 读记录：读不到、不属于这个店铺、或已经有结论（成功、失败）就幂等跳过，不重复调用亚马逊；
//   2. 请求内容不完整（APL_REQUEST_INVALID）与写入开关已关闭（APL_SWITCH_OFF）在发请求之前就不可重试地结束；
//   3. 记录置为“处理中”，启动流程；成功后记录由流程置为成功（带结果与亚马逊的警告），这里登记开关的成功调用。
// 失败的收尾统一在 markAplusFailed：任务不可重试地失败、或重试用尽后，由监听器调用，把记录置为失败并记下失败码（不在这里捕获，避免同一次失败被登记两遍）。

export const APLUS_JOB_TYPES: readonly string[] = [APLUS_WRITE_JOB]

type AplusRow = { tenantId: string; connection: { id: string } }
const FINISHED = ['SUCCEEDED', 'FAILED']

export async function processAplusWrite(deps: ProductionDeps, row: AplusRow, sellerAccountId: string, payload: SyncPayload, run: ProductionRun) {
  const { prisma, reliability, writeWorkflows } = deps
  const runId = payload.aplusRunId
  if (!runId) throw new NonRetryableError('APL_RUN_CONTEXT_MISSING', 'A+ 写入任务缺少写入记录编号')
  const record = await prisma.aplusWriteRun.findFirst({ where: { id: runId, tenantId: row.tenantId, sellerAccountId } })
  if (!record) return { skipped: true, reason: 'RUN_NOT_FOUND' }
  if (FINISHED.includes(record.status)) return { skipped: true, reason: 'RUN_FINISHED', status: record.status }
  parseAplusRequest(record.kind, record.requestJson) // 内容不完整：不可重试地结束，不向亚马逊发任何请求
  if (!(await aplusSwitchOn(prisma, row.tenantId))) throw new NonRetryableError('APL_SWITCH_OFF', 'A+ 内容的写入开关已关闭，未向亚马逊发出请求')
  await prisma.aplusWriteRun.updateMany({ where: { id: record.id, tenantId: row.tenantId, status: { in: ['QUEUED', 'RUNNING'] } }, data: { status: 'RUNNING', failureCode: null } })
  const result = await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.aplusWrite, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.APLUS_WRITE, record.id, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, aplusRunId: record.id },
  })
  await recordSwitchOutcome(prisma, row.tenantId, APLUS_SWITCH_KEY, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return result
}

// 流程失败码有三种来源：我们自己的 SP_API_<状态码>、运行时对未识别 HTTP 错误的分类 HTTP_<状态码>、LWA 换令牌失败（也算调用了亚马逊）
const CALL_FAILURE = /^(SP_API_|HTTP_|LWA_TOKEN_FAILED_)/
const AUTH_FAILURE = /^(SP_API_(401|403)|HTTP_(401|403)|LWA_TOKEN_FAILED_(400|401))/

/** 失败码只留“来源 + 状态码”（SP_API_400）或 APL_* 码：亚马逊返回的原文不进写入记录；开关关闭记 APL_SWITCH_OFF。 */
export function aplusFailureCode(code: string): string {
  if (code === 'SWITCH_DISABLED') return 'APL_SWITCH_OFF'
  const status = /^(?:SP_API_|HTTP_)(\d{3})/.exec(code)?.[1]
  return status ? `SP_API_${status}` : code.slice(0, 60)
}

/**
 * 永久失败后的处置（由监听器在任务进入死信时调用）：写入记录标为失败并记下失败码，页面不再显示“排队中”“处理中”；已经有结论的记录不改。
 * 只有真正调用了亚马逊的失败才计入开关的连续失败次数，授权失效（401、403）立即关闭开关。
 */
export async function markAplusFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.aplusRunId) return
  const run = await db.aplusWriteRun.findFirst({ where: { id: payload.aplusRunId, tenantId }, select: { id: true, status: true } })
  if (!run || FINISHED.includes(run.status)) return
  await db.aplusWriteRun.updateMany({ where: { id: run.id, tenantId, status: { notIn: FINISHED } }, data: { status: 'FAILED', failureCode: aplusFailureCode(failureCode), finishedAt: new Date() } })
  if (CALL_FAILURE.test(failureCode))
    await recordSwitchOutcome(db, tenantId, APLUS_SWITCH_KEY, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
}
