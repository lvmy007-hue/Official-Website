import { describe, expect, it, vi } from 'vitest'
import { BA_REPORT_TYPES } from '@nova/api-contracts'
import { MONTHLY_REPORT_FROM_DAY, dueBrandReports, dueReports, scheduleInventoryReports } from './report-schedule'
import type { ScheduleDeps } from './schedule-jobs'

const typesOf = (now: string) => dueReports(new Date(now)).map(item => item.reportType)

describe('库存与费用类报告的到期计划', () => {
  it('月中之前只有每日报告；月度费用报告在每月 16 日之后出现', () => {
    expect(MONTHLY_REPORT_FROM_DAY).toBe(16)
    const early = typesOf('2026-10-10T08:00:00Z')
    expect(early).toContain('GET_FBA_INVENTORY_PLANNING_DATA')
    expect(early).toContain('GET_LEDGER_DETAIL_VIEW_DATA')
    expect(early).not.toContain('GET_FBA_STORAGE_FEE_CHARGES_DATA')
    const late = typesOf('2026-10-16T00:00:00Z')
    for (const type of ['GET_FBA_STORAGE_FEE_CHARGES_DATA', 'GET_FBA_OVERAGE_FEE_CHARGES_DATA', 'GET_FBA_FULFILLMENT_LONGTERM_STORAGE_FEE_CHARGES_DATA']) expect(late).toContain(type)
  })

  it('时间窗：快照类没有时间窗；台账取最近 3 天、移除类取最近 30 天（都以日为界）；仓储费取上一个自然月', () => {
    const due = dueReports(new Date('2026-10-22T08:30:00Z'))
    const of = (type: string) => due.find(item => item.reportType === type)!
    expect(of('GET_AFN_INVENTORY_DATA')).toMatchObject({ from: null, to: null })
    expect(of('GET_LEDGER_DETAIL_VIEW_DATA').from?.toISOString()).toBe('2026-10-19T00:00:00.000Z')
    expect(of('GET_LEDGER_DETAIL_VIEW_DATA').to?.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    expect(of('GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA').from?.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(of('GET_FBA_STORAGE_FEE_CHARGES_DATA').from?.toISOString()).toBe('2026-09-01T00:00:00.000Z')
    expect(of('GET_FBA_STORAGE_FEE_CHARGES_DATA').to?.toISOString()).toBe('2026-10-01T00:00:00.000Z')
    // 跨年：1 月的“上一个自然月”是去年 12 月
    const january = dueReports(new Date('2027-01-20T00:00:00Z')).find(item => item.reportType === 'GET_FBA_STORAGE_FEE_CHARGES_DATA')!
    expect(january.from?.toISOString()).toBe('2026-12-01T00:00:00.000Z')
  })

  it('订单页的两份物流报告每天申请，取最近 7 天', () => {
    const due = dueReports(new Date('2026-10-22T08:30:00Z'))
    for (const type of ['GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA']) {
      const item = due.find(entry => entry.reportType === type)!
      expect(item.from?.toISOString()).toBe('2026-10-15T00:00:00.000Z')
      expect(item.to?.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    }
  })

  it('退货页的客户退货报告每天申请，取最近 30 天', () => {
    const item = dueReports(new Date('2026-10-22T08:30:00Z')).find(entry => entry.reportType === 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA')!
    expect(item.from?.toISOString()).toBe('2026-09-22T00:00:00.000Z')
    expect(item.to?.toISOString()).toBe('2026-10-22T00:00:00.000Z')
  })

  it('促销绩效与优惠券绩效报告每天申请，取最近 30 天（效果数据晚到，下一天还会再看到）', () => {
    for (const type of ['GET_PROMOTION_PERFORMANCE_REPORT', 'GET_COUPON_PERFORMANCE_REPORT']) {
      const item = dueReports(new Date('2026-10-22T08:30:00Z')).find(entry => entry.reportType === type)!
      expect(item.from?.toISOString()).toBe('2026-09-22T00:00:00.000Z')
      expect(item.to?.toISOString()).toBe('2026-10-22T00:00:00.000Z')
    }
  })

  it('销售与流量报告每天申请昨天（UTC 日）整一天，窗口恰好一天', () => {
    const item = dueReports(new Date('2026-10-22T08:30:00Z')).find(entry => entry.reportType === 'GET_SALES_AND_TRAFFIC_REPORT')!
    expect(item.from?.toISOString()).toBe('2026-10-21T00:00:00.000Z')
    expect(item.to?.toISOString()).toBe('2026-10-21T23:59:59.999Z')
    expect(item.requiresKioskSalesTraffic).toBe(true)
  })

  it('每种报告只出现一次', () => {
    // 品牌分析的周报与月报是同一种类型的两个不同窗口，所以按「类型 + 窗口起点」判断
    const keys = dueReports(new Date('2026-10-22T00:00:00Z')).map(item => `${item.reportType}|${item.from?.toISOString() ?? ''}`)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('定时申请库存类报告', () => {
  function setup(existing: number, kioskSalesTraffic = true) {
    const prisma = {
      fbaReportJob: {
        count: vi.fn(async () => existing),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `rj-${data.reportType}`, ...data })),
        update: vi.fn(async () => ({})),
      },
      salesTrafficDaily: { findFirst: vi.fn(async () => (kioskSalesTraffic ? { id: 'st1' } : null)) },
      syncJob: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `sj-${(data.context as { reportType: string }).reportType}`, ...data })) },
    }
    const systemPrisma = { platformConnection: { findMany: vi.fn(async () => [{ id: 'c1', tenantId: 't1', sellerAccountId: 'sa1' }]) } }
    const queues = { addSync: vi.fn(async () => undefined) }
    return { prisma, systemPrisma, queues, deps: { prisma, systemPrisma, queues } as unknown as ScheduleDeps }
  }

  it('销售与流量报告只给数据中心已经有数据的店铺申请（报告需要同样的品牌分析角色，也没有可核对的对象）', async () => {
    vi.stubEnv('APP_MODE', 'production')
    vi.stubEnv('MOCK_CONNECTOR', 'false')
    const now = new Date('2026-10-22T08:00:00Z')
    const without = setup(0, false)
    expect(await scheduleInventoryReports(without.deps, now)).toBe(dueReports(now).length - 1)
    expect(without.prisma.fbaReportJob.create.mock.calls.map(call => call[0].data.reportType)).not.toContain('GET_SALES_AND_TRAFFIC_REPORT')
    const withData = setup(0, true)
    await scheduleInventoryReports(withData.deps, now)
    expect(withData.prisma.fbaReportJob.create.mock.calls.map(call => call[0].data.reportType)).toContain('GET_SALES_AND_TRAFFIC_REPORT')
    vi.unstubAllEnvs()
  })

  it('非生产环境与模拟连接不申请', async () => {
    const { deps, systemPrisma } = setup(0)
    vi.stubEnv('APP_MODE', 'development')
    expect(await scheduleInventoryReports(deps)).toBe(0)
    expect(systemPrisma.platformConnection.findMany).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('生产环境：为到期的报告建报告任务与同步任务并入队；窗口内已有的不重复申请', async () => {
    vi.stubEnv('APP_MODE', 'production')
    vi.stubEnv('MOCK_CONNECTOR', 'false')
    const now = new Date('2026-10-22T08:00:00Z')
    const fresh = setup(0)
    const created = await scheduleInventoryReports(fresh.deps, now)
    expect(created).toBe(dueReports(now).length)
    expect(fresh.prisma.fbaReportJob.create).toHaveBeenCalledTimes(created)
    const planning = fresh.prisma.syncJob.create.mock.calls.map(call => call[0].data).find(data => (data.context as { reportType: string }).reportType === 'GET_FBA_INVENTORY_PLANNING_DATA')!
    expect(planning).toMatchObject({ tenantId: 't1', connectionId: 'c1', type: 'FBA_REPORT_CREATE', domain: 'reports', requestId: 'schedule' })
    expect(fresh.queues.addSync).toHaveBeenCalledTimes(created)
    expect(fresh.queues.addSync.mock.calls[0]).toMatchObject(['FBA_REPORT_CREATE', { tenantId: 't1', reportJobId: expect.any(String), reportType: expect.any(String) }, { priority: 3 }])
    const done = setup(1)
    expect(await scheduleInventoryReports(done.deps, now)).toBe(0)
    expect(done.queues.addSync).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})

describe('品牌分析报告的到期计划（P4-04）', () => {
  const windowsOf = (now: string) => dueBrandReports(new Date(now)).map(item => `${item.from?.toISOString().slice(0, 10)}~${item.to?.toISOString().slice(0, 10)}`)

  it('周报：周二至周六申请上一个自然周（周日至周六）；周日与周一不申请', () => {
    expect(windowsOf('2026-10-20T08:00:00Z')).toContain('2026-10-11~2026-10-17') // 周二
    expect(windowsOf('2026-10-24T08:00:00Z')).toContain('2026-10-11~2026-10-17') // 周六
    const sunday = windowsOf('2026-10-25T08:00:00Z')
    const monday = windowsOf('2026-10-26T08:00:00Z')
    expect(sunday.filter(item => item.endsWith('2026-10-24'))).toEqual([])
    expect(monday.filter(item => item.endsWith('2026-10-24'))).toEqual([])
  })

  it('月报：每月 6 日之后申请上一个自然月；跨年取去年 12 月；季度不排程', () => {
    expect(windowsOf('2026-10-06T08:00:00Z')).toContain('2026-09-01~2026-09-30')
    expect(windowsOf('2026-10-05T08:00:00Z')).not.toContain('2026-09-01~2026-09-30')
    expect(windowsOf('2027-01-08T08:00:00Z')).toContain('2026-12-01~2026-12-31')
    expect(dueBrandReports(new Date('2026-10-22T08:00:00Z')).filter(item => item.to!.getTime() - item.from!.getTime() > 31 * 86_400_000)).toEqual([])
  })

  it('五份报告每个窗口各一份，按窗口去重（perWindow）；日期是 UTC 日零点', () => {
    const due = dueBrandReports(new Date('2026-10-22T08:00:00Z'))
    expect(due).toHaveLength(BA_REPORT_TYPES.length * 2) // 周 + 月
    expect(due.every(item => item.perWindow === true)).toBe(true)
    expect(due.filter(item => item.reportType === BA_REPORT_TYPES[0]).map(item => item.to?.toISOString())).toEqual(['2026-10-17T00:00:00.000Z', '2026-09-30T00:00:00.000Z'])
    const all = dueReports(new Date('2026-10-22T08:00:00Z')).map(item => item.reportType)
    for (const type of BA_REPORT_TYPES) expect(all).toContain(type)
  })

  it('已申请过同一窗口的不再申请（不看创建时间）；失败的窗口也不每天重复', async () => {
    vi.stubEnv('APP_MODE', 'production')
    vi.stubEnv('MOCK_CONNECTOR', 'false')
    const now = new Date('2026-10-22T08:00:00Z')
    const counts: Array<Record<string, unknown>> = []
    const prisma = {
      fbaReportJob: {
        count: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          counts.push(where)
          return BA_REPORT_TYPES.includes(where.reportType as string) ? 1 : 0
        }),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: `rj-${data.reportType}`, ...data })),
        update: vi.fn(async () => ({})),
      },
      salesTrafficDaily: { findFirst: vi.fn(async () => ({ id: 'st1' })) },
      syncJob: { create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: 'sj', ...data })) },
    }
    const deps = {
      prisma,
      systemPrisma: { platformConnection: { findMany: vi.fn(async () => [{ id: 'c1', tenantId: 't1', sellerAccountId: 'sa1' }]) } },
      queues: { addSync: vi.fn(async () => undefined) },
    } as unknown as ScheduleDeps
    await scheduleInventoryReports(deps, now)
    const brandCounts = counts.filter(where => BA_REPORT_TYPES.includes(where.reportType as string))
    expect(brandCounts.length).toBeGreaterThan(0)
    for (const where of brandCounts) expect(where).toMatchObject({ fromDate: expect.any(Date), toDate: expect.any(Date) })
    for (const where of brandCounts) expect(where.createdAt).toBeUndefined()
    expect(prisma.fbaReportJob.create.mock.calls.map(call => call[0].data.reportType).filter(type => BA_REPORT_TYPES.includes(type as string))).toEqual([])
    vi.unstubAllEnvs()
  })
})
