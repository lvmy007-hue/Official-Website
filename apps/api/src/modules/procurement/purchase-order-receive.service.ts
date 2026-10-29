import { Injectable } from '@nestjs/common'
import { PoInspectionBodySchema, PoReceiptBodySchema, poStatusLabel, purchaseOrderActions, type PoActionResult, type PoStatus } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { ensureCostDrafts } from './cost-drafts'
import { assertNotFuture, isUniqueViolation, parseDay, PO_RECEIVE, stateConflict } from './procurement-common'
import { resolveDomesticWarehouse } from './stock-ops'
import { SupplierService } from './supplier.service'

// 收货（可分批）与质检。收货在同一个事务里：登记收货单、累加商品行已收数量、在国内仓记入库流水（带采购单价，用于库存计价）、
// 更新采购单状态（部分到货 / 全部到货）；全部到货时自动生成成本版本草稿并刷新供应商交付指标。
@Injectable()
export class PurchaseOrderReceiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async receive(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_RECEIVE)
    const body = PoReceiptBodySchema.parse(rawBody)
    assertNotFuture(body.receivedAt, '收货日期')
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId }, include: { lines: true } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (!purchaseOrderActions(order).includes('RECEIVE')) throw stateConflict('当前状态不能登记收货（需要已下单、生产中或部分到货）', order.status)

    const received = new Map<string, { quantity: number; batchNo: string | null }>()
    for (const entry of body.lines) {
      if (received.has(entry.lineId)) throw appError('VALIDATION_FAILED', '同一商品行在一次收货里只能出现一次', { fieldErrors: { lines: ['同一商品行重复'] } })
      const line = order.lines.find(item => item.id === entry.lineId)
      if (!line) throw appError('VALIDATION_FAILED', '收货商品行不属于这张采购单', { fieldErrors: { lines: ['收货商品行不属于这张采购单'] } })
      const remaining = line.quantity - line.receivedQuantity
      if (entry.quantity > remaining)
        throw appError('VALIDATION_FAILED', `${line.sellerSku} 本次收货 ${entry.quantity} 超过未收数量 ${remaining}（订购 ${line.quantity}，已收 ${line.receivedQuantity}）`, {
          fieldErrors: { lines: [`${line.sellerSku} 超过未收数量`] },
        })
      received.set(entry.lineId, { quantity: entry.quantity, batchNo: entry.batchNo ?? null })
    }
    const totalQty = body.lines.reduce((sum, entry) => sum + entry.quantity, 0)
    const complete = order.lines.every(line => line.receivedQuantity + (received.get(line.id)?.quantity ?? 0) >= line.quantity)
    const status: PoStatus = complete ? 'RECEIVED' : 'PARTIALLY_RECEIVED'
    const receivedAt = parseDay(body.receivedAt)

    try {
      const outcome = await this.prisma.$transaction(async tx => {
        const warehouse = await resolveDomesticWarehouse(tx, context.tenantId, body.warehouseId)
        if (!warehouse) throw appError('VALIDATION_FAILED', '所选仓库不存在或不是有效的国内仓', { fieldErrors: { warehouseId: ['所选仓库不存在或不是有效的国内仓'] } })
        const next = await updateWithVersion(
          tx.purchaseOrder,
          { id, tenantId: context.tenantId },
          body.version,
          { status, receivedQtyTotal: { increment: totalQty }, ...(complete ? { completedAt: receivedAt } : {}) },
          { label: '采购单' },
        )
        const count = await tx.purchaseReceipt.count({ where: { tenantId: context.tenantId, purchaseOrderId: id } })
        const receiptNo = `RC-${order.number}-${String(count + 1).padStart(2, '0')}`
        const lineViews = order.lines.flatMap(line => {
          const entry = received.get(line.id)
          return entry ? [{ lineId: line.id, sellerSku: line.sellerSku, quantity: entry.quantity, batchNo: entry.batchNo, unitCost: line.unitCost?.toString() ?? null }] : []
        })
        await tx.purchaseReceipt.create({
          data: {
            tenantId: context.tenantId,
            purchaseOrderId: id,
            warehouseId: warehouse.id,
            receiptNo,
            receivedAt,
            linesJson: lineViews,
            totalQty,
            note: body.note ?? null,
            receivedBy: context.userId,
          },
        })
        for (const line of order.lines) {
          const entry = received.get(line.id)
          if (!entry) continue
          await tx.purchaseOrderLine.update({ where: { id: line.id }, data: { receivedQuantity: { increment: entry.quantity } } })
          await tx.inventoryMovement.create({
            data: {
              tenantId: context.tenantId,
              warehouseId: warehouse.id,
              sellerSku: line.sellerSku,
              asin: line.asin,
              movementType: 'RECEIPT',
              quantity: entry.quantity,
              referenceType: 'PURCHASE_ORDER',
              referenceId: id,
              reasonCode: 'PURCHASE_RECEIPT',
              occurredAt: receivedAt,
              unitCost: line.unitCost,
              currency: line.unitCost === null ? null : line.currency,
              notes: entry.batchNo ? `批次 ${entry.batchNo}` : null,
              createdBy: context.userId,
            },
          })
        }
        let drafts = 0
        if (complete) {
          const fresh = await tx.purchaseOrderLine.findMany({ where: { purchaseOrderId: id }, take: 200 })
          drafts = await ensureCostDrafts(tx, { tenantId: context.tenantId, purchaseOrderId: id, effectiveFrom: receivedAt, lines: fresh })
          await SupplierService.refreshMetrics(tx, context.tenantId, order.supplierId)
        }
        await this.audit.record(
          req,
          {
            action: 'PURCHASE_RECEIPT_RECORDED',
            resourceType: 'PurchaseOrder',
            resourceId: id,
            before: { status: order.status },
            after: { status },
            detail: { receiptNo, totalQty, warehouseId: warehouse.id, costDrafts: drafts },
          },
          { client: tx },
        )
        return { next, receiptNo }
      })
      return { id, status, statusLabel: complete ? '全部到货' : '部分到货', version: outcome.next.version, documentNo: outcome.receiptNo }
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '收货单号冲突，请刷新页面后重试')
      throw error
    }
  }

  async inspect(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_RECEIVE)
    const body = PoInspectionBodySchema.parse(rawBody)
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (!purchaseOrderActions(order).includes('INSPECT')) throw stateConflict('当前状态不能登记质检', order.status)
    if (body.receiptId) {
      const receipt = await this.prisma.purchaseReceipt.findFirst({ where: { id: body.receiptId, tenantId: context.tenantId, purchaseOrderId: id }, select: { id: true } })
      if (!receipt) throw appError('VALIDATION_FAILED', '所选收货单不属于这张采购单', { fieldErrors: { receiptId: ['所选收货单不属于这张采购单'] } })
    }
    const next = await this.prisma.$transaction(async tx => {
      const updated = await updateWithVersion(tx.purchaseOrder, { id, tenantId: context.tenantId }, body.version, {}, { label: '采购单' })
      const created = await tx.qualityInspection.create({
        data: {
          tenantId: context.tenantId,
          purchaseOrderId: id,
          receiptId: body.receiptId ?? null,
          result: body.result,
          lotQty: body.lotQty,
          sampleQty: body.sampleQty,
          defectQty: body.defectQty,
          handling: body.handling ?? null,
          note: body.note ?? null,
          inspectorId: context.userId,
        },
      })
      await SupplierService.refreshMetrics(tx, context.tenantId, order.supplierId)
      await this.audit.record(
        req,
        {
          action: 'PURCHASE_INSPECTION_RECORDED',
          resourceType: 'PurchaseOrder',
          resourceId: id,
          after: { inspectionId: created.id, result: body.result, lotQty: body.lotQty, sampleQty: body.sampleQty, defectQty: body.defectQty },
        },
        { client: tx },
      )
      return updated
    })
    return { id, status: next.status as PoStatus, statusLabel: poStatusLabel(next.status), version: next.version }
  }
}
