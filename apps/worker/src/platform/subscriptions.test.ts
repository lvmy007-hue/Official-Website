import { NonRetryableError } from '@nova/workflow'
import { describe, expect, it, vi } from 'vitest'
import { UpstreamHttpError } from '../connectors/http-error'
import { createSubscription, deleteSubscription, subscriptionBody, type NotificationsApi } from './subscriptions'

const ENV = { AMAZON_NOTIFICATION_DESTINATION_ID: 'dest-1' }
const connection = { id: 'c1', sellerAccountId: 's1', encryptedRefreshToken: 'cipher' }

function makeDb(rows: Array<Record<string, any>>, conn: unknown = connection) {
  const db = {
    notificationSubscription: {
      findFirst: vi.fn(async ({ where }: any) => rows.find(row => row.id === where.id && row.tenantId === where.tenantId) ?? null),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.find(item => item.id === where.id)!
        const { version, ...rest } = data
        Object.assign(row, rest, version ? { version: row.version + 1 } : {})
        return { count: 1 }
      }),
      deleteMany: vi.fn(async ({ where }: any) => {
        const index = rows.findIndex(item => item.id === where.id)
        if (index >= 0) rows.splice(index, 1)
        return { count: 1 }
      }),
    },
    platformConnection: { findFirst: vi.fn(async () => conn) },
  }
  return db
}
const row = (over: Record<string, any> = {}) => ({
  id: 'sub1',
  tenantId: 't1',
  sellerAccountId: 's1',
  destinationId: 'dest-1',
  notificationType: 'ORDER_CHANGE',
  subscriptionId: '',
  filterJson: null,
  status: 'NOT_CREATED',
  version: 1,
  ...over,
})
const upstream = (status: number, source: 'api' | 'lwa' = 'api') => new UpstreamHttpError(`E${status}`, status, undefined, source)

function makeApi(over: Partial<NotificationsApi> = {}) {
  const api = {
    create: vi.fn(async () => ({ subscriptionId: 'amz-sub-1' })),
    remove: vi.fn(async () => undefined),
    ...over,
  }
  const factory = vi.fn(() => api)
  return { api, factory }
}

describe('订阅请求体', () => {
  it('不支持过滤的类型忽略过滤条件；支持的类型带站点与聚合周期', () => {
    expect(subscriptionBody('ORDER_CHANGE', 'd', { aggregationTimePeriod: 'FiveMinutes' })).toEqual({ payloadVersion: '1.0', destinationId: 'd' })
    expect(subscriptionBody('ANY_OFFER_CHANGED', 'd', null)).toEqual({ payloadVersion: '1.0', destinationId: 'd' })
    expect(subscriptionBody('ANY_OFFER_CHANGED', 'd', { marketplaceIds: ['ATVPDKIKX0DER'], aggregationTimePeriod: 'TenMinutes' })).toEqual({
      payloadVersion: '1.0',
      destinationId: 'd',
      processingDirective: { eventFilter: { eventFilterType: 'ANY_OFFER_CHANGED', marketplaceIds: ['ATVPDKIKX0DER'], aggregationSettings: { aggregationTimePeriod: 'TenMinutes' } } },
    })
  })

  it('报告处理完成等类型用各自的负载版本', () => {
    expect(subscriptionBody('REPORT_PROCESSING_FINISHED', 'd', null).payloadVersion).toBe('2020-09-18')
  })
})

describe('创建订阅', () => {
  it('成功：保存亚马逊返回的订阅编号并置为有效；用该店铺的授权', async () => {
    const rows = [row()]
    const { api, factory } = makeApi()
    expect(await createSubscription({ db: makeDb(rows) as never, api: factory, env: ENV }, 't1', 'sub1')).toEqual({ status: 'ACTIVE' })
    expect(rows[0]).toMatchObject({ subscriptionId: 'amz-sub-1', status: 'ACTIVE', version: 2 })
    expect(factory.mock.calls[0][0]).toMatchObject({ grantless: false, connection, tenantId: 't1' })
    expect(api.create).toHaveBeenCalledWith('ORDER_CHANGE', { payloadVersion: '1.0', destinationId: 'dest-1' })
    expect(api.remove).not.toHaveBeenCalled()
  })

  it('免授权类型（货件追踪节点）：不需要店铺授权', async () => {
    const rows = [row({ notificationType: 'SHIPMENT_TRACKING_MILESTONE_CHANGED' })]
    const { factory } = makeApi()
    const db = makeDb(rows, null)
    await createSubscription({ db: db as never, api: factory, env: ENV }, 't1', 'sub1')
    expect(db.platformConnection.findFirst).not.toHaveBeenCalled()
    expect(factory.mock.calls[0][0]).toMatchObject({ grantless: true, connection: null })
    expect(rows[0].status).toBe('ACTIVE')
  })

  it('更新过滤条件：先取消旧订阅（对方已不存在也算取消）再按新条件创建', async () => {
    const rows = [row({ notificationType: 'ANY_OFFER_CHANGED', subscriptionId: 'old', filterJson: { aggregationTimePeriod: 'FiveMinutes' }, status: 'NOT_CREATED' })]
    const { api, factory } = makeApi({ remove: vi.fn(async () => Promise.reject(upstream(404))) })
    await createSubscription({ db: makeDb(rows) as never, api: factory, env: ENV }, 't1', 'sub1')
    expect(api.remove).toHaveBeenCalledWith('ANY_OFFER_CHANGED', 'old')
    expect((api.create.mock.calls[0] as unknown[])[1]).toMatchObject({ processingDirective: { eventFilter: { aggregationSettings: { aggregationTimePeriod: 'FiveMinutes' } } } })
    expect(rows[0]).toMatchObject({ subscriptionId: 'amz-sub-1', status: 'ACTIVE' })
  })

  it('接收端没配置：不重试，订阅保持“未创建”，也不调用亚马逊', async () => {
    const rows = [row()]
    const { api, factory } = makeApi()
    await expect(createSubscription({ db: makeDb(rows) as never, api: factory, env: {} }, 't1', 'sub1')).rejects.toMatchObject({ code: 'DESTINATION_NOT_CONFIGURED', retryable: false })
    expect(rows[0].status).toBe('NOT_CREATED')
    expect(api.create).not.toHaveBeenCalled()
  })

  it('店铺没有有效授权：不重试', async () => {
    await expect(createSubscription({ db: makeDb([row()], null) as never, api: makeApi().factory, env: ENV }, 't1', 'sub1')).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('亚马逊拒绝（400/403）：订阅标记为已失效且不重试；限流与服务端错误原样抛出等待重试，状态不变', async () => {
    const rejected = [row()]
    await expect(
      createSubscription({ db: makeDb(rejected) as never, api: makeApi({ create: vi.fn(async () => Promise.reject(upstream(403))) }).factory, env: ENV }, 't1', 'sub1'),
    ).rejects.toMatchObject({ code: 'SUBSCRIPTION_REJECTED' })
    expect(rejected[0].status).toBe('INVALID')
    for (const status of [429, 500, 503]) {
      const rows = [row()]
      await expect(
        createSubscription({ db: makeDb(rows) as never, api: makeApi({ create: vi.fn(async () => Promise.reject(upstream(status))) }).factory, env: ENV }, 't1', 'sub1'),
      ).rejects.toBeInstanceOf(UpstreamHttpError)
      expect(rows[0].status).toBe('NOT_CREATED')
    }
  })

  it('记录不存在（已被删除）：跳过；只按租户查，别的租户的订阅看不到', async () => {
    const { factory } = makeApi()
    expect(await createSubscription({ db: makeDb([]) as never, api: factory, env: ENV }, 't1', 'sub1')).toEqual({ status: 'SKIPPED' })
    expect(await createSubscription({ db: makeDb([row({ tenantId: 't2' })]) as never, api: factory, env: ENV }, 't1', 'sub1')).toEqual({ status: 'SKIPPED' })
  })
})

describe('取消订阅', () => {
  it('取消成功后删除记录；对方已不存在也算成功；其他错误保留记录以便重试', async () => {
    const rows = [row({ subscriptionId: 'amz-1', status: 'ACTIVE' })]
    const { api, factory } = makeApi()
    expect(await deleteSubscription({ db: makeDb(rows) as never, api: factory }, 't1', 'sub1')).toEqual({ status: 'DELETED' })
    expect(api.remove).toHaveBeenCalledWith('ORDER_CHANGE', 'amz-1')
    expect(rows).toHaveLength(0)
    const gone = [row({ subscriptionId: 'amz-1' })]
    await deleteSubscription({ db: makeDb(gone) as never, api: makeApi({ remove: vi.fn(async () => Promise.reject(upstream(404))) }).factory }, 't1', 'sub1')
    expect(gone).toHaveLength(0)
    const failing = [row({ subscriptionId: 'amz-1' })]
    await expect(deleteSubscription({ db: makeDb(failing) as never, api: makeApi({ remove: vi.fn(async () => Promise.reject(upstream(500))) }).factory }, 't1', 'sub1')).rejects.toBeInstanceOf(
      UpstreamHttpError,
    )
    expect(failing).toHaveLength(1)
  })

  it('从没在亚马逊创建成功过（没有订阅编号）：直接删除记录，不调用亚马逊', async () => {
    const rows = [row()]
    const { api, factory } = makeApi()
    await deleteSubscription({ db: makeDb(rows) as never, api: factory }, 't1', 'sub1')
    expect(api.remove).not.toHaveBeenCalled()
    expect(rows).toHaveLength(0)
  })
})
