import { ADS_WRITE_JOB, ADS_WRITE_KIND_INFO, adsWriteFailureText, type AdsWriteKind } from '@nova/api-contracts'
import { NonRetryableError, WORKFLOW_KINDS, writeRunDedupeKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { recordSwitchOutcome } from '../platform/switch-outcome'
import { runWriteWorkflow } from '../runtime/workflows'
import type { SyncPayload } from '../types'
import type { ProductionDeps, ProductionRun } from './dispatch'

// 广告写入任务分发（P3-17）：任务类型 ADS_WRITE，进 ads 队列，和广告同步、报告同店铺互斥（读写不并发）。
// 写入走流程状态机（runtime/ads-write-workflow.ts）；失败的处置在 markAdsWriteFailed。

export const ADS_WRITE_JOB_TYPES: readonly string[] = [ADS_WRITE_JOB]

export async function processAdsWrite(deps: ProductionDeps, row: { tenantId: string; connection: { id: string } }, payload: SyncPayload, run: ProductionRun) {
  const { prisma, reliability, writeWorkflows } = deps
  if (!payload.adsWriteRunId) throw new NonRetryableError('ADS_WRITE_CONTEXT_MISSING', '写入任务缺少写入记录编号')
  const record = await prisma.adsWriteRun.findFirst({ where: { id: payload.adsWriteRunId, tenantId: row.tenantId }, select: { kind: true } })
  if (!record) throw new NonRetryableError('ADS_WRITE_RUN_NOT_FOUND', '写入记录不存在')
  const result = await runWriteWorkflow(reliability.engine, reliability.locks, writeWorkflows.adsWrite, {
    tenantId: row.tenantId,
    dedupeKey: writeRunDedupeKey(WORKFLOW_KINDS.ADS_WRITE, payload.adsWriteRunId, run.jobId),
    syncJobId: payload.syncJobId,
    priority: run.priority,
    lease: run.lease,
    isLastAttempt: run.isLastAttempt,
    owner: `${reliability.ownerId}:${run.jobId}`,
    intent: { tenantId: row.tenantId, connectionId: row.connection.id, adsWriteRunId: payload.adsWriteRunId },
  })
  const info = ADS_WRITE_KIND_INFO[record.kind as AdsWriteKind]
  if (info) await recordSwitchOutcome(prisma, row.tenantId, info.switchKey, { success: true }).catch(() => undefined) // 登记失败不影响写入结果
  return result
}

const CALL_FAILURE = /^ADS_API_/
const AUTH_FAILURE = /^ADS_API_(401|403)_/

/** 失败码只留“来源 + 状态码”（ADS_API_400）：亚马逊返回的原文不进写入记录。 */
export function shortAdsWriteCode(code: string): string {
  return /^ADS_API_\d{3}/.exec(code)?.[0] ?? code.slice(0, 60)
}

/**
 * 写入任务永久失败后的处置（由监听器在任务进入死信时调用）：写入记录标为失败并记下原因，页面不再显示“排队中”；
 * 已经成功的记录不改。只有真正调用了亚马逊的失败才计入开关的连续失败次数。
 */
export async function markAdsWriteFailed(db: PrismaClient, tenantId: string, payload: SyncPayload, failureCode: string): Promise<void> {
  if (!payload.adsWriteRunId) return
  const run = await db.adsWriteRun.findFirst({ where: { id: payload.adsWriteRunId, tenantId }, select: { id: true, kind: true } })
  if (!run) return
  await db.adsWriteRun.updateMany({ where: { id: run.id, tenantId, status: { not: 'SUCCEEDED' } }, data: { status: 'FAILED', failureCode: shortAdsWriteCode(failureCode), finishedAt: new Date() } })
  const failed = { outcome: 'FAILED', message: adsWriteFailureText(shortAdsWriteCode(failureCode)).slice(0, 500) }
  await db.adsAutomationRun.updateMany({ where: { tenantId, writeRunId: run.id, outcome: 'QUEUED' }, data: failed })
  await db.daypartingRun.updateMany({ where: { tenantId, writeRunId: run.id, outcome: 'QUEUED' }, data: failed })
  const info = ADS_WRITE_KIND_INFO[run.kind as AdsWriteKind]
  if (info && CALL_FAILURE.test(failureCode)) {
    await recordSwitchOutcome(db, tenantId, info.switchKey, { success: false, errorCode: failureCode.slice(0, 40), authInvalid: AUTH_FAILURE.test(failureCode) }).catch(() => undefined)
  }
}
