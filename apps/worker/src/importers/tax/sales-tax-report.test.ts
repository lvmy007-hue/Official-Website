import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../../types'
import { rowsOf, tsv } from '../inventory/fake-context.test-helper'
import { syncSalesTaxReport } from './sales-tax-report'

// 销售税报告导入器（R-33，P2b-12）：按（日期、州、辖区、税种）汇总后整份写入；先删这份报告覆盖日期范围内的旧汇总；不读订单号与收货地址等列。

const NOW = new Date('2026-10-23T00:00:00Z')

function stub() {
  const salesTaxSummary = { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), createMany: vi.fn().mockResolvedValue({ count: 0 }) }
  const prisma = { salesTaxSummary, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) } as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  return { ctx, salesTaxSummary, warn }
}

const HEADER = ['order-id', 'purchase-date', 'ship-to-state', 'ship-to-city', 'ship-to-postal-code', 'jurisdiction-name', 'tax-type', 'taxable-amount', 'tax-amount']
const line = (over: Partial<Record<(typeof HEADER)[number], string>> = {}) => {
  const base: Record<string, string> = {
    'order-id': '111-0000001-1',
    'purchase-date': '2026-10-02T08:00:00Z',
    'ship-to-state': 'wa',
    'ship-to-city': 'Seattle',
    'ship-to-postal-code': '98101',
    'jurisdiction-name': 'King County',
    'tax-type': 'Sales Tax',
    'taxable-amount': '100.00',
    'tax-amount': '10.25',
    ...over,
  }
  return HEADER.map(name => base[name]!)
}
const options = { reportJobId: 'rj1', now: NOW }
const run = (ctx: ImportContext, ...lines: string[][]) => syncSalesTaxReport(ctx, rowsOf(tsv(HEADER, ...lines)), 't1', 'sa1', options)
const written = (createMany: ReturnType<typeof vi.fn>) => createMany.mock.calls.flatMap(call => (call[0] as { data: Array<Record<string, unknown>> }).data)

describe('R-33 销售税报告', () => {
  it('同一天同州同辖区同税种的多行合计成一行，带行数与来源任务；州转大写、税种转下划线大写', async () => {
    const { ctx, salesTaxSummary } = stub()
    const result = await run(
      ctx,
      line(),
      line({ 'order-id': '111-0000002-1', 'taxable-amount': '50', 'tax-amount': '5.125' }),
      line({ 'ship-to-state': 'OR', 'jurisdiction-name': '', 'tax-amount': '0' }),
    )
    expect(result).toMatchObject({ imported: 3, read: 3, skipped: 0 })
    const rows = written(salesTaxSummary.createMany)
    expect(rows).toHaveLength(2)
    const wa = rows.find(row => row.state === 'WA')!
    expect(wa).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      jurisdictionKey: 'KING COUNTY',
      taxKind: 'SALES_TAX',
      source: 'TAX_LIBRARY',
      taxableSales: 150,
      taxCollected: 15.375,
      lineCount: 2,
      currency: 'USD',
      sourceReportJobId: 'rj1',
      syncedAt: NOW,
    })
    expect((wa.taxPeriod as Date).toISOString()).toBe('2026-10-02T00:00:00.000Z')
    // 税额为 0 的行照样保留（该州该日有应税销售但没有税），州一级的辖区是空串
    expect(rows.find(row => row.state === 'OR')).toMatchObject({ jurisdictionKey: '', taxCollected: 0, lineCount: 1 })
  })

  it('不同日期、不同税种分开汇总；退款行（负税额）与销售行相抵', async () => {
    const { ctx, salesTaxSummary } = stub()
    await run(ctx, line(), line({ 'purchase-date': '2026-10-03', 'tax-amount': '4' }), line({ 'tax-type': 'Use Tax', 'tax-amount': '1' }), line({ 'tax-amount': '-2.25' }))
    const rows = written(salesTaxSummary.createMany)
    expect(rows.map(row => [(row.taxPeriod as Date).toISOString().slice(0, 10), row.taxKind, row.taxCollected]).sort()).toEqual([
      ['2026-10-02', 'SALES_TAX', 8],
      ['2026-10-02', 'USE_TAX', 1],
      ['2026-10-03', 'SALES_TAX', 4],
    ])
  })

  it('先删这份报告覆盖的日期范围（含首尾日）内同店铺同来源的旧汇总，再写新的，保证重复导入不翻倍', async () => {
    const { ctx, salesTaxSummary } = stub()
    await run(ctx, line({ 'purchase-date': '2026-09-28' }), line({ 'purchase-date': '2026-10-05' }), line({ 'purchase-date': '2026-10-01' }))
    const where = salesTaxSummary.deleteMany.mock.calls[0]![0].where
    expect(where).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', source: 'TAX_LIBRARY' })
    expect(where.taxPeriod.gte.toISOString()).toBe('2026-09-28T00:00:00.000Z')
    expect(where.taxPeriod.lte.toISOString()).toBe('2026-10-05T00:00:00.000Z')
    expect(salesTaxSummary.deleteMany.mock.invocationCallOrder[0]!).toBeLessThan(salesTaxSummary.createMany.mock.invocationCallOrder[0]!)
  })

  it('没有给应税销售额列：应税销售额为空（不是 0）；没有税种列：默认销售税', async () => {
    const { ctx, salesTaxSummary } = stub()
    const header = ['purchase-date', 'ship-to-state', 'tax-amount']
    await syncSalesTaxReport(ctx, rowsOf(tsv(header, ['2026-10-02', 'WA', '3'])), 't1', 'sa1', options)
    expect(written(salesTaxSummary.createMany)[0]).toMatchObject({ taxableSales: null, taxKind: 'SALES_TAX', taxCollected: 3 })
  })

  it('缺州、税额或日期的行跳过并计数，其余照常导入；买家订单号、收货城市与邮编不会写进库', async () => {
    const { ctx, salesTaxSummary, warn } = stub()
    const result = await run(ctx, line(), line({ 'ship-to-state': '' }), line({ 'tax-amount': 'N/A' }), line({ 'purchase-date': 'not a date' }))
    expect(result).toMatchObject({ imported: 1, read: 4, skipped: 3 })
    expect(warn).toHaveBeenCalled()
    const dump = JSON.stringify(salesTaxSummary.createMany.mock.calls)
    expect(dump).not.toContain('111-0000001-1')
    expect(dump).not.toContain('Seattle')
    expect(dump).not.toContain('98101')
  })

  it('一行都没有可用数据：不删旧汇总也不写（读到行但全被跳过由上层按失败处理）', async () => {
    const { ctx, salesTaxSummary } = stub()
    const result = await run(ctx, line({ 'ship-to-state': '' }))
    expect(result).toMatchObject({ imported: 0, read: 1, skipped: 1 })
    expect(salesTaxSummary.deleteMany).not.toHaveBeenCalled()
    expect(salesTaxSummary.createMany).not.toHaveBeenCalled()
  })

  it('缺少州、税额或日期整组关键列：整份报告按格式变化失败（PARSE_HEADER），什么都不写', async () => {
    const { ctx, salesTaxSummary } = stub()
    await expect(syncSalesTaxReport(ctx, rowsOf(tsv(['purchase-date', 'tax-amount'], ['2026-10-02', '3'])), 't1', 'sa1', options)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
    await expect(syncSalesTaxReport(ctx, rowsOf(tsv(['ship-to-state', 'purchase-date'], ['WA', '2026-10-02'])), 't1', 'sa1', options)).rejects.toBeInstanceOf(NonRetryableError)
    expect(salesTaxSummary.createMany).not.toHaveBeenCalled()
  })

  it('金额按 6 位小数取整，避免浮点累加的尾巴', async () => {
    const { ctx, salesTaxSummary } = stub()
    await run(ctx, ...Array.from({ length: 10 }, () => line({ 'tax-amount': '0.1', 'taxable-amount': '0.2' })))
    expect(written(salesTaxSummary.createMany)[0]).toMatchObject({ taxCollected: 1, taxableSales: 2, lineCount: 10 })
  })
})
