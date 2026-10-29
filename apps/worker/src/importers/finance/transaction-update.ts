import { TRANSACTION_UPDATE_FRESHNESS_KEY, TRANSACTION_UPDATE_TYPE } from '@nova/api-contracts'
import type { ObjectStorage } from '@nova/storage'
import { PRIORITY, syncDomainOf, syncSourceKey } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import { recordFreshness } from '../../freshness/record'
import type { NotificationEventRef, NotificationProcessor } from '../../platform/notification-events'
import { readJson, resolveSellerAccountId } from '../notifications/hourly-write'

// 交易更新推送（TRANSACTION_UPDATE，importers.md N-14，P2b-05）：推送只是“有交易变化”的信号，本身不带可信的金额与状态，
// 所以处理器不解析交易内容，而是给对应店铺排一个“财务增量同步”（I-02，推送增量优先级）去重拉，写入与状态刷新都走既有的财务同步器。
// 推送接收端按 14.10 暂缓：现在没有任何东西会把这类事件收进来，由每 6 小时的财务全量同步（前推 14 天重拉）兜底；
// 这里只保证事件一旦进来（含失败后的人工重放）就能被正确处理，不假装已有推送。
// 载荷字段名按官方文档整理、未经真实推送验证：店铺归属优先用事件上的店铺，否则用载荷里的 sellerId / accountId 反查。

export type TransactionUpdateDeps = {
  db: PrismaClient
  storage: Pick<ObjectStorage, 'openRead'>
  /** 同步队列的入口（运行时的 QueueRegistry 满足这个形状；导入器不直接依赖运行时目录）。 */
  queues: { addSync(type: string, data: Record<string, unknown>, options: { jobId: string; priority: number; delayMs?: number }): Promise<unknown> }
}

const FINANCE_JOB = 'FBA_FINANCE'
const US = 'ATVPDKIKX0DER'
const obj = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null)
const fail = (code: string) => Object.assign(new Error(code), { code })

/** 载荷里可能出现的店铺编号（卖家编号）。 */
export function accountIdsOf(raw: unknown): string[] {
  const root = obj(raw)
  const payload = obj(root?.payload)
  const candidates = [root?.sellerId, root?.accountId, payload?.sellerId, payload?.accountId, obj(payload?.transactionUpdateNotification)?.sellerId]
  return candidates.filter((value): value is string => typeof value === 'string' && value.trim() !== '').map(value => value.trim())
}

export function createTransactionUpdateProcessor(deps: TransactionUpdateDeps): NotificationProcessor {
  return async (event: NotificationEventRef) => {
    const accountIds = event.sellerAccountId ? [] : accountIdsOf(await readJson(deps.storage, event.payloadObjectKey))
    const sellerAccountId = await resolveSellerAccountId(deps.db, event.tenantId, event.sellerAccountId, accountIds)
    if (!sellerAccountId) throw fail('SELLER_ACCOUNT_UNRESOLVED')
    const connection = await deps.db.platformConnection.findFirst({
      where: { tenantId: event.tenantId, sellerAccountId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED' },
      select: { id: true },
    })
    if (!connection) throw fail('CONNECTION_NOT_AUTHORIZED')

    // 已经有一个排队中的财务同步：它启动后会前推 14 天重拉，包含这次变化，不重复排
    const queued = await deps.db.syncJob.count({ where: { connectionId: connection.id, type: FINANCE_JOB, status: 'PENDING' } })
    let created = 0
    if (queued === 0) {
      const requestId = `push:${event.id}`
      const job = await deps.db.syncJob.create({
        data: {
          tenantId: event.tenantId,
          connectionId: connection.id,
          type: FINANCE_JOB,
          status: 'PENDING',
          requestId,
          domain: syncDomainOf(FINANCE_JOB),
          priority: PRIORITY.PUSH_INCREMENT,
          sourceKey: syncSourceKey(connection.id, FINANCE_JOB, US),
        },
        select: { id: true },
      })
      try {
        await deps.queues.addSync(FINANCE_JOB, { tenantId: event.tenantId, syncJobId: job.id, requestId, marketplaceId: US }, { jobId: job.id, priority: PRIORITY.PUSH_INCREMENT })
      } catch (error) {
        await deps.db.syncJob.update({ where: { id: job.id }, data: { status: 'FAILED', failureCode: 'QUEUE_UNAVAILABLE', finishedAt: new Date() } })
        throw error
      }
      created = 1
    }
    await recordFreshness(deps.db, { tenantId: event.tenantId, sellerAccountId, sourceKey: TRANSACTION_UPDATE_FRESHNESS_KEY, ok: true, rowCount: created })
  }
}

export function registerTransactionUpdateProcessor(registry: { register(type: string, processor: NotificationProcessor): unknown }, deps: TransactionUpdateDeps) {
  registry.register(TRANSACTION_UPDATE_TYPE, createTransactionUpdateProcessor(deps))
}
