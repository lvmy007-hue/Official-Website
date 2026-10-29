import { afterEach, describe, expect, it, vi } from 'vitest'
import { EVENT_PER_TYPE_LIMIT } from '@nova/api-contracts'
import { createTestApp } from '../../testing/harness'
import { prismaFor } from '../inventory/inventory-http.test-helper'
import { resolveWindow } from './events-window'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const NOW = new Date('2026-10-20T12:00:00Z')
const ALL = ['products.read', 'pricing.read', 'ads.read', 'alerts.read', 'listing.read', 'audit.read']

/** 事件来源表的替身：都返回空；单个用例按需覆盖。 */
function eventsPrisma(permissions: string[], over: Record<string, unknown> = {}) {
  const empty = () => ({ findMany: vi.fn().mockResolvedValue([]) })
  const prisma = prismaFor(permissions, {
    fbaProduct: { findFirst: vi.fn().mockResolvedValue({ sellerAccountId: 's1', asin: 'B0TEST0001', sellerSku: 'SKU-1' }) },
    operationLog: empty(),
    entityEvent: empty(),
    listingWriteRun: empty(),
    adsProfile: empty(),
    adsChangeLog: empty(),
    alertInstance: empty(),
    listingChangeEvent: empty(),
    auditEvent: empty(),
    ...over,
  })
  prisma.membership.findMany = vi.fn().mockResolvedValue([{ userId: 'user-1', user: { displayName: '甲', email: 'a@x.com' } }])
  return prisma
}

const url = (params: Record<string, string> = {}) => `/events?${new URLSearchParams({ objectType: 'ASIN', objectId: 'p1', ...params }).toString()}`

describe('统一事件：权限、范围与参数', () => {
  it('没有登录 401；没有对象读权限 403，且先于参数校验（坏类型也是 403）', async () => {
    harness = await createTestApp(eventsPrisma([]))
    expect((await harness.call('GET', url(), { auth: false })).status).toBe(401)
    expect((await harness.call('GET', url())).status).toBe(403)
    expect((await harness.call('GET', url({ types: 'NOPE', from: 'bad' }))).status).toBe(403)
    expect((await harness.call('GET', url({ objectType: 'STORE', objectId: 's1' }))).status).toBe(403)
  })

  it('参数不合法 422：缺对象、不认识的对象类型或事件类型、坏日期、开始晚于结束、跨度超过 400 天', async () => {
    harness = await createTestApp(eventsPrisma(['products.read']))
    const cases: Array<Record<string, string>> = [{ types: 'NOPE' }, { from: 'bad' }, { from: '2026-10-10', to: '2026-10-01' }, { from: '2024-01-01', to: '2026-10-01' }]
    for (const bad of cases) {
      expect((await harness.call('GET', url(bad))).status, JSON.stringify(bad)).toBe(422)
    }
    expect((await harness.call('GET', '/events')).status).toBe(422)
    expect((await harness.call('GET', url({ objectType: 'NOPE' }))).status).toBe(422)
  })

  it('商品不在数据范围内或不存在：404，查询条件带企业与对象编号', async () => {
    const prisma = eventsPrisma(['products.read'])
    prisma.fbaProduct.findFirst.mockResolvedValue(null)
    harness = await createTestApp(prisma)
    expect((await harness.call('GET', url())).status).toBe(404)
    expect(prisma.fbaProduct.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'p1', tenantId: 'tenant-1' })
    expect(prisma.operationLog.findMany).not.toHaveBeenCalled()
  })

  it('没有读权限的类型不查库，列在 unavailableTypes；有权限的类型正常返回', async () => {
    const prisma = eventsPrisma(['products.read'])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', url())
    expect(res.status).toBe(200)
    expect(res.json.data).toMatchObject({ items: [], truncated: false, truncatedTypes: [], unavailableTypes: ['PRICE', 'ADS', 'ALERT', 'LISTING', 'AUDIT'] })
    for (const table of ['listingWriteRun', 'adsChangeLog', 'alertInstance', 'listingChangeEvent', 'auditEvent'] as const) expect(prisma[table].findMany, table).not.toHaveBeenCalled()
    expect(prisma.operationLog.findMany).toHaveBeenCalledTimes(1)
  })

  it('每个来源最多读 201 行，带企业、对象与时间窗；日期按企业时区取整日（太平洋时间，终点是次日零点）', async () => {
    const prisma = eventsPrisma(ALL)
    harness = await createTestApp(prisma)
    await harness.call('GET', url({ from: '2026-10-01', to: '2026-10-10' }))
    const window = { gte: new Date('2026-10-01T07:00:00Z'), lt: new Date('2026-10-11T07:00:00Z') }
    expect(prisma.operationLog.findMany.mock.calls[0][0]).toMatchObject({ where: { tenantId: 'tenant-1', scope: 'ASIN', scopeRef: 'p1', occurredAt: window }, take: EVENT_PER_TYPE_LIMIT + 1 })
    expect(prisma.listingWriteRun.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: 'tenant-1',
      sellerAccountId: 's1',
      kind: 'PRICE_PATCH',
      status: 'SUCCEEDED',
      sellerSku: 'SKU-1',
      createdAt: window,
    })
    expect(prisma.listingChangeEvent.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', OR: [{ sellerSku: 'SKU-1' }, { asin: 'B0TEST0001' }] })
    expect(prisma.alertInstance.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', sellerAccountId: 's1', entityId: { in: ['p1', 'B0TEST0001', 'SKU-1'] } })
    expect(prisma.auditEvent.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 'tenant-1', resourceType: 'FbaProduct', resourceId: 'p1', result: 'SUCCEEDED' })
    // 对象事件表按类型各查一次：价格、广告、预警、Listing 用已登记的种类，“其他”排除全部已登记的种类
    const kinds = prisma.entityEvent.findMany.mock.calls.map((call: [{ where: { kind: unknown } }]) => call[0].where.kind)
    expect(kinds).toHaveLength(5)
    expect(kinds).toContainEqual({ in: ['price.change'] })
    expect(kinds).toContainEqual({ in: ['budget.change'] })
    expect(kinds.find((kind: { notIn?: string[] }) => kind.notIn)).toEqual({ notIn: expect.arrayContaining(['price.change', 'alert', 'content.change']) })
    // 商品没有按商品记录的广告变更：不读广告变更日志
    expect(prisma.adsChangeLog.findMany).not.toHaveBeenCalled()
  })

  it('某一类读满 201 行：只返回最近 200 条并标记截断，别的类型不受影响', async () => {
    const rows = Array.from({ length: EVENT_PER_TYPE_LIMIT + 1 }, (_, i) => ({
      id: `l${i}`,
      category: 'PRICE',
      text: `记录 ${i}`,
      authorId: 'user-1',
      occurredAt: new Date(NOW.getTime() - i * 60_000),
    }))
    const prisma = eventsPrisma(['products.read'], { operationLog: { findMany: vi.fn().mockResolvedValue(rows) } })
    harness = await createTestApp(prisma)
    const { data } = (await harness.call('GET', url({ types: 'OPERATION,OTHER' }))).json
    expect(data.items).toHaveLength(EVENT_PER_TYPE_LIMIT)
    expect(data.items[0].id).toBe('log:l0')
    expect(data).toMatchObject({ truncated: true, truncatedTypes: ['OPERATION'] })
    expect(data.items[0]).toMatchObject({ type: 'OPERATION', title: '运营记录：价格', summary: '记录 0', actor: '甲', link: '/app/products/p1' })
  })

  it('其他对象类型（待办、采购单、库存规则……）只读对象事件表，对象读权限由对象类型决定', async () => {
    const prisma = eventsPrisma(['inventory.read'], {
      entityEvent: { findMany: vi.fn().mockResolvedValue([{ id: 'e1', title: '库存规则 v2 生效', occurredAt: NOW, actorKind: 'SYSTEM', actorId: null, detailJson: null }]) },
    })
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', url({ objectType: 'REPLENISHMENT_POLICY', objectId: 'TENANT:ALL', types: 'OTHER,OPERATION' }))
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.items).toHaveLength(1)
    expect(res.json.data.items[0]).toMatchObject({ id: 'event:e1', type: 'OTHER', actor: '系统' })
    expect(prisma.operationLog.findMany).not.toHaveBeenCalled()
    expect((await harness.call('GET', url({ objectType: 'PURCHASE_ORDER', objectId: 'po1' }))).status).toBe(403)
  })
})

describe('统一事件：时间窗', () => {
  it('没给范围：最近 90 天，终点是此刻之后一毫秒（含此刻）', () => {
    const window = resolveWindow({}, 'UTC', NOW)
    expect(window.to.getTime()).toBe(NOW.getTime() + 1)
    expect(window.to.getTime() - window.from.getTime()).toBe(90 * 86_400_000)
  })

  it('日期按企业时区：起点是当日零点、终点是次日零点；完整时间点原样，终点含该时刻', () => {
    const day = resolveWindow({ from: '2026-10-01', to: '2026-10-01' }, 'Asia/Shanghai', NOW)
    expect(day.from.toISOString()).toBe('2026-09-30T16:00:00.000Z')
    expect(day.to.toISOString()).toBe('2026-10-01T16:00:00.000Z')
    const instant = resolveWindow({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' }, 'Asia/Shanghai', NOW)
    expect(instant.from.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    expect(instant.to.toISOString()).toBe('2026-10-02T00:00:00.001Z')
  })

  it('开始不早于结束、跨度超过 400 天都抛参数错误；正好 400 天通过', () => {
    expect(() => resolveWindow({ from: '2026-10-02', to: '2026-10-01' }, 'UTC', NOW)).toThrow('开始时间必须早于结束时间')
    expect(() => resolveWindow({ from: '2025-01-01', to: '2026-10-01' }, 'UTC', NOW)).toThrow('最多 400 天')
    expect(() => resolveWindow({ from: '2025-08-28', to: '2026-10-01' }, 'UTC', NOW)).not.toThrow()
  })
})
