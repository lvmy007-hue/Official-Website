import { describe, expect, it, vi } from 'vitest'
import { AuxHandlerRegistry } from '../runtime/consumers'
import { NotificationProcessorRegistry } from './notification-events'
import { registerPlatformHandlers } from './register'

function setup() {
  const rows: Array<Record<string, any>> = [
    { id: 'sub1', tenantId: 't1', sellerAccountId: 's1', destinationId: 'd', notificationType: 'ORDER_CHANGE', subscriptionId: 'amz-1', filterJson: null, status: 'ACTIVE', version: 1 },
  ]
  const db = {
    notificationSubscription: { findFirst: vi.fn(async ({ where }: any) => rows.find(row => row.id === where.id) ?? null), deleteMany: vi.fn(async () => ({ count: 1 })) },
    platformConnection: { findFirst: vi.fn(async () => ({ id: 'c1', sellerAccountId: 's1', encryptedRefreshToken: 'x' })) },
    amazonNotificationEvent: { findMany: vi.fn(async () => []) },
    tenantSetting: { findFirst: vi.fn(async () => null) },
    fxSourceConfig: { findMany: vi.fn(async () => []), findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn() },
    fxRate: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn() },
    membership: { findMany: vi.fn(async () => []) },
    notification: { createMany: vi.fn(async () => ({ count: 0 })) },
  }
  const remove = vi.fn(async () => undefined)
  const aux = new AuxHandlerRegistry()
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ date: new Date().toISOString().slice(0, 10), rate: 7.1 }), { status: 200 }))
  registerPlatformHandlers(aux, { db: db as never, api: () => ({ create: vi.fn(), remove }), processors: new NotificationProcessorRegistry(), fetchImpl: fetchImpl as never })
  const run = (data: Record<string, unknown>) => aux.find('notifications', 'notifications')!({ data } as never, { tenantId: 't1' })
  return { run, db, remove, fetchImpl }
}

describe('通知队列处理器', () => {
  it('汇率立即获取：在租户上下文里获取并保存', async () => {
    const { run, db, fetchImpl } = setup()
    const result = (await run({ tenantId: 't1', kind: 'fx-fetch' })) as { saved: number }
    expect(result.saved).toBe(1)
    expect(fetchImpl).toHaveBeenCalled()
    expect(db.fxRate.create).toHaveBeenCalled()
  })

  it('取消订阅与事件重放按载荷分发', async () => {
    const { run, remove } = setup()
    expect(await run({ tenantId: 't1', kind: 'subscription-delete', subscriptionRowId: 'sub1' })).toEqual({ status: 'DELETED' })
    expect(remove).toHaveBeenCalledWith('ORDER_CHANGE', 'amz-1')
    expect(await run({ tenantId: 't1', kind: 'events-replay', eventIds: ['e1'] })).toEqual({ processed: 0, failed: 0 })
  })

  it('载荷缺少编号或类型未知：不重试', async () => {
    const { run } = setup()
    await expect(run({ tenantId: 't1', kind: 'subscription-create' })).rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID', retryable: false })
    await expect(run({ tenantId: 't1', kind: 'events-replay', eventIds: [1] })).rejects.toMatchObject({ code: 'JOB_PAYLOAD_INVALID' })
    await expect(run({ tenantId: 't1', kind: 'something-else' })).rejects.toMatchObject({ code: 'NOTIFICATION_KIND_UNKNOWN', retryable: false })
    await expect(run({ tenantId: 't1' })).rejects.toMatchObject({ code: 'NOTIFICATION_KIND_UNKNOWN' })
  })
})
