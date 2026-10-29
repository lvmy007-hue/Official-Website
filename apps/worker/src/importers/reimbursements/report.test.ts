import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../../types'
import { rowsOf, tsv } from '../inventory/fake-context.test-helper'
import { syncReimbursementsReport } from './report'

// R-27 官方赔付明细报告（P2b-03）：幂等键、负数金额（冲回）、不覆盖匹配结果、缺关键列失败、缺批准日期 / 金额 / SKU 的行跳过。

const HEADER = [
  'approval-date',
  'reimbursement-id',
  'case-id',
  'amazon-order-id',
  'reason',
  'sku',
  'fnsku',
  'asin',
  'product-name',
  'currency-unit',
  'amount-per-unit',
  'amount-total',
  'quantity-reimbursed-cash',
  'quantity-reimbursed-inventory',
  'quantity-reimbursed-total',
]
const ROW = ['2026-10-05', 'R100', '1234567890', '111-0000001-0000001', 'Lost_Warehouse', 'SKU-1', 'X00FNSKU01', 'B000000001', '保温杯', 'USD', '12.50', '25.00', '2', '0', '2']

function stub() {
  const reimbursementRecord = { upsert: vi.fn().mockResolvedValue({}) }
  const prisma = { reimbursementRecord, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) } as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  return { ctx, upsert: reimbursementRecord.upsert, warn }
}

const run = (ctx: ImportContext, ...lines: string[][]) => syncReimbursementsReport(ctx, rowsOf(tsv(HEADER, ...lines)), 't1', 'sa1', { reportJobId: 'rj1' })

describe('R-27 官方赔付明细导入', () => {
  it('按（赔付编号、SKU、FNSKU）幂等写入，列与单位正确', async () => {
    const { ctx, upsert } = stub()
    const result = await run(ctx, ROW)
    expect(result).toMatchObject({ read: 1, imported: 1 })
    const args = upsert.mock.calls[0][0]
    expect(args.where).toEqual({ sellerAccountId_reimbursementId_sku_fnsku: { sellerAccountId: 'sa1', reimbursementId: 'R100', sku: 'SKU-1', fnsku: 'X00FNSKU01' } })
    expect(args.create).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      quantity: 2,
      amount: 25,
      currency: 'USD',
      reason: 'Lost_Warehouse',
      originalOrderId: '111-0000001-0000001',
      amazonCaseId: '1234567890',
      asin: 'B000000001',
    })
    expect(args.create.approvedAt).toEqual(new Date('2026-10-05'))
    expect(args.create.sourceReportJobId).toBe('rj1')
  })

  it('更新只覆盖报告给出的列：不带匹配结果（matchedCaseId、matchBasis），重复导入不会把已匹配的赔付变回未归属', async () => {
    const { ctx, upsert } = stub()
    await run(ctx, ROW)
    const update = upsert.mock.calls[0][0].update
    expect(Object.keys(update)).not.toContain('matchedCaseId')
    expect(Object.keys(update)).not.toContain('matchBasis')
    expect(Object.keys(update)).not.toContain('matchedAt')
  })

  it('负数金额（赔付冲回）原样保存；没有合计金额时用单价乘数量', async () => {
    const { ctx, upsert } = stub()
    await run(ctx, ['2026-10-06', 'R101', '', '', 'Reimbursement_Reversal', 'SKU-1', '', '', '', 'USD', '', '-25.00', '0', '0', '2'])
    expect(upsert.mock.calls[0][0].create).toMatchObject({ amount: -25, amazonCaseId: null, originalOrderId: null, fnsku: '' })
    const second = stub()
    await run(second.ctx, ['2026-10-06', 'R102', '', '', 'Lost_Warehouse', 'SKU-2', '', '', '', 'EUR', '3.20', '', '0', '0', '3'])
    expect(second.upsert.mock.calls[0][0].create).toMatchObject({ amount: 9.6, quantity: 3, currency: 'EUR' })
  })

  it('没有批准日期、金额或 SKU 的行跳过（不用当前时间或 0 兜底），没有赔付编号的行忽略', async () => {
    const { ctx, upsert, warn } = stub()
    const noDate = [...ROW]
    noDate[0] = ''
    const noSku = [...ROW]
    noSku[1] = 'R200'
    noSku[5] = ''
    const noId = [...ROW]
    noId[1] = ''
    const noAmount = [...ROW]
    noAmount[1] = 'R201'
    noAmount[10] = ''
    noAmount[11] = ''
    const result = await run(ctx, ROW, noDate, noSku, noId, noAmount)
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(result.imported).toBe(1)
    expect(warn).toHaveBeenCalled()
  })

  it('缺少关键列时失败，不静默导入空数据', async () => {
    const { ctx } = stub()
    await expect(syncReimbursementsReport(ctx, rowsOf(tsv(['sku', 'quantity'], ['A', '1'])), 't1', 'sa1')).rejects.toThrow()
  })
})
