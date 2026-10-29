import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../types'
import { buildEconomicsPreviewQuery, economicsPreviewDataset, readPreviewLines } from './economics-preview'

// 官方费用预览（P2b-11，D-05）：查询文本、一行拆成多段、没有费用调整时单件变化为 null。

const params = { startDate: '2026-10-23', endDate: '2027-02-18', queriedAt: '2026-10-23T08:00:00.000Z', sellerAccountId: 'sa1' }
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const amount = (value: number) => ({ amount: value, currencyCode: 'USD' })
const charge = (start: string, end: string, total: number, quantity: number | null, perUnit: number | null, delta: number | null) => ({
  startDate: start,
  endDate: end,
  aggregatedDetail: { totalAmount: amount(total), quantity, amountPerUnit: perUnit === null ? null : amount(perUnit), amountPerUnitDelta: delta === null ? null : amount(delta) },
})
const row = {
  msku: 'SKU-A',
  childAsin: 'B0AAAAAAA1',
  startDate: '2026-10-23',
  endDate: '2027-02-18',
  fees: [
    { feeTypeName: 'FBA_FULFILLMENT_FEES', charges: [charge('2026-10-23', '2027-01-14', 300, 100, 3, null), charge('2027-01-15', '2027-02-18', 360, 100, 3.6, 0.6)] },
    { feeTypeName: 'REFERRAL_FEES', charges: [{ startDate: '2026-10-23', endDate: '2027-02-18', aggregatedDetail: {} }] },
  ],
}

describe('查询文本', () => {
  it('按官方 schema 拼装：区间聚合、美国站、费用类型取枚举值（不加引号）；压缩后不超过 8000 字符', () => {
    const query = buildEconomicsPreviewQuery(params)
    expect(query).toContain('economicsPreview(')
    expect(query).toContain('aggregateBy: { date: RANGE, productId: MSKU }')
    expect(query).toContain('startDate: "2026-10-23", endDate: "2027-02-18"')
    expect(query).toMatch(/feeTypes: \[FBA_FULFILLMENT_FEES, /)
    expect(query).toContain('amountPerUnitDelta')
    expect(query.replace(/\s+/g, ' ').length).toBeLessThan(8000)
  })

  it('日期不合法或区间超过 119 天本地拒绝', () => {
    expect(() => buildEconomicsPreviewQuery({ ...params, endDate: '2027-02-19' })).toThrow('ECONOMICS_PREVIEW_DATE_INVALID')
    expect(() => buildEconomicsPreviewQuery({ ...params, startDate: 'x' })).toThrow('ECONOMICS_PREVIEW_DATE_INVALID')
    expect(() => buildEconomicsPreviewQuery({ ...params, endDate: '2026-10-22' })).toThrow('ECONOMICS_PREVIEW_DATE_INVALID')
  })
})

describe('结果行解析', () => {
  it('每个费用类型下每一段区间一行；没有金额的段丢弃；没有调整时单件变化为 null', () => {
    const lines = readPreviewLines(row, params)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      msku: 'SKU-A',
      feeType: 'FBA_FULFILLMENT_FEES',
      rangeStart: '2026-10-23',
      rangeEnd: '2027-01-14',
      estimatedAmount: 300,
      quantity: 100,
      amountPerUnit: 3,
      amountPerUnitDelta: null,
    })
    expect(lines[1]).toMatchObject({ rangeStart: '2027-01-15', estimatedAmount: 360, amountPerUnit: 3.6, amountPerUnitDelta: 0.6 })
  })

  it('段里没有日期时用行上的日期，行上也没有就用查询窗口；没有 SKU 的行无法使用', () => {
    const bare = { msku: 'S', fees: [{ feeTypeName: 'REFERRAL_FEES', charges: [{ aggregatedDetail: { totalAmount: amount(9) } }] }] }
    expect(readPreviewLines(bare, params)[0]).toMatchObject({ rangeStart: '2026-10-23', rangeEnd: '2027-02-18', quantity: null, amountPerUnit: null })
    expect(readPreviewLines({ fees: [] }, params)).toEqual([])
  })
})

describe('结果落库', () => {
  it('每一段按（企业、店铺、SKU、费用类型、区间）键覆盖写入，并带上本次查询时间', async () => {
    const upsert = vi.fn(async () => ({}))
    const ctx: ImportContext = { prisma: { economicsPreview: { upsert } } as unknown as PrismaClient, logger: { warn: vi.fn() } as unknown as Logger }
    expect(await economicsPreviewDataset.handle(ctx, row, scope, params)).toBe('imported')
    expect(upsert).toHaveBeenCalledTimes(2)
    const first = upsert.mock.calls[0] as unknown as [{ create: Record<string, unknown>; update: Record<string, unknown> }]
    expect(first[0].create).toMatchObject({ tenantId: 't1', feeType: 'FBA_FULFILLMENT_FEES', queriedAt: new Date('2026-10-23T08:00:00.000Z') })
    expect(first[0].update).toMatchObject({ queriedAt: new Date('2026-10-23T08:00:00.000Z') })
  })

  it('没有可用行时跳过', async () => {
    const upsert = vi.fn()
    const ctx: ImportContext = { prisma: { economicsPreview: { upsert } } as unknown as PrismaClient, logger: { warn: vi.fn() } as unknown as Logger }
    expect(await economicsPreviewDataset.handle(ctx, { msku: 'X', fees: [] }, scope, params)).toBe('skipped')
    expect(upsert).not.toHaveBeenCalled()
  })
})
