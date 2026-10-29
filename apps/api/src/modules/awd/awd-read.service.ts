import { Injectable } from '@nestjs/common'
import {
  AwdListQuerySchema,
  awdOrderActions,
  type AwdAddress,
  type AwdInventoryResponse,
  type AwdInventoryRow,
  type AwdOrderDetail,
  type AwdOrderListResponse,
  type AwdPackageInput,
  type AwdShipmentItemRow,
  type AwdShipmentListResponse,
} from '@nova/api-contracts'
import { Prisma, type AwdInboundShipment } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ActionGuardService } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { awdFreshness, AWD_READ, dateText, orderRowOf, shipmentRowOf, viewState, writeStatus } from './awd-common'
import { orderTimeline } from './awd-timeline'

// 上游仓储的读取：库存（每店铺最近一次快照）、入库订单、入库货件。没有记录的数字显示为空，不补 0。
@Injectable()
export class AwdReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly guard: ActionGuardService,
  ) {}

  private async storeNames(tenantId: string, ids: string[]) {
    const stores = await this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(ids)] } }, select: { id: true, displayName: true }, take: 500 })
    return new Map(stores.map(store => [store.id, store.displayName]))
  }

  async inventory(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AwdInventoryResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, rawQuery)
    const query = AwdListQuerySchema.parse(rawQuery)
    const freshness = await awdFreshness(this.prisma, context.tenantId, scope)
    // 每个店铺只取最近一次快照（对应日期的全部 SKU）
    const latest = await this.prisma.awdInventory.groupBy({ by: ['sellerAccountId'], where: { tenantId: context.tenantId, ...storeWhere(scope) }, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    const empty = {
      items: [],
      total: 0,
      page: query.page,
      pageSize: query.pageSize,
      snapshotDate: null,
      totals: { onhandQty: null, availableQty: null, reservedForReplenishment: null, inboundToAwdQty: null, outboundToFbaInTransit: null },
      freshness,
    }
    if (pairs.length === 0) return { ...viewState(freshness, false), ...empty }
    const where: Prisma.AwdInventoryWhereInput = {
      tenantId: context.tenantId,
      OR: pairs,
      ...(query.q ? { sku: { contains: query.q, mode: 'insensitive' } } : {}),
    }
    const [rows, total, sums] = await Promise.all([
      this.prisma.awdInventory.findMany({ where, orderBy: [{ sku: 'asc' }, { sellerAccountId: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.awdInventory.count({ where }),
      this.prisma.awdInventory.aggregate({ where, _sum: { onhandQty: true, availableQty: true, reservedForReplenishment: true, inboundToAwdQty: true, outboundToFbaInTransit: true } }),
    ])
    const names = await this.storeNames(
      context.tenantId,
      rows.map(row => row.sellerAccountId),
    )
    const items: AwdInventoryRow[] = rows.map(row => ({
      sellerAccountId: row.sellerAccountId,
      storeName: names.get(row.sellerAccountId) ?? '',
      sku: row.sku,
      snapshotDate: dateText(row.snapshotDate) as string,
      onhandQty: row.onhandQty,
      availableQty: row.availableQty,
      reservedForReplenishment: row.reservedForReplenishment,
      inboundToAwdQty: row.inboundToAwdQty,
      outboundToFbaInTransit: row.outboundToFbaInTransit,
      expiryDate: dateText(row.expiryDate),
      expirations: Array.isArray(row.expirationJson) ? (row.expirationJson as AwdInventoryRow['expirations']) : [],
    }))
    const snapshotDate = pairs.map(pair => dateText(pair.snapshotDate) as string).sort()[pairs.length - 1]
    return {
      ...viewState(freshness, total > 0),
      items,
      total,
      page: query.page,
      pageSize: query.pageSize,
      snapshotDate,
      totals: {
        onhandQty: sums._sum.onhandQty,
        availableQty: sums._sum.availableQty,
        reservedForReplenishment: sums._sum.reservedForReplenishment,
        inboundToAwdQty: sums._sum.inboundToAwdQty,
        outboundToFbaInTransit: sums._sum.outboundToFbaInTransit,
      },
      freshness,
    }
  }

  async orders(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AwdOrderListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, rawQuery)
    const query = AwdListQuerySchema.parse(rawQuery)
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
    const where: Prisma.AwdInboundOrderWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ orderId: contains(query.q) }, { externalReferenceId: contains(query.q) }] } : {}),
    }
    const [rows, total, freshness, write] = await Promise.all([
      this.prisma.awdInboundOrder.findMany({ where, orderBy: { updatedAt: 'desc' }, skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.awdInboundOrder.count({ where }),
      awdFreshness(this.prisma, context.tenantId, scope),
      writeStatus(this.guard, context),
    ])
    const names = await this.storeNames(
      context.tenantId,
      rows.map(row => row.sellerAccountId),
    )
    return { ...viewState(freshness, total > 0), items: rows.map(row => orderRowOf(row, names.get(row.sellerAccountId) ?? '')), total, page: query.page, pageSize: query.pageSize, write, freshness }
  }

  /** 货件的预期与接收件数：只累加以“件”为单位的明细；任何一条没给数字时该货件的合计为空（不显示不完整的数字）。 */
  private async unitsOf(tenantId: string, shipments: AwdInboundShipment[]) {
    if (shipments.length === 0) return new Map<string, { expected: number | null; received: number | null; items: AwdShipmentItemRow[] }>()
    const items = await this.prisma.awdShipmentItem.findMany({
      where: { tenantId, OR: shipments.map(item => ({ sellerAccountId: item.sellerAccountId, shipmentId: item.shipmentId })) },
      orderBy: { sku: 'asc' },
      take: 10_000,
    })
    const result = new Map<string, { expected: number | null; received: number | null; items: AwdShipmentItemRow[] }>()
    for (const shipment of shipments) {
      const own = items.filter(item => item.sellerAccountId === shipment.sellerAccountId && item.shipmentId === shipment.shipmentId)
      const countable = own.length > 0 && own.every(item => item.unit === 'PRODUCT_UNITS')
      const sum = (pick: (item: (typeof own)[number]) => number | null) => (countable && own.every(item => pick(item) !== null) ? own.reduce((total, item) => total + (pick(item) as number), 0) : null)
      result.set(shipment.id, {
        expected: sum(item => item.expectedQty),
        received: sum(item => item.receivedQty),
        items: own.map(item => ({ sku: item.sku, expectedQty: item.expectedQty, receivedQty: item.receivedQty, unit: item.unit, expiryDate: dateText(item.expiryDate), prepInfo: item.prepInfoJson })),
      })
    }
    return result
  }

  private async orderRowIds(tenantId: string, shipments: AwdInboundShipment[]) {
    const orderIds = [...new Set(shipments.flatMap(item => (item.orderId ? [item.orderId] : [])))]
    const rows = orderIds.length
      ? await this.prisma.awdInboundOrder.findMany({ where: { tenantId, orderId: { in: orderIds } }, select: { id: true, sellerAccountId: true, orderId: true }, take: 1000 })
      : []
    return (shipment: AwdInboundShipment) => rows.find(row => row.orderId === shipment.orderId && row.sellerAccountId === shipment.sellerAccountId)?.id ?? null
  }

  async shipments(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AwdShipmentListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, rawQuery)
    const query = AwdListQuerySchema.parse(rawQuery)
    const contains = (value: string) => ({ contains: value, mode: 'insensitive' as const })
    const where: Prisma.AwdInboundShipmentWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q ? { OR: [{ shipmentId: contains(query.q) }, { orderId: contains(query.q) }, { trackingNumber: contains(query.q) }] } : {}),
    }
    const [rows, total, freshness] = await Promise.all([
      this.prisma.awdInboundShipment.findMany({ where, orderBy: [{ amazonUpdatedAt: { sort: 'desc', nulls: 'last' } }, { id: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.awdInboundShipment.count({ where }),
      awdFreshness(this.prisma, context.tenantId, scope),
    ])
    const [units, orderRowOf] = await Promise.all([this.unitsOf(context.tenantId, rows), this.orderRowIds(context.tenantId, rows)])
    const items = rows.map(row => shipmentRowOf(row, { orderRowId: orderRowOf(row), expectedUnits: units.get(row.id)?.expected ?? null, receivedUnits: units.get(row.id)?.received ?? null }))
    return { ...viewState(freshness, total > 0), items, total, page: query.page, pageSize: query.pageSize, freshness }
  }

  async orderDetail(req: RequestWithContext, id: string): Promise<AwdOrderDetail> {
    const { context, scope } = await this.context.authorizeScoped(req, AWD_READ, {})
    const row = await this.prisma.awdInboundOrder.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '入库订单不存在')
    const shipments = row.orderId
      ? await this.prisma.awdInboundShipment.findMany({ where: { tenantId: context.tenantId, sellerAccountId: row.sellerAccountId, orderId: row.orderId }, orderBy: { createdAt: 'asc' }, take: 50 })
      : []
    const [names, units, events, write] = await Promise.all([
      this.storeNames(context.tenantId, [row.sellerAccountId]),
      this.unitsOf(context.tenantId, shipments),
      this.prisma.auditEvent.findMany({
        where: { tenantId: context.tenantId, resourceType: 'AwdInboundOrder', resourceId: row.id },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: { action: true, result: true, createdAt: true, reason: true },
      }),
      writeStatus(this.guard, context, row.sellerAccountId),
    ])
    const draft = row.draftJson && typeof row.draftJson === 'object' ? (row.draftJson as { source?: unknown; batchId?: unknown; items?: unknown }) : null
    const source = typeof draft?.source === 'string' ? draft.source : null
    return {
      ...orderRowOf(row, names.get(row.sellerAccountId) ?? ''),
      originAddress: (row.originAddressJson as AwdAddress | null) ?? null,
      packages: Array.isArray(row.packagesJson) ? (row.packagesJson as unknown as AwdPackageInput[]) : [],
      preferredRegion: row.preferredRegion,
      note: row.note,
      draft: source
        ? { source, batchId: typeof draft?.batchId === 'string' ? draft.batchId : null, items: Array.isArray(draft?.items) ? (draft.items as Array<{ sku: string; qty: number }>) : [] }
        : null,
      shipments: shipments.map(shipment => ({
        ...shipmentRowOf(shipment, { orderRowId: row.id, expectedUnits: units.get(shipment.id)?.expected ?? null, receivedUnits: units.get(shipment.id)?.received ?? null }),
        items: units.get(shipment.id)?.items ?? [],
      })),
      timeline: orderTimeline(row, shipments, events),
      write,
      actions: awdOrderActions(
        row,
        shipments.some(shipment => shipment.status !== 'CANCELLED'),
      ),
    }
  }
}
