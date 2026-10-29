import type { PrismaClient } from '@prisma/client'
import { describe, expect, it } from 'vitest'
import { fakeContext, rowsOf, scope, tsv } from '../inventory/fake-context.test-helper'
import { feeBaselineImporterFor, syncFeeEstimateReport, syncReferralPreviewReport } from './fee-baseline'

// 费用核查基准报告导入（R-23、R-24）：单位换算、尺寸分段与上次快照、自发货行与缺列、两份报告互不覆盖。

const HEAD = [
  'sku',
  'asin',
  'product-size-tier',
  'longest-side',
  'median-side',
  'shortest-side',
  'unit-of-dimension',
  'item-package-weight',
  'unit-of-weight',
  'expected-fulfillment-fee-per-unit',
  'fulfilled-by',
  'currency',
]

/** 在通用替身上让“上次快照”的查询返回指定的尺寸分段。 */
function withPrevious(sizeTier: string | null) {
  const base = fakeContext()
  const prisma: PrismaClient = new Proxy(base.ctx.prisma, {
    get(target, model: string) {
      // 导入器在事务回调里拿到的是替身自己，要换成加了查询覆盖的这一个
      if (model === '$transaction') return async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma)
      if (model !== 'feeBaseline') return Reflect.get(target, model)
      const inner = Reflect.get(target, model) as Record<string, unknown>
      return new Proxy(inner, {
        get(innerTarget, op: string) {
          if (op !== 'findFirst') return Reflect.get(innerTarget, op)
          return async (args: unknown) => {
            await (Reflect.get(innerTarget, op) as (value: unknown) => Promise<unknown>)(args)
            return sizeTier ? { sizeTier } : null
          }
        },
      })
    },
  }) as unknown as PrismaClient
  return { ...base, ctx: { ...base.ctx, prisma } }
}

describe('R-23 预估配送费报告', () => {
  it('换算尺寸与重量，记录尺寸分段与单件预期配送费', async () => {
    const { ctx, of } = fakeContext()
    const result = await syncFeeEstimateReport(ctx, rowsOf(tsv(HEAD, ['SKU-1', 'B0TEST0001', 'Large Standard', '10', '8', '4', 'inches', '2', 'pounds', '4.5', 'Amazon', 'USD'])), scope)
    expect(result.imported).toBe(1)
    const baseline = of('feeBaseline')[0].args
    expect(baseline.where).toEqual({ sellerAccountId_sku_snapshotDate: { sellerAccountId: 'sa1', sku: 'SKU-1', snapshotDate: scope.snapshotDate } })
    expect(baseline.create).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      sku: 'SKU-1',
      asin: 'B0TEST0001',
      sizeTier: 'Large Standard',
      expectedFulfillmentFee: 4.5,
      currency: 'USD',
      sourceReportJobId: 'rj1',
    })
    expect(baseline.create.lengthCm).toBeCloseTo(25.4, 3)
    expect(baseline.create.widthCm).toBeCloseTo(20.32, 3)
    expect(baseline.create.heightCm).toBeCloseTo(10.16, 3)
    expect(baseline.create.weightKg).toBeCloseTo(0.9072, 3)
  })

  it('尺寸三边按从长到短存放，与报告里的列顺序无关', async () => {
    const { ctx, of } = fakeContext()
    await syncFeeEstimateReport(ctx, rowsOf(tsv(HEAD, ['SKU-1', '', 'Small Standard', '2', '10', '5', 'centimeters', '', '', '', '', ''])), scope)
    expect(of('feeBaseline')[0].args.create).toMatchObject({ lengthCm: 10, widthCm: 5, heightCm: 2 })
  })

  it('上次快照的分段不同：写入 prevSizeTier；没有上次快照写空', async () => {
    const changed = withPrevious('Small Standard')
    await syncFeeEstimateReport(changed.ctx, rowsOf(tsv(HEAD, ['SKU-1', '', 'Large Standard', '', '', '', '', '', '', '4', '', ''])), scope)
    expect(changed.of('feeBaseline')[0].args.create).toMatchObject({ sizeTier: 'Large Standard', prevSizeTier: 'Small Standard' })
    const first = withPrevious(null)
    await syncFeeEstimateReport(first.ctx, rowsOf(tsv(HEAD, ['SKU-1', '', 'Large Standard', '', '', '', '', '', '', '4', '', ''])), scope)
    expect(first.of('feeBaseline')[0].args.create.prevSizeTier).toBeNull()
  })

  it('报告里没给的数值保持为空，不写 0', async () => {
    const { ctx, of } = fakeContext()
    await syncFeeEstimateReport(ctx, rowsOf(tsv(HEAD, ['SKU-1', '', 'Large Standard', '', '', '', '', '', '', '', '', ''])), scope)
    const create = of('feeBaseline')[0].args.create
    expect(create).not.toHaveProperty('expectedFulfillmentFee')
    expect(create).not.toHaveProperty('weightKg')
    expect(create).not.toHaveProperty('lengthCm')
  })

  it('自发货的行与没有 SKU 的行忽略；单位认不出的尺寸不写', async () => {
    const { ctx, of } = fakeContext()
    const result = await syncFeeEstimateReport(
      ctx,
      rowsOf(
        tsv(
          HEAD,
          ['SKU-M', '', 'Large Standard', '', '', '', '', '', '', '4', 'Merchant', ''],
          ['', '', 'Large Standard', '', '', '', '', '', '', '4', '', ''],
          ['SKU-U', '', 'Large Standard', '3', '2', '1', 'furlongs', '', '', '4', '', ''],
        ),
      ),
      scope,
    )
    expect(result.imported).toBe(1)
    expect(of('feeBaseline')).toHaveLength(1)
    expect(of('feeBaseline')[0].args.create).toMatchObject({ sku: 'SKU-U' })
    expect(of('feeBaseline')[0].args.create).not.toHaveProperty('lengthCm')
  })

  it('缺少关键列：整份报告失败，不当作“没有数据”', async () => {
    const { ctx } = fakeContext()
    await expect(syncFeeEstimateReport(ctx, rowsOf(tsv(['foo', 'bar'], ['1', '2'])), scope)).rejects.toThrow()
  })
})

describe('R-24 佣金预览报告', () => {
  it('写售价与单件预估佣金，不碰配送费与尺寸列', async () => {
    const { ctx, of } = fakeContext()
    const result = await syncReferralPreviewReport(ctx, rowsOf(tsv(['sku', 'asin', 'sales-price', 'estimated-referral-fee-per-unit', 'currency'], ['SKU-1', 'B0TEST0001', '30', '4.5', 'USD'])), scope)
    expect(result.imported).toBe(1)
    const args = of('feeBaseline')[0].args
    expect(args.create).toMatchObject({ sku: 'SKU-1', salesPrice: 30, expectedReferralFee: 4.5 })
    for (const key of ['expectedFulfillmentFee', 'sizeTier', 'lengthCm']) {
      expect(args.create).not.toHaveProperty(key)
      expect(args.update).not.toHaveProperty(key)
    }
  })

  it('没有佣金数值的行忽略；缺关键列失败', async () => {
    const { ctx, of } = fakeContext()
    const result = await syncReferralPreviewReport(ctx, rowsOf(tsv(['sku', 'estimated-referral-fee-per-unit'], ['SKU-1', ''], ['SKU-2', '1.2'])), scope)
    expect(result.imported).toBe(1)
    expect(of('feeBaseline')).toHaveLength(1)
    await expect(syncReferralPreviewReport(fakeContext().ctx, rowsOf(tsv(['sku', 'price'], ['SKU-1', '3'])), scope)).rejects.toThrow()
  })
})

describe('分发', () => {
  it('两种报告类型各有导入器，其它类型返回空', () => {
    expect(feeBaselineImporterFor('GET_FBA_ESTIMATED_FBA_FEES_TXT_DATA', scope)).toBeTypeOf('function')
    expect(feeBaselineImporterFor('GET_REFERRAL_FEE_PREVIEW_REPORT', scope)).toBeTypeOf('function')
    expect(feeBaselineImporterFor('GET_AFN_INVENTORY_DATA', scope)).toBeNull()
  })
})
