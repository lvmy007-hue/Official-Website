import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'

// 亚马逊通知事件的重放与到期清理（P1-28-11）。
// 重放：接口已把失败事件重置为“已接收”并把编号放进队列；这里逐条交给该类型的处理器。处理器由各业务工作包注册
// （订单变化、库存变化、报价变化等）；还没有处理器的类型如实标记为失败（错误码 PROCESSOR_NOT_AVAILABLE），不假装已处理。
// 清理：事件保留 90 天（freeze/models.md）：先删对象存储里的消息体，再删库内记录；删文件失败的保留记录，下次再试。

export const NOTIFICATION_EVENT_RETENTION_DAYS = 90
export const NOTIFICATION_EVENT_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const BATCH = 200
const MAX_BATCHES = 50

export interface NotificationEventRef {
  id: string
  tenantId: string
  sellerAccountId: string | null
  notificationType: string
  payloadObjectKey: string
}
export type NotificationProcessor = (event: NotificationEventRef) => Promise<void>

export class NotificationProcessorRegistry {
  private readonly items = new Map<string, NotificationProcessor>()
  register(notificationType: string, processor: NotificationProcessor) {
    if (this.items.has(notificationType)) throw new Error(`通知处理器重复注册：${notificationType}`)
    this.items.set(notificationType, processor)
    return this
  }
  find(notificationType: string) {
    return this.items.get(notificationType)
  }
}

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown } | null)?.code
  return (typeof code === 'string' && /^[A-Z0-9_]{2,60}$/.test(code) ? code : 'PROCESSING_FAILED').slice(0, 60)
}

export async function replayEvents(deps: { db: PrismaClient; processors: NotificationProcessorRegistry; now?: () => Date }, tenantId: string, eventIds: readonly string[]) {
  const now = (deps.now ?? (() => new Date()))()
  const events = await deps.db.amazonNotificationEvent.findMany({
    where: { tenantId, id: { in: [...eventIds].slice(0, BATCH) }, status: 'RECEIVED' },
    select: { id: true, tenantId: true, sellerAccountId: true, notificationType: true, payloadObjectKey: true },
    take: BATCH,
  })
  const result = { processed: 0, failed: 0 }
  for (const event of events) {
    const processor = deps.processors.find(event.notificationType)
    let errorCode: string | null = null
    if (!processor) errorCode = 'PROCESSOR_NOT_AVAILABLE'
    else {
      try {
        await processor(event)
      } catch (error) {
        errorCode = codeOf(error)
      }
    }
    await deps.db.amazonNotificationEvent.updateMany({
      where: { tenantId, id: event.id },
      data: errorCode ? { status: 'FAILED', errorCode, attempts: { increment: 1 } } : { status: 'PROCESSED', processedAt: now, errorCode: null, attempts: { increment: 1 } },
    })
    if (errorCode) result.failed += 1
    else result.processed += 1
  }
  return result
}

export interface EventPurgeDeps {
  systemDb: Pick<PrismaClient, 'amazonNotificationEvent'>
  storage: Pick<ObjectStorage, 'delete'>
  logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
  now?: () => Date
}

export async function purgeExpiredNotificationEvents(deps: EventPurgeDeps) {
  const now = (deps.now ?? (() => new Date()))()
  const cutoff = new Date(now.getTime() - NOTIFICATION_EVENT_RETENTION_DAYS * 86_400_000)
  const result = { deleted: 0, failed: 0 }
  const failedIds = new Set<string>()
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const rows = await deps.systemDb.amazonNotificationEvent.findMany({
      where: { receivedAt: { lt: cutoff }, ...(failedIds.size > 0 ? { id: { notIn: [...failedIds] } } : {}) },
      select: { id: true, payloadObjectKey: true },
      orderBy: { receivedAt: 'asc' },
      take: BATCH,
    })
    if (rows.length === 0) break
    const removable: string[] = []
    for (const row of rows) {
      try {
        if (row.payloadObjectKey) await deps.storage.delete(row.payloadObjectKey)
        removable.push(row.id)
      } catch {
        failedIds.add(row.id)
        result.failed += 1
      }
    }
    if (removable.length > 0) {
      await deps.systemDb.amazonNotificationEvent.deleteMany({ where: { id: { in: removable }, receivedAt: { lt: cutoff } } })
      result.deleted += removable.length
    }
    if (rows.length < BATCH) break
  }
  if (result.deleted > 0) deps.logger.info({ event: 'notification_events_purged', deleted: result.deleted }, 'expired amazon notification events deleted')
  if (result.failed > 0) deps.logger.warn({ event: 'notification_events_purge_failed', failed: result.failed }, 'some expired notification event payloads could not be deleted, will retry next run')
  return result
}
