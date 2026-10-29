import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  delete process.env.AMAZON_NOTIFICATION_DESTINATION_ID
  await harness?.close()
  harness = undefined
})

const prismaFor = (permissions: string[], over: Record<string, any> = {}) => ({
  ...sessionStub(permissions),
  tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
  sellerAccount: { findMany: vi.fn().mockResolvedValue([{ id: 's1' }]) },
  storeDailySummary: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  hourlySalesEvent: { findMany: vi.fn().mockResolvedValue([]) },
  hourlyTrafficEvent: { findMany: vi.fn().mockResolvedValue([]) },
  hourlyInventoryEvent: { findMany: vi.fn().mockResolvedValue([]) },
  entityEvent: { findMany: vi.fn().mockResolvedValue([]) },
  ...over,
})

describe('今日实时接口（P2a-03）', () => {
  it.each(['summary', 'hourly', 'events'])('%s：未登录 401，没有 overview.read 403', async path => {
    harness = await createTestApp(prismaFor(['products.read']))
    expect((await harness.call('GET', `/today/${path}`, { auth: false })).status).toBe(401)
    expect((await harness.call('GET', `/today/${path}`)).status).toBe(403)
  })

  it('接收端未配置：summary / hourly 返回 NOT_CONNECTED，广告区未接入，不含假数字冒充实时', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    const summary = await harness.call('GET', '/today/summary')
    expect(summary.status).toBe(200)
    expect(summary.json.data).toMatchObject({
      realtimeState: 'NOT_CONNECTED',
      ads: { state: 'NOT_CONNECTED', workPackage: 'P3-06' },
      inventory: { state: 'NOT_CONNECTED', outOfStock: [], predictedStockout: [] },
    })
    expect(summary.json.data.note).toContain('AMAZON_NOTIFICATION_DESTINATION_ID')
    const hourly = await harness.call('GET', '/today/hourly')
    expect(hourly.json.data).toMatchObject({ realtimeState: 'NOT_CONNECTED', anomalies: [] })
    expect(hourly.json.data.hours.every((h: { band: unknown }) => h.band === null)).toBe(true)
  })

  it('接收端已配置但无小时事件：NO_DATA；站点非法 422', async () => {
    process.env.AMAZON_NOTIFICATION_DESTINATION_ID = 'dest-1'
    harness = await createTestApp(prismaFor(['overview.read']))
    const summary = await harness.call('GET', '/today/summary')
    expect(summary.json.data.realtimeState).toBe('NO_DATA')
    expect((await harness.call('GET', '/today/summary?marketplaceId=A1F83G8C2ARO7P')).status).toBe(422)
  })

  it('events 游标页大小超限 422', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/today/events?pageSize=201')).status).toBe(422)
  })
})
