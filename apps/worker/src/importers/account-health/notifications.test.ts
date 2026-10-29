import { Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { createAccountStatusProcessor, parseStatusChange, registerAccountStatusProcessor } from './notifications'

const message = (inner: Record<string, unknown>, eventTime = '2026-10-22T16:30:00Z') => ({
  notificationType: 'ACCOUNT_STATUS_CHANGED',
  eventTime,
  payload: { accountStatusChangedNotification: { sellerId: 'SELLER1', previousAccountStatus: 'NORMAL', currentAccountStatus: 'AT_RISK', ...inner } },
})
const event = { id: 'e1', tenantId: 't1', sellerAccountId: null, notificationType: 'ACCOUNT_STATUS_CHANGED', payloadObjectKey: 'events/e1.json' }

function deps(body: unknown, existing: { sourceUpdatedAt: Date } | null = null, timezone = 'Asia/Shanghai') {
  const upsert = vi.fn(async () => ({}))
  const db = {
    tenant: { findFirst: vi.fn(async () => ({ timezone })) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 'sa1', sellerId: 'SELLER1' }]) },
    accountHealthSnapshot: { findUnique: vi.fn(async () => existing), upsert },
    dataFreshness: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), update: vi.fn(), updateMany: vi.fn() },
  }
  const storage = { openRead: vi.fn(async () => Readable.from([Buffer.from(JSON.stringify(body))])) }
  return { db, storage, upsert }
}

describe('账户状态变化推送（N-17）', () => {
  it('解析：当前状态与之前状态原文都保留；认不出的状态、错误的类型一律拒绝，不猜', () => {
    const parsed = parseStatusChange(message({}))
    expect(parsed).toMatchObject({ sellerId: 'SELLER1', current: 'AT_RISK', currentRaw: 'AT_RISK', previousRaw: 'NORMAL' })
    expect(() => parseStatusChange(message({ currentAccountStatus: 'MYSTERY' }))).toThrow(/无法识别/)
    expect(() => parseStatusChange({ ...message({}), notificationType: 'OTHER' })).toThrow(/期望/)
    expect(() => parseStatusChange({ ...message({}), eventTime: 'x' })).toThrow(/eventTime/)
    expect(() => parseStatusChange(null)).toThrow()
  })

  it('写事件发生那一天（企业时区）的状态快照，来源记为推送，并记录新鲜度', async () => {
    const d = deps(message({}))
    await createAccountStatusProcessor({ db: d.db as never, storage: d.storage })(event)
    expect(d.upsert).toHaveBeenCalledTimes(1)
    const args = (d.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }])[0]
    // UTC 16:30 在东八区已是次日 00:30
    expect((args.create.snapshotDate as Date).toISOString().slice(0, 10)).toBe('2026-10-23')
    expect(args.create).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', metricKey: 'ACCOUNT_STATUS', accountStatus: 'AT_RISK', source: 'PUSH', metricGroup: 'STATUS' })
    expect(d.db.dataFreshness.create).toHaveBeenCalled()
  })

  it('当天已有更晚的记录（后到的报告）时不覆盖；非美国站不处理', async () => {
    const later = deps(message({}), { sourceUpdatedAt: new Date('2026-10-22T20:00:00Z') })
    await createAccountStatusProcessor({ db: later.db as never, storage: later.storage })(event)
    expect(later.upsert).not.toHaveBeenCalled()
    const other = deps(message({ marketplaceId: 'A1F83G8C2ARO7P' }))
    await createAccountStatusProcessor({ db: other.db as never, storage: other.storage })(event)
    expect(other.upsert).not.toHaveBeenCalled()
  })

  it('注册到通知类型 ACCOUNT_STATUS_CHANGED', () => {
    const register = vi.fn()
    registerAccountStatusProcessor({ register }, { db: {} as never, storage: { openRead: vi.fn() } })
    expect(register).toHaveBeenCalledWith('ACCOUNT_STATUS_CHANGED', expect.any(Function))
  })
})
