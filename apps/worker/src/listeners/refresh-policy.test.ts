import { afterEach, describe, expect, it, vi } from 'vitest'
import { REFRESH_DOMAINS, refreshDomainOf } from '@nova/api-contracts'
import { ADS_ENTITY_SCHEDULE_INTERVAL_MS } from '../ads-entities/schedule'
import {
  APLUS_REFRESH_INTERVAL_MS,
  AWD_REFRESH_INTERVAL_MS,
  CATALOG_REFRESH_INTERVAL_MS,
  COMPETITOR_REFRESH_INTERVAL_MS,
  FEEDBACK_REFRESH_INTERVAL_MS,
  INVENTORY_REFRESH_INTERVAL_MS,
  LISTING_REFRESH_INTERVAL_MS,
  PRICING_REFRESH_INTERVAL_MS,
  PROMOTIONS_REFRESH_INTERVAL_MS,
  SETTLEMENT_REFRESH_INTERVAL_MS,
  SUPPORT_REFRESH_INTERVAL_MS,
  TAX_REFRESH_INTERVAL_MS,
  refreshAllowed,
  scheduleProductionSync,
  type ScheduleDeps,
} from './schedule-jobs'

// 刷新策略（P5-10）：企业在设置里暂停或放慢某个数据域后，定时同步按策略跳过；没有设置的数据域不受影响。

const MIN = 60_000
const OWN_SCHEDULER = ['ADS_ENTITY_SYNC', 'ADS_REPORT_V1']
const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function setup(valueJson: unknown, lastScheduled: Date | null = null) {
  const created: string[] = []
  const findLast = vi.fn(async () => (lastScheduled ? { createdAt: lastScheduled } : null))
  const prisma = {
    tenantSetting: { findFirst: vi.fn(async () => (valueJson === null ? null : { valueJson })) },
    syncJob: {
      count: vi.fn(async () => 0),
      findFirst: findLast,
      create: vi.fn(async ({ data }: { data: { type: string } }) => {
        created.push(data.type)
        return { id: `sj-${data.type}` }
      }),
    },
  }
  const systemPrisma = { platformConnection: { findMany: vi.fn(async () => [{ id: 'c1', tenantId: 't1', provider: 'AMAZON_SP_API' }]) } }
  const queues = { addSync: vi.fn(async () => undefined) }
  process.env.APP_MODE = 'production'
  delete process.env.MOCK_CONNECTOR
  return { created, prisma, findLast, deps: { prisma, systemPrisma, queues } as unknown as ScheduleDeps }
}

describe('刷新策略目录与定时器的内置频率一致', () => {
  it('目录里每个数据域的内置间隔等于 worker 里的定时常量（改了一边没改另一边会在这里失败）', () => {
    const minutes = (key: string) => refreshDomainOf(key)?.builtInMinutes
    expect(minutes('FBA_INVENTORY')).toBe(INVENTORY_REFRESH_INTERVAL_MS / MIN)
    expect(minutes('AWD_SYNC')).toBe(AWD_REFRESH_INTERVAL_MS / MIN)
    expect(minutes('SUPPORT_SYNC')).toBe(SUPPORT_REFRESH_INTERVAL_MS / MIN)
    expect(minutes('PRICING_SYNC')).toBe(PRICING_REFRESH_INTERVAL_MS / MIN)
    expect(minutes('COMPETITOR_SYNC')).toBe(COMPETITOR_REFRESH_INTERVAL_MS / MIN)
    for (const [key, ms] of [
      ['CATALOG_SYNC', CATALOG_REFRESH_INTERVAL_MS],
      ['SETTLEMENT_SYNC', SETTLEMENT_REFRESH_INTERVAL_MS],
      ['TAX_SYNC', TAX_REFRESH_INTERVAL_MS],
      ['PROMOTIONS_SYNC', PROMOTIONS_REFRESH_INTERVAL_MS],
      ['LISTING_SYNC', LISTING_REFRESH_INTERVAL_MS],
      ['FEEDBACK_SYNC', FEEDBACK_REFRESH_INTERVAL_MS],
      ['APLUS_SYNC', APLUS_REFRESH_INTERVAL_MS],
    ] as const)
      expect(minutes(key), key).toBe(ms / MIN)
    // 订单、财务、入仓、补货、广告随 6 小时全量同步
    for (const key of ['FBA_ORDERS', 'FBA_FINANCE', 'FBA_INBOUND_SYNC', 'FBA_REPLENISHMENT', 'FBA_ADS']) expect(minutes(key), key).toBe(360)
    // 广告实体每 2 小时；广告报表每个模板每天一次（定时器每 6 小时检查，距上一次满 20 小时才排）
    expect(minutes('ADS_ENTITY_SYNC')).toBe(ADS_ENTITY_SCHEDULE_INTERVAL_MS / MIN)
    expect(minutes('ADS_REPORT_V1')).toBe(24 * 60)
  })

  it('目录里的数据域都是会被定时排队的同步类型', async () => {
    const { deps, created } = setup(null)
    await scheduleProductionSync(deps)
    const adsDeps = setup(null)
    adsDeps.deps.systemPrisma.platformConnection.findMany = vi.fn(async () => [{ id: 'c2', tenantId: 't1', provider: 'AMAZON_ADS_API' }]) as never
    await scheduleProductionSync(adsDeps.deps)
    // 广告实体与广告报表（P5-12A）有自己的排任务函数（按广告档案逐个排），不走 scheduleProductionSync；它们的暂停与放慢见 ads-sync-schedule.db.test.ts
    const dedicated = REFRESH_DOMAINS.filter(domain => !OWN_SCHEDULER.includes(domain.key) && !created.includes(domain.key) && !adsDeps.created.includes(domain.key)).map(domain => domain.key)
    for (const key of dedicated) {
      const one = setup(null)
      await scheduleProductionSync(one.deps, [key])
      expect(one.created, key).toEqual([key])
    }
  })
})

describe('refreshAllowed', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  const db = (last: Date | null) => ({ syncJob: { findFirst: vi.fn(async () => (last ? { createdAt: last } : null)) } }) as never

  it('没有设置的数据域直接放行，不查任务表', async () => {
    const prisma = db(null)
    expect(await refreshAllowed(prisma, {}, 'c1', 'FBA_ORDERS', now)).toBe(true)
    expect((prisma as { syncJob: { findFirst: ReturnType<typeof vi.fn> } }).syncJob.findFirst).not.toHaveBeenCalled()
  })

  it('暂停：不排，也不查任务表', async () => {
    const prisma = db(null)
    expect(await refreshAllowed(prisma, { FBA_ORDERS: { mode: 'PAUSED' } }, 'c1', 'FBA_ORDERS', now)).toBe(false)
    expect((prisma as { syncJob: { findFirst: ReturnType<typeof vi.fn> } }).syncJob.findFirst).not.toHaveBeenCalled()
  })

  it('放慢：距上次定时同步不够久就跳过，够久（减去半个内置间隔）就排，从没排过也排', async () => {
    const policy = { FBA_ORDERS: { mode: 'EVERY', minutes: 720 } } as const
    expect(await refreshAllowed(db(new Date(now.getTime() - 6 * 60 * MIN)), policy, 'c1', 'FBA_ORDERS', now)).toBe(false) // 6 小时前：不够 12 小时
    expect(await refreshAllowed(db(new Date(now.getTime() - (12 * 60 - 5) * MIN)), policy, 'c1', 'FBA_ORDERS', now)).toBe(true) // 抖动几分钟不多等一轮
    expect(await refreshAllowed(db(null), policy, 'c1', 'FBA_ORDERS', now)).toBe(true)
  })

  it('不在目录里的任务类型（例如连接健康检查）不受策略影响', async () => {
    expect(await refreshAllowed(db(null), { X: { mode: 'PAUSED' } } as never, 'c1', 'CONNECTION_HEALTH_CHECK', now)).toBe(true)
  })
})

describe('定时同步按企业的刷新策略排任务', () => {
  it('暂停订单与财务：6 小时全量同步里不再排这两项，其余照常', async () => {
    const { deps, created } = setup({ FBA_ORDERS: { mode: 'PAUSED' }, FBA_FINANCE: { mode: 'PAUSED' } })
    await scheduleProductionSync(deps)
    expect(created).toEqual(['FBA_INVENTORY', 'FBA_INBOUND_SYNC', 'FBA_REPLENISHMENT', 'AWD_SYNC', 'SUPPORT_SYNC'])
  })

  it('专属定时器：暂停的数据域不排；放慢且刚排过的也不排', async () => {
    const paused = setup({ CATALOG_SYNC: { mode: 'PAUSED' } })
    await scheduleProductionSync(paused.deps, ['CATALOG_SYNC'])
    expect(paused.created).toEqual([])
    const slowed = setup({ CATALOG_SYNC: { mode: 'EVERY', minutes: 2880 } }, new Date(Date.now() - 24 * 60 * MIN))
    await scheduleProductionSync(slowed.deps, ['CATALOG_SYNC'])
    expect(slowed.created).toEqual([])
    const due = setup({ CATALOG_SYNC: { mode: 'EVERY', minutes: 2880 } }, new Date(Date.now() - 47 * 60 * MIN))
    await scheduleProductionSync(due.deps, ['CATALOG_SYNC'])
    expect(due.created).toEqual(['CATALOG_SYNC'])
  })

  it('存的策略格式坏了：按系统内置频率处理，什么都不跳过', async () => {
    const { deps, created } = setup({ FBA_ORDERS: { mode: 'EVERY', minutes: 5 }, NOPE: { mode: 'PAUSED' } })
    await scheduleProductionSync(deps)
    expect(created).toContain('FBA_ORDERS')
  })
})
