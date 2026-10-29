import { Injectable } from '@nestjs/common'
import {
  SUPPLIER_METRIC_BASIS,
  SupplierCreateBodySchema,
  SupplierListQuerySchema,
  SupplierUpdateBodySchema,
  type SupplierDetail,
  type SupplierListResponse,
  type SupplierProductView,
  type SupplierRow,
} from '@nova/api-contracts'
import { Prisma, type Supplier } from '@prisma/client'
import { stripSensitiveFields, SUPPLIER_DETAIL_RULES } from '../../platform/field-filter'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { AttachmentService } from './attachment.service'
import { orderRowOf, ROW_INCLUDE } from './po-rows'
import { isoText, isUniqueViolation, moneyText, SUPPLIER_READ, SUPPLIER_WRITE } from './procurement-common'
import { computeSupplierMetrics, supplierTrend } from './supplier-metrics'

type Rating = SupplierRow['rating']

const rowOf = (supplier: Supplier, poCount: number, skuCount: number): SupplierRow => ({
  id: supplier.id,
  code: supplier.code,
  name: supplier.name,
  contactName: supplier.contactName,
  email: supplier.email,
  phone: supplier.phone,
  currency: supplier.currency,
  status: supplier.status,
  version: supplier.version,
  poCount,
  skuCount,
  onTimeRate: supplier.onTimeRate === null ? null : supplier.onTimeRate.toNumber(),
  qualityPassRate: supplier.qualityPassRate === null ? null : supplier.qualityPassRate.toNumber(),
  avgLeadDays: supplier.avgLeadDays,
  rating: supplier.rating as Rating,
  metricsAt: isoText(supplier.metricsAt),
})

const snapshot = (supplier: Supplier) => ({
  name: supplier.name,
  contactName: supplier.contactName,
  email: supplier.email,
  phone: supplier.phone,
  currency: supplier.currency,
  status: supplier.status,
  notes: supplier.notes,
})

// 供应商：资料维护、表现指标（系统在收货、质检后重算）、详情（合作商品与报价历史、采购历史、交付趋势、质检记录、附件）。
@Injectable()
export class SupplierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly attachments: AttachmentService,
  ) {}

  /** 每个供应商合作过的不同 SKU 数。 */
  private async skuCounts(tenantId: string, supplierIds: readonly string[]): Promise<Map<string, number>> {
    const lines = await this.prisma.purchaseOrderLine.findMany({
      where: { purchaseOrder: { tenantId, supplierId: { in: [...supplierIds] } } },
      select: { sellerSku: true, purchaseOrder: { select: { supplierId: true } } },
      take: 20000,
    })
    const sets = new Map<string, Set<string>>()
    for (const line of lines) sets.set(line.purchaseOrder.supplierId, (sets.get(line.purchaseOrder.supplierId) ?? new Set()).add(line.sellerSku))
    return new Map([...sets].map(([id, set]) => [id, set.size]))
  }

  private async rowFor(supplier: Supplier): Promise<SupplierRow> {
    const poCount = await this.prisma.purchaseOrder.count({ where: { tenantId: supplier.tenantId, supplierId: supplier.id } })
    return rowOf(supplier, poCount, (await this.skuCounts(supplier.tenantId, [supplier.id])).get(supplier.id) ?? 0)
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<SupplierListResponse> {
    const context = await this.context.authorize(req, SUPPLIER_READ)
    const query = SupplierListQuerySchema.parse(rawQuery)
    const where: Prisma.SupplierWhereInput = {
      tenantId: context.tenantId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [{ name: { contains: query.q, mode: 'insensitive' } }, { code: { contains: query.q, mode: 'insensitive' } }, { contactName: { contains: query.q, mode: 'insensitive' } }],
          }
        : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.supplier.findMany({
        where,
        orderBy: [{ status: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        include: { _count: { select: { purchaseOrders: true } } },
      }),
      this.prisma.supplier.count({ where }),
    ])
    const skus = await this.skuCounts(
      context.tenantId,
      rows.map(row => row.id),
    )
    return { items: rows.map(row => rowOf(row, row._count.purchaseOrders, skus.get(row.id) ?? 0)), total, page: query.page, pageSize: query.pageSize }
  }

  async detail(req: RequestWithContext, id: string): Promise<SupplierDetail> {
    const context = await this.context.authorize(req, SUPPLIER_READ)
    const supplier = await this.prisma.supplier.findFirst({ where: { id, tenantId: context.tenantId }, include: { _count: { select: { purchaseOrders: true } } } })
    if (!supplier) throw appError('RESOURCE_NOT_FOUND', '供应商不存在')
    const [orders, lines, inspections, attachments] = await Promise.all([
      this.prisma.purchaseOrder.findMany({ where: { tenantId: context.tenantId, supplierId: id }, include: ROW_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 200 }),
      this.prisma.purchaseOrderLine.findMany({
        where: { purchaseOrder: { tenantId: context.tenantId, supplierId: id } },
        select: { sellerSku: true, title: true, quantity: true, unitCost: true, currency: true, purchaseOrder: { select: { number: true, orderedAt: true, createdAt: true } } },
        take: 5000,
      }),
      this.prisma.qualityInspection.findMany({
        where: { tenantId: context.tenantId, purchaseOrder: { supplierId: id } },
        include: { purchaseOrder: { select: { number: true } } },
        orderBy: { inspectedAt: 'desc' },
        take: 100,
      }),
      this.attachments.list(context.tenantId, 'SUPPLIER', id),
    ])
    const metricOrders = await this.prisma.purchaseOrder.findMany({
      where: { tenantId: context.tenantId, supplierId: id, completedAt: { not: null } },
      select: { expectedDate: true, orderedAt: true, completedAt: true },
      take: 5000,
    })

    const products = new Map<string, SupplierProductView & { quotes: NonNullable<SupplierProductView['quotes']> }>()
    for (const line of lines) {
      const at = line.purchaseOrder.orderedAt ?? line.purchaseOrder.createdAt
      const entry = products.get(line.sellerSku) ?? { sku: line.sellerSku, title: line.title, orderedQty: 0, lastOrderedAt: at.toISOString(), quotes: [] }
      entry.orderedQty += line.quantity
      if (at.toISOString() > entry.lastOrderedAt) entry.lastOrderedAt = at.toISOString()
      entry.title = entry.title ?? line.title
      entry.quotes.push({ poNumber: line.purchaseOrder.number, orderedAt: at.toISOString(), unitCost: moneyText(line.unitCost), currency: line.currency })
      products.set(line.sellerSku, entry)
    }
    for (const entry of products.values()) entry.quotes.sort((a, b) => (a.orderedAt < b.orderedAt ? 1 : -1))

    const detail: SupplierDetail = {
      supplier: { ...rowOf(supplier, supplier._count.purchaseOrders, products.size), notes: supplier.notes, createdAt: isoText(supplier.createdAt) as string },
      products: [...products.values()].sort((a, b) => (a.lastOrderedAt < b.lastOrderedAt ? 1 : -1)),
      purchaseOrders: orders.map(order => orderRowOf(order, null)),
      trend: supplierTrend(metricOrders),
      inspections: inspections.map(item => ({
        id: item.id,
        poNumber: item.purchaseOrder.number,
        result: item.result,
        lotQty: item.lotQty,
        sampleQty: item.sampleQty,
        defectQty: item.defectQty,
        defectRatio: item.sampleQty > 0 ? item.defectQty / item.sampleQty : 0,
        inspectedAt: isoText(item.inspectedAt) as string,
      })),
      attachments,
      basis: SUPPLIER_METRIC_BASIS,
    }
    return stripSensitiveFields(detail, context.permissions, SUPPLIER_DETAIL_RULES)
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<SupplierRow> {
    const context = await this.context.authorize(req, SUPPLIER_WRITE)
    const body = SupplierCreateBodySchema.parse(rawBody)
    try {
      return await this.prisma.$transaction(async tx => {
        const created = await tx.supplier.create({ data: { tenantId: context.tenantId, ...body } })
        await this.audit.record(req, { action: 'SUPPLIER_CREATED', resourceType: 'Supplier', resourceId: created.id, after: snapshot(created) }, { client: tx })
        return rowOf(created, 0, 0)
      })
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', `编码 ${body.code} 已被使用`, { fieldErrors: { code: ['编码已被使用'] } })
      throw error
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<SupplierRow> {
    const context = await this.context.authorize(req, SUPPLIER_WRITE)
    const { version, ...changes } = SupplierUpdateBodySchema.parse(rawBody)
    const before = await this.prisma.supplier.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '供应商不存在')
    const after = await this.prisma.$transaction(async tx => {
      const updated = await updateWithVersion(tx.supplier, { id, tenantId: context.tenantId }, version, changes as Record<string, unknown>, { label: '供应商' })
      await this.audit.record(req, { action: 'SUPPLIER_UPDATED', resourceType: 'Supplier', resourceId: id, before: snapshot(before), after: snapshot(updated) }, { client: tx })
      return updated
    })
    return this.rowFor(after)
  }

  /** 停用（软删除）：保留全部历史；停用后不能再用它新建采购单。重复停用不报错。 */
  async deactivate(req: RequestWithContext, id: string): Promise<SupplierRow> {
    const context = await this.context.authorize(req, SUPPLIER_WRITE)
    const before = await this.prisma.supplier.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '供应商不存在')
    if (before.status === 'INACTIVE') return this.rowFor(before)
    const after = await this.prisma.$transaction(async tx => {
      const updated = await updateWithVersion(tx.supplier, { id, tenantId: context.tenantId }, before.version, { status: 'INACTIVE' }, { label: '供应商' })
      await this.audit.record(req, { action: 'SUPPLIER_DEACTIVATED', resourceType: 'Supplier', resourceId: id, before: snapshot(before), after: snapshot(updated) }, { client: tx })
      return updated
    })
    return this.rowFor(after)
  }

  /** 重算供应商表现指标（收货、质检、关闭采购单之后在同一个事务里调用）。 */
  static async refreshMetrics(tx: Pick<Prisma.TransactionClient, 'purchaseOrder' | 'qualityInspection' | 'supplier'>, tenantId: string, supplierId: string): Promise<void> {
    const [orders, inspections] = await Promise.all([
      tx.purchaseOrder.findMany({ where: { tenantId, supplierId, completedAt: { not: null } }, select: { expectedDate: true, orderedAt: true, completedAt: true }, take: 5000 }),
      tx.qualityInspection.findMany({ where: { tenantId, purchaseOrder: { supplierId } }, select: { sampleQty: true, defectQty: true }, take: 20000 }),
    ])
    const metrics = computeSupplierMetrics(orders, inspections)
    await tx.supplier.updateMany({
      where: { id: supplierId, tenantId },
      data: {
        onTimeRate: metrics.onTimeRate === null ? null : new Prisma.Decimal(metrics.onTimeRate).toDecimalPlaces(4),
        qualityPassRate: metrics.qualityPassRate === null ? null : new Prisma.Decimal(metrics.qualityPassRate).toDecimalPlaces(4),
        avgLeadDays: metrics.avgLeadDays,
        rating: metrics.rating,
        metricsAt: new Date(),
      },
    })
  }
}
