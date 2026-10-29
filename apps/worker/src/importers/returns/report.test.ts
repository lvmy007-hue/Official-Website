import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { PiiSealer } from '../../crypto/secrets'
import type { ImportContext } from '../../types'
import { rowsOf, tsv } from '../inventory/fake-context.test-helper'
import { syncReturnsReport } from './report'

// R-26 客户退货报告（P2b-02）：幂等键、处置分组、不覆盖我方维护的列、缺关键列失败、买家备注截断。

const NOW = new Date('2026-10-22T08:00:00Z')
const HEADER = [
  'return-date',
  'order-id',
  'sku',
  'asin',
  'fnsku',
  'product-name',
  'quantity',
  'fulfillment-center-id',
  'detailed-disposition',
  'reason',
  'status',
  'license-plate-number',
  'customer-comments',
]
const ROW = [
  '2026-10-01T09:30:00Z',
  '111-0000001-0000001',
  'SKU-1',
  'B000000001',
  'X00FNSKU01',
  '保温杯',
  '2',
  'ABE2',
  'CARRIER_DAMAGED',
  'DAMAGED_BY_CARRIER',
  'Unit returned to inventory',
  'LPN123',
  'box was crushed',
]

/** 加密替身：密文带前缀，便于断言“库里没有明文”。 */
const secrets: PiiSealer = { sealBuyerPii: async text => `sealed:${Buffer.from(text).toString('base64')}` }

function stub(over: { orders?: unknown[]; stale?: unknown[]; maps?: unknown[]; retentionDays?: number; noSecrets?: boolean } = {}) {
  const fbaReturnCase = {
    upsert: vi.fn().mockResolvedValue({}),
    findMany: vi.fn().mockResolvedValue(over.stale ?? []),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  }
  const order = { findMany: vi.fn().mockResolvedValue(over.orders ?? []) }
  const returnReasonMap = { findMany: vi.fn().mockResolvedValue(over.maps ?? []), createMany: vi.fn().mockResolvedValue({ count: 0 }) }
  const tenantSetting = { findFirst: vi.fn().mockResolvedValue(over.retentionDays ? { valueJson: { customerInfoDays: over.retentionDays } } : null) }
  const prisma = { fbaReturnCase, order, returnReasonMap, tenantSetting, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) } as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger, ...(over.noSecrets ? {} : { secrets }) }
  return { ctx, upsert: fbaReturnCase.upsert, warn, fbaReturnCase, order, returnReasonMap }
}

const run = (ctx: ImportContext, ...lines: string[][]) => syncReturnsReport(ctx, rowsOf(tsv(HEADER, ...lines)), 't1', 'sa1', 'ATVPDKIKX0DER', { reportJobId: 'rj1', now: NOW })

describe('R-26 客户退货报告', () => {
  it('写入退货明细：键含退货件编号与退货时间；处置原值与我方分组都保存；来源任务与时间写入', async () => {
    const { ctx, upsert } = stub()
    expect(await run(ctx, ROW)).toMatchObject({ imported: 1, read: 1, skipped: 0 })
    const args = upsert.mock.calls[0][0]
    const key = args.where.sellerAccountId_amazonOrderId_asin_sellerSku_fnsku_licensePlateNumber_returnDate
    expect(key).toMatchObject({ sellerAccountId: 'sa1', amazonOrderId: '111-0000001-0000001', asin: 'B000000001', sellerSku: 'SKU-1', fnsku: 'X00FNSKU01', licensePlateNumber: 'LPN123' })
    expect(key.returnDate.toISOString()).toBe('2026-10-01T09:30:00.000Z')
    expect(args.create).toMatchObject({
      tenantId: 't1',
      marketplaceId: 'ATVPDKIKX0DER',
      quantity: 2,
      detailedDisposition: 'CARRIER_DAMAGED',
      disposition: 'CARRIER_DAMAGED',
      reason: 'DAMAGED_BY_CARRIER',
      reportStatus: 'Unit returned to inventory',
      fulfillmentCenterId: 'ABE2',
      customerCommentsKinds: '',
      sourceReportJobId: 'rj1',
    })
    // 买家备注只以密文保存：保留期从退货日起算 30 天；明文列不写
    expect(args.create.customerCommentsCipher).toBe(`sealed:${Buffer.from('box was crushed').toString('base64')}`)
    expect(args.create.customerCommentsExpiresAt.toISOString()).toBe('2026-10-31T09:30:00.000Z')
    expect(args.create).not.toHaveProperty('customerComments')
    expect(args.update).not.toHaveProperty('customerComments')
    expect(args.create.sourceUpdatedAt).toEqual(NOW)
  })

  it('同一订单的两个退货件（不同退货件编号）是两条记录；重复导入同一行键不变', async () => {
    const { ctx, upsert } = stub()
    const second = [...ROW]
    second[11] = 'LPN999'
    await run(ctx, ROW, second)
    await run(ctx, ROW)
    const keys = upsert.mock.calls.map(call => call[0].where.sellerAccountId_amazonOrderId_asin_sellerSku_fnsku_licensePlateNumber_returnDate.licensePlateNumber)
    expect(keys).toEqual(['LPN123', 'LPN999', 'LPN123'])
  })

  it('不覆盖我方维护的列：更新里没有处理状态、赔付状态、赔付案件、退款金额', async () => {
    const { ctx, upsert } = stub()
    await run(ctx, ROW)
    const { update, create } = upsert.mock.calls[0][0]
    for (const field of ['status', 'reimbursementStatus', 'reimbursementCaseId', 'refundAmount']) {
      expect(update, field).not.toHaveProperty(field)
      expect(create, field).not.toHaveProperty(field)
    }
  })

  it('报告没给的列不写（更新时保留旧值）；处置没给时分组也不写；没有件数按 1 件', async () => {
    const { ctx, upsert } = stub()
    const bare = ['2026-10-01T09:30:00Z', '111-1', 'SKU-1', 'B1', '', '', '', '', '', '', '', '', '']
    await run(ctx, bare)
    const { update, create } = upsert.mock.calls[0][0]
    for (const field of ['detailedDisposition', 'disposition', 'reason', 'reportStatus', 'fulfillmentCenterId', 'customerCommentsCipher', 'customerCommentsExpiresAt', 'customerCommentsKinds'])
      expect(update, field).not.toHaveProperty(field)
    expect(create).toMatchObject({ quantity: 1, fnsku: '', licensePlateNumber: '' })
  })

  it('官方新增的处置值：原值照存，分组写为其他处置；买家备注超长截断', async () => {
    const { ctx, upsert } = stub()
    const odd = [...ROW]
    odd[8] = 'BRAND_NEW_VALUE'
    odd[12] = 'x'.repeat(5000)
    await run(ctx, odd)
    const { create } = upsert.mock.calls[0][0]
    expect(create).toMatchObject({ detailedDisposition: 'BRAND_NEW_VALUE', disposition: 'OTHER' })
    expect(Buffer.from(String(create.customerCommentsCipher).replace('sealed:', ''), 'base64').toString()).toHaveLength(1000)
  })

  it('买家备注里的电话、邮箱、地址只记类别（不含内容）；明文不出现在任何写入参数里', async () => {
    const { ctx, upsert } = stub()
    const row = [...ROW]
    row[12] = '请联系 13812345678 或 a@b.com，寄到 12 Main Street'
    await run(ctx, row)
    const { create, update } = upsert.mock.calls[0][0]
    expect(create.customerCommentsKinds).toBe('PHONE,EMAIL,ADDRESS')
    for (const value of [create, update]) expect(JSON.stringify(value)).not.toMatch(/13812345678|a@b\.com|Main Street/)
  })

  it('保留期取企业设置（只能缩短）；已经过了保留期的备注不写入，并告警一次（不含内容）', async () => {
    const short = stub({ retentionDays: 25 })
    await run(short.ctx, ROW)
    expect(short.upsert.mock.calls[0][0].create.customerCommentsExpiresAt.toISOString()).toBe('2026-10-26T09:30:00.000Z')

    const past = stub({ retentionDays: 25 })
    const old = [...ROW]
    old[0] = '2026-08-01T09:30:00Z'
    await run(past.ctx, old)
    expect(past.upsert.mock.calls[0][0].create).not.toHaveProperty('customerCommentsCipher')
    expect(JSON.stringify(past.warn.mock.calls)).toContain('skippedComments')
    expect(JSON.stringify(past.warn.mock.calls)).not.toContain('box was crushed')
  })

  it('没有加密能力时备注一律不保存，绝不退回成明文', async () => {
    const { ctx, upsert, warn } = stub({ noSecrets: true })
    await run(ctx, ROW)
    const { create, update } = upsert.mock.calls[0][0]
    for (const value of [create, update]) {
      expect(value).not.toHaveProperty('customerComments')
      expect(value).not.toHaveProperty('customerCommentsCipher')
    }
    expect(warn).toHaveBeenCalled()
  })

  it('没有退货时间的行跳过并告警（不用当前时间兜底）；没有订单号的行忽略', async () => {
    const { ctx, upsert, warn } = stub()
    const noDate = [...ROW]
    noDate[0] = ''
    const noOrder = [...ROW]
    noOrder[1] = ''
    const result = await run(ctx, noDate, noOrder, ROW)
    expect(result).toMatchObject({ imported: 1, read: 3, skipped: 1 })
    expect(upsert).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalled()
  })

  it('导入后按订单回填下单与发货时间：同一订单多个下单时间取最早的；订单还没同步下来的保持为空', async () => {
    const early = new Date('2026-09-01T19:00:00Z')
    const { ctx, fbaReturnCase, order } = stub({
      orders: [
        { amazonOrderId: '111-0000001-0000001', purchaseDate: early, shippedAt: new Date('2026-09-03T19:00:00Z') },
        { amazonOrderId: '111-0000001-0000001', purchaseDate: new Date('2026-09-02T19:00:00Z'), shippedAt: null },
      ],
    })
    const other = [...ROW]
    other[1] = '111-NO-ORDER'
    other[11] = 'LPN2'
    await run(ctx, ROW, other)
    expect(order.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: { in: ['111-0000001-0000001', '111-NO-ORDER'] } })
    expect(fbaReturnCase.updateMany).toHaveBeenCalledTimes(2)
    expect(fbaReturnCase.updateMany.mock.calls[0][0]).toMatchObject({
      where: { tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: '111-0000001-0000001' },
      data: { orderPurchasedAt: early, orderShippedAt: new Date('2026-09-03T19:00:00Z') },
    })
    // 发货日回填后，买家备注的保留期改按发货日起算：只提前不推后（只改比新截止更晚的）
    expect(fbaReturnCase.updateMany.mock.calls[1][0]).toMatchObject({
      where: { amazonOrderId: '111-0000001-0000001', customerCommentsCipher: { not: null }, customerCommentsExpiresAt: { gt: new Date('2026-10-03T19:00:00Z') } },
      data: { customerCommentsExpiresAt: new Date('2026-10-03T19:00:00Z') },
    })
  })

  it('下单时间回填还会补齐该店铺里仍为空的退货（订单晚到）', async () => {
    const { ctx, order } = stub({ stale: [{ amazonOrderId: '111-LATE' }] })
    await run(ctx, ROW)
    expect(order.findMany.mock.calls[0][0].where.amazonOrderId.in.sort()).toEqual(['111-0000001-0000001', '111-LATE'])
  })

  it('新原因代码自动加入映射表（转大写，大类未分类）；预置的与已有的不重复加；没有原因不加', async () => {
    const { ctx, returnReasonMap } = stub({ maps: [{ code: 'KNOWN_NEW' }] })
    const rowWith = (reason: string, lpn: string) => {
      const copy = [...ROW]
      copy[9] = reason
      copy[11] = lpn
      return copy
    }
    await run(ctx, rowWith('DEFECTIVE', 'L1'), rowWith('brand_new_reason', 'L2'), rowWith('KNOWN_NEW', 'L3'), rowWith('', 'L4'))
    expect(returnReasonMap.createMany).toHaveBeenCalledTimes(1)
    expect(returnReasonMap.createMany.mock.calls[0][0]).toEqual({
      data: [{ tenantId: 't1', code: 'BRAND_NEW_REASON', labelZh: 'BRAND_NEW_REASON', category: '未分类', isSystem: false }],
      skipDuplicates: true,
    })
  })

  it('映射表满 500 行后不再自动加入，只告警；补充步骤失败不让导入失败', async () => {
    const full = stub({ maps: Array.from({ length: 500 }, (_, index) => ({ code: `C${index}` })) })
    const odd = [...ROW]
    odd[9] = 'another_new_code'
    expect(await run(full.ctx, odd)).toMatchObject({ imported: 1 })
    expect(full.returnReasonMap.createMany).not.toHaveBeenCalled()
    expect(full.warn).toHaveBeenCalled()
    const broken = stub()
    broken.order.findMany.mockRejectedValue(new Error('boom'))
    expect(await run(broken.ctx, ROW)).toMatchObject({ imported: 1 })
    expect(broken.warn).toHaveBeenCalled()
  })

  it('缺少订单号或退货时间列：按报告格式变化失败（PARSE_HEADER）', async () => {
    await expect(syncReturnsReport(stub().ctx, rowsOf(tsv(['sku', 'asin'], ['A', 'B'])), 't1', 'sa1', 'ATVPDKIKX0DER')).rejects.toMatchObject({ code: 'PARSE_HEADER' })
    await expect(syncReturnsReport(stub().ctx, rowsOf(tsv(['order-id', 'sku'], ['1', 'A'])), 't1', 'sa1', 'ATVPDKIKX0DER')).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })
})
