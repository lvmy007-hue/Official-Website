import { Injectable } from '@nestjs/common'
import {
  ALLOCATION_METHOD_LABEL,
  ALLOCATION_METHODS,
  FIRST_MILE_COST_LABEL,
  FirstMileListQuerySchema,
  firstMileActions,
  isDeviationAbnormal,
  MILESTONE_SOURCE_LABEL,
  milestoneLabel,
  type AllocationMethod,
  type AllocationView,
  type FirstMileCostItem,
  type FirstMileDetail,
  type FirstMileListResponse,
  type FirstMileMode,
  type LinkedInboundView,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { Prisma } from '@prisma/client'
import { FIRST_MILE_DETAIL_RULES, FIRST_MILE_LIST_RULES, stripSensitiveFields } from '../../platform/field-filter'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { AttachmentService } from '../procurement'
import { allocationReadiness } from './allocation-math'
import { dayText, FM_READ, isoText, moneyText, todayText } from './first-mile-common'
import { deviationPctOf, rowOf, SHIPMENT_INCLUDE } from './first-mile-rows'
import { loadFillSuggestions, qtyCheckOf } from './freight-missing'
import { transitHintFor } from './transit-load'

/** 异常单筛选最多扫描最近多少张有预估与费用的运单。 */
const DEVIATION_SCAN_LIMIT = 5000

// 头程运单的列表与详情（06 章 6.10）。费用类字段按 field.cost 过滤；详情带可用动作，页面只负责显示。
@Injectable()
export class FirstMileReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly attachments: AttachmentService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<FirstMileListResponse> {
    const context = await this.context.authorize(req, FM_READ)
    const query = FirstMileListQuerySchema.parse(rawQuery)
    const stageWhere: Record<string, Prisma.FirstMileShipmentWhereInput> = {
      DELIVERED: { ataDelivery: { not: null } },
      ARRIVED: { ataDelivery: null, ataPort: { not: null } },
      IN_TRANSIT: { ataDelivery: null, ataPort: null, shipDate: { not: null } },
      PLANNED: { ataDelivery: null, ataPort: null, shipDate: null },
    }
    // 异常单筛选（P6-26）：差异比例要用费用明细合计现算，先在候选里挑出编号再查；没有成本字段权限不能按费用筛（否则能从结果反推金额）
    let deviationIds: string[] | null = null
    if (query.deviation) {
      if (!canSeeField(context.permissions, 'cost')) throw appError('TENANT_ACCESS_DENIED', '按预估与实际差异筛选需要成本字段权限（field.cost）')
      const candidates = await this.prisma.firstMileShipment.findMany({
        where: { tenantId: context.tenantId, estimatedCost: { not: null }, costs: { some: {} } },
        select: { id: true, estimatedCost: true, currency: true, costs: { select: { amount: true, currency: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: DEVIATION_SCAN_LIMIT,
      })
      deviationIds = candidates.filter(row => isDeviationAbnormal(deviationPctOf(row), query.deviationPct)).map(row => row.id)
    }
    const where: Prisma.FirstMileShipmentWhereInput = {
      tenantId: context.tenantId,
      ...(deviationIds ? { id: { in: deviationIds } } : {}),
      ...(query.forwarderId ? { forwarderId: query.forwarderId } : {}),
      ...(query.mode ? { mode: query.mode } : {}),
      ...(query.stage ? stageWhere[query.stage] : {}),
      ...(query.q
        ? {
            OR: [
              { waybillNo: { contains: query.q, mode: 'insensitive' } },
              { containerNo: { contains: query.q, mode: 'insensitive' } },
              { forwarder: { name: { contains: query.q, mode: 'insensitive' } } },
              { items: { some: { sku: { contains: query.q, mode: 'insensitive' } } } },
              { linkedInboundShipmentIds: { has: query.q } },
            ],
          }
        : {}),
    }
    const [rows, total, forwarders, warehouses] = await Promise.all([
      this.prisma.firstMileShipment.findMany({
        where,
        include: SHIPMENT_INCLUDE,
        orderBy: [{ shipDate: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.firstMileShipment.count({ where }),
      this.prisma.freightForwarder.findMany({
        where: { tenantId: context.tenantId },
        select: { id: true, name: true, status: true, defaultMode: true },
        orderBy: [{ status: 'asc' }, { name: 'asc' }],
        take: 200,
      }),
      this.prisma.warehouse.findMany({
        where: { tenantId: context.tenantId, kind: 'DOMESTIC', status: 'ACTIVE' },
        select: { id: true, name: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: 50,
      }),
    ])
    const today = todayText()
    const response: FirstMileListResponse = {
      items: rows.map(row => rowOf(row, today)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      forwarders: forwarders.map(row => ({ ...row, defaultMode: row.defaultMode as FirstMileMode | null })),
      warehouses,
    }
    return stripSensitiveFields(response, context.permissions, FIRST_MILE_LIST_RULES)
  }

  async detail(req: RequestWithContext, id: string): Promise<FirstMileDetail> {
    const context = await this.context.authorize(req, FM_READ)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({
      where: { id, tenantId },
      include: { ...SHIPMENT_INCLUDE, items: true, costs: { orderBy: [{ incurredAt: 'asc' }, { createdAt: 'asc' }] } },
    })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    const [milestones, allocations, attachments, orders, inbound, outboundSum] = await Promise.all([
      this.prisma.firstMileMilestone.findMany({ where: { tenantId, shipmentId: id }, orderBy: [{ occurredAt: 'asc' }, { createdAt: 'asc' }], take: 500 }),
      this.prisma.landedCostAllocation.findMany({
        where: { tenantId, firstMileShipmentId: id },
        include: { costVersion: { select: { versionNo: true, status: true } } },
        orderBy: { sku: 'asc' },
        take: 500,
      }),
      this.attachments.list(tenantId, 'FIRST_MILE', id),
      shipment.items.some(item => item.purchaseOrderId)
        ? this.prisma.purchaseOrder.findMany({
            where: { tenantId, id: { in: shipment.items.flatMap(item => (item.purchaseOrderId ? [item.purchaseOrderId] : [])) } },
            select: { id: true, number: true },
            take: 200,
          })
        : Promise.resolve([]),
      shipment.linkedInboundShipmentIds.length
        ? this.prisma.fbaInboundShipment.findMany({
            where: { shipmentId: { in: shipment.linkedInboundShipmentIds }, plan: { tenantId } },
            select: { planId: true, shipmentId: true, status: true, destinationFc: true, unitsExpected: true, unitsReceived: true },
            take: 200,
          })
        : Promise.resolve([]),
      shipment.outboundAt
        ? this.prisma.inventoryMovement.aggregate({ where: { tenantId, referenceType: 'FIRST_MILE', referenceId: id, movementType: 'FIRST_MILE_OUT' }, _sum: { quantity: true } })
        : Promise.resolve(null),
    ])
    const shippedRows = inbound.length
      ? await this.prisma.shipmentItem.groupBy({
          by: ['planId', 'shipmentId'],
          where: { tenantId, OR: inbound.map(row => ({ planId: row.planId, shipmentId: row.shipmentId })) },
          _sum: { shippedQty: true },
        })
      : []
    const names = await memberNames(this.prisma, tenantId, [
      shipment.createdBy,
      ...milestones.map(row => row.createdBy),
      ...shipment.costs.map(row => row.createdBy),
      ...allocations.map(row => row.createdBy),
    ])
    const today = todayText()
    const numbers = new Map(orders.map(order => [order.id, order.number]))
    const dec = (value: Prisma.Decimal | null) => (value === null ? null : value.toNumber())
    const mathItems = shipment.items.map(item => ({ sku: item.sku, quantity: item.quantity, volumeCbm: item.volumeCbm, weightKg: item.weightKg, goodsValue: item.goodsValue }))
    const allocated = allocations.length > 0

    const linkedInbound: LinkedInboundView[] = shipment.linkedInboundShipmentIds.map(shipmentId => {
      const found = inbound.find(row => row.shipmentId === shipmentId)
      if (!found) return { shipmentId, found: false, status: null, destinationFc: null, unitsExpected: null, unitsReceived: null, shippedUnits: null }
      const shipped = shippedRows.find(row => row.planId === found.planId && row.shipmentId === found.shipmentId)
      return {
        shipmentId,
        found: true,
        status: found.status,
        destinationFc: found.destinationFc,
        unitsExpected: found.unitsExpected,
        unitsReceived: found.unitsReceived,
        shippedUnits: shipped?._sum.shippedQty ?? null,
      }
    })
    const allocation: AllocationView | null = allocated
      ? {
          method: allocations[0].method as AllocationMethod,
          methodLabel: ALLOCATION_METHOD_LABEL[allocations[0].method as AllocationMethod],
          currency: allocations[0].currency,
          total: allocations.reduce((sum, row) => sum.plus(row.allocatedAmount), new Prisma.Decimal(0)).toString(),
          createdAt: isoText(allocations[0].createdAt) as string,
          createdByName: nameOrFormer(names, allocations[0].createdBy),
          lines: allocations.map(row => ({
            sku: row.sku,
            quantity: row.quantity,
            allocatedAmount: row.allocatedAmount.toString(),
            unitCost: row.allocatedAmount.div(row.quantity).toDecimalPlaces(6).toString(),
            costVersionNo: row.costVersion?.versionNo ?? null,
            costVersionStatus: row.costVersion?.status ?? null,
          })),
        }
      : null
    const detail: FirstMileDetail = {
      shipment: { ...rowOf(shipment, today), note: shipment.note, createdAt: isoText(shipment.createdAt) as string, createdByName: nameOrFormer(names, shipment.createdBy) },
      items: shipment.items
        .sort((a, b) => a.sku.localeCompare(b.sku))
        .map(item => ({
          sku: item.sku,
          purchaseOrderId: item.purchaseOrderId,
          purchaseOrderNo: item.purchaseOrderId ? (numbers.get(item.purchaseOrderId) ?? null) : null,
          quantity: item.quantity,
          cartons: item.cartons,
          volumeCbm: dec(item.volumeCbm),
          weightKg: dec(item.weightKg),
          goodsValue: moneyText(item.goodsValue),
        })),
      milestones: milestones.map(row => ({
        id: row.id,
        milestone: row.milestone,
        label: milestoneLabel(row.milestone),
        occurredAt: isoText(row.occurredAt) as string,
        location: row.location,
        source: row.source,
        sourceLabel: MILESTONE_SOURCE_LABEL[row.source as keyof typeof MILESTONE_SOURCE_LABEL] ?? row.source,
        note: row.note,
        createdByName: row.createdBy ? nameOrFormer(names, row.createdBy) : null,
      })),
      costs: shipment.costs.map(row => ({
        id: row.id,
        item: row.item as FirstMileCostItem,
        itemLabel: FIRST_MILE_COST_LABEL[row.item as FirstMileCostItem] ?? row.item,
        amount: row.amount.toString(),
        incurredAt: dayText(row.incurredAt) as string,
        note: row.note,
        createdByName: nameOrFormer(names, row.createdBy),
      })),
      allocation,
      allocationReady: Object.fromEntries(ALLOCATION_METHODS.map(method => [method, allocationReadiness(mathItems, method)])) as Record<AllocationMethod, string | null>,
      attachments,
      linkedInbound,
      missingFields: await loadFillSuggestions(this.prisma, tenantId, shipment.items),
      qtyCheck: qtyCheckOf({
        firstMileUnits: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
        outboundUnits: outboundSum ? -(outboundSum._sum.quantity ?? 0) : null,
        linked: linkedInbound,
      }),
      actions: firstMileActions({
        hasCosts: shipment.costs.length > 0,
        hasItems: shipment.items.length > 0,
        allocated,
        outbound: shipment.outboundAt !== null,
        hasWarehouse: shipment.warehouseId !== null,
      }),
      transitHint: await transitHintFor(this.prisma, { tenantId, today, forwarderId: shipment.forwarderId, forwarderName: shipment.forwarder.name, mode: shipment.mode as FirstMileMode }),
    }
    return stripSensitiveFields(detail, context.permissions, FIRST_MILE_DETAIL_RULES)
  }
}
