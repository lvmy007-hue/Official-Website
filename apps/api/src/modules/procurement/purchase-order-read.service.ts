import { Injectable } from '@nestjs/common'
import {
  PurchaseOrderListQuerySchema,
  purchaseOrderActions,
  type PoApprovalView,
  type PoInspectionView,
  type PoLineView,
  type PoLinks,
  type PoLogView,
  type PoPaymentView,
  type PoReceiptView,
  type PurchaseOrderDetail,
  type PurchaseOrderListResponse,
} from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { Prisma } from '@prisma/client'
import { stripSensitiveFields, PURCHASE_ORDER_DETAIL_RULES, PURCHASE_ORDER_LIST_RULES } from '../../platform/field-filter'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { costDiffOf, deliveryDeviation, firstMileLinks, loadActiveCosts, loadReplenishmentLinks } from './po-hints'
import { inboundPlanLinks } from './po-inbound-links'
import { orderRowOf, ROW_INCLUDE } from './po-rows'
import { dayText, isoText, moneyText, PO_APPROVE, PO_READ, ratioOf } from './procurement-common'
import { AttachmentService } from './attachment.service'

// 采购单的读取：列表（筛选、页码分页、交期偏差提示）与详情（9 个页签的数据一次返回，页签只负责显示）。
// 金额与单价属 field.cost：没有该权限时响应里这些键不存在；也不允许按金额筛选（否则能从筛选结果反推金额）。
@Injectable()
export class PurchaseOrderReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly attachments: AttachmentService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<PurchaseOrderListResponse> {
    const context = await this.context.authorize(req, PO_READ)
    const query = PurchaseOrderListQuerySchema.parse(rawQuery)
    if ((query.minAmount !== undefined || query.maxAmount !== undefined) && !canSeeField(context.permissions, 'cost')) {
      throw appError('TENANT_ACCESS_DENIED', '没有查看采购金额的权限，不能按金额筛选')
    }
    const and: Prisma.PurchaseOrderWhereInput[] = []
    if (query.batchId) {
      const linked = await this.prisma.replenishmentAction.findMany({
        where: { tenantId: context.tenantId, batchId: query.batchId, targetDocType: 'PURCHASE_ORDER' },
        select: { targetDocId: true },
        take: 2000,
      })
      and.push({ id: { in: linked.flatMap(item => (item.targetDocId ? [item.targetDocId] : [])) } })
    }
    if (query.q) {
      and.push({
        OR: [
          { number: { contains: query.q, mode: 'insensitive' } },
          { supplier: { name: { contains: query.q, mode: 'insensitive' } } },
          { lines: { some: { sellerSku: { contains: query.q, mode: 'insensitive' } } } },
        ],
      })
    }
    if (query.receiving === 'NONE') and.push({ receivedQtyTotal: 0, status: { notIn: ['CANCELLED', 'RETURNED_TO_SUPPLIER'] } })
    if (query.receiving === 'PARTIAL') and.push({ status: 'PARTIALLY_RECEIVED' })
    if (query.receiving === 'FULL') and.push({ completedAt: { not: null } })
    const where: Prisma.PurchaseOrderWhereInput = {
      tenantId: context.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(query.currency ? { currency: query.currency } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.expectedFrom || query.expectedTo
        ? {
            expectedDate: {
              ...(query.expectedFrom ? { gte: new Date(`${query.expectedFrom}T00:00:00.000Z`) } : {}),
              ...(query.expectedTo ? { lte: new Date(`${query.expectedTo}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
      ...(query.minAmount !== undefined || query.maxAmount !== undefined
        ? { totalAmount: { ...(query.minAmount !== undefined ? { gte: query.minAmount } : {}), ...(query.maxAmount !== undefined ? { lte: query.maxAmount } : {}) } }
        : {}),
      ...(and.length ? { AND: and } : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where, include: ROW_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.purchaseOrder.count({ where }),
    ])
    const links = await loadReplenishmentLinks(
      this.prisma,
      context.tenantId,
      rows.map(row => row.id),
    )
    const items = rows.map(row => orderRowOf(row, deliveryDeviation(row, links.get(row.id)?.needBy ?? [])))
    return stripSensitiveFields({ items, total, page: query.page, pageSize: query.pageSize }, context.permissions, PURCHASE_ORDER_LIST_RULES)
  }

  async detail(req: RequestWithContext, id: string): Promise<PurchaseOrderDetail> {
    const context = await this.context.authorize(req, PO_READ)
    const order = await this.prisma.purchaseOrder.findFirst({
      where: { id, tenantId: context.tenantId },
      include: {
        ...ROW_INCLUDE,
        lines: true,
        receipts: { orderBy: { createdAt: 'asc' }, include: { warehouse: { select: { name: true } } } },
        inspections: { orderBy: { inspectedAt: 'desc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        approvals: { orderBy: { step: 'desc' } },
      },
    })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    const canFirstMile = hasPermission(context.permissions, 'firstmile.read')
    // 入仓计划靠头程运单推算（po-inbound-links.ts），两项读权限都要有，否则不显示也不泄露
    const canInboundPlans = canFirstMile && hasPermission(context.permissions, 'inbound.read')
    const [linkMap, costs, audits, costVersions, attachments, firstMileItems] = await Promise.all([
      loadReplenishmentLinks(this.prisma, context.tenantId, [id]),
      loadActiveCosts(this.prisma, context.tenantId, [...new Set(order.lines.map(line => line.sellerSku))]),
      this.prisma.auditEvent.findMany({ where: { tenantId: context.tenantId, resourceType: 'PurchaseOrder', resourceId: id }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 }),
      this.prisma.costVersion.findMany({ where: { tenantId: context.tenantId, source: 'PURCHASE_RECEIPT', sourceDocId: id }, orderBy: { sku: 'asc' }, take: 500 }),
      this.attachments.list(context.tenantId, 'PURCHASE_ORDER', id),
      // 头程运单明细里引用了这张采购单的（P2a-11）；没有头程读权限的成员只看到“无权查看”，不泄露运单信息
      canFirstMile
        ? this.prisma.firstMileShipmentItem.findMany({
            where: { tenantId: context.tenantId, purchaseOrderId: id },
            select: { shipmentId: true, quantity: true, shipment: { select: { waybillNo: true, linkedInboundShipmentIds: true, forwarder: { select: { name: true } } } } },
            orderBy: { shipment: { createdAt: 'desc' } },
            take: 200,
          })
        : Promise.resolve([]),
    ])
    const names = await memberNames(this.prisma, context.tenantId, [
      order.createdById,
      ...order.approvals.flatMap(item => [item.submittedBy, item.approverId]),
      ...order.payments.map(item => item.createdBy),
      ...order.receipts.map(item => item.receivedBy),
      ...order.inspections.map(item => item.inspectorId),
      ...audits.map(item => item.actorId),
    ])
    const who = (userId: string | null | undefined) => nameOrFormer(names, userId)
    const links = linkMap.get(id)
    const row = orderRowOf(order, deliveryDeviation(order, links?.needBy ?? []))
    const receiptNo = new Map(order.receipts.map(item => [item.id, item.receiptNo]))

    const lines: PoLineView[] = order.lines.map(line => ({
      id: line.id,
      sellerSku: line.sellerSku,
      asin: line.asin,
      title: line.title,
      quantity: line.quantity,
      receivedQuantity: line.receivedQuantity,
      currency: line.currency,
      unitCost: moneyText(line.unitCost),
      lineAmount: line.unitCost === null ? null : line.unitCost.mul(line.quantity).toString(),
      costDiff: costDiffOf(line.unitCost, costs.get(line.sellerSku), line.currency),
    }))
    const approvals: PoApprovalView[] = order.approvals.map(item => ({
      id: item.id,
      step: item.step,
      decision: item.decision,
      submittedByName: who(item.submittedBy),
      approverName: item.approverId ? who(item.approverId) : null,
      comment: item.comment,
      decidedAt: isoText(item.decidedAt),
      createdAt: isoText(item.createdAt) as string,
    }))
    const payments: PoPaymentView[] = order.payments.map(item => ({
      id: item.id,
      kind: item.kind,
      status: item.status,
      currency: item.currency,
      method: item.method,
      plannedAt: dayText(item.plannedAt),
      paidAt: dayText(item.paidAt),
      voucherAttachmentId: item.voucherAttachmentId,
      note: item.note,
      createdByName: who(item.createdBy),
      amount: item.amount.toString(),
    }))
    const receipts: PoReceiptView[] = order.receipts.map(item => ({
      id: item.id,
      receiptNo: item.receiptNo,
      receivedAt: dayText(item.receivedAt) as string,
      warehouseName: item.warehouse?.name ?? null,
      totalQty: item.totalQty,
      note: item.note,
      receivedByName: who(item.receivedBy),
      lines: Array.isArray(item.linesJson) ? (item.linesJson as unknown as PoReceiptView['lines']) : [],
    }))
    const inspections: PoInspectionView[] = order.inspections.map(item => ({
      id: item.id,
      receiptNo: item.receiptId ? (receiptNo.get(item.receiptId) ?? null) : null,
      result: item.result,
      lotQty: item.lotQty,
      sampleQty: item.sampleQty,
      defectQty: item.defectQty,
      sampleRatio: ratioOf(item.sampleQty, item.lotQty) ?? 0,
      defectRatio: ratioOf(item.defectQty, item.sampleQty) ?? 0,
      handling: item.handling,
      note: item.note,
      inspectorName: who(item.inspectorId),
      inspectedAt: isoText(item.inspectedAt) as string,
    }))
    const log: PoLogView[] = audits.map(item => ({ id: item.id, at: isoText(item.createdAt) as string, action: item.action, actorName: who(item.actorId), result: item.result, reason: item.reason }))
    const poLinks: PoLinks = {
      batches: [...(links?.batches.entries() ?? [])].map(([batchId, batchNo]) => ({ id: batchId, batchNo })),
      inboundPlans: canInboundPlans
        ? await inboundPlanLinks(
            this.prisma,
            context.tenantId,
            firstMileItems.flatMap(item => item.shipment.linkedInboundShipmentIds),
          )
        : 'NO_PERMISSION',
      firstMile: canFirstMile ? firstMileLinks(firstMileItems) : 'NO_PERMISSION',
      costVersions: costVersions.map(item => ({ sku: item.sku, versionNo: item.versionNo, status: item.status, unitProductCost: moneyText(item.unitProductCost), currency: item.currency })),
    }
    const pending = order.approvals.find(item => item.decision === 'PENDING')
    const canApprove = order.status === 'PENDING_APPROVAL' && hasPermission(context.permissions, PO_APPROVE) && order.createdById !== context.userId && pending?.submittedBy !== context.userId

    const detail: PurchaseOrderDetail = {
      order: {
        ...row,
        notes: order.notes,
        createdByName: who(order.createdById),
        submittedAt: isoText(order.submittedAt),
        orderedAt: isoText(order.orderedAt),
        completedAt: isoText(order.completedAt),
        supplierCode: order.supplier.code,
      },
      lines,
      approvals,
      payments,
      receipts,
      inspections,
      attachments,
      links: poLinks,
      log,
      actions: purchaseOrderActions(order),
      canApprove,
    }
    return stripSensitiveFields(detail, context.permissions, PURCHASE_ORDER_DETAIL_RULES)
  }
}
