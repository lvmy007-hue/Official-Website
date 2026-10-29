import { CUSTOMS_STATUS_LABEL, estimateGap, FIRST_MILE_MODE_LABEL, FIRST_MILE_STAGE_LABEL, firstMileStage, type CustomsStatus, type FirstMileMode, type FirstMileRow } from '@nova/api-contracts'
import { Prisma, type FirstMileShipment } from '@prisma/client'
import { daysBetween, dayText, isoText, moneyText, parseDay } from './first-mile-common'

// 运单行（列表与详情头部共用）。预估与实际费用都带出来，没有字段权限的人由控制器层的字段过滤去掉。

export const SHIPMENT_INCLUDE = {
  forwarder: { select: { name: true } },
  warehouse: { select: { name: true } },
  carrierChannel: { select: { name: true, carrier: { select: { name: true } } } },
  items: { select: { quantity: true } },
  costs: { select: { amount: true, currency: true } },
  _count: { select: { allocations: true } },
} satisfies Prisma.FirstMileShipmentInclude

/** 预估与实际的差异比例（%）：币种不一致（费用明细里有别的币种）、预估或实际没有、预估为 0 都返回 null。 */
export function deviationPctOf(shipment: Pick<ShipmentWithSummary, 'estimatedCost' | 'currency' | 'costs'>): number | null {
  if (shipment.estimatedCost === null || shipment.costs.length === 0) return null
  if (shipment.costs.some(cost => cost.currency !== shipment.currency)) return null
  const actual = shipment.costs.reduce((sum, cost) => sum.plus(cost.amount), new Prisma.Decimal(0))
  return estimateGap(shipment.estimatedCost.toNumber(), actual.toNumber()).pct
}

export type ShipmentWithSummary = Prisma.FirstMileShipmentGetPayload<{ include: typeof SHIPMENT_INCLUDE }>

/** 延误天数：已交付按“实际 − 预计”；未交付且已过预计交付日按“今天 − 预计”；其余为 null。 */
export function delayDaysOf(etaDelivery: string | null, ataDelivery: string | null, today: string): number | null {
  if (!etaDelivery) return null
  if (ataDelivery) return daysBetween(parseDay(etaDelivery), parseDay(ataDelivery))
  return today > etaDelivery ? daysBetween(parseDay(etaDelivery), parseDay(today)) : null
}

export function rowOf(shipment: ShipmentWithSummary, today: string): FirstMileRow {
  const dates = {
    shipDate: dayText(shipment.shipDate),
    etaPort: dayText(shipment.etaPort),
    ataPort: dayText(shipment.ataPort),
    etaDelivery: dayText(shipment.etaDelivery),
    ataDelivery: dayText(shipment.ataDelivery),
  }
  const stage = firstMileStage(dates)
  const actual = shipment.costs.length ? shipment.costs.reduce((sum, cost) => sum.plus(cost.amount), new Prisma.Decimal(0)) : null
  return {
    id: shipment.id,
    forwarderId: shipment.forwarderId,
    forwarderName: shipment.forwarder.name,
    waybillNo: shipment.waybillNo,
    mode: shipment.mode as FirstMileMode,
    modeLabel: FIRST_MILE_MODE_LABEL[shipment.mode as FirstMileMode] ?? shipment.mode,
    containerNo: shipment.containerNo,
    ...dates,
    customsStatus: shipment.customsStatus as CustomsStatus,
    customsLabel: CUSTOMS_STATUS_LABEL[shipment.customsStatus as CustomsStatus] ?? shipment.customsStatus,
    stage,
    stageLabel: FIRST_MILE_STAGE_LABEL[stage],
    delayDays: delayDaysOf(dates.etaDelivery, dates.ataDelivery, today),
    currency: shipment.currency,
    estimatedCost: moneyText(shipment.estimatedCost),
    actualCost: moneyText(actual),
    deviationPct: deviationPctOf(shipment),
    carrierChannelId: shipment.carrierChannelId,
    carrierChannelName: shipment.carrierChannel ? `${shipment.carrierChannel.carrier.name} · ${shipment.carrierChannel.name}` : null,
    estimatedAt: isoText(shipment.estimatedAt),
    linkedInboundShipmentIds: shipment.linkedInboundShipmentIds,
    itemCount: shipment.items.length,
    totalQty: shipment.items.reduce((sum, item) => sum + item.quantity, 0),
    warehouseId: shipment.warehouseId,
    warehouseName: shipment.warehouse?.name ?? null,
    outboundAt: isoText(shipment.outboundAt),
    allocated: shipment._count.allocations > 0,
    version: shipment.version,
  }
}

/** 用于审计的前后快照（不含明细）。 */
export const snapshotOf = (shipment: FirstMileShipment) => ({
  forwarderId: shipment.forwarderId,
  waybillNo: shipment.waybillNo,
  mode: shipment.mode,
  containerNo: shipment.containerNo,
  shipDate: dayText(shipment.shipDate),
  etaPort: dayText(shipment.etaPort),
  ataPort: dayText(shipment.ataPort),
  customsStatus: shipment.customsStatus,
  etaDelivery: dayText(shipment.etaDelivery),
  ataDelivery: dayText(shipment.ataDelivery),
  estimatedCost: moneyText(shipment.estimatedCost),
  carrierChannelId: shipment.carrierChannelId,
  currency: shipment.currency,
  warehouseId: shipment.warehouseId,
  linkedInboundShipmentIds: shipment.linkedInboundShipmentIds,
})
