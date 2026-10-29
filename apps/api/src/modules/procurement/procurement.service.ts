import { Injectable } from '@nestjs/common'
import { PURCHASE_ORDER_FIELD_RULES, PURCHASE_ORDER_ONE_FIELD_RULES, stripSensitiveFields } from '../../platform/field-filter'
import { AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { purchaseOrderCreateData, purchaseOrdersWhere } from './procurement.queries'

@Injectable()
export class ProcurementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async suppliers(req: RequestWithContext) {
    const context = await this.context.authorize(req, 'supplier.read')
    return this.prisma.supplier.findMany({
      where: { tenantId: context.tenantId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { purchaseOrders: true } } },
    })
  }

  async purchaseOrders(req: RequestWithContext, query: Record<string, string>) {
    const context = await this.context.authorize(req, 'purchase.read')
    const orders = await this.prisma.purchaseOrder.findMany({
      where: purchaseOrdersWhere(context.tenantId, query),
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: { supplier: true, lines: true },
    })
    // 采购单金额与单价属成本字段：没有成本权限时不返回。
    return stripSensitiveFields(orders, context.permissions, PURCHASE_ORDER_FIELD_RULES)
  }

  async createPurchaseOrder(req: RequestWithContext, raw: Record<string, unknown>) {
    const context = await this.context.authorize(req, 'purchase.order.write')
    const supplierId = String(raw.supplierId ?? '')
    const numberValue = String(raw.number ?? '')
    const lines = Array.isArray(raw.lines) ? (raw.lines as Array<Record<string, unknown>>) : []
    if (!supplierId || !numberValue || !lines.length) {
      throw new AppError(400, 'PURCHASE_ORDER_INVALID', 'supplierId, number and lines are required')
    }
    const supplier = await this.prisma.supplier.findFirst({ where: { id: supplierId, tenantId: context.tenantId } })
    if (!supplier) throw new AppError(404, 'RESOURCE_NOT_FOUND', 'Supplier not found')
    const created = await this.prisma.purchaseOrder.create({
      data: purchaseOrderCreateData(context.tenantId, supplier, numberValue, raw, lines),
      include: { supplier: true, lines: true },
    })
    return stripSensitiveFields(created, context.permissions, PURCHASE_ORDER_ONE_FIELD_RULES)
  }
}
