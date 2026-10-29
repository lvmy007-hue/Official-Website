import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../types'
import { buildEconomicsDailyQuery, economicsDailyDataset, readEconomicsDay } from './economics-daily'
import { clearDataKioskDatasetsForTest, dataKioskDatasetFor } from './registry'
import { registerDataKioskDatasets } from './register'

// 官方单品经济（P2b-11，D-04）：查询文本、结果行解析（缺失字段是“官方没给”而不是 0）、按键覆盖写入。

const params = { startDate: '2026-10-10', endDate: '2026-10-23', sellerAccountId: 'sa1' }
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const amount = (value: number, currency = 'USD') => ({ amount: value, currencyCode: currency })
const row = (overrides: Record<string, unknown> = {}) => ({
  startDate: '2026-10-20',
  msku: 'SKU-A',
  childAsin: 'B0AAAAAAA1',
  sales: { orderedProductSales: amount(120), refundedProductSales: amount(20), netProductSales: amount(100), unitsOrdered: 6, unitsRefunded: 1, netUnitsSold: 5 },
  fees: [
    { feeTypeName: 'FBA fulfillment fees', charges: [{ aggregatedDetail: { totalAmount: amount(12.5) } }, { aggregatedDetail: { totalAmount: amount(2.5) } }] },
    { feeTypeName: 'Referral fees', charges: [{ aggregatedDetail: { totalAmount: amount(15) } }] },
  ],
  ads: [{ adTypeName: 'SP', charge: { totalAmount: amount(8) } }],
  cost: { costOfGoodsSold: amount(3), fbaCost: { shippingToAmazonCost: amount(0.5) } },
  netProceeds: { total: amount(55) },
  ...overrides,
})

describe('查询文本', () => {
  it('按官方 schema 拼装：按天按 MSKU 聚合、美国站、带销售/费用/广告/成本/净收入；压缩后不超过 8000 字符', () => {
    const query = buildEconomicsDailyQuery(params)
    expect(query).toContain('economics(')
    expect(query).toContain('aggregateBy: { date: DAY, productId: MSKU }')
    expect(query).toContain('marketplaceIds: ["ATVPDKIKX0DER"]')
    expect(query).toContain('startDate: "2026-10-10", endDate: "2026-10-23"')
    for (const field of ['netProductSales', 'feeTypeName', 'adTypeName', 'costOfGoodsSold', 'shippingToAmazonCost', 'netProceeds']) expect(query).toContain(field)
    expect(query.replace(/\s+/g, ' ').length).toBeLessThan(8000)
  })

  it('日期格式不对、倒置、超过 90 天的窗口本地拒绝', () => {
    expect(() => buildEconomicsDailyQuery({ ...params, startDate: '2026-10-10T00:00' })).toThrow('ECONOMICS_DAILY_DATE_INVALID')
    expect(() => buildEconomicsDailyQuery({ ...params, startDate: '2026-10-24', endDate: '2026-10-23' })).toThrow('ECONOMICS_DAILY_DATE_INVALID')
    expect(() => buildEconomicsDailyQuery({ startDate: '2026-07-01', endDate: '2026-10-23' })).toThrow('ECONOMICS_DAILY_DATE_INVALID')
    expect(() => buildEconomicsDailyQuery({ startDate: '2026-07-25', endDate: '2026-10-23' })).not.toThrow() // 恰好 91 天内（回补 90 天 + 余量）
  })
})

describe('结果行解析', () => {
  it('销售取净额；费用按类型把各笔相加；广告相加；成本 = 商品成本 + 发往亚马逊运费；币种取第一个有的', () => {
    expect(readEconomicsDay(row())).toEqual({
      msku: 'SKU-A',
      asin: 'B0AAAAAAA1',
      date: '2026-10-20',
      currency: 'USD',
      unitsOrdered: 6,
      unitsRefunded: 1,
      netUnits: 5,
      orderedSales: 120,
      refundedSales: 20,
      sales: 100,
      fees: { 'FBA fulfillment fees': 15, 'Referral fees': 15 },
      feesTotal: 30,
      adsSpend: 8,
      costPerUnit: 3.5,
      cost: { cogs: 3, shippingToAmazon: 0.5 },
      netProceeds: 55,
    })
  })

  it('卖家没填成本、没有广告、没有净收入：成本与净收入为 null，广告为 0（官方没有广告扣款）', () => {
    const parsed = readEconomicsDay(row({ cost: null, ads: [], netProceeds: null }))
    expect(parsed).toMatchObject({ costPerUnit: null, cost: null, netProceeds: null, adsSpend: 0 })
  })

  it('兼容带 data 外壳的写法与数字字符串；没有 SKU、日期或净销售额的行无法使用', () => {
    const wrapped = { data: { analytics_economics_2024_03_15: { economics: [row({ sales: { netProductSales: { amount: '99.5', currencyCode: 'USD' }, netUnitsSold: '4' } })] } } }
    expect(readEconomicsDay(wrapped)).toMatchObject({ sales: 99.5, netUnits: 4 })
    expect(readEconomicsDay(row({ msku: '' }))).toBeNull()
    expect(readEconomicsDay(row({ startDate: 'bad' }))).toBeNull()
    expect(readEconomicsDay(row({ sales: {} }))).toBeNull()
  })

  it('币种不是美元时原样保留，由对账页决定不核对', () => {
    expect(readEconomicsDay(row({ sales: { netProductSales: amount(80, 'CAD') } }))?.currency).toBe('CAD')
  })
})

describe('结果落库', () => {
  const makeCtx = () => {
    const upsert = vi.fn(async () => ({}))
    const prisma = { economicsDaily: { upsert } } as unknown as PrismaClient
    const ctx: ImportContext = { prisma, logger: { warn: vi.fn() } as unknown as Logger }
    return { ctx, upsert }
  }

  it('按（企业、店铺、SKU、日期、聚合）键覆盖写入，重试不会重复', async () => {
    const { ctx, upsert } = makeCtx()
    expect(await economicsDailyDataset.handle(ctx, row(), scope, params)).toBe('imported')
    const args = upsert.mock.calls[0] as unknown as [{ where: Record<string, unknown>; create: Record<string, unknown>; update: Record<string, unknown> }]
    expect(args[0].where).toEqual({
      tenantId_sellerAccountId_msku_date_aggregation: { tenantId: 't1', sellerAccountId: 'sa1', msku: 'SKU-A', date: new Date('2026-10-20T00:00:00Z'), aggregation: 'DAY' },
    })
    expect(args[0].create).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', sales: 100, feesTotal: 30, adsSpend: 8, sellerCostPerUnit: 3.5, netProceeds: 55, asin: 'B0AAAAAAA1' })
    expect(args[0].update).not.toHaveProperty('tenantId')
  })

  it('无法解析的行跳过，不写入', async () => {
    const { ctx, upsert } = makeCtx()
    expect(await economicsDailyDataset.handle(ctx, { msku: 'X' }, scope, params)).toBe('skipped')
    expect(upsert).not.toHaveBeenCalled()
  })
})

describe('注册', () => {
  it('三个数据集一次登记齐全；重复登记报错', () => {
    clearDataKioskDatasetsForTest()
    registerDataKioskDatasets()
    for (const id of ['dk.economics', 'dk.economics-preview', 'dk.economics-simulation']) expect(dataKioskDatasetFor(id)).toBeDefined()
    expect(() => registerDataKioskDatasets()).toThrow('DATA_KIOSK_DATASET_DUPLICATE')
    clearDataKioskDatasetsForTest()
  })
})
