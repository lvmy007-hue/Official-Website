import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScheduleDeps } from '../listeners/schedule-jobs'
import { economicsDailyWindow, economicsPreviewWindow, scheduleEconomicsQueries } from './schedule'

// 官方经济数据的定时查询（P2b-11）：窗口计算、按数据集判断是否已有进行中的任务、只在生产环境跑。

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})
const today = new Date('2026-10-23T00:00:00Z')

describe('查询窗口', () => {
  it('官方单品经济：结束日是昨天；有数据重拉最近 14 天，第一次回补 90 天', () => {
    expect(economicsDailyWindow(today, true)).toEqual({ startDate: '2026-10-09', endDate: '2026-10-22' })
    expect(economicsDailyWindow(today, false)).toEqual({ startDate: '2026-07-25', endDate: '2026-10-22' })
  })

  it('费用预览：从今天起 119 天', () => {
    expect(economicsPreviewWindow(today)).toEqual({ startDate: '2026-10-23', endDate: '2027-02-18' })
  })
})

function setup(running: Record<string, number> = {}) {
  const created: Array<{ dataset: string; params: Record<string, string> }> = []
  const prisma = {
    tenant: { findFirst: vi.fn(async () => ({ timezone: 'UTC' })) },
    economicsPreview: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    economicsDaily: { findFirst: vi.fn(async () => null) },
    syncJob: {
      count: vi.fn(async ({ where }: { where: { context: { equals: string } } }) => running[where.context.equals] ?? 0),
      create: vi.fn(async ({ data }: { data: { context: { dataset: string; params: Record<string, string> } } }) => {
        created.push(data.context)
        return { id: `sj-${data.context.dataset}` }
      }),
    },
  }
  const systemPrisma = { platformConnection: { findMany: vi.fn(async () => [{ id: 'c1', tenantId: 't1', sellerAccountId: 'sa1' }]) } }
  const queues = { addSync: vi.fn(async () => undefined) }
  process.env.APP_MODE = 'production'
  delete process.env.MOCK_CONNECTOR
  return { created, queues, prisma, deps: { prisma, systemPrisma, queues } as unknown as ScheduleDeps }
}

describe('定时排队', () => {
  it('每个店铺各排一个官方单品经济与一个费用预览查询，并按任务编号入队；第一次回补 90 天', async () => {
    const { deps, created, queues, prisma } = setup()
    await scheduleEconomicsQueries(deps, new Date('2026-10-23T12:00:00Z'))
    expect(created.map(item => item.dataset)).toEqual(['dk.economics', 'dk.economics-preview'])
    expect(created[0]?.params).toEqual({ startDate: '2026-07-25', endDate: '2026-10-22', sellerAccountId: 'sa1' })
    expect(created[1]?.params).toMatchObject({ startDate: '2026-10-23', endDate: '2027-02-18', queriedAt: '2026-10-23T12:00:00.000Z', sellerAccountId: 'sa1' })
    expect(queues.addSync).toHaveBeenCalledWith('DATA_KIOSK_QUERY', expect.objectContaining({ tenantId: 't1', syncJobId: 'sj-dk.economics' }), expect.objectContaining({ jobId: 'sj-dk.economics' }))
    expect(prisma.economicsPreview.deleteMany).toHaveBeenCalledTimes(1) // 清理 7 天前的预览行
  })

  it('同一数据集还有进行中的任务：本轮跳过这一个，另一个照常排', async () => {
    const { deps, created } = setup({ 'dk.economics': 1 })
    await scheduleEconomicsQueries(deps)
    expect(created.map(item => item.dataset)).toEqual(['dk.economics-preview'])
  })

  it('非生产环境与模拟模式不建任务', async () => {
    const { deps, created } = setup()
    process.env.APP_MODE = 'development'
    await scheduleEconomicsQueries(deps)
    process.env.APP_MODE = 'production'
    process.env.MOCK_CONNECTOR = 'true'
    await scheduleEconomicsQueries(deps)
    expect(created).toEqual([])
  })
})
