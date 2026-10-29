import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { ImportContext } from '../../types'
import { rowsOf, tsv } from '../inventory/fake-context.test-helper'
import { FULFILLMENT_REPORT_TYPES, fulfillmentImporterFor, syncReplacementReport, syncShipmentsReport } from './fulfillment-reports'

const scope = { tenantId: 't1', sellerAccountId: 'sa1', reportJobId: 'rj1', now: new Date('2026-10-22T08:00:00Z') }
const PURCHASE = new Date('2026-10-01T10:00:00Z')

function stub(over: { order?: unknown; samePackage?: unknown; updated?: number } = {}) {
  const order = { findFirst: vi.fn().mockResolvedValue('order' in over ? over.order : { id: 'o1', purchaseDate: PURCHASE }), updateMany: vi.fn().mockResolvedValue({ count: over.updated ?? 1 }) }
  const orderPackage = { findFirst: vi.fn().mockResolvedValue(over.samePackage ?? null), update: vi.fn().mockResolvedValue({}), upsert: vi.fn().mockResolvedValue({}) }
  const prisma = { order, orderPackage, $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma) } as unknown as PrismaClient
  const warn = vi.fn()
  const ctx: ImportContext = { prisma, logger: { warn, info: vi.fn(), error: vi.fn() } as unknown as Logger }
  return { ctx, order, orderPackage, warn }
}

const HEADER = [
  'amazon-order-id',
  'shipment-id',
  'shipment-item-id',
  'shipment-date',
  'sku',
  'buyer-email',
  'buyer-name',
  'recipient-name',
  'ship-address-1',
  'ship-service-level',
  'carrier',
  'tracking-number',
  'fulfillment-center-id',
]
const SHIPMENT = ['111-1', 'SHIP1', 'ITEM1', '2026-10-02T08:00:00Z', 'SKU-1', 'bob@example.com', 'Bob Buyer', 'Bob Recipient', '1 Main St', 'Standard', 'UPS', '1ZTRACK', 'ABE2']

describe('R-03 亚马逊物流发货报告', () => {
  it('类型注册：只认两种物流报告类型', () => {
    expect(FULFILLMENT_REPORT_TYPES).toEqual(['GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA'])
    for (const type of FULFILLMENT_REPORT_TYPES) expect(fulfillmentImporterFor(type, scope), type).toBeTypeOf('function')
    expect(fulfillmentImporterFor('GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL', scope)).toBeNull()
  })

  it('没有同追踪号的包裹：按“订单 + 发货编号 + 追踪号”新建，带承运商、服务、配送中心、发货时间与来源任务', async () => {
    const { ctx, orderPackage } = stub()
    const result = await syncShipmentsReport(ctx, rowsOf(tsv(HEADER, SHIPMENT)), scope)
    expect(result).toMatchObject({ imported: 1, read: 1, skipped: 0 })
    const args = orderPackage.upsert.mock.calls[0][0]
    expect(args.where).toEqual({ sellerAccountId_orderId_packageId_trackingNumber: { sellerAccountId: 'sa1', orderId: 'o1', packageId: 'SHIP1', trackingNumber: '1ZTRACK' } })
    expect(args.create).toMatchObject({ tenantId: 't1', orderPurchaseDate: PURCHASE, carrier: 'UPS', shippingService: 'Standard', fulfillmentCenter: 'ABE2', sourceReportJobId: 'rj1' })
    expect(args.create.shipDate.toISOString()).toBe('2026-10-02T08:00:00.000Z')
  })

  it('订单接口已写过同追踪号的包裹：补充字段，不新建第二个包裹', async () => {
    const { ctx, orderPackage } = stub({ samePackage: { id: 'pk1' } })
    await syncShipmentsReport(ctx, rowsOf(tsv(HEADER, SHIPMENT)), scope)
    expect(orderPackage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pk1' }, data: expect.objectContaining({ carrier: 'UPS', fulfillmentCenter: 'ABE2' }) }))
    expect(orderPackage.upsert).not.toHaveBeenCalled()
  })

  it('同一订单的多行只查一次订单；订单还没同步下来的行跳过并计数，全部跳过时 imported 为 0（上层按失败重试）', async () => {
    const two = stub()
    await syncShipmentsReport(two.ctx, rowsOf(tsv(HEADER, SHIPMENT, [...SHIPMENT.slice(0, 2), 'ITEM2', ...SHIPMENT.slice(3)])), scope)
    expect(two.order.findFirst).toHaveBeenCalledTimes(1)
    const none = stub({ order: null })
    const result = await syncShipmentsReport(none.ctx, rowsOf(tsv(HEADER, SHIPMENT)), scope)
    expect(result).toMatchObject({ imported: 0, read: 1, skipped: 1 })
    expect(none.warn).toHaveBeenCalled()
  })

  it('不读取、不写入、不记录买家与收件人个人信息', async () => {
    const { ctx, orderPackage, order, warn } = stub({ order: null })
    await syncShipmentsReport(ctx, rowsOf(tsv(HEADER, SHIPMENT)), scope)
    const ok = stub()
    await syncShipmentsReport(ok.ctx, rowsOf(tsv(HEADER, SHIPMENT)), scope)
    const written = JSON.stringify([
      ok.orderPackage.upsert.mock.calls,
      ok.orderPackage.update.mock.calls,
      ok.order.findFirst.mock.calls,
      orderPackage.upsert.mock.calls,
      order.findFirst.mock.calls,
      warn.mock.calls,
    ])
    for (const secret of ['bob@example.com', 'Bob Buyer', 'Bob Recipient', '1 Main St']) expect(written).not.toContain(secret)
  })

  it('缺少订单号列：按报告格式变化失败（PARSE_HEADER），不当作没有数据', async () => {
    const { ctx } = stub()
    await expect(syncShipmentsReport(ctx, rowsOf(tsv(['order', 'shipment-id'], ['111-1', 'S1'])), scope)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })

  it('没有追踪号时以空串入键，仍可按发货编号去重；缺订单号或发货编号的行忽略', async () => {
    const { ctx, orderPackage } = stub()
    const noTracking = [...SHIPMENT]
    noTracking[11] = ''
    const result = await syncShipmentsReport(ctx, rowsOf(tsv(HEADER, noTracking, ['', 'S2', 'I2'])), scope)
    expect(result).toMatchObject({ imported: 1, read: 2 })
    expect(orderPackage.findFirst).not.toHaveBeenCalled()
    expect(orderPackage.upsert.mock.calls[0][0].create).toMatchObject({ trackingNumber: '', packageId: 'SHIP1' })
  })
})

describe('R-05 替换订单报告', () => {
  const header = ['shipment-date', 'sku', 'quantity', 'replacement-reason-code', 'replacement-amazon-order-id', 'original-amazon-order-id']

  it('在替换订单上写入原订单号与原因码；订单没同步下来的行跳过', async () => {
    const { ctx, order } = stub()
    const result = await syncReplacementReport(ctx, rowsOf(tsv(header, ['2026-10-03', 'SKU-1', '1', 'DAMAGED', '222-2', '111-1'])), scope)
    expect(result).toMatchObject({ imported: 1, read: 1 })
    expect(order.updateMany).toHaveBeenCalledWith({
      where: { tenantId: 't1', sellerAccountId: 'sa1', amazonOrderId: '222-2' },
      data: { isReplacement: true, replacedOrderId: '111-1', replacementReason: 'DAMAGED' },
    })
    const missing = stub({ updated: 0 })
    expect(await syncReplacementReport(missing.ctx, rowsOf(tsv(header, ['2026-10-03', 'SKU-1', '1', '', '222-2', '111-1'])), scope)).toMatchObject({ imported: 0, skipped: 1 })
    expect(missing.order.updateMany.mock.calls[0][0].data.replacementReason).toBeNull()
  })

  it('缺原订单号的行忽略；缺关键列按格式变化失败', async () => {
    const { ctx, order } = stub()
    expect(await syncReplacementReport(ctx, rowsOf(tsv(header, ['2026-10-03', 'SKU-1', '1', 'X', '222-2', ''])), scope)).toMatchObject({ imported: 0, read: 1, skipped: 0 })
    expect(order.updateMany).not.toHaveBeenCalled()
    await expect(syncReplacementReport(stub().ctx, rowsOf(tsv(['sku'], ['A'])), scope)).rejects.toMatchObject({ code: 'PARSE_HEADER' })
  })
})
