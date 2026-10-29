import { runWithTenant } from '@nova/tenancy'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { AuxHandlerRegistry } from '../runtime/consumers'
import { fetchFxForTenant } from './fx-fetch'
import { replayEvents, type NotificationProcessorRegistry } from './notification-events'
import { createSubscription, deleteSubscription, type NotificationsApiFactory } from './subscriptions'

/**
 * 注册“通知”队列的处理器（P1-28）：接口把汇率立即获取、订阅创建与取消、事件重放放进同一个队列，按载荷里的 kind 分发。
 * 载荷只含编号（租户、订阅记录、事件编号）；处理在该租户的上下文里执行。
 */
export function registerPlatformHandlers(aux: AuxHandlerRegistry, deps: { db: PrismaClient; api: NotificationsApiFactory; processors: NotificationProcessorRegistry; fetchImpl?: typeof fetch }) {
  aux.register('notifications', 'notifications', async (job, { tenantId }) => {
    const data = (job.data ?? {}) as { kind?: unknown; subscriptionRowId?: unknown; eventIds?: unknown }
    const text = (value: unknown, label: string) => {
      if (typeof value !== 'string' || !value) throw new NonRetryableError('JOB_PAYLOAD_INVALID', `任务缺少${label}`)
      return value
    }
    switch (data.kind) {
      case 'fx-fetch':
        return runWithTenant(tenantId, () => fetchFxForTenant({ db: deps.db, fetchImpl: deps.fetchImpl }, tenantId))
      case 'subscription-create':
        return runWithTenant(tenantId, () => createSubscription({ db: deps.db, api: deps.api }, tenantId, text(data.subscriptionRowId, '订阅编号')))
      case 'subscription-delete':
        return runWithTenant(tenantId, () => deleteSubscription({ db: deps.db, api: deps.api }, tenantId, text(data.subscriptionRowId, '订阅编号')))
      case 'events-replay': {
        if (!Array.isArray(data.eventIds) || data.eventIds.some(item => typeof item !== 'string')) throw new NonRetryableError('JOB_PAYLOAD_INVALID', '任务缺少事件编号')
        return runWithTenant(tenantId, () => replayEvents({ db: deps.db, processors: deps.processors }, tenantId, data.eventIds as string[]))
      }
      default:
        throw new NonRetryableError('NOTIFICATION_KIND_UNKNOWN', '未知的通知任务类型')
    }
  })
}
