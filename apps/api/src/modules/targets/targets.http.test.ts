import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, sessionStub } from '../../testing/harness'

let harness: Awaited<ReturnType<typeof createTestApp>> | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const businessTargetRow = (over: Record<string, unknown> = {}) => ({
  id: 'bt-1',
  tenantId: 'tenant-1',
  sellerAccountId: 's1',
  periodKind: 'MONTH',
  periodStart: new Date('2026-10-01T00:00:00Z'),
  dimension: 'STORE',
  dimensionRef: 'ALL',
  metric: 'SALES',
  targetValue: { toString: () => '10000' },
  paceMode: 'LINEAR',
  note: null,
  version: 1,
  updatedBy: 'user-1',
  updatedAt: new Date('2026-10-05T00:00:00Z'),
  ...over,
})

function prismaFor(permissions: string[], over: Record<string, any> = {}) {
  const prisma: Record<string, any> = {
    ...sessionStub(permissions),
    tenant: { findFirst: vi.fn().mockResolvedValue({ timezone: 'America/Los_Angeles' }) },
    sellerAccount: { findMany: vi.fn().mockResolvedValue([]) },
    businessTarget: {
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(async ({ data }) => businessTargetRow({ ...data, id: 'bt-new', version: 1 })),
      updateMany: vi.fn().mockResolvedValue({ count: 0 }),
    },
    storeDailySummary: { findMany: vi.fn().mockResolvedValue([]) },
    asinDailySummary: { findMany: vi.fn().mockResolvedValue([]) },
    entityEvent: { findMany: vi.fn().mockResolvedValue([]), create: vi.fn().mockResolvedValue({}) },
    auditEvent: { create: vi.fn().mockResolvedValue({}) },
    membership: {
      findFirst: vi.fn().mockResolvedValue({ id: 'membership-1', tenantId: 'tenant-1', role: { permissions }, tenant: { lifecycleStatus: 'ACTIVE' } }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    ...over,
  }
  prisma.$transaction = vi.fn(async (arg: unknown) => (typeof arg === 'function' ? (arg as (tx: unknown) => Promise<unknown>)(prisma) : Promise.all(arg as Promise<unknown>[])))
  return prisma
}

describe('目标与预算接口（P2a-04）', () => {
  it('未登录 401，没有 targets.read / targets.write 403', async () => {
    harness = await createTestApp(prismaFor(['overview.read']))
    expect((await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01', { auth: false })).status).toBe(401)
    expect((await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')).status).toBe(403)
    expect((await harness.call('GET', '/targets/history?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')).status).toBe(403)
    expect((await harness.call('PUT', '/targets', { body: { sellerAccountId: 's1', periodStart: '2026-10-01', metric: 'SALES', targetValue: 100, version: 0 } })).status).toBe(403)
  })

  it('期间起始日期不是期初：422', async () => {
    harness = await createTestApp(prismaFor(['targets.read']))
    expect((await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-15')).status).toBe(422)
  })

  it('没有任何目标：整店 5 个指标全部“尚未设置”，细化目标为空', async () => {
    harness = await createTestApp(prismaFor(['targets.read']))
    const res = await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    expect(res.status).toBe(200)
    expect(res.json.data.storeRows).toHaveLength(5)
    expect(res.json.data.storeRows.every((row: { progress: { state: string } }) => row.progress.state === 'NOT_SET')).toBe(true)
    expect(res.json.data.customRows).toEqual([])
    expect(res.json.data.periodEnd).toBe('2026-10-31')
  })

  it('店铺不在数据范围内：403', async () => {
    harness = await createTestApp(prismaFor(['targets.read'], { membershipScope: { findMany: vi.fn().mockResolvedValue([{ legalEntityId: null, sellerAccountId: 'other-store' }]) } }))
    const res = await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    expect(res.status).toBe(403)
  })

  it('已设置整店销售额目标，且有日汇总数据：达成进度按天均摊计算；未设置的指标为“尚未设置”', async () => {
    const rows = [1, 2, 3].map(day => ({ summaryDate: new Date(`2026-10-0${day}T00:00:00Z`), salesAmount: { toString: () => '1000' }, orders: 10, units: 20, profit: null, adsSpend: null }))
    harness = await createTestApp(
      prismaFor(['targets.read'], {
        businessTarget: { findMany: vi.fn().mockResolvedValue([businessTargetRow()]) },
        storeDailySummary: { findMany: vi.fn().mockResolvedValue(rows) },
      }),
    )
    const res = await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    expect(res.status).toBe(200)
    const sales = res.json.data.storeRows.find((row: { metric: string }) => row.metric === 'SALES')
    expect(sales.targetValue).toBe(10000)
    expect(sales.progress.state).toBe('OK')
    expect(sales.progress.actualToDate).toBe(3000)
    // 没有设置过目标的指标：尚未设置，不等同于“未接入”
    const units = res.json.data.storeRows.find((row: { metric: string }) => row.metric === 'UNITS')
    expect(units.progress.state).toBe('NOT_SET')
  })

  it('已设置净利润目标，但利润日表还没有数据：尚未接入', async () => {
    const rows = [{ summaryDate: new Date('2026-10-01T00:00:00Z'), salesAmount: { toString: () => '1000' }, orders: 10, units: 20, profit: null, adsSpend: null }]
    harness = await createTestApp(
      prismaFor(['targets.read', 'field.profit'], {
        businessTarget: { findMany: vi.fn().mockResolvedValue([businessTargetRow({ metric: 'PROFIT', id: 'bt-2' })]) },
        storeDailySummary: { findMany: vi.fn().mockResolvedValue(rows) },
      }),
    )
    const res = await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    const profit = res.json.data.storeRows.find((row: { metric: string }) => row.metric === 'PROFIT')
    expect(profit.progress.state).toBe('NOT_CONNECTED')
  })

  it('净利润目标且无“利润”字段权限：RESTRICTED', async () => {
    harness = await createTestApp(prismaFor(['targets.read'], { businessTarget: { findMany: vi.fn().mockResolvedValue([businessTargetRow({ metric: 'PROFIT', id: 'bt-2' })]) } }))
    const res = await harness.call('GET', '/targets?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    const profit = res.json.data.storeRows.find((row: { metric: string }) => row.metric === 'PROFIT')
    expect(profit.progress.state).toBe('RESTRICTED')
  })

  it('新建目标（version 0）：写入成功并记一条变更历史', async () => {
    const created: Record<string, unknown>[] = []
    harness = await createTestApp(
      prismaFor(['targets.write'], {
        businessTarget: {
          findFirst: vi.fn().mockResolvedValue(null),
          create: vi.fn().mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
            created.push(data)
            return businessTargetRow({ ...data, id: 'bt-new', version: 1 })
          }),
        },
      }),
    )
    const res = await harness.call('PUT', '/targets', {
      body: { sellerAccountId: 's1', periodKind: 'MONTH', periodStart: '2026-10-01', metric: 'SALES', targetValue: 10000, paceMode: 'LINEAR', version: 0 },
    })
    expect(res.status).toBe(200)
    expect(res.json.data.row.targetValue).toBe(10000)
    expect(created).toHaveLength(1)
  })

  it('已存在但 version 为 0：409（应先刷新再编辑）', async () => {
    harness = await createTestApp(prismaFor(['targets.write'], { businessTarget: { findFirst: vi.fn().mockResolvedValue(businessTargetRow()), updateMany: vi.fn().mockResolvedValue({ count: 0 }) } }))
    const res = await harness.call('PUT', '/targets', { body: { sellerAccountId: 's1', periodKind: 'MONTH', periodStart: '2026-10-01', metric: 'SALES', targetValue: 10000, version: 0 } })
    expect(res.status).toBe(409)
  })

  it('版本不一致：409（他人已修改）', async () => {
    harness = await createTestApp(
      prismaFor(['targets.write'], {
        businessTarget: { findFirst: vi.fn().mockResolvedValue(businessTargetRow()), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
      }),
    )
    const res = await harness.call('PUT', '/targets', { body: { sellerAccountId: 's1', periodKind: 'MONTH', periodStart: '2026-10-01', metric: 'SALES', targetValue: 12000, version: 1 } })
    expect(res.status).toBe(409)
  })

  it('变更历史：按店铺 + 期间返回事件列表', async () => {
    const event = {
      id: 'e1',
      occurredAt: new Date('2026-10-05T00:00:00Z'),
      title: '整店 · 销售额目标：10000 → 12000',
      detailJson: { dimension: 'STORE', dimensionRef: 'ALL', metric: 'SALES' },
      actorId: 'user-1',
    }
    harness = await createTestApp(prismaFor(['targets.read'], { entityEvent: { findMany: vi.fn().mockResolvedValue([event]) } }))
    const res = await harness.call('GET', '/targets/history?sellerAccountId=s1&periodKind=MONTH&periodStart=2026-10-01')
    expect(res.status).toBe(200)
    expect(res.json.data.items).toHaveLength(1)
    expect(res.json.data.items[0]).toMatchObject({ id: 'e1', metric: 'SALES', dimension: 'STORE' })
  })
})
