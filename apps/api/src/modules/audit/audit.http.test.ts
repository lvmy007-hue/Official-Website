import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const event = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  occurredAt: new Date('2026-10-25T08:00:00Z'),
  actorId: 'user-2',
  action: 'ORDER_BUYER_PII_VIEWED',
  resourceType: 'Order',
  resourceId: 'o1',
  requestId: 'req-1',
  result: 'SUCCEEDED',
  reason: '客户来电核对收货信息',
  source: 'PAGE',
  page: '/app/orders',
  detail: { outcome: 'OK', amazonOrderId: '111-2222222-3333333', fields: ['buyerName', 'buyerPhone'] },
  ...over,
})

function stubs(permissions: string[], rows: unknown[] = []) {
  const base = sessionStub(permissions)
  return {
    ...base,
    membership: { ...base.membership, findMany: vi.fn().mockResolvedValue([{ userId: 'user-2', user: { displayName: '林客服', email: 'lin@example.com' } }]) },
    auditEvent: {
      findMany: vi.fn().mockResolvedValue(rows),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    alertRule: { findFirst: vi.fn().mockResolvedValue(null) },
  }
}

describe('审计接口', () => {
  it('四个接口都需要审计读取权限，没有权限先 403（不先报参数错误）', async () => {
    harness = await createTestApp(stubs(['orders.read']))
    for (const path of ['/audit', '/audit?pageSize=999', '/audit/options', '/audit/pii-views', '/audit/a1']) expect((await harness.call('GET', path)).status, path).toBe(403)
  })

  it('列表：服务端筛选条件带租户，行里有操作人姓名、来源与所属页面；没有导出权限时说明原因', async () => {
    const prisma = stubs(['audit.read'], [event()])
    harness = await createTestApp(prisma)
    const res = await harness.call('GET', '/audit?action=ORDER_BUYER_PII_VIEWED&source=PAGE&result=SUCCEEDED')
    expect(res.status).toBe(200)
    expect(res.json.data.items[0]).toMatchObject({ id: 'a1', actor: { name: '林客服', kind: 'USER' }, source: 'PAGE', sourceLabel: '页面操作', page: '/app/orders' })
    expect(res.json.data).toMatchObject({ canExport: false })
    expect(res.json.data.exportBlockedReason).toContain('export.create')
    const where = JSON.stringify(prisma.auditEvent.findMany.mock.calls[0][0].where)
    expect(where).toContain('tenant-1')
    expect(where).toContain('ORDER_BUYER_PII_VIEWED')
  })

  it('列表：未知参数与超限的页大小返回 422', async () => {
    harness = await createTestApp(stubs(['audit.read']))
    expect((await harness.call('GET', '/audit?pageSize=999')).status).toBe(422)
    expect((await harness.call('GET', '/audit?nope=1')).status).toBe(422)
    expect((await harness.call('GET', '/audit?fromAt=2026-10-02T00:00:00Z&toAt=2026-10-01T00:00:00Z')).status).toBe(422)
  })

  it('筛选项与明文查看列表是静态路径，不会被当成审计编号；没有数据时是空列表而不是 0', async () => {
    harness = await createTestApp(stubs(['audit.read']))
    expect((await harness.call('GET', '/audit/options')).json.data).toMatchObject({ actions: [], resourceTypes: [], pages: [], actors: [], truncated: false })
    const pii = await harness.call('GET', '/audit/pii-views')
    expect(pii.status).toBe(200)
    expect(pii.json.data).toMatchObject({ items: [], alertRule: null })
  })

  it('明文查看：写明查看的人、理由、订单与字段名（不含内容）', async () => {
    harness = await createTestApp(stubs(['audit.read'], [event()]))
    const res = await harness.call('GET', '/audit/pii-views')
    expect(res.json.data.items[0]).toMatchObject({
      actor: { name: '林客服' },
      reason: '客户来电核对收货信息',
      object: { label: '111-2222222-3333333', path: '/app/orders/o1' },
      fields: ['姓名', '电话'],
      outcome: 'OK',
    })
  })

  it('详情：不存在的审计编号返回 404', async () => {
    harness = await createTestApp(stubs(['audit.read']))
    expect((await harness.call('GET', '/audit/missing')).status).toBe(404)
  })
})
