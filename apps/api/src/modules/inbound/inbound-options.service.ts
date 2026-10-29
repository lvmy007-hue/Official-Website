import { Injectable } from '@nestjs/common'
import {
  SHIPPING_MODES,
  SHIPPING_MODE_LABEL,
  placementTotalCost,
  recommendPlacement,
  shippingModeOf,
  validateBoxes,
  type InboundBoxesResponse,
  type InboundOptionsResponse,
  type InboundShipmentView,
  type PlacementEstimate,
  type PlacementOptionView,
  type PlacementShipmentView,
} from '@nova/api-contracts'
import type { FbaInboundPlan, Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { INBOUND_READ, iso, loadPlan, num, record } from './inbound-common'

const asItems = (value: unknown): Array<{ sku: string; quantity: number }> =>
  (Array.isArray(value) ? value : []).map(record).flatMap(item => (typeof item.sku === 'string' && typeof item.quantity === 'number' ? [{ sku: item.sku, quantity: item.quantity }] : []))

// 入仓计划的方案、箱内物品与货件读取。方案过期时间、总成本都在读取时按当前数据计算，不存结果。
@Injectable()
export class InboundOptionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private async groupsOf(plan: FbaInboundPlan) {
    if (!plan.selectedPackingOptionId) return []
    const groups = await this.prisma.packingGroup.findMany({
      where: { tenantId: plan.tenantId, planId: plan.id, packingOptionId: plan.selectedPackingOptionId },
      orderBy: { packingGroupId: 'asc' },
      take: 200,
    })
    return groups.map(group => ({ packingGroupId: group.packingGroupId, items: asItems(group.itemsJson) }))
  }

  private async totalWeightLb(tenantId: string, planId: string): Promise<number | null> {
    const boxes = await this.prisma.inboundBox.findMany({ where: { tenantId, planId }, select: { weightLb: true, quantity: true }, take: 1000 })
    return boxes.length ? Math.round(boxes.reduce((sum, box) => sum + (num(box.weightLb) ?? 0) * box.quantity, 0) * 1000) / 1000 : null
  }

  async options(req: RequestWithContext, id: string): Promise<InboundOptionsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const tenantId = context.tenantId
    const now = new Date()
    const [packing, groups, placement, transport, windows, shipments, totalWeightLb] = await Promise.all([
      this.prisma.packingOption.findMany({ where: { tenantId, planId: plan.id }, orderBy: [{ confirmed: 'desc' }, { packingOptionId: 'asc' }], take: 50 }),
      this.prisma.packingGroup.findMany({ where: { tenantId, planId: plan.id }, orderBy: { packingGroupId: 'asc' }, take: 500 }),
      this.prisma.placementOption.findMany({ where: { tenantId, planId: plan.id }, orderBy: [{ confirmed: 'desc' }, { placementOptionId: 'asc' }], take: 50 }),
      this.prisma.transportOption.findMany({ where: { tenantId, planId: plan.id }, orderBy: [{ shipmentId: 'asc' }, { transportOptionId: 'asc' }], take: 500 }),
      this.prisma.deliveryWindow.findMany({ where: { tenantId, planId: plan.id }, orderBy: [{ shipmentId: 'asc' }, { windowStart: 'asc' }], take: 500 }),
      this.prisma.fbaInboundShipment.findMany({ where: { planId: plan.id }, orderBy: { shipmentId: 'asc' }, take: 100 }),
      this.totalWeightLb(tenantId, plan.id),
    ])
    const estimate = plan.estimateJson ? (plan.estimateJson as PlacementEstimate) : null
    const placementViews: PlacementOptionView[] = placement.map(option => {
      const shipmentViews: PlacementShipmentView[] = (Array.isArray(option.shipmentsJson) ? option.shipmentsJson : []).map(record).map(item => ({
        shipmentId: String(item.shipmentId ?? ''),
        destinationFc: typeof item.destinationFc === 'string' ? item.destinationFc : null,
        units: typeof item.units === 'number' ? item.units : null,
      }))
      const fees = num(option.fees) ?? 0
      const discounts = num(option.discounts) ?? 0
      return {
        placementOptionId: option.placementOptionId,
        status: option.status,
        shipmentCount: option.shipmentCount,
        fees,
        discounts,
        currency: option.currency,
        expiresAt: iso(option.expiresAt),
        confirmed: option.confirmed,
        shipments: shipmentViews,
        cost: placementTotalCost({ fees, discounts, shipments: shipmentViews }, { totalWeightLb, params: estimate }),
        recommended: false,
        cheapestFee: false,
      }
    })
    const recommendation = recommendPlacement(placementViews, now)
    const offered = placementViews.filter(option => option.status === 'OFFERED')
    const cheapest = offered.length ? Math.min(...offered.map(option => option.fees - option.discounts)) : null
    for (const option of placementViews) {
      option.recommended = option.placementOptionId === recommendation.placementOptionId
      option.cheapestFee = option.status === 'OFFERED' && cheapest !== null && option.fees - option.discounts === cheapest
    }
    const confirmedMode = new Map(transport.filter(option => option.confirmed).map(option => [option.shipmentId, shippingModeOf(option.mode)]))
    return {
      packing: packing.map(option => ({
        packingOptionId: option.packingOptionId,
        status: option.status,
        fees: num(option.fees),
        discounts: num(option.discounts),
        currency: option.currency,
        expiresAt: iso(option.expiresAt),
        confirmed: option.confirmed,
        shippingConfigs: Array.isArray(option.configsJson) ? (option.configsJson as string[]) : [],
        groups: groups.filter(group => group.packingOptionId === option.packingOptionId).map(group => ({ packingGroupId: group.packingGroupId, items: asItems(group.itemsJson) })),
      })),
      placement: placementViews,
      recommendation,
      transport: transport.map(option => ({
        shipmentId: option.shipmentId,
        transportOptionId: option.transportOptionId,
        carrier: option.carrier,
        mode: option.mode,
        modeLabel: shippingModeOf(option.mode) ? SHIPPING_MODE_LABEL[shippingModeOf(option.mode)!] : null,
        solution: option.solution,
        cost: num(option.cost),
        currency: option.currency,
        eta: option.etaJson,
        preconditions: Array.isArray(option.preconditionsJson) ? (option.preconditionsJson as string[]) : [],
        voidableUntil: iso(option.voidableUntil),
        expiresAt: iso(option.expiresAt),
        status: option.status,
        confirmed: option.confirmed,
      })),
      windows: windows.map(window => ({
        shipmentId: window.shipmentId,
        deliveryWindowOptionId: window.deliveryWindowOptionId,
        windowStart: window.windowStart.toISOString(),
        windowEnd: window.windowEnd.toISOString(),
        availabilityType: window.availabilityType,
        availabilityExpiresAt: iso(window.availabilityExpiresAt),
        confirmed: window.confirmed,
      })),
      shipments: shipments.map(shipment => ({ shipmentId: shipment.shipmentId, destinationFc: shipment.destinationFc, shippingMode: confirmedMode.get(shipment.shipmentId) ?? null })),
      estimate,
      totalWeightLb,
    }
  }

  async boxes(req: RequestWithContext, id: string): Promise<InboundBoxesResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    const [rows, items, groups] = await Promise.all([
      this.prisma.inboundBox.findMany({ where: { tenantId: context.tenantId, planId: plan.id }, orderBy: { boxId: 'asc' }, take: 1000 }),
      this.prisma.inboundPlanItem.findMany({ where: { tenantId: context.tenantId, planId: plan.id }, select: { sku: true, quantity: true }, orderBy: { sku: 'asc' }, take: 500 }),
      this.groupsOf(plan),
    ])
    const boxes = rows.map(row => ({
      boxId: row.boxId,
      packingGroupId: row.packingGroupId,
      quantity: row.quantity,
      weightLb: num(row.weightLb) ?? 0,
      lengthIn: num(row.lengthIn) ?? 0,
      widthIn: num(row.widthIn) ?? 0,
      heightIn: num(row.heightIn) ?? 0,
      items: asItems(row.contentJson),
      labelStatus: row.labelStatus,
    }))
    return { boxes, validation: validateBoxes(items, boxes, groups), groups }
  }

  async shipments(req: RequestWithContext, id: string): Promise<{ shipments: InboundShipmentView[] }> {
    const { context, scope } = await this.context.authorizeScoped(req, INBOUND_READ, {})
    const plan = await loadPlan(this.prisma, context.tenantId, scope, id)
    return { shipments: await this.shipmentViews(plan.tenantId, { planId: plan.id }, new Map([[plan.id, plan.shippingMode]])) }
  }

  /** 货件视图（计划页与货件页共用）：件数按明细合计，任何一行没有接收数据时该货件的接收合计为空，不显示不完整的数字。 */
  async shipmentViews(tenantId: string, where: Prisma.FbaInboundShipmentWhereInput, planModes: ReadonlyMap<string, string | null>): Promise<InboundShipmentView[]> {
    const shipments = await this.prisma.fbaInboundShipment.findMany({ where: { AND: [where, { plan: { tenantId } }] }, orderBy: [{ shipmentId: 'asc' }], take: 200 })
    if (shipments.length === 0) return []
    const items = await this.prisma.shipmentItem.findMany({
      where: { tenantId, OR: shipments.map(shipment => ({ planId: shipment.planId, shipmentId: shipment.shipmentId })) },
      orderBy: { sku: 'asc' },
      take: 10_000,
    })
    const transport = await this.prisma.transportOption.findMany({ where: { tenantId, confirmed: true, planId: { in: [...new Set(shipments.map(shipment => shipment.planId))] } }, take: 500 })
    return shipments.map(shipment => {
      const own = items.filter(item => item.planId === shipment.planId && item.shipmentId === shipment.shipmentId)
      const complete = own.length > 0 && own.every(item => item.receivedQty !== null)
      const confirmed = transport.find(option => option.planId === shipment.planId && option.shipmentId === shipment.shipmentId)
      const tracking = record(shipment.trackingJson)
      return {
        id: shipment.id,
        shipmentId: shipment.shipmentId,
        shipmentConfirmationId: shipment.shipmentConfirmationId,
        destinationFc: shipment.destinationFc,
        status: shipment.status,
        boxCount: shipment.boxCount ?? (Array.isArray(tracking.boxIds) ? tracking.boxIds.length : null),
        units: own.length ? own.reduce((sum, item) => sum + item.shippedQty, 0) : shipment.unitsExpected,
        declaredUnits: shipment.unitsExpected > 0 ? shipment.unitsExpected : null,
        receivedUnits: complete ? own.reduce((sum, item) => sum + (item.receivedQty as number), 0) : null,
        discrepancyUnits: complete && shipment.status === 'CLOSED' ? own.reduce((sum, item) => sum + Math.max(0, item.discrepancyQty ?? 0), 0) : null,
        carrier: shipment.carrier ?? confirmed?.carrier ?? null,
        trackingNumber: shipment.trackingNumber,
        shippingMode: shippingModeOf(confirmed?.mode) ?? SHIPPING_MODES.find(mode => mode === planModes.get(shipment.planId)) ?? null,
        receivedFirstAt: iso(shipment.receivedFirstAt),
        receivedDoneAt: iso(shipment.receivedDoneAt),
        items: own.map(item => ({ sku: item.sku, fnsku: item.fnsku, shippedQty: item.shippedQty, receivedQty: item.receivedQty, discrepancyQty: item.discrepancyQty })),
      }
    })
  }
}
