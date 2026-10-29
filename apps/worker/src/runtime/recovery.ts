import type { PrismaClient } from '@prisma/client'
import { Queue } from 'bullmq'
import { MAX_ATTEMPTS, jobOptions, syncDomainOf, syncQueueName } from '@nova/workflow'
import type { RunnerLogger } from './job-runner'
import type { Reliability } from './reliability'
import { recordSyncEvent } from './sync-trace'
import { workflowLockKey } from './workflows'
import type { RedisConnections } from './redis'

// 崩溃恢复（12.3）：
// 1. 流程状态机：心跳过期的运行中流程由别的进程接管，已完成步骤复用，未完成步骤先对账再继续；
// 2. 同步任务：队列里的任务因进程崩溃“卡住”由队列自身的停滞检测重新派发；
//    这里再兜底一种队列自己救不了的情况——队列数据丢失（例如 Redis 被清空）而数据库里任务仍显示运行中。

export interface RecoveryDeps {
  reliability: Reliability
  systemPrisma: PrismaClient
  redis: RedisConnections
  queues: (name: string) => Queue
  logger: RunnerLogger
  /** 流程心跳多久没更新算作崩溃。 */
  staleMs?: number
  /** 同步任务显示运行中超过多久、且队列里已没有对应任务，才重新入队。 */
  stuckJobMs?: number
}

export async function recoverOnce(deps: RecoveryDeps): Promise<{ workflows: number; syncJobs: number }> {
  const staleMs = deps.staleMs ?? 5 * 60_000
  const stuckMs = deps.stuckJobMs ?? 30 * 60_000
  // 接管流程前先抢流程锁，与队列任务里的同一流程互斥。
  const resumed = await deps.reliability.engine.recover({ staleMs, lockFor: run => deps.reliability.locks.tryAcquire(run.tenantId, workflowLockKey(run.id), `${deps.reliability.ownerId}:recovery`) })
  for (const item of resumed) deps.logger.info({ runId: item.runId, outcome: item.outcome, errorCode: item.errorCode }, 'workflow recovery')

  // 同步任务兜底：用系统连接跨租户扫描，只取出编号与归属，入队时仍带租户编号。
  const stuck = await deps.systemPrisma.syncJob.findMany({
    where: { status: 'RUNNING', startedAt: { lt: new Date(Date.now() - stuckMs) }, deadLettered: false },
    select: { id: true, tenantId: true, type: true, priority: true, attempts: true, requestId: true, context: true },
    take: 50,
  })
  let requeued = 0
  for (const row of stuck) {
    const queue = deps.queues(syncQueueName(syncDomainOf(row.type)))
    const existing = await queue.getJob(row.id)
    const state = existing ? await existing.getState() : null
    if (state === 'active' || state === 'waiting' || state === 'delayed' || state === 'prioritized') continue // 队列里还有它，不干预
    if (row.attempts >= MAX_ATTEMPTS) {
      await deps.systemPrisma.syncJob.update({ where: { id: row.id }, data: { status: 'FAILED_PERMANENT', failureCode: 'WORKER_CRASHED', finishedAt: new Date(), deadLettered: true } })
      await recordSyncEvent(deps.systemPrisma, row.id, 'FAILED', 'WORKER_CRASHED')
      deps.logger.warn({ jobId: row.id }, 'stuck sync job exceeded attempts, marked failed')
      continue
    }
    const saved = (row.context ?? {}) as Record<string, unknown>
    await deps.systemPrisma.syncJob.update({ where: { id: row.id }, data: { status: 'PENDING', startedAt: null } })
    await queue.add('sync', { tenantId: row.tenantId, syncJobId: row.id, requestId: row.requestId, ...saved }, jobOptions({ jobId: `${row.id}-recover-${Date.now()}`, priority: row.priority }))
    requeued++
    deps.logger.warn({ jobId: row.id }, 'stuck sync job re-enqueued')
  }
  return { workflows: resumed.length, syncJobs: requeued }
}

export function startRecovery(deps: RecoveryDeps & { intervalMs?: number }): () => void {
  const timer = setInterval(
    () => {
      void recoverOnce(deps).catch(error => deps.logger.error({ error: error instanceof Error ? error.message : String(error) }, 'recovery sweep failed'))
    },
    deps.intervalMs ?? 5 * 60_000,
  )
  timer.unref?.()
  return () => clearInterval(timer)
}
