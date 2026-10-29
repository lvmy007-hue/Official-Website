import { runWithTenant } from '@nova/tenancy'
import { syncDomainOf, syncLockKey, type LockLease } from '@nova/workflow'
import type { Prisma, PrismaClient } from '@prisma/client'
import { UnrecoverableError, type Job } from 'bullmq'
import type { Logger } from 'pino'
import type { ObjectStorage } from '@nova/storage'
import { CONNECTION_HEALTH_JOB } from '@nova/api-contracts'
import { markAdsWriteFailed } from '../connectors/ads-write-dispatch'
import { markAplusFailed } from '../connectors/aplus-dispatch'
import { markAwdWriteFailed } from '../connectors/awd-dispatch'
import { processConnectionHealth } from '../connectors/connection-health'
import { processProduction } from '../connectors/dispatch'
import { markInboundOpFailed } from '../connectors/inbound-dispatch'
import { markListingRunFailed } from '../connectors/listing-dispatch'
import { markSolicitationFailed } from '../connectors/solicitation-dispatch'
import type { WorkerSecrets } from '../crypto/secrets'
import { enqueueSummariesAfterSync } from '../derivers/trigger'
import { recordSyncOutcome } from '../freshness/record'
import { failedData } from '../reports/job-state'
import { runGuarded } from '../runtime/job-runner'
import type { QueueRegistry } from '../runtime/queues'
import type { createReliability } from '../runtime/reliability'
import { recordSyncEvent, resultJsonOf, timelineOf } from '../runtime/sync-trace'
import type { createWriteWorkflows } from '../runtime/workflows'
import type { RawFileOpener } from '../streaming/raw-files'
import { resolveJobOwnership } from '../tenant-db'
import type { SyncPayload } from '../types'

export interface SyncListenerDeps {
  prisma: PrismaClient
  systemPrisma: PrismaClient
  logger: Logger
  reliability: ReturnType<typeof createReliability>
  queues: QueueRegistry
  writeWorkflows: ReturnType<typeof createWriteWorkflows>
  /** 原始报告文件的去向（对象存储）。 */
  openRawFile?: RawFileOpener
  /** 对象存储：保存上游仓储货件标签。 */
  storage?: ObjectStorage
  /** 应用层加密：解密亚马逊令牌、加密买家信息（P1-24）。 */
  secrets: WorkerSecrets
  /** 开发用模拟连接器：不访问亚马逊，直接把任务置为成功（生产环境永远为 false）。 */
  mock: boolean
}

async function markFailure(deps: SyncListenerDeps, payload: SyncPayload, code: string) {
  const { prisma } = deps
  await prisma.syncJob.update({ where: { id: payload.syncJobId }, data: { status: 'FAILED_PERMANENT', failureCode: code, finishedAt: new Date(), deadLettered: true } })
  await recordSyncEvent(prisma, payload.syncJobId, 'FAILED', code) // 同步中心：任务详情的过程时间线
  await recordSyncOutcome(prisma, payload.syncJobId, { ok: false, errorCode: code }) // 数据新鲜度：页面据此显示失败原因与已落后多久
  // 已取消的报告任务保持“已取消”，不改成失败
  if (payload.reportJobId) await prisma.fbaReportJob.updateMany({ where: { id: payload.reportJobId, status: { not: 'CANCELLED' } }, data: failedData(code) }).catch(() => undefined)
  // 广告报告任务（P3-15）：重试用尽或永久失败后不再显示“生成中”；运行器已写下的中文原因保留，没写过的（如重试用尽）页面按失败码兜底
  if (payload.reportJobId)
    await prisma.adsReportJob.updateMany({ where: { id: payload.reportJobId, status: { not: 'READY' } }, data: { status: 'FAILED', failureCode: code, finishedAt: new Date() } }).catch(() => undefined)
  if (payload.fbaPlanId) await prisma.fbaInboundPlan.update({ where: { id: payload.fbaPlanId }, data: { status: 'CREATE_FAILED' } }).catch(() => undefined)
  if (payload.awdOrderId && payload.tenantId) await markAwdWriteFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // 上游仓储订单不再显示“处理中”，记下失败原因
  if (payload.adsWriteRunId && payload.tenantId) await markAdsWriteFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // 广告写入记录不再显示“排队中”，记下失败原因
  if (payload.inboundOpId && payload.tenantId) await markInboundOpFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // 入仓计划不再显示“处理中”，记下失败原因
  if (payload.listingRunId && payload.tenantId) await markListingRunFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // 刊登写入与查询记录不再显示“排队中”“处理中”，记下失败原因
  if (payload.solicitationBatchId && payload.tenantId) await markSolicitationFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // 请求评价批次里还在“处理中”的订单改为发送失败，可再次受理
  if (payload.aplusRunId && payload.tenantId) await markAplusFailed(prisma, payload.tenantId, payload, code).catch(() => undefined) // A+ 写入记录不再显示“排队中”“处理中”，记下失败码
}
// 任务入口（P1-16）：先用系统连接查出任务实际归属的租户，核对载荷里声明的租户；之后全部在该租户上下文里执行。
export async function processSync(deps: SyncListenerDeps, job: Job<SyncPayload>, token?: string) {
  const { prisma, systemPrisma, logger, reliability } = deps
  const payload = job.data
  const record = await systemPrisma.syncJob.findUnique({ where: { id: payload.syncJobId }, select: { tenantId: true, connectionId: true, type: true, tenant: { select: { lifecycleStatus: true } } } })
  const ownership = resolveJobOwnership(payload.tenantId, record?.tenantId)
  if (!ownership.ok) {
    if (ownership.reason === 'JOB_NOT_FOUND') return
    // 载荷声称的租户与任务记录不一致：不执行、不碰任何数据，直接永久失败（重试没有意义）
    logger.error({ jobId: payload.syncJobId, requestId: payload.requestId, claimedTenantId: payload.tenantId }, 'job tenant mismatch, rejected')
    throw new UnrecoverableError('JOB_TENANT_MISMATCH')
  }
  if (ownership.legacy) logger.warn({ jobId: payload.syncJobId }, 'legacy job message without tenantId')
  const tenantId = ownership.tenantId
  const guarded = { ...payload, tenantId }
  // 企业生命周期门禁（P1-19）：只有试用、正常的企业执行同步；暂停、停用、注销的企业，已入队的任务直接作废（不进死信，恢复后可重新触发）
  if (!record || !['TRIAL', 'ACTIVE'].includes(record.tenant.lifecycleStatus)) {
    await runWithTenant(tenantId, async () => {
      await prisma.syncJob.update({ where: { id: payload.syncJobId }, data: { status: 'FAILED_PERMANENT', failureCode: 'TENANT_NOT_ACTIVE', finishedAt: new Date() } })
      await recordSyncEvent(prisma, payload.syncJobId, 'FAILED', 'TENANT_NOT_ACTIVE')
    })
    logger.warn({ jobId: payload.syncJobId, tenantId, lifecycleStatus: record?.tenant.lifecycleStatus }, 'tenant not active, sync job cancelled')
    return
  }
  // 运行外壳：租户公平并发 → 同店铺同数据域互斥锁 → 执行 → 失败分类（重试 / 永久失败并写入死信）。
  return runWithTenant(tenantId, () =>
    runGuarded(
      job,
      token,
      reliability,
      {
        queue: job.queueName,
        tenantId,
        lockKey: syncLockKey(record!.connectionId, syncDomainOf(record!.type)),
        syncJobId: payload.syncJobId,
        execute: lease => processSyncInTenant(deps, job, tenantId, lease),
        onRetry: async ({ failureCode, attempt, maxAttempts }) => {
          // 将要重试：任务回到等待，页面能看到原因与已尝试次数；不是失败，也不会进死信。
          await prisma.syncJob.update({ where: { id: payload.syncJobId }, data: { status: 'PENDING', failureCode } }).catch(() => undefined)
          await recordSyncEvent(prisma, payload.syncJobId, 'RETRY_WAIT', `${failureCode}（第 ${attempt}/${maxAttempts} 次尝试失败）`)
          logger.warn({ jobId: payload.syncJobId, requestId: payload.requestId, failureCode, attempt, maxAttempts }, 'sync job failed, will retry')
        },
        onTerminal: async ({ failureCode, retryable, attempt }) => {
          await markFailure(deps, guarded, failureCode)
          logger.error({ jobId: payload.syncJobId, requestId: payload.requestId, failureCode, retryable, attempt }, 'sync job failed permanently, moved to dead letter')
        },
      },
      logger,
    ),
  )
}
// 任务载荷里引用的报表、入仓计划必须属于本租户（行级安全下他租户的对象查不到），否则任务永久失败，不改动任何对象。
async function referencesBelongToTenant(deps: SyncListenerDeps, payload: SyncPayload) {
  const { prisma } = deps
  if (payload.reportJobId) {
    const report =
      (await prisma.fbaReportJob.findFirst({ where: { id: payload.reportJobId }, select: { id: true } })) ??
      (await prisma.adsReportJob.findFirst({ where: { id: payload.reportJobId }, select: { id: true } }))
    if (!report) return false
  }
  if (payload.fbaPlanId && !(await prisma.fbaInboundPlan.findFirst({ where: { id: payload.fbaPlanId }, select: { id: true } }))) return false
  if (payload.adsWriteRunId && !(await prisma.adsWriteRun.findFirst({ where: { id: payload.adsWriteRunId }, select: { id: true } }))) return false
  if (payload.listingRunId && !(await prisma.listingWriteRun.findFirst({ where: { id: payload.listingRunId }, select: { id: true } }))) return false
  if (payload.awdOrderId && !(await prisma.awdInboundOrder.findFirst({ where: { id: payload.awdOrderId }, select: { id: true } }))) return false
  if (payload.inboundOpId && !(await prisma.inboundOperation.findFirst({ where: { id: payload.inboundOpId }, select: { id: true } }))) return false
  if (payload.solicitationBatchId && !(await prisma.solicitationRequest.findFirst({ where: { batchId: payload.solicitationBatchId }, select: { id: true } }))) return false
  if (payload.aplusRunId && !(await prisma.aplusWriteRun.findFirst({ where: { id: payload.aplusRunId }, select: { id: true } }))) return false
  if (payload.adsProfileId && !(await prisma.adsProfile.findFirst({ where: { id: payload.adsProfileId }, select: { id: true } }))) return false
  return true
}
async function processSyncInTenant(deps: SyncListenerDeps, job: Job<SyncPayload>, tenantId: string, lease: LockLease | null) {
  const { prisma, logger, queues, mock, reliability } = deps
  const payload = { ...job.data, tenantId }
  const row = await prisma.syncJob.findUnique({ where: { id: payload.syncJobId }, include: { connection: true } })
  if (!row) return
  // 重复投递（例如进程在“已成功但未确认”时崩溃）：已成功的任务不再重复导入。手动重试会先把状态改回等待。
  if (row.status === 'SUCCEEDED' && !payload.poll) {
    logger.info({ jobId: row.id }, 'job already succeeded, skipped')
    return
  }
  if (!(await referencesBelongToTenant(deps, payload))) {
    await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'JOB_TENANT_MISMATCH', finishedAt: new Date() } })
    await recordSyncEvent(prisma, row.id, 'FAILED', 'JOB_TENANT_MISMATCH')
    logger.error({ jobId: row.id, requestId: payload.requestId }, 'job references objects outside its tenant, rejected')
    throw new UnrecoverableError('JOB_TENANT_MISMATCH')
  }
  // 连接已在连接中心断开（P5-04）：排在队列里的任务直接作废，不调用亚马逊、不记数据新鲜度、不重试
  if (row.connection.state === 'REVOKED') {
    await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'CONNECTION_DISCONNECTED', finishedAt: new Date() } })
    await recordSyncEvent(prisma, row.id, 'FAILED', 'CONNECTION_DISCONNECTED')
    logger.info({ jobId: row.id, requestId: payload.requestId }, 'connection disconnected, sync job closed')
    return
  }
  // 开始执行：状态、尝试次数与“开始”事件一起写（时间线随后在主流程里继续往后追加，不再重复读）
  let timeline: Prisma.InputJsonValue = timelineOf(row.timelineJson, 'STARTED', `第 ${row.attempts + 1} 次尝试`)
  await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'RUNNING', attempts: { increment: 1 }, startedAt: new Date(), failureCode: null, timelineJson: timeline } })
  try {
    if (mock) {
      await new Promise(resolve => setTimeout(resolve, 300))
      await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date() } })
      if (payload.reportJobId)
        await prisma.fbaReportJob
          .update({ where: { id: payload.reportJobId }, data: { status: 'READY', finishedAt: new Date(), expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000) } })
          .catch(() => undefined)
      if (payload.fbaPlanId) await prisma.fbaInboundPlan.update({ where: { id: payload.fbaPlanId }, data: { status: 'READY_FOR_PLACEMENT' } }).catch(() => undefined)
      return
    }
    // 连接健康检查（P5-04）：只读探测，结果写进连接的健康记录；不是数据同步，所以不记数据新鲜度、不更新“最近成功同步”、不触发汇总。检查本身不抛错（接口失败是检查结果）
    if (row.type === CONNECTION_HEALTH_JOB) {
      await processConnectionHealth(
        { prisma, logger, secrets: deps.secrets, guardFor: (tenant, connection) => reliability.guardFor(tenant, connection) },
        { tenantId, connection: row.connection },
        payload.requestId,
      )
      await prisma.syncJob.update({
        where: { id: row.id },
        data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date(), timelineJson: timelineOf(timeline, 'SUCCEEDED') },
      })
      return
    }
    const result = await processProduction(deps, payload, row, { jobId: String(job.id), priority: row.priority, lease, isLastAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) })
    lease?.assertHeld() // 租约丢失说明别的进程可能已接管，不再写入完成状态
    // 报表中心里被取消的报告任务：不再轮询也不下载；同步任务以“已取消”收尾，不记数据新鲜度失败（不是数据出了问题）
    if ((result as { cancelled?: boolean } | null)?.cancelled === true) {
      await prisma.syncJob.update({
        where: { id: row.id },
        data: { status: 'FAILED_PERMANENT', failureCode: 'REPORT_CANCELLED', finishedAt: new Date(), timelineJson: timelineOf(timeline, 'CANCELLED') },
      })
      logger.info({ jobId: row.id, requestId: payload.requestId }, 'report job cancelled in report center, sync job closed')
      return
    }
    if ((result as { pending?: boolean }).pending) {
      timeline = timelineOf(timeline, 'POLL_WAIT')
      await prisma.syncJob.update({ where: { id: row.id }, data: { status: 'PENDING', progressCurrent: 0, progressTotal: 1, finishedAt: null, timelineJson: timeline } })
      await queues.addSync(row.type, { ...payload, poll: true }, { jobId: `${row.id}-poll-${Date.now()}`, priority: row.priority, delayMs: 30000 })
      logger.info({ jobId: row.id, requestId: payload.requestId, result }, 'Amazon report is still generating; poll scheduled')
      return
    }
    await prisma.syncJob.update({
      where: { id: row.id },
      data: { status: 'SUCCEEDED', progressCurrent: 1, progressTotal: 1, finishedAt: new Date(), resultJson: resultJsonOf(result), timelineJson: timelineOf(timeline, 'SUCCEEDED') },
    })
    const imported = (result as { imported?: unknown } | null)?.imported
    // 同步器声明“不适用”（例如没有开通订阅省）：任务算成功，但新鲜度如实记为“不适用”，不记成“正常”
    const notApplicable = (result as { notApplicable?: unknown } | null)?.notApplicable === true
    await recordSyncOutcome(prisma, row.id, notApplicable ? { ok: false, errorCode: 'SCOPE_UNAVAILABLE' } : { ok: true, rowCount: typeof imported === 'number' ? imported : undefined })
    await enqueueSummariesAfterSync(queues, { tenantId, domain: row.domain, context: row.context, requestId: payload.requestId }) // 日汇总增量刷新（P2a-01）
    await prisma.platformConnection.update({ where: { id: row.connectionId }, data: { lastSuccessfulSyncAt: new Date(), lastHealthCheckedAt: new Date(), lastErrorCode: null } }).catch(() => undefined)
    logger.info({ jobId: row.id, requestId: payload.requestId, result }, 'Amazon data import completed')
  } catch (error) {
    // 失败的处置（重试、永久失败、死信）统一由运行外壳 runGuarded 完成；这里只记录连接的最近错误并把错误原样抛出。
    const code = error instanceof Error ? error.message.slice(0, 120) : 'CONNECTOR_FAILED'
    await prisma.platformConnection.update({ where: { id: row.connectionId }, data: { lastHealthCheckedAt: new Date(), lastErrorCode: code } }).catch(() => undefined)
    throw error
  }
}
