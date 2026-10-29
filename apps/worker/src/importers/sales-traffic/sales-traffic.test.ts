import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { recordSourceDiffs } from './diff'
import { singleReportDay, syncSalesTrafficReport } from './report'

// 销售与流量报告（P4-01，R-34）：JSON 文档拆成店铺日行与 ASIN 行，按来源 REPORT 写入；ASIN 部分只在窗口恰好一天时导入；
// 导入后与数据中心核对差异，只记录不覆盖；核对失败不影响导入。

const NOW = new Date('2026-10-24T12:00:00Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const amount = (value: number) => ({ amount: value, currencyCode: 'USD' })
const doc = (): Row => ({
  reportSpecification: { reportType: 'GET_SALES_AND_TRAFFIC_REPORT' },
  salesAndTrafficByDate: [
    { date: '2026-10-21', salesByDate: { orderedProductSales: amount(500), unitsOrdered: 20 }, trafficByDate: { sessions: 300, pageViews: 450, buyBoxPercentage: 90 } },
    { salesByDate: { unitsOrdered: 1 } }, // 没有日期
  ],
  salesAndTrafficByAsin: [
    { parentAsin: 'B0PARENT01', childAsin: 'B0CHILD001', salesByAsin: { orderedProductSales: amount(80), unitsOrdered: 4 }, trafficByAsin: { sessions: 60 } },
    { parentAsin: 'B0PARENT01', salesByAsin: { unitsOrdered: 2 } }, // 缺子体 ASIN
    'garbage',
  ],
})
async function* docs(...items: Row[]) {
  for (const item of items) yield item
}

function setup(overrides: Record<string, unknown> = {}) {
  const prisma = {
    $transaction: vi.fn(async (fn: (client: unknown) => unknown) => fn(prisma)),
    salesTrafficDaily: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    salesTrafficAsinDaily: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []) },
    salesTrafficDiff: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => []), deleteMany: vi.fn(async () => ({ count: 0 })) },
    ...overrides,
  }
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  return { prisma, logger, ctx: { prisma: prisma as unknown as PrismaClient, logger: logger as unknown as Logger } as ImportContext }
}

const day = { from: new Date('2026-10-21T00:00:00Z'), to: new Date('2026-10-21T23:59:59.999Z') }

describe('报告窗口', () => {
  it('两端是同一个 UTC 日才算单日窗口', () => {
    expect(singleReportDay(day.from, day.to)).toBe('2026-10-21')
    expect(singleReportDay(day.from, new Date('2026-10-22T00:00:00Z'))).toBeNull()
    expect(singleReportDay(null, day.to)).toBeNull()
    expect(singleReportDay(day.from, undefined)).toBeNull()
  })
})

describe('报告导入', () => {
  it('单日窗口：店铺日行与 ASIN 行都按来源 REPORT 写入；没日期、缺身份、不是对象的行跳过', async () => {
    const { ctx, prisma } = setup()
    const result = await syncSalesTrafficReport(ctx, docs(doc()), 't1', 'sa1', { ...day, reportJobId: 'rj1', now: NOW })
    expect(result).toEqual({ imported: 2, read: 4, skipped: 2 }) // 'garbage' 不是对象，展开时就丢掉，不计入
    const daily = prisma.salesTrafficDaily.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown>; update: Record<string, unknown> }]
    expect(daily[0].create).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      granularity: 'DAY',
      source: 'REPORT',
      orderedSales: 500,
      unitsOrdered: 20,
      sessions: 300,
      buyBoxPct: 0.9,
      sourceReportJobId: 'rj1',
    })
    expect(daily[0].update).not.toHaveProperty('ordersCount') // 报告没给的列不进更新
    const asin = prisma.salesTrafficAsinDaily.upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown> }]
    expect(asin[0].create).toMatchObject({ asin: 'B0CHILD001', asinGranularity: 'CHILD', sku: '', source: 'REPORT', parentAsin: 'B0PARENT01', units: 4, sessions: 60 })
    expect(ctx.logger.warn).toHaveBeenCalledWith(expect.objectContaining({ skipped: 2, tenantId: 't1' }), expect.stringContaining('skipped'))
  })

  it('窗口不是一天：ASIN 部分没有日期列，不猜日期，整段跳过；店铺日行照常导入', async () => {
    const { ctx, prisma } = setup()
    const result = await syncSalesTrafficReport(ctx, docs(doc()), 't1', 'sa1', { from: day.from, to: new Date('2026-10-23T00:00:00Z'), now: NOW })
    expect(prisma.salesTrafficAsinDaily.upsert).not.toHaveBeenCalled()
    expect(prisma.salesTrafficDaily.upsert).toHaveBeenCalledTimes(1)
    expect(result.imported).toBe(1)
    const noWindow = setup()
    await syncSalesTrafficReport(noWindow.ctx, docs(doc()), 't1', 'sa1', { now: NOW })
    expect(noWindow.prisma.salesTrafficAsinDaily.upsert).not.toHaveBeenCalled()
  })

  it('没有任何数据的报告：读 0 行，不报错、不核对', async () => {
    const { ctx, prisma } = setup()
    expect(await syncSalesTrafficReport(ctx, docs({ reportSpecification: {} }), 't1', 'sa1', { ...day, now: NOW })).toEqual({ imported: 0, read: 0, skipped: 0 })
    expect(prisma.salesTrafficDaily.findMany).not.toHaveBeenCalled()
  })

  it('导入后核对失败只记日志，导入结果不受影响', async () => {
    const { ctx, logger } = setup({ salesTrafficDaily: { upsert: vi.fn(async () => ({})), findMany: vi.fn(async () => Promise.reject(new Error('db down'))) } })
    const result = await syncSalesTrafficReport(ctx, docs(doc()), 't1', 'sa1', { ...day, now: NOW })
    expect(result.imported).toBe(2)
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: 'db down' }), expect.stringContaining('diff check failed'))
  })
})

describe('来源核对', () => {
  const decimal = (value: number) => ({ toNumber: () => value })
  const d = new Date('2026-10-21T00:00:00Z')
  const daily = (source: string, sales: number, sessions: number) => ({ date: d, source, orderedSales: decimal(sales), unitsOrdered: 20, sessions, pageViews: 450 })

  it('两边都有且超过容差的指标记一行差异；容差内的不记；只有一边有数据不比较', async () => {
    const { prisma, logger } = setup()
    prisma.salesTrafficDaily.findMany.mockResolvedValue([daily('DATA_KIOSK', 500, 300), daily('REPORT', 560, 300)] as never)
    prisma.salesTrafficAsinDaily.findMany.mockResolvedValue([
      { date: d, asin: 'B0A', asinGranularity: 'CHILD', sku: '', source: 'REPORT', orderedSales: decimal(10), units: 1, sessions: 5, pageViews: 9 },
    ] as never)
    const recorded = await recordSourceDiffs(prisma as unknown as PrismaClient, scope, [d], logger as unknown as Logger, NOW)
    expect(recorded).toBe(1)
    expect(prisma.salesTrafficDiff.upsert).toHaveBeenCalledTimes(1)
    const call = prisma.salesTrafficDiff.upsert.mock.calls[0] as unknown as [
      { where: { tenantId_sellerAccountId_level_date_asin_sku_metric: Record<string, unknown> }; create: Record<string, unknown> },
    ]
    expect(call[0].where.tenantId_sellerAccountId_level_date_asin_sku_metric).toMatchObject({ level: 'DAY', asin: '', sku: '', metric: 'orderedSales' })
    expect(call[0].create).toMatchObject({ kioskValue: 500, reportValue: 560, delta: 60, relativeDiff: 0.12, detectedAt: NOW })
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ code: 'ST_SOURCE_DIFF', recorded: 1 }), expect.any(String))
  })

  it('ASIN 级：同粒度、同 ASIN、同 SKU、同日期的两个来源才比较', async () => {
    const { prisma, logger } = setup()
    const asin = (source: string, sales: number, key = 'B0A') => ({ date: d, asin: key, asinGranularity: 'CHILD', sku: '', source, orderedSales: decimal(sales), units: 1, sessions: 5, pageViews: 9 })
    prisma.salesTrafficAsinDaily.findMany.mockResolvedValue([asin('DATA_KIOSK', 100), asin('REPORT', 150), asin('REPORT', 900, 'B0OTHER')] as never)
    expect(await recordSourceDiffs(prisma as unknown as PrismaClient, scope, [d], logger as unknown as Logger, NOW)).toBe(1)
    expect(prisma.salesTrafficDiff.upsert.mock.calls[0]?.[0]).toMatchObject({ create: { level: 'CHILD', asin: 'B0A', metric: 'orderedSales' } })
  })

  it('差异消失后，之前记的行删除；仍在的保留', async () => {
    const { prisma, logger } = setup()
    prisma.salesTrafficDaily.findMany.mockResolvedValue([daily('DATA_KIOSK', 500, 300), daily('REPORT', 560, 300)] as never)
    prisma.salesTrafficDiff.findMany.mockResolvedValue([
      { id: 'keep', level: 'DAY', date: d, asin: '', sku: '', metric: 'orderedSales' },
      { id: 'stale', level: 'DAY', date: d, asin: '', sku: '', metric: 'sessions' },
    ] as never)
    await recordSourceDiffs(prisma as unknown as PrismaClient, scope, [d], logger as unknown as Logger, NOW)
    expect(prisma.salesTrafficDiff.deleteMany).toHaveBeenCalledWith({ where: { tenantId: 't1', id: { in: ['stale'] } } })
  })

  it('没有日期不查库', async () => {
    const { prisma, logger } = setup()
    expect(await recordSourceDiffs(prisma as unknown as PrismaClient, scope, [], logger as unknown as Logger, NOW)).toBe(0)
    expect(prisma.salesTrafficDaily.findMany).not.toHaveBeenCalled()
  })
})
