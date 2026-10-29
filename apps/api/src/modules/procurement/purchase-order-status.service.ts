import { Injectable } from '@nestjs/common'
import { PoStatusBodySchema, purchaseOrderActions, type PoActionResult, type PoStatus } from '@nova/api-contracts'
import { Prisma, type PurchaseOrder } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { PO_WRITE, stateConflict } from './procurement-common'
import { availableQty } from './stock-ops'
import { SupplierService } from './supplier.service'

const AUDIT_ACTION = { START_PRODUCTION: 'PURCHASE_ORDER_PRODUCTION_STARTED', CLOSE: 'PURCHASE_ORDER_CLOSED', CANCEL: 'PURCHASE_ORDER_CANCELLED', RETURN: 'PURCHASE_ORDER_RETURNED' } as const

const result = (order: Pick<PurchaseOrder, 'id' | 'status' | 'version'>, label: string): PoActionResult => ({
  id: order.id,
  status: order.status as PoStatus,
  statusLabel: label,
  version: order.version,
})

// 采购单的状态动作：开始生产、关闭、取消、退货给供应商。
// 能不能做由 purchaseOrderActions（契约里的状态机）决定，服务端和页面用同一份规则。
@Injectable()
export class PurchaseOrderStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async apply(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_WRITE)
    const body = PoStatusBodySchema.parse(rawBody)
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId }, include: { lines: true, payments: { select: { status: true } } } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (!purchaseOrderActions(order).includes(body.action))
      throw stateConflict(`当前状态不能${{ START_PRODUCTION: '开始生产', CLOSE: '关闭', CANCEL: '取消', RETURN: '退货' }[body.action]}`, order.status)

    const paid = order.payments.some(payment => payment.status === 'PAID')
    const data: Record<string, unknown> = {}
    let status: PoStatus
    switch (body.action) {
      case 'START_PRODUCTION':
        status = 'IN_PRODUCTION'
        break
      case 'CANCEL':
        // 已付过款的单不能直接取消（系统不记录退款，避免账实不符）：先走“退货”或与供应商线下处理后关闭
        if (paid) throw appError('DATA_CONDITION_FAILED', '这张采购单已有付款记录，不能直接取消。请先与供应商处理退款，再联系管理员处理。', { details: { status: order.status } })
        status = 'CANCELLED'
        break
      case 'CLOSE':
        // 全部到货的单要付清才能关闭；部分到货的“短交关闭”只需说明原因，剩余款项关闭后仍可登记
        if (order.status === 'RECEIVED' && order.totalAmount !== null && order.paymentStatus !== 'PAID')
          throw appError('DATA_CONDITION_FAILED', '全部到货的采购单需要付清款项后才能关闭', { details: { status: order.status } })
        status = 'CLOSED'
        if (!order.completedAt) data.completedAt = new Date()
        break
      case 'RETURN':
        status = 'RETURNED_TO_SUPPLIER'
        break
    }
    data.status = status

    const updated = await this.prisma.$transaction(async tx => {
      if (body.action === 'RETURN') await this.recordReturn(tx, context.tenantId, context.userId, order, body.lines ?? [])
      const next = await updateWithVersion(tx.purchaseOrder, { id, tenantId: context.tenantId }, body.version, data, { label: '采购单' })
      if (body.action === 'CANCEL' && order.status === 'PENDING_APPROVAL') {
        await tx.purchaseApproval.updateMany({
          where: { purchaseOrderId: id, tenantId: context.tenantId, decision: 'PENDING' },
          data: { decision: 'REJECTED', approverId: context.userId, comment: `订单已取消：${body.reason}`, decidedAt: new Date() },
        })
        await tx.purchaseOrder.updateMany({ where: { id, tenantId: context.tenantId }, data: { approvalStatus: 'NONE' } })
      }
      if (body.action === 'CLOSE' || body.action === 'RETURN') await SupplierService.refreshMetrics(tx, context.tenantId, order.supplierId)
      await this.audit.record(
        req,
        {
          action: AUDIT_ACTION[body.action],
          resourceType: 'PurchaseOrder',
          resourceId: id,
          before: { status: order.status },
          after: { status },
          ...(body.reason ? { reason: body.reason } : {}),
          ...(body.lines ? { detail: { lines: body.lines } } : {}),
        },
        { client: tx },
      )
      return next
    })
    return result(updated, { START_PRODUCTION: '生产中', CLOSE: '已关闭', CANCEL: '已取消', RETURN: '退货给供应商' }[body.action])
  }

  /** 退货给供应商：从收货所在的国内仓扣减库存（负的 RETURN_TO_SUPPLIER 流水）。库存不够退时拒绝，不让库存变负。 */
  private async recordReturn(
    tx: Prisma.TransactionClient,
    tenantId: string,
    userId: string,
    order: Prisma.PurchaseOrderGetPayload<{ include: { lines: true } }>,
    lines: ReadonlyArray<{ lineId: string; quantity: number }>,
  ) {
    const receipts = await tx.inventoryMovement.findMany({
      where: { tenantId, referenceType: 'PURCHASE_ORDER', referenceId: order.id, movementType: 'RECEIPT' },
      select: { warehouseId: true, sellerSku: true },
      orderBy: { occurredAt: 'asc' },
      take: 5000,
    })
    const warehouseBySku = new Map<string, string>()
    for (const move of receipts) if (move.warehouseId && !warehouseBySku.has(move.sellerSku)) warehouseBySku.set(move.sellerSku, move.warehouseId)
    const now = new Date()
    for (const entry of lines) {
      const line = order.lines.find(item => item.id === entry.lineId)
      if (!line) throw appError('VALIDATION_FAILED', '退货商品行不属于这张采购单', { fieldErrors: { lines: ['退货商品行不属于这张采购单'] } })
      if (entry.quantity > line.receivedQuantity)
        throw appError('VALIDATION_FAILED', `${line.sellerSku} 退货数量（${entry.quantity}）超过已收货数量（${line.receivedQuantity}）`, {
          fieldErrors: { lines: [`${line.sellerSku} 退货数量超过已收货数量`] },
        })
      const warehouseId = warehouseBySku.get(line.sellerSku)
      if (!warehouseId) throw appError('DATA_CONDITION_FAILED', `${line.sellerSku} 没有对应的国内仓入库记录，无法退货`, { details: { status: order.status } })
      const available = await availableQty(tx, tenantId, warehouseId, line.sellerSku)
      if (entry.quantity > available)
        throw appError('DATA_CONDITION_FAILED', `${line.sellerSku} 国内仓可用库存只有 ${available}，不够退 ${entry.quantity}（可能已出库或被占用）`, { details: { status: order.status } })
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          warehouseId,
          sellerSku: line.sellerSku,
          movementType: 'RETURN_TO_SUPPLIER',
          quantity: -entry.quantity,
          referenceType: 'PURCHASE_ORDER',
          referenceId: order.id,
          reasonCode: 'RETURN_TO_SUPPLIER',
          occurredAt: now,
          createdBy: userId,
        },
      })
    }
  }
}
