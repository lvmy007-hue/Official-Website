import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  APLUS_REFRESH_INTERVAL_MS,
  CATALOG_REFRESH_INTERVAL_MS,
  COMPETITOR_REFRESH_INTERVAL_MS,
  FEEDBACK_REFRESH_INTERVAL_MS,
  LISTING_REFRESH_INTERVAL_MS,
  PRICING_REFRESH_INTERVAL_MS,
  PROMOTIONS_REFRESH_INTERVAL_MS,
  SUPPORT_REFRESH_INTERVAL_MS,
  scheduleProductionSync,
  type ScheduleDeps,
} from './schedule-jobs'

// 商品目录同步（P2a-14）有自己的每日定时器：6 小时的全量同步不带它，专属定时器才建它；有进行中的任务时跳过。

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

function setup(activeJobs = 0) {
  const created: string[] = []
  const prisma = {
    tenantSetting: { findFirst: vi.fn(async () => null) },
    syncJob: {
      count: vi.fn(async () => activeJobs),
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
  return { created, queues, deps: { prisma, systemPrisma, queues } as unknown as ScheduleDeps }
}

describe('商品目录同步的定时', () => {
  it('每日一次', () => {
    expect(CATALOG_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('6 小时全量同步不带商品目录', async () => {
    const { deps, created } = setup()
    await scheduleProductionSync(deps)
    expect(created).toEqual(['FBA_ORDERS', 'FBA_INVENTORY', 'FBA_FINANCE', 'FBA_INBOUND_SYNC', 'FBA_REPLENISHMENT', 'AWD_SYNC', 'SUPPORT_SYNC'])
  })

  it('支持案件每 2 小时同步一次，也随 6 小时全量同步', () => {
    expect(SUPPORT_REFRESH_INTERVAL_MS).toBe(2 * 60 * 60 * 1000)
  })

  it('促销与优惠券（P4-05）每日同步一次，只走专属定时器，不随 6 小时全量同步', async () => {
    expect(PROMOTIONS_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    const { deps, created } = setup()
    await scheduleProductionSync(deps, ['PROMOTIONS_SYNC'])
    expect(created).toEqual(['PROMOTIONS_SYNC'])
  })

  it('刊登质量（P4-10）每日同步一次，只走专属定时器，不随 6 小时全量同步', async () => {
    expect(LISTING_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    const { deps, created } = setup()
    await scheduleProductionSync(deps, ['LISTING_SYNC'])
    expect(created).toEqual(['LISTING_SYNC'])
  })

  it('定价（P4-11）每 2 小时同步一次，只走专属定时器，不随 6 小时全量同步', async () => {
    expect(PRICING_REFRESH_INTERVAL_MS).toBe(2 * 60 * 60 * 1000)
    const { deps, created } = setup()
    await scheduleProductionSync(deps, ['PRICING_SYNC'])
    expect(created).toEqual(['PRICING_SYNC'])
  })

  it('竞品监控（P4-12）每 6 小时同步一次，只走专属定时器，不随 6 小时全量同步', async () => {
    expect(COMPETITOR_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60 * 1000)
    const { deps, created } = setup()
    await scheduleProductionSync(deps, ['COMPETITOR_SYNC'])
    expect(created).toEqual(['COMPETITOR_SYNC'])
  })

  it('客户反馈（P4-13）每日同步一次，只走专属定时器，不随 6 小时全量同步，并按任务编号入队', async () => {
    expect(FEEDBACK_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    const full = setup()
    await scheduleProductionSync(full.deps)
    expect(full.created).not.toContain('FEEDBACK_SYNC')
    const { deps, created, queues } = setup()
    await scheduleProductionSync(deps, ['FEEDBACK_SYNC'])
    expect(created).toEqual(['FEEDBACK_SYNC'])
    expect(queues.addSync).toHaveBeenCalledWith('FEEDBACK_SYNC', expect.objectContaining({ tenantId: 't1', syncJobId: 'sj-FEEDBACK_SYNC' }), expect.objectContaining({ jobId: 'sj-FEEDBACK_SYNC' }))
  })

  it('A+ 内容（P4-14）每日同步一次，只走专属定时器，不随 6 小时全量同步，并按任务编号入队', async () => {
    expect(APLUS_REFRESH_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
    const full = setup()
    await scheduleProductionSync(full.deps)
    expect(full.created).not.toContain('APLUS_SYNC')
    const { deps, created, queues } = setup()
    await scheduleProductionSync(deps, ['APLUS_SYNC'])
    expect(created).toEqual(['APLUS_SYNC'])
    expect(queues.addSync).toHaveBeenCalledWith('APLUS_SYNC', expect.objectContaining({ tenantId: 't1', syncJobId: 'sj-APLUS_SYNC' }), expect.objectContaining({ jobId: 'sj-APLUS_SYNC' }))
  })

  it('专属定时器只建商品目录同步，并按任务编号入队', async () => {
    const { deps, created, queues } = setup()
    await scheduleProductionSync(deps, ['CATALOG_SYNC'])
    expect(created).toEqual(['CATALOG_SYNC'])
    expect(queues.addSync).toHaveBeenCalledWith('CATALOG_SYNC', expect.objectContaining({ tenantId: 't1', syncJobId: 'sj-CATALOG_SYNC' }), expect.objectContaining({ jobId: 'sj-CATALOG_SYNC' }))
  })

  it('这个连接上还有进行中的任务：本轮跳过，不排队堆积', async () => {
    const { deps, created } = setup(1)
    await scheduleProductionSync(deps, ['CATALOG_SYNC'])
    expect(created).toEqual([])
  })

  it('非生产环境不建任务', async () => {
    const { deps, created } = setup()
    process.env.APP_MODE = 'development'
    await scheduleProductionSync(deps, ['CATALOG_SYNC'])
    expect(created).toEqual([])
  })
})
