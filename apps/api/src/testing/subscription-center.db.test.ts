import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 消息推送订阅页（P5-05，真实数据库 + 完整应用）：列表按数据范围与企业隔离；订阅（接收端、店铺授权、重复）、改过滤条件（乐观并发）、
// 取消（未创建的直接删，已创建的交后台任务）、重放失败事件（只重置本订阅类型与店铺的失败事件）；每次写入留审计并排对应后台任务。

type Member = { userId: string; token: string }
type Item = {
  id: string | null
  sellerAccountId: string
  notificationType: string
  state: string
  events24h: number
  failures24h: number
  version: number | null
  actions: Record<string, { allowed: boolean; reason: string | null }>
}
const DESTINATION = 'arn:aws:sqs:us-east-1:111122223333:nova-dbtest'
const HOUR = 3_600_000

describe('消息推送订阅页（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeA2: string
  let admin: Member
  let reader: Member
  let scopedA: Member
  let otherAdmin: Member
  const savedEnv = process.env.AMAZON_NOTIFICATION_DESTINATION_ID

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const list = async (member: Member) => {
    const res = await h.call(member.token, 'GET', '/notifications/subscriptions')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as {
      destination: { configured: boolean }
      canManage: boolean
      stores: { id: string; authorized: boolean }[]
      items: Item[]
      summary: Record<string, number>
      affectedPages: unknown[]
    }
  }
  const itemOf = (data: Awaited<ReturnType<typeof list>>, store: string, type: string) => data.items.find(item => item.sellerAccountId === store && item.notificationType === type)!
  const subscribe = (member: Member, sellerAccountId: string, notificationType: string, filter?: unknown) =>
    h.call(member.token, 'POST', '/notifications/subscriptions', { body: { sellerAccountId, notificationType, ...(filter ? { filter } : {}) } })
  const subRows = (type?: string) =>
    rows<{ id: string; status: string; version: number; subscriptionId: string; filterJson: unknown; sellerAccountId: string }>(
      `SELECT id, status, version, "subscriptionId", "filterJson", "sellerAccountId" FROM "NotificationSubscription" WHERE "tenantId" = $1 ${type ? `AND "notificationType" = '${type}'` : ''} ORDER BY id`,
      [tenantId],
    )
  const audits = (action: string) => rows<{ resourceId: string }>(`SELECT "resourceId" FROM "AuditEvent" WHERE action = $1 AND "tenantId" = $2 AND result = 'SUCCEEDED'`, [action, tenantId])
  const queued = (kind: string) => h.queue.add.mock.calls.filter(call => (call[1] as { kind?: string }).kind === kind)
  const insertSub = (id: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'NotificationSubscription', {
      id,
      tenantId,
      sellerAccountId: storeA,
      destinationId: DESTINATION,
      notificationType: 'ORDER_CHANGE',
      subscriptionId: '',
      status: 'NOT_CREATED',
      ...over,
    })
  const insertEvent = (id: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'AmazonNotificationEvent', {
      id,
      tenantId,
      sellerAccountId: storeA,
      notificationId: `n-${id}`,
      notificationType: 'ORDER_CHANGE',
      receivedAt: new Date(Date.now() - HOUR).toISOString(),
      payloadObjectKey: `k/${id}`,
      status: 'PROCESSED',
      ...over,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'sub_center' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '主店' WHERE id = $1`, [storeA])
    storeA2 = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeA2, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '二店' })
    // 主店有有效授权，二店没有
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-a',
      tenantId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'SEALED',
      sellerAccountId: storeA,
      externalAccountId: 'SELLER-A',
    })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-a2',
      tenantId,
      provider: 'AMAZON_SP_API',
      state: 'REVOKED',
      encryptedRefreshToken: null,
      sellerAccountId: storeA2,
      externalAccountId: 'SELLER-A2',
    })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-b',
      tenantId: otherTenantId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'SEALED',
      sellerAccountId: b.sellerAccountId,
    })
    admin = await h.createMember(tenantId, 'admin', ['connection.read', 'notifications.manage'])
    reader = await h.createMember(tenantId, 'reader', ['connection.read'])
    scopedA = await h.createMember(tenantId, 'scopeda', ['connection.read', 'notifications.manage'], { scopes: [{ sellerAccountId: storeA }] })
    otherAdmin = await h.createMember(otherTenantId, 'otheradmin', ['connection.read', 'notifications.manage'])
  })
  afterAll(async () => {
    if (savedEnv === undefined) delete process.env.AMAZON_NOTIFICATION_DESTINATION_ID
    else process.env.AMAZON_NOTIFICATION_DESTINATION_ID = savedEnv
    await h?.close()
  })
  beforeEach(async () => {
    process.env.AMAZON_NOTIFICATION_DESTINATION_ID = DESTINATION
    h.queue.add.mockClear()
    await h.client.query(`DELETE FROM "AmazonNotificationEvent" WHERE "tenantId" = $1`, [tenantId])
    await h.client.query(`DELETE FROM "NotificationSubscription" WHERE "tenantId" = $1`, [tenantId])
  })

  it('接收端没配置：列表是正式的“接收端未接入”，订阅返回 503，库里什么都不写', async () => {
    delete process.env.AMAZON_NOTIFICATION_DESTINATION_ID
    const data = await list(admin)
    expect(data.destination.configured).toBe(false)
    expect(data.affectedPages.length).toBeGreaterThan(5)
    expect(data.items.every(item => item.state === 'DESTINATION_MISSING')).toBe(true)
    const res = await subscribe(admin, storeA, 'ORDER_CHANGE')
    expect(res.status).toBe(503)
    expect(await subRows()).toEqual([])
    expect(queued('subscription-create')).toHaveLength(0)
  })

  it('列表：主店未订阅、二店没有有效授权；免授权类型二店也能订阅；只读成员动作全禁用、管理员可订阅', async () => {
    const data = await list(admin)
    expect(data.canManage).toBe(true)
    expect(data.stores).toEqual([
      { id: storeA, displayName: '主店', authorized: true },
      { id: storeA2, displayName: '二店', authorized: false },
    ])
    expect(itemOf(data, storeA, 'ORDER_CHANGE')).toMatchObject({ id: null, state: 'NOT_SUBSCRIBED' })
    expect(itemOf(data, storeA, 'ORDER_CHANGE').actions.subscribe.allowed).toBe(true)
    expect(itemOf(data, storeA2, 'ORDER_CHANGE').state).toBe('STORE_NOT_AUTHORIZED')
    expect(itemOf(data, storeA2, 'ORDER_CHANGE').actions.subscribe.reason).toContain('连接中心')
    expect(itemOf(data, storeA2, 'SHIPMENT_TRACKING_MILESTONE_CHANGED').state).toBe('NOT_SUBSCRIBED')
    const readOnly = await list(reader)
    expect(readOnly.canManage).toBe(false)
    expect(readOnly.items.every(item => Object.values(item.actions).every(action => !action.allowed))).toBe(true)
  })

  it('订阅：登记一条待创建记录、写审计、排创建任务；重复订阅 409；没有授权的店铺 409；只读成员 403', async () => {
    const res = await subscribe(admin, storeA, 'ORDER_CHANGE')
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    const [row] = await subRows('ORDER_CHANGE')
    expect(row).toMatchObject({ status: 'NOT_CREATED', version: 1, subscriptionId: '', sellerAccountId: storeA })
    expect(res.json.data).toEqual({ id: row!.id, status: 'NOT_CREATED' })
    expect(await audits('NOTIFICATION_SUBSCRIPTION_REQUESTED')).toHaveLength(1)
    expect(queued('subscription-create')).toHaveLength(1)
    expect(itemOf(await list(admin), storeA, 'ORDER_CHANGE')).toMatchObject({ id: row!.id, state: 'PENDING', version: 1 })

    expect((await subscribe(admin, storeA, 'ORDER_CHANGE')).status).toBe(409)
    const noAuth = await subscribe(admin, storeA2, 'ORDER_CHANGE')
    expect(noAuth.status).toBe(409)
    expect(noAuth.json.error.code).toBe('FBA_CONNECTION_REQUIRED')
    expect((await subscribe(admin, storeA2, 'SHIPMENT_TRACKING_MILESTONE_CHANGED')).status).toBe(202)
    expect((await subscribe(reader, storeA, 'TRANSACTION_UPDATE')).status).toBe(403)
    expect((await subRows()).length).toBe(2)
  })

  it('订阅的参数：不支持的类型与不支持过滤的类型带过滤条件是 422；店铺不存在 404；过滤条件原样存下', async () => {
    expect((await subscribe(admin, storeA, 'NOT_A_TYPE')).status).toBe(422)
    expect((await subscribe(admin, storeA, 'ORDER_CHANGE', { aggregationTimePeriod: 'FiveMinutes' })).status).toBe(422)
    expect((await subscribe(admin, 'seller-none', 'ORDER_CHANGE')).status).toBe(404)
    const filter = { marketplaceIds: ['ATVPDKIKX0DER'], aggregationTimePeriod: 'TenMinutes' }
    expect((await subscribe(admin, storeA, 'ANY_OFFER_CHANGED', filter)).status).toBe(202)
    expect((await subRows('ANY_OFFER_CHANGED'))[0]?.filterJson).toEqual(filter)
    expect(await subRows()).toHaveLength(1)
  })

  it('数据范围：只管主店的成员看不到二店；订阅二店 404；别家企业的订阅编号一律 404', async () => {
    const scoped = await list(scopedA)
    expect(scoped.stores.map(store => store.id)).toEqual([storeA])
    expect(scoped.items.every(item => item.sellerAccountId === storeA)).toBe(true)
    expect((await subscribe(scopedA, storeA2, 'SHIPMENT_TRACKING_MILESTONE_CHANGED')).status).toBe(404)
    expect((await subscribe(scopedA, storeA, 'ORDER_CHANGE')).status).toBe(202)

    await insertSub('sub-a2', { sellerAccountId: storeA2, notificationType: 'TRANSACTION_UPDATE' })
    const [mine] = await subRows('ORDER_CHANGE')
    expect((await h.call(scopedA.token, 'DELETE', '/notifications/subscriptions/sub-a2')).status).toBe(404)
    expect((await h.call(scopedA.token, 'POST', '/notifications/subscriptions/sub-a2/replay', { body: { allFailed: true } })).status).toBe(404)
    expect((await h.call(otherAdmin.token, 'DELETE', `/notifications/subscriptions/${mine!.id}`)).status).toBe(404)
    expect((await h.call(otherAdmin.token, 'POST', `/notifications/subscriptions/${mine!.id}/replay`, { body: { allFailed: true } })).status).toBe(404)
    const others = await list(otherAdmin)
    expect(others.items.every(item => item.id === null)).toBe(true)
    expect(await rows(`SELECT id FROM "NotificationSubscription" WHERE id = $1`, [mine!.id])).toHaveLength(1)
  })

  it('改过滤条件：版本号不对 409；成功后回到待创建、版本加一、排重建任务并写审计；不支持过滤的类型 422', async () => {
    await insertSub('sub-offer', { notificationType: 'ANY_OFFER_CHANGED', subscriptionId: 'amz-1', status: 'ACTIVE', version: 4 })
    await insertSub('sub-order', { notificationType: 'ORDER_CHANGE', subscriptionId: 'amz-2', status: 'ACTIVE' })
    const patch = (id: string, body: Record<string, unknown>) => h.call(admin.token, 'PATCH', `/notifications/subscriptions/${id}`, { body })
    const stale = await patch('sub-offer', { version: 3, filter: { aggregationTimePeriod: 'FiveMinutes' } })
    expect(stale.status).toBe(409)
    expect((await patch('sub-order', { version: 1, filter: { aggregationTimePeriod: 'FiveMinutes' } })).status).toBe(422)

    const res = await patch('sub-offer', { version: 4, filter: { aggregationTimePeriod: 'FiveMinutes' } })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data).toMatchObject({ id: 'sub-offer', status: 'NOT_CREATED', version: 5 })
    const [row] = await subRows('ANY_OFFER_CHANGED')
    expect(row).toMatchObject({ status: 'NOT_CREATED', version: 5, filterJson: { aggregationTimePeriod: 'FiveMinutes' } })
    expect(queued('subscription-create')).toHaveLength(1)
    expect(await audits('NOTIFICATION_SUBSCRIPTION_UPDATED')).toHaveLength(1)
    expect((await h.call(reader.token, 'PATCH', '/notifications/subscriptions/sub-offer', { body: { version: 5, filter: {} } })).status).toBe(403)
  })

  it('取消：没有亚马逊订阅编号的直接删除；已创建的交后台任务（记录先保留）；都写审计', async () => {
    await insertSub('sub-new', { notificationType: 'ORDER_CHANGE' })
    await insertSub('sub-live', { notificationType: 'TRANSACTION_UPDATE', subscriptionId: 'amz-9', status: 'ACTIVE' })
    const first = await h.call(admin.token, 'DELETE', '/notifications/subscriptions/sub-new')
    expect(first.status).toBe(200)
    expect(first.json.data).toEqual({ id: 'sub-new', removed: true })
    const second = await h.call(admin.token, 'DELETE', '/notifications/subscriptions/sub-live')
    expect(second.json.data).toEqual({ id: 'sub-live', removed: false })
    expect((await subRows()).map(row => row.id)).toEqual(['sub-live'])
    expect(queued('subscription-delete')).toHaveLength(1)
    expect(await audits('NOTIFICATION_SUBSCRIPTION_DELETED')).toHaveLength(2)
    expect((await h.call(reader.token, 'DELETE', '/notifications/subscriptions/sub-live')).status).toBe(403)
  })

  it('近 24 小时事件数与失败数按店铺与类型现算：超过 24 小时的不算，别的店铺与类型不混', async () => {
    await insertSub('sub-order', { subscriptionId: 'amz-1', status: 'ACTIVE' })
    await insertEvent('e1', {})
    await insertEvent('e2', { status: 'FAILED', errorCode: 'PROCESSING_FAILED' })
    await insertEvent('e3', { receivedAt: new Date(Date.now() - 30 * HOUR).toISOString(), status: 'FAILED' })
    await insertEvent('e4', { sellerAccountId: storeA2 })
    await insertEvent('e5', { notificationType: 'TRANSACTION_UPDATE', status: 'FAILED' })
    const data = await list(admin)
    expect(itemOf(data, storeA, 'ORDER_CHANGE')).toMatchObject({ state: 'ACTIVE', events24h: 2, failures24h: 1 })
    expect(itemOf(data, storeA, 'ORDER_CHANGE').actions.replay.allowed).toBe(true)
    expect(itemOf(data, storeA2, 'ORDER_CHANGE')).toMatchObject({ events24h: 1, failures24h: 0 })
    expect(itemOf(data, storeA, 'TRANSACTION_UPDATE')).toMatchObject({ events24h: 1, failures24h: 1 })
    expect(data.summary).toMatchObject({ rows: 1, active: 1, events24h: 4, failures24h: 2 })
  })

  it('重放：只重置本店铺本类型的失败事件并排处理任务；没有失败事件 409；指定的事件编号也只认本订阅范围内的失败事件', async () => {
    await insertSub('sub-order', { subscriptionId: 'amz-1', status: 'ACTIVE' })
    await insertEvent('f1', { status: 'FAILED', errorCode: 'PROCESSING_FAILED' })
    await insertEvent('f2', { status: 'FAILED', errorCode: 'PROCESSOR_NOT_AVAILABLE' })
    await insertEvent('f3', { sellerAccountId: storeA2, status: 'FAILED' })
    await insertEvent('f4', { notificationType: 'TRANSACTION_UPDATE', status: 'FAILED' })
    await insertEvent('p1', {})
    const replay = (body: Record<string, unknown>) => h.call(admin.token, 'POST', '/notifications/subscriptions/sub-order/replay', { body })
    expect((await replay({ eventIds: ['f3', 'f4', 'p1'] })).status).toBe(409) // 不属于本订阅或不是失败事件
    const res = await replay({ allFailed: true })
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    expect(res.json.data).toEqual({ replayed: 2 })
    const state = Object.fromEntries(
      (await rows<{ id: string; status: string; errorCode: string | null }>(`SELECT id, status, "errorCode" FROM "AmazonNotificationEvent" WHERE "tenantId" = $1`, [tenantId])).map(row => [
        row.id,
        row,
      ]),
    )
    expect(state.f1).toMatchObject({ status: 'RECEIVED', errorCode: null })
    expect(state.f2).toMatchObject({ status: 'RECEIVED', errorCode: null })
    expect(state.f3?.status).toBe('FAILED')
    expect(state.f4?.status).toBe('FAILED')
    expect(state.p1?.status).toBe('PROCESSED')
    const jobs = queued('events-replay')
    expect(jobs).toHaveLength(1)
    expect([...(jobs[0]![1] as { eventIds: string[] }).eventIds].sort()).toEqual(['f1', 'f2'])
    expect(await audits('NOTIFICATION_EVENTS_REPLAYED')).toHaveLength(1)
    expect((await replay({ allFailed: true })).status).toBe(409) // 已经没有失败事件
    expect((await h.call(reader.token, 'POST', '/notifications/subscriptions/sub-order/replay', { body: { allFailed: true } })).status).toBe(403)
  })
})
