import { describe, expect, it, vi } from 'vitest'
import { escalateOverdueWork } from './work-escalation'

const NOW = new Date('2026-10-22T08:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000)
const OWNER_ROLE = { permissions: ['*'], system: true, version: 2, fieldPermissions: [] }
const OPS_ROLE = { permissions: ['workitem.handle'], system: false, version: 2, fieldPermissions: [] }

function makeDb(items: Array<Record<string, any>>) {
  const notifications: Array<Record<string, any>> = []
  const db = {
    workItem: {
      findMany: vi.fn(async ({ where, take }: any) =>
        items
          .filter(item => where.status.in.includes(item.status) && item.dueAt <= where.dueAt.lte && item.slaBreachedAt === null && (!item.deferredUntil || item.deferredUntil <= NOW))
          .sort((a, b) => a.dueAt - b.dueAt)
          .slice(0, take),
      ),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = items.find(item => item.id === where.id && item.slaBreachedAt === null)
        if (!row) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      }),
    },
    membership: {
      findMany: vi.fn(async () => [
        { userId: 'owner-user', role: OWNER_ROLE },
        { userId: 'ops-user', role: OPS_ROLE },
      ]),
    },
    notification: { createMany: vi.fn(async ({ data }: any) => (notifications.push(...data), { count: data.length })) },
  }
  return { db: db as never, raw: db, notifications }
}

const item = (over: Record<string, any> = {}) => ({
  id: 'w1',
  tenantId: 't1',
  title: '核对退货差异',
  ownerId: 'ops-user',
  severity: 'WARNING',
  status: 'PENDING',
  dueAt: hoursAgo(1),
  slaBreachedAt: null,
  escalatedAt: null,
  deferredUntil: null,
  ...over,
})

describe('待办超时升级', () => {
  it('超时的待办：标记已超时与升级时间，通知负责人和有预警管理权限的管理员', async () => {
    const items = [item()]
    const { db, notifications } = makeDb(items)
    expect(await escalateOverdueWork(db, NOW)).toEqual({ escalated: 1 })
    expect(items[0]).toMatchObject({ slaBreachedAt: NOW, escalatedAt: NOW })
    expect(notifications.map(row => [row.userId, row.kind])).toEqual([
      ['ops-user', 'WORK_OVERDUE'],
      ['owner-user', 'WORK_ESCALATED'],
    ])
    expect(notifications[0]).toMatchObject({ title: '待办已超过处理时限', body: '核对退货差异', severity: 'WARNING' })
  })

  it('负责人本人就是管理员时只收到一条；严重待办的通知级别为严重', async () => {
    const items = [item({ ownerId: 'owner-user', severity: 'CRITICAL' })]
    const { db, notifications } = makeDb(items)
    await escalateOverdueWork(db, NOW)
    expect(notifications).toHaveLength(1)
    expect(notifications[0]).toMatchObject({ userId: 'owner-user', kind: 'WORK_OVERDUE', severity: 'CRITICAL' })
  })

  it('不升级：未到期、已完成或关闭、已经标记过、延期中的待办', async () => {
    const items = [
      item({ id: 'a', dueAt: new Date(NOW.getTime() + 3_600_000) }),
      item({ id: 'b', status: 'DONE' }),
      item({ id: 'c', status: 'CLOSED' }),
      item({ id: 'd', slaBreachedAt: hoursAgo(5) }),
      item({ id: 'e', deferredUntil: new Date(NOW.getTime() + 86_400_000) }),
    ]
    const { db, notifications } = makeDb(items)
    expect(await escalateOverdueWork(db, NOW)).toEqual({ escalated: 0 })
    expect(notifications).toHaveLength(0)
  })

  it('处理中的待办也会升级；延期已到期的待办重新参与', async () => {
    const items = [item({ id: 'a', status: 'IN_PROGRESS' }), item({ id: 'b', deferredUntil: hoursAgo(2), dueAt: hoursAgo(2) })]
    const { db } = makeDb(items)
    expect((await escalateOverdueWork(db, NOW)).escalated).toBe(2)
  })

  it('另一个进程已抢先标记（条件更新没有命中）：不重复通知；重复运行不会再升级', async () => {
    const items = [item()]
    const { db, raw, notifications } = makeDb(items)
    raw.workItem.updateMany.mockResolvedValueOnce({ count: 0 })
    expect((await escalateOverdueWork(db, NOW)).escalated).toBe(0)
    expect(notifications).toHaveLength(0)
    expect((await escalateOverdueWork(db, NOW)).escalated).toBe(1)
    const before = notifications.length
    expect((await escalateOverdueWork(db, NOW)).escalated).toBe(0)
    expect(notifications).toHaveLength(before)
  })

  it('通知去重键带待办与到期时间：延期后再次超时是新的通知，同一次超时不会重复', async () => {
    const items = [item()]
    const { db, notifications } = makeDb(items)
    await escalateOverdueWork(db, NOW)
    expect(notifications[0].dedupKey).toBe(`work-overdue:w1:${hoursAgo(1).getTime()}`)
    expect(notifications[1].dedupKey).toBe(`work-escalated:w1:${hoursAgo(1).getTime()}`)
  })
})
