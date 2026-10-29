import { EXPORT_KINDS } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { auditEvents } from './audit-source'
import { EXPORT_SOURCES } from './sources'

// 审计日志导出源（P5-09）：与页面同一套筛选、不分店铺、操作人导出成名字、列与契约一致、分页续取。

const row = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  occurredAt: new Date('2026-10-25T08:00:00Z'),
  actorId: 'u1',
  action: 'ORDER_BUYER_PII_VIEWED',
  resourceType: 'Order',
  resourceId: 'o1',
  requestId: 'req-1',
  result: 'SUCCEEDED',
  reason: '核对收货信息',
  source: 'PAGE',
  page: '/app/orders',
  detail: { accessMode: 'NORMAL', changes: [{ field: 'phone', before: '13800000000', after: '13900000000' }] },
  ip: '203.0.113.9',
  ...over,
})
const collect = async (iterable: AsyncIterable<unknown>) => {
  const rows: Array<Record<string, unknown>> = []
  for await (const item of iterable) rows.push(item as Record<string, unknown>)
  return rows
}
const members = [{ userId: 'u1', user: { displayName: '林客服', email: 'lin@example.com' } }]
const run = (db: unknown, filters: Record<string, unknown> = {}) => collect(auditEvents({ db: db as never, tenantId: 't1', filters, storeIds: null }))

describe('审计日志导出', () => {
  it('已登记到导出源，契约里的每一列都有取数，且不分店铺', async () => {
    expect(EXPORT_SOURCES['audit-events']).toBe(auditEvents)
    const spec = EXPORT_KINDS.find(item => item.kind === 'audit-events')
    expect(spec?.storeScoped).toBe(false)
    const [first] = await run({ auditEvent: { findMany: vi.fn().mockResolvedValue([row('a')]) }, membership: { findMany: vi.fn().mockResolvedValue(members) } })
    for (const column of spec?.columns ?? []) expect(first, column.key).toHaveProperty(column.key)
  })

  it('字段：操作人写名字；系统任务写“系统”；平台人员写“平台人员”；已离开的成员写固定文案；不导出修改前后的内容', async () => {
    const findMany = vi.fn().mockResolvedValue([row('a'), row('b', { actorId: null, source: 'SYSTEM' }), row('c', { detail: { accessMode: 'SUPPORT' }, actorId: null }), row('d', { actorId: 'gone' })])
    const rows = await run({ auditEvent: { findMany }, membership: { findMany: vi.fn().mockResolvedValue(members) } })
    expect(rows.map(item => item.actorName)).toEqual(['林客服', '系统', '平台人员', '已离开的成员'])
    expect(rows[0]).toMatchObject({ sourceLabel: '页面操作', page: '/app/orders', actionLabel: expect.any(String), resultLabel: '成功', ip: '203.0.113.9' })
    expect(JSON.stringify(rows)).not.toContain('13800000000')
  })

  it('筛选与租户：带租户条件，筛选与列表一致；时间解析不了的丢弃', async () => {
    const findMany = vi.fn().mockResolvedValue([])
    const db = { auditEvent: { findMany }, membership: { findMany: vi.fn() } }
    await run(db, { action: 'LOGIN', result: 'FAILED', source: 'SYSTEM', fromAt: '2026-10-01T00:00:00Z', toAt: 'bad', bogus: 'x' })
    const where = findMany.mock.calls[0][0].where
    expect(where.AND[0]).toEqual({ tenantId: 't1' })
    const text = JSON.stringify(where)
    expect(text).toContain('LOGIN')
    expect(text).toContain('FAILED')
    expect(text).toContain('"source":null')
    expect(text).toContain('2026-10-01')
    expect(text).not.toContain('bogus')
    expect(findMany.mock.calls[0][0].orderBy).toEqual([{ occurredAt: 'desc' }, { id: 'desc' }])
  })

  it('分页续取：整页满了就按（时间，编号）续取下一页，不满就停；名字只查一次', async () => {
    const page = Array.from({ length: 2000 }, (_, i) => row(`p${String(i).padStart(4, '0')}`))
    const findMany = vi
      .fn()
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([row('z')])
    const memberFind = vi.fn().mockResolvedValue(members)
    const rows = await run({ auditEvent: { findMany }, membership: { findMany: memberFind } })
    expect(rows).toHaveLength(2001)
    expect(findMany).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(findMany.mock.calls[1][0].where)).toContain('p1999')
    expect(memberFind).toHaveBeenCalledTimes(1)
  })
})
