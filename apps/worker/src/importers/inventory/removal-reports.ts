import type { Prisma } from '@prisma/client'
import { importRows, type ImportResult } from '../../streaming/batch'
import type { Row } from '../../streaming/rows'
import type { ImportContext } from '../../types'
import { cells, day, int, intColumns, num, requireColumns, text } from './columns'
import { sourceFields, type InventoryReportScope } from './scope'

// 移除订单与移除货件（R-18 GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA、R-19 GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA）。
// 移除订单的状态会随时间变化（处理中 → 已完成），同一幂等键重复导入覆盖为最新状态。

const SKU = ['sku', 'seller-sku', 'merchant-sku']

/** 订单类型：Return → RETURN，Disposal → DISPOSAL，其余（如清算）→ OTHER，保留原始文字以外的信息不丢（状态列单独保存）。 */
export const removalTypeOf = (value: string | undefined): 'RETURN' | 'DISPOSAL' | 'OTHER' => {
  const lower = (value ?? '').toLowerCase()
  if (lower.includes('return')) return 'RETURN'
  if (lower.includes('dispos')) return 'DISPOSAL'
  return 'OTHER'
}

export function syncRemovalOrderReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['order-id'], SKU], 'GET_FBA_FULFILLMENT_REMOVAL_ORDER_DETAIL_DATA')
      const orderId = text(c, ['order-id'])
      const sku = text(c, SKU)
      if (!orderId || !sku) return 'ignored'
      const requestDate = day(c, ['request-date', 'requested-date'])
      if (!requestDate) return 'skipped'
      const fnsku = text(c, ['fnsku']) ?? ''
      const disposition = text(c, ['disposition']) ?? ''
      const data = {
        type: removalTypeOf(text(c, ['order-type'])),
        status: text(c, ['order-status']) ?? '',
        requestDate,
        lastUpdatedDate: day(c, ['last-updated-date']),
        serviceSpeed: text(c, ['service-speed']),
        ...intColumns(c, {
          requestedQty: ['requested-quantity'],
          shippedQty: ['shipped-quantity'],
          disposedQty: ['disposed-quantity'],
          cancelledQty: ['cancelled-quantity'],
          inProcessQty: ['in-process-quantity'],
        }),
        fee: num(c, ['removal-fee']),
        currency: text(c, ['currency']),
        ...sourceFields(scope),
      } as Prisma.RemovalOrderUncheckedUpdateInput
      await prisma.removalOrder.upsert({
        where: { tenantId_sellerAccountId_orderId_sku_fnsku_disposition: { tenantId, sellerAccountId, orderId, sku, fnsku, disposition } },
        create: { ...(data as Prisma.RemovalOrderUncheckedCreateInput), tenantId, sellerAccountId, orderId, sku, fnsku, disposition },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'removal order rows without a request date were skipped', logFields: { tenantId, sellerAccountId } },
  )
}

/** 移除货件：官方报告没有货件编号列，shipmentId 取运单号，没有运单号时取 NOTRACK-发货日期。 */
export function syncRemovalShipmentReport(ctx: ImportContext, rows: AsyncIterable<Row>, scope: InventoryReportScope): Promise<ImportResult> {
  const { tenantId, sellerAccountId } = scope
  return importRows(
    ctx,
    rows,
    async ({ prisma }, row, index) => {
      const c = cells(row)
      if (index === 0) requireColumns(c, [['order-id'], SKU], 'GET_FBA_FULFILLMENT_REMOVAL_SHIPMENT_DETAIL_DATA')
      const orderId = text(c, ['order-id'])
      const sku = text(c, SKU)
      if (!orderId || !sku) return 'ignored'
      const shipDate = day(c, ['shipment-date', 'ship-date'])
      const trackingNumber = text(c, ['tracking-number'])
      const shipmentId = text(c, ['shipment-id']) ?? trackingNumber ?? `NOTRACK-${shipDate ? shipDate.toISOString().slice(0, 10) : 'UNKNOWN'}`
      const fnsku = text(c, ['fnsku']) ?? ''
      const data = {
        disposition: text(c, ['disposition']) ?? '',
        carrier: text(c, ['carrier']),
        trackingNumber,
        shippedQty: int(c, ['shipped-quantity']) ?? 0,
        shipDate,
        ...sourceFields(scope),
      } as Prisma.RemovalShipmentUncheckedUpdateInput
      await prisma.removalShipment.upsert({
        where: { tenantId_sellerAccountId_orderId_shipmentId_sku_fnsku: { tenantId, sellerAccountId, orderId, shipmentId, sku, fnsku } },
        create: { ...(data as Prisma.RemovalShipmentUncheckedCreateInput), tenantId, sellerAccountId, orderId, shipmentId, sku, fnsku },
        update: data,
      })
      return 'imported'
    },
    { skippedMessage: 'removal shipment rows were skipped', logFields: { tenantId, sellerAccountId } },
  )
}
