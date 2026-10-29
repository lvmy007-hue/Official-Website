import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../types'
import { clearDataKioskDatasetsForTest, dataKioskDatasetFor } from './registry'
import { registerDataKioskDatasets } from './register'
import { buildSalesTrafficAsinQuery, buildSalesTrafficDateQuery, buildSalesTrafficTrendsQuery, salesTrafficAsinDataset, salesTrafficDateDataset, salesTrafficTrendsDataset } from './sales-traffic'
import { readFigures, readKioskAsinRow, readKioskDateRow, readReportAsinRow, readReportDateRow } from './sales-traffic-parse'

// 销售与流量（P4-01，D-01、D-02、D-03）：查询文本、结果行解析（缺失字段是“官方没给”不是 0；百分数换算成小数）、按键覆盖写入且不抹掉另一个数据集写的列。

const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const amount = (value: number, currency = 'USD') => ({ amount: value, currencyCode: currency })
const sales = (overrides: Record<string, unknown> = {}) => ({
  orderedProductSales: amount(1234.5),
  orderedProductSalesB2B: amount(100),
  unitsOrdered: 50,
  unitsOrderedB2B: 4,
  totalOrderItems: 40,
  unitsRefunded: 2,
  refundRate: 4,
  claimsGranted: 1,
  ...overrides,
})
const traffic = (overrides: Record<string, unknown> = {}) => ({ pageViews: 1000, sessions: 600, buyBoxPercentage: 95.5, unitSessionPercentage: 8.3, ...overrides })
const dateRow = (overrides: Record<string, unknown> = {}) => ({ startDate: '2026-10-20', endDate: '2026-10-20', sales: sales(), traffic: traffic(), ...overrides })
const asinRow = (overrides: Record<string, unknown> = {}) => ({
  startDate: '2026-10-20',
  endDate: '2026-10-20',
  parentAsin: 'B0PARENT01',
  childAsin: 'B0CHILD001',
  sku: 'SKU-A',
  sales: sales(),
  traffic: traffic(),
  ...overrides,
})

describe('查询文本', () => {
  it('按日期：窗口、粒度、美国站；压缩后不超过 8000 字符；粒度缺省为日', () => {
    const query = buildSalesTrafficDateQuery({ startDate: '2026-10-01', endDate: '2026-10-07', granularity: 'WEEK' })
    expect(query).toContain('salesAndTrafficByDate(')
    expect(query).toContain('startDate: "2026-10-01", endDate: "2026-10-07", aggregateBy: WEEK')
    expect(query).toContain('marketplaceIds: ["ATVPDKIKX0DER"]')
    for (const field of ['orderedProductSales', 'unitsOrdered', 'totalOrderItems', 'sessions', 'pageViews', 'buyBoxPercentage', 'unitSessionPercentage', 'refundRate']) expect(query).toContain(field)
    expect(query.replace(/\s+/g, ' ').length).toBeLessThan(8000)
    expect(buildSalesTrafficDateQuery({ startDate: '2026-10-01', endDate: '2026-10-07' })).toContain('aggregateBy: DAY')
  })

  it('按日期：日期不对、倒置、超过 92 天、粒度不认识都本地拒绝', () => {
    const base = { startDate: '2026-10-01', endDate: '2026-10-07' }
    expect(() => buildSalesTrafficDateQuery({ ...base, startDate: '2026-10-01T00:00' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
    expect(() => buildSalesTrafficDateQuery({ startDate: '2026-10-08', endDate: '2026-10-07' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
    expect(() => buildSalesTrafficDateQuery({ startDate: '2026-07-01', endDate: '2026-10-01' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
    expect(() => buildSalesTrafficDateQuery({ ...base, granularity: 'YEAR' })).toThrow('SALES_TRAFFIC_GRANULARITY_INVALID')
  })

  it('按 ASIN：单独一天；身份字段随粒度；外部输入只以字符串字面量进入查询', () => {
    const parent = buildSalesTrafficAsinQuery({ date: '2026-10-20', asinGranularity: 'PARENT' })
    expect(parent).toContain('salesAndTrafficByAsin(')
    expect(parent).toContain('startDate: "2026-10-20", endDate: "2026-10-20", aggregateBy: PARENT')
    expect(parent).toContain('parentAsin')
    expect(parent).not.toContain('childAsin')
    expect(buildSalesTrafficAsinQuery({ date: '2026-10-20', asinGranularity: 'SKU' })).toContain('parentAsin childAsin sku')
    expect(() => buildSalesTrafficAsinQuery({ date: '2026-10-20T00', asinGranularity: 'CHILD' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
    expect(() => buildSalesTrafficAsinQuery({ date: '2026-10-20', asinGranularity: 'child' })).toThrow('SALES_TRAFFIC_GRANULARITY_INVALID')
    expect(() => buildSalesTrafficAsinQuery({ date: '2026-10-20", asinGranularity: DROP', asinGranularity: 'CHILD' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
  })

  it('趋势：窗口与店铺日期查询同样校验', () => {
    expect(buildSalesTrafficTrendsQuery({ startDate: '2026-10-01', endDate: '2026-10-07' })).toContain('salesAndTrafficTrends(')
    expect(() => buildSalesTrafficTrendsQuery({ startDate: '2026-10-07', endDate: '2026-10-01' })).toThrow('SALES_TRAFFIC_DATE_INVALID')
  })

  it('三个数据集登记到数据中心，都声明 403 → DK_NO_BRAND', () => {
    clearDataKioskDatasetsForTest()
    registerDataKioskDatasets()
    for (const [id, dataset] of [
      ['dk.sales-traffic-by-date', salesTrafficDateDataset],
      ['dk.sales-traffic-by-asin', salesTrafficAsinDataset],
      ['dk.sales-traffic-trends', salesTrafficTrendsDataset],
    ] as const) {
      expect(dataKioskDatasetFor(id)).toBe(dataset)
      expect(dataset.roleMissing?.code).toBe('DK_NO_BRAND')
    }
  })
})

describe('结果行解析', () => {
  it('数据中心的店铺日行：金额、件数、会话；百分数换算成小数；币种取销售额的', () => {
    expect(readKioskDateRow(dateRow())).toEqual({
      date: '2026-10-20',
      orderedSales: 1234.5,
      unitsOrdered: 50,
      ordersCount: 40,
      sessions: 600,
      pageViews: 1000,
      buyBoxPct: 0.955,
      unitSessionPct: 0.083,
      unitsRefunded: 2,
      refundRate: 0.04,
      claimsGranted: 1,
      b2bSales: 100,
      b2bUnits: 4,
      currency: 'USD',
    })
  })

  it('官方没给的值是 null，不补 0；越界的百分数、负数、非数字也是 null', () => {
    const parsed = readKioskDateRow(dateRow({ sales: { unitsOrdered: -3, refundRate: 180 }, traffic: { sessions: 'abc', buyBoxPercentage: null } }))
    expect(parsed).toMatchObject({ orderedSales: null, unitsOrdered: null, ordersCount: null, sessions: null, pageViews: null, buyBoxPct: null, refundRate: null, b2bSales: null, currency: null })
    expect(readKioskDateRow({ startDate: '2026-10-20' })).toBeNull() // 没有任何指标
    expect(readKioskDateRow({ sales: sales() })).toBeNull() // 没有日期
    expect(readFigures(undefined, undefined)).toBeNull()
    expect(readFigures({ unitsOrdered: '12' }, undefined)?.unitsOrdered).toBe(12) // 官方可能以数字字符串给整数
  })

  it('报告 JSON 的行用 salesByDate / trafficByDate，口径与数据中心一致', () => {
    const parsed = readReportDateRow({ date: '2026-10-20', salesByDate: sales(), trafficByDate: traffic() })
    expect(parsed).toMatchObject({ date: '2026-10-20', orderedSales: 1234.5, buyBoxPct: 0.955, sessions: 600 })
    expect(readReportDateRow({ salesByDate: sales() })).toBeNull()
  })

  it('ASIN 行的身份随粒度：父体用父 ASIN；子体用子 ASIN；SKU 要有 SKU，缺身份丢弃', () => {
    expect(readKioskAsinRow(asinRow(), 'PARENT')).toMatchObject({ asin: 'B0PARENT01', sku: '', parentAsin: null })
    expect(readKioskAsinRow(asinRow(), 'CHILD')).toMatchObject({ asin: 'B0CHILD001', sku: '', parentAsin: 'B0PARENT01', date: '2026-10-20' })
    expect(readKioskAsinRow(asinRow(), 'SKU')).toMatchObject({ asin: 'B0CHILD001', sku: 'SKU-A' })
    expect(readKioskAsinRow(asinRow({ sku: undefined }), 'SKU')).toBeNull()
    expect(readKioskAsinRow(asinRow({ childAsin: ' ' }), 'CHILD')).toBeNull()
  })

  it('ASIN 行跨多天（开始日不等于结束日）放不进日表，丢弃；没给结束日按开始日', () => {
    expect(readKioskAsinRow(asinRow({ endDate: '2026-10-21' }), 'CHILD')).toBeNull()
    expect(readKioskAsinRow(asinRow({ endDate: undefined }), 'CHILD')).not.toBeNull()
  })

  it('报告的 ASIN 行没有日期列：日期由调用方给', () => {
    const parsed = readReportAsinRow({ parentAsin: 'B0PARENT01', childAsin: 'B0CHILD001', salesByAsin: sales(), trafficByAsin: traffic() }, 'CHILD', '2026-10-21')
    expect(parsed).toMatchObject({ date: '2026-10-21', asin: 'B0CHILD001', unitsOrdered: 50 })
  })
})

function context() {
  const daily = { upsert: vi.fn(async () => ({})) }
  const asin = { upsert: vi.fn(async () => ({})) }
  const prisma = { salesTrafficDaily: daily, salesTrafficAsinDaily: asin } as unknown as PrismaClient
  return { daily, asin, ctx: { prisma, logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger } as ImportContext }
}

describe('写入', () => {
  it('店铺日行按唯一键覆盖写入，来源是数据中心；官方没给的列不进更新，不抹掉别的数据集写的值', async () => {
    const { ctx, daily } = context()
    const outcome = await salesTrafficDateDataset.handle(ctx, dateRow({ sales: { unitsOrdered: 7 }, traffic: {} }), scope, { granularity: 'DAY' })
    expect(outcome).toBe('imported')
    const call = daily.upsert.mock.calls[0] as unknown as [
      { where: { tenantId_sellerAccountId_date_granularity_source: Record<string, unknown> }; create: Record<string, unknown>; update: Record<string, unknown> },
    ]
    expect(call[0].where.tenantId_sellerAccountId_date_granularity_source).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', granularity: 'DAY', source: 'DATA_KIOSK' })
    expect(call[0].update).toMatchObject({ unitsOrdered: 7, currency: 'USD' })
    expect(call[0].update).not.toHaveProperty('orderedSales')
    expect(call[0].update).not.toHaveProperty('sessions')
    expect(call[0].create).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', unitsOrdered: 7 })
  })

  it('周粒度的行带着周粒度写入；没有日期的行跳过', async () => {
    const { ctx, daily } = context()
    await salesTrafficDateDataset.handle(ctx, dateRow(), scope, { granularity: 'WEEK' })
    expect((daily.upsert.mock.calls[0] as unknown as [{ create: { granularity: string } }])[0].create.granularity).toBe('WEEK')
    expect(await salesTrafficDateDataset.handle(ctx, { sales: sales() }, scope, { granularity: 'DAY' })).toBe('skipped')
  })

  it('ASIN 行按粒度写入；跨多天的行跳过；趋势按子体写同一张表', async () => {
    const { ctx, asin } = context()
    expect(await salesTrafficAsinDataset.handle(ctx, asinRow(), scope, { asinGranularity: 'SKU', date: '2026-10-20' })).toBe('imported')
    expect(asin.upsert.mock.calls[0]?.[0]).toMatchObject({ create: { asin: 'B0CHILD001', sku: 'SKU-A', asinGranularity: 'SKU', parentAsin: 'B0PARENT01', units: 50, b2bUnits: 4 } })
    expect(await salesTrafficAsinDataset.handle(ctx, asinRow({ endDate: '2026-10-22' }), scope, { asinGranularity: 'CHILD', date: '2026-10-20' })).toBe('skipped')
    expect(await salesTrafficTrendsDataset.handle(ctx, asinRow({ sku: undefined }), scope, { startDate: '2026-10-14', endDate: '2026-10-20' })).toBe('imported')
    expect(asin.upsert.mock.calls.at(-1)?.[0]).toMatchObject({ create: { asinGranularity: 'CHILD', sku: '' } })
  })

  it('带 data 外壳的行也能读（与其他数据中心数据集一致）', async () => {
    const { ctx, daily } = context()
    const wrapped = { data: { analytics_salesAndTraffic_2024_04_24: { salesAndTrafficByDate: dateRow() } } }
    expect(await salesTrafficDateDataset.handle(ctx, wrapped, scope, { granularity: 'DAY' })).toBe('imported')
    expect(daily.upsert).toHaveBeenCalledTimes(1)
  })
})
