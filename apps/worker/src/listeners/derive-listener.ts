import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { UnrecoverableError, Worker } from 'bullmq'
import type IORedis from 'ioredis'
import type { Logger } from 'pino'
import { DERIVE_QUEUE_NAME, DeriveRangeError, DeriveRegistry, DeriveTaskNotFoundError, runDerive, type DerivePayload } from '../derivers/derive'
import { registerSummaryTasks } from '../derivers/summary-tasks'
import { createProfitTask } from '../profit/run'
import { runInJobTrace } from '../tracing'

// 日汇总表增量刷新的队列消费者：具体任务由后续工作包在注册表里登记，登记之前收到任务会被拒绝。
export function startDeriveListener(deps: { connection: IORedis; logger: Logger; concurrency?: number; db: PrismaClient }) {
  const registry = new DeriveRegistry()
  registerSummaryTasks(registry, deps.db) // P2a-01：经营日汇总、ASIN 日汇总
  registry.register(createProfitTask(deps.db)) // P2b-09：利润日表（三种收入确认口径）
  const { logger } = deps
  const worker = new Worker<DerivePayload>(
    DERIVE_QUEUE_NAME,
    async job => {
      return runInJobTrace('derive', job.data.traceparent, { 'nova.request_id': job.data.requestId, 'nova.tenant_id': job.data.tenantId, 'nova.derive_task': job.data.task }, async () => {
        try {
          return await runWithTenant(job.data.tenantId, () => runDerive(registry, job.data, logger))
        } catch (error) {
          if (error instanceof DeriveRangeError || error instanceof DeriveTaskNotFoundError) throw new UnrecoverableError(error.message)
          throw error
        }
      })
    },
    { connection: deps.connection, concurrency: deps.concurrency ?? 2 },
  )
  worker.on('failed', (job, error) => logger.error({ jobId: job?.id, error: error.message }, 'derive job failed'))
  return { registry, worker }
}
