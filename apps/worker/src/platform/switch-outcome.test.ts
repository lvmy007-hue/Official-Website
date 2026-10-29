import { SWITCH_AUTO_CLOSE_FAILURES, SWITCH_CATALOG } from '@nova/api-contracts'
import { describe, expect, it, vi } from 'vitest'
import { recordSwitchOutcome } from './switch-outcome'

const NOW = new Date('2026-10-22T08:00:00Z')
const OWNER_ROLE = { permissions: ['*'], system: true, version: 2, fieldPermissions: [] }
const sellerKey = SWITCH_CATALOG.find(spec => spec.provider === 'AMAZON_SP_API')!.key
const siblingKey = SWITCH_CATALOG.filter(spec => spec.provider === 'AMAZON_SP_API')[1].key
const adsKey = SWITCH_CATALOG.find(spec => spec.provider === 'AMAZON_ADS_API')!.key

function makeDb(rows: Array<Record<string, any>>) {
  const logs: Array<Record<string, any>> = []
  const notifications: Array<Record<string, any>> = []
  const tx = {
    integrationSwitch: {
      findFirst: vi.fn(async ({ where }: any) => rows.find(row => row.switchKey === where.switchKey && row.enabled === where.enabled) ?? null),
      findMany: vi.fn(async ({ where }: any) => rows.filter(row => row.enabled && row.switchKey !== where.NOT.switchKey)),
      update: vi.fn(async ({ where, data }: any) => {
        const row = rows.find(item => item.id === where.id)!
        const { version, ...rest } = data
        Object.assign(row, rest, version ? { version: row.version + 1 } : {})
      }),
    },
    integrationSwitchLog: { create: vi.fn(async ({ data }: any) => void logs.push(data)) },
  }
  const db = {
    $transaction: vi.fn(async (fn: (client: typeof tx) => unknown) => fn(tx)),
    membership: { findMany: vi.fn(async () => [{ userId: 'owner', role: OWNER_ROLE }]) },
    notification: { createMany: vi.fn(async ({ data }: any) => (notifications.push(...data), { count: data.length })) },
  }
  return { db: db as never, logs, notifications }
}

const row = (key: string, over: Record<string, any> = {}) => ({
  id: key,
  tenantId: 't1',
  switchKey: key,
  sellerAccountId: null,
  enabled: true,
  consecutiveFailures: 0,
  calls7d: 0,
  failures7d: 0,
  statsJson: null,
  version: 1,
  ...over,
})

describe('写调用结果登记（后台任务侧）', () => {
  it('成功：记一次调用并清零连续失败，不关闭', async () => {
    const rows = [row(sellerKey, { consecutiveFailures: 3 })]
    const { db, logs } = makeDb(rows)
    expect(await recordSwitchOutcome(db, 't1', sellerKey, { success: true }, NOW)).toEqual({ autoClosed: [] })
    expect(rows[0]).toMatchObject({ enabled: true, consecutiveFailures: 0, calls7d: 1, failures7d: 0, version: 2 })
    expect(logs).toHaveLength(0)
  })

  it('失败未到上限：累计连续失败，不关闭', async () => {
    const rows = [row(sellerKey, { consecutiveFailures: SWITCH_AUTO_CLOSE_FAILURES - 2 })]
    const { db } = makeDb(rows)
    await recordSwitchOutcome(db, 't1', sellerKey, { success: false, errorCode: 'SP_API_500' }, NOW)
    expect(rows[0]).toMatchObject({ enabled: true, consecutiveFailures: SWITCH_AUTO_CLOSE_FAILURES - 1, failures7d: 1 })
  })

  it('连续失败达到上限：自动关闭、写变更记录与原因、通知管理员', async () => {
    const rows = [row(sellerKey, { consecutiveFailures: SWITCH_AUTO_CLOSE_FAILURES - 1 })]
    const { db, logs, notifications } = makeDb(rows)
    const result = await recordSwitchOutcome(db, 't1', sellerKey, { success: false, errorCode: 'SP_API_500' }, NOW)
    expect(result.autoClosed).toEqual([sellerKey])
    expect(rows[0]).toMatchObject({ enabled: false })
    expect(rows[0].autoDisabledReason).toContain('连续失败')
    expect(rows[0].autoDisabledReason).toContain('SP_API_500')
    expect(logs[0]).toMatchObject({ action: 'AUTO_DISABLED', actorId: null, beforeJson: { enabled: true }, afterJson: { enabled: false } })
    expect(notifications[0]).toMatchObject({
      userId: 'owner',
      kind: 'ALERT_WRITE_SWITCH_AUTO_CLOSED',
      severity: 'CRITICAL',
      link: '/app/settings/integrations',
      dedupKey: `alert:WRITE_SWITCH_AUTO_CLOSED:${sellerKey}:2026-10-22`,
    })
  })

  it('授权失效：立刻关闭，同一提供方其他已开启的开关一并关闭，其他提供方不受影响', async () => {
    const rows = [row(sellerKey), row(siblingKey), row(adsKey)]
    const { db, logs } = makeDb(rows)
    const result = await recordSwitchOutcome(db, 't1', sellerKey, { success: false, authInvalid: true }, NOW)
    expect(result.autoClosed.sort()).toEqual([sellerKey, siblingKey].sort())
    expect(rows.map(item => item.enabled)).toEqual([false, false, true])
    expect(logs).toHaveLength(2)
    expect(rows[0].autoDisabledReason).toBe('亚马逊返回授权失效或权限不足')
  })

  it('未开启的开关、不认识的开关键：不登记也不报错', async () => {
    const rows = [row(sellerKey, { enabled: false })]
    const { db } = makeDb(rows)
    expect(await recordSwitchOutcome(db, 't1', sellerKey, { success: false }, NOW)).toEqual({ autoClosed: [] })
    expect(rows[0].calls7d).toBe(0)
    expect(await recordSwitchOutcome(db, 't1', 'no.such.switch', { success: false }, NOW)).toEqual({ autoClosed: [] })
  })

  it('通知失败不影响开关已关闭的结果', async () => {
    const rows = [row(sellerKey, { consecutiveFailures: SWITCH_AUTO_CLOSE_FAILURES - 1 })]
    const { db } = makeDb(rows)
    ;(db as { membership: { findMany: unknown } }).membership.findMany = vi.fn(async () => {
      throw new Error('db down')
    })
    expect((await recordSwitchOutcome(db, 't1', sellerKey, { success: false }, NOW)).autoClosed).toEqual([sellerKey])
    expect(rows[0].enabled).toBe(false)
  })
})
