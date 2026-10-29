import type { PrismaClient } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, parseTime, requireColumns, text } from '../inventory/columns'

// 订单页（P2b-01）用到的两份物流报告（importers.md R-03、R-05）。
// 两份报告里都有买家姓名、邮箱、收件地址等个人信息列：这里一概不读取、不写库、不进日志——
// 买家信息只由订单接口同步器加密保存，并且有保留期（见 importers/orders/v2026-write.ts）。

export interface FulfillmentReportScope {
  tenantId: string
  sellerAccountId: string
  reportJobId?: string | null
  /** 测试用：固定“现在”。 */
  now?: Date
}

export const FULFILLMENT_REPORT_TYPES = ['GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL', 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA'] as const

export type RowsImporter = (ctx: ImportContext, rows: AsyncIterable<Row>) => Promise<ImportResult>

export function fulfillmentImporterFor(reportType: string, scope: FulfillmentReportScope): RowsImporter | null {
  if (reportType === FULFILLMENT_REPORT_TYPES[0]) return (ctx, rows) => syncShipmentsReport(ctx, rows, scope)
  if (reportType === FULFILLMENT_REPORT_TYPES[1]) return (ctx, rows) => syncReplacementReport(ctx, rows, scope)
  return null
}

type OrderRef = { id: string; purchaseDate: Date } | null

/** 同一份报告里一个订单常有多行（每个商品一行）：按订单号缓存查询结果，缓存有上限。 */
function orderFinder(scope: FulfillmentReportScope) {
  const cache = new Map<string, OrderRef>()
  return async (prisma: PrismaClient, amazonOrderId: string): Promise<OrderRef> => {
    if (cache.has(amazonOrderId)) return cache.get(amazonOrderId) ?? null
    const order = await prisma.order.findFirst({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, amazonOrderId },
      orderBy: { purchaseDate: 'desc' },
      select: { id: true, purchaseDate: true },
    })
    if (cache.size >= 2000) cache.clear()
    cache.set(amazonOrderId, order)
    return order
  }
}

/**
 * R-03 亚马逊物流发货报告：承运商、追踪号、发货时间、配送服务、配送中心 → OrderPackage。
 * 订单接口同步器可能已写过同一包裹（按订单加追踪号认）：已有就补充字段，没有就以发货编号为包裹编号新建。
 * 订单还没同步下来的行跳过（订单每 15 分钟同步，下一次报告会补上）。
 */
export function syncShipmentsReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: FulfillmentReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  const find = orderFinder(scope)
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['amazon-order-id'], ['shipment-id', 'shipment-item-id']], 'GET_AMAZON_FULFILLED_SHIPMENTS_DATA_GENERAL')
      const amazonOrderId = text(c, ['amazon-order-id'])
      const packageId = text(c, ['shipment-id', 'shipment-item-id'])
      if (!amazonOrderId || !packageId) return 'ignored'
      const order = await find(prisma, amazonOrderId)
      if (!order) return 'skipped'
      const trackingNumber = text(c, ['tracking-number']) ?? ''
      const carrier = text(c, ['carrier'])
      const data = {
        ...(carrier ? { carrier } : {}),
        ...optional('shippingService', text(c, ['ship-service-level'])),
        ...optional('fulfillmentCenter', text(c, ['fulfillment-center-id'])),
        ...optional('shipDate', parseTime(text(c, ['shipment-date']))),
        sourceUpdatedAt: scope.now ?? new Date(),
        sourceReportJobId: scope.reportJobId ?? undefined,
      }
      const same = trackingNumber ? await prisma.orderPackage.findFirst({ where: { tenantId, sellerAccountId, orderId: order.id, trackingNumber }, select: { id: true } }) : null
      if (same) {
        await prisma.orderPackage.update({ where: { id: same.id }, data })
        return 'imported'
      }
      await prisma.orderPackage.upsert({
        where: { sellerAccountId_orderId_packageId_trackingNumber: { sellerAccountId, orderId: order.id, packageId, trackingNumber } },
        create: { ...data, tenantId, sellerAccountId, orderId: order.id, orderPurchaseDate: order.purchaseDate, packageId, trackingNumber, carrier: carrier ?? '' },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'fulfilled shipment rows for orders not synced yet were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

/** R-05 替换订单报告：替换订单号 → 原订单号与原因码，写在替换订单自己的行上（isReplacement、replacedOrderId、replacementReason）。 */
export function syncReplacementReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: FulfillmentReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['replacement-amazon-order-id'], ['original-amazon-order-id']], 'GET_FBA_FULFILLMENT_CUSTOMER_SHIPMENT_REPLACEMENT_DATA')
      const replacementId = text(c, ['replacement-amazon-order-id'])
      const originalId = text(c, ['original-amazon-order-id'])
      if (!replacementId || !originalId) return 'ignored'
      const { count } = await prisma.order.updateMany({
        where: { tenantId, sellerAccountId, amazonOrderId: replacementId },
        data: { isReplacement: true, replacedOrderId: originalId, replacementReason: text(c, ['replacement-reason-code']) ?? null },
      })
      return count > 0 ? 'imported' : 'skipped'
    },
    { skippedMessage: 'replacement rows for orders not synced yet were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : ({ [key]: value } as Record<K, V>))
