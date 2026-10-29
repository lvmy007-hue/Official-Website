import { shippingModeOf, type ShippingMode } from '@nova/api-contracts'
import type { JsonObject } from '../../types'

// Fulfillment Inbound v2024-03-20 响应解析（P2a-12，importers.md I-06、I-07）：纯函数，不碰数据库。
// 没给的字段是 null，不补 0；金额只在币种一致时合计；未知状态原样保留，不猜测。

const object = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})
const list = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(object) : [])
const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const date = (value: unknown): Date | null => {
  const raw = text(value)
  if (!raw) return null
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}
const number = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  return Number.isFinite(parsed) ? parsed : null
}

/** 金额：{ amount, code } 或 { value: { amount, code } }（费用行）。 */
function money(value: unknown): { amount: number; code: string } | null {
  const raw = object(value)
  const inner = raw.value !== undefined && typeof raw.value === 'object' ? object(raw.value) : raw
  const amount = number(inner.amount)
  return amount === null ? null : { amount, code: text(inner.code) ?? 'USD' }
}
/** 多条费用合计；币种不一致或没有任何一条时不合计（null）。 */
export function sumMoney(values: unknown): { amount: number; currency: string } | null {
  const rows = (Array.isArray(values) ? values : []).map(money).filter((row): row is { amount: number; code: string } => row !== null)
  if (rows.length === 0 || new Set(rows.map(row => row.code)).size > 1) return null
  return { amount: Math.round(rows.reduce((sum, row) => sum + row.amount, 0) * 1e6) / 1e6, currency: rows[0].code }
}

export const PLAN_STATUSES = ['ACTIVE', 'VOIDED', 'SHIPPED', 'ERRORED'] as const
export function parsePlan(body: JsonObject) {
  const status = (text(body.status) ?? 'UNKNOWN').toUpperCase()
  return {
    inboundPlanId: text(body.inboundPlanId),
    status,
    shipmentIds: list(body.shipments)
      .map(shipment => text(shipment.shipmentId))
      .filter((id): id is string => id !== null),
  }
}

export interface ParsedPacking {
  packingOptionId: string
  status: string
  fees: number | null
  discounts: number | null
  currency: string
  expiresAt: Date | null
  groupIds: string[]
  configs: string[]
}
export function parsePackingOptions(body: JsonObject): { options: ParsedPacking[]; skipped: number } {
  let skipped = 0
  const options: ParsedPacking[] = []
  for (const row of list(body.packingOptions)) {
    const id = text(row.packingOptionId)
    if (!id) {
      skipped += 1
      continue
    }
    const fees = sumMoney(row.fees)
    const discounts = sumMoney(row.discounts)
    options.push({
      packingOptionId: id,
      status: (text(row.status) ?? 'OFFERED').toUpperCase(),
      fees: fees?.amount ?? null,
      discounts: discounts?.amount ?? null,
      currency: fees?.currency ?? discounts?.currency ?? 'USD',
      expiresAt: date(row.expiration),
      groupIds: (Array.isArray(row.packingGroups) ? row.packingGroups : []).map(text).filter((value): value is string => value !== null),
      configs: (Array.isArray(row.supportedShippingConfigurations) ? row.supportedShippingConfigurations : [])
        .map(item => text(object(item).shippingMode) ?? text(item))
        .filter((value): value is string => value !== null),
    })
  }
  return { options, skipped }
}
export const parseGroupItems = (body: JsonObject) =>
  list(body.items)
    .map(item => ({ sku: text(item.msku), quantity: number(item.quantity) }))
    .filter((item): item is { sku: string; quantity: number } => item.sku !== null && item.quantity !== null && item.quantity > 0)

export interface ParsedPlacement {
  placementOptionId: string
  status: string
  fees: number
  discounts: number
  currency: string
  expiresAt: Date | null
  shipmentIds: string[]
}
export function parsePlacementOptions(body: JsonObject): { options: ParsedPlacement[]; skipped: number } {
  let skipped = 0
  const options: ParsedPlacement[] = []
  for (const row of list(body.placementOptions)) {
    const id = text(row.placementOptionId)
    if (!id) {
      skipped += 1
      continue
    }
    const fees = sumMoney(row.fees)
    const discounts = sumMoney(row.discounts)
    options.push({
      placementOptionId: id,
      status: (text(row.status) ?? 'OFFERED').toUpperCase(),
      // 没有费用行代表没有费用：分仓费为 0 是亚马逊的事实（免费分仓），不是“没数据”
      fees: fees?.amount ?? 0,
      discounts: discounts?.amount ?? 0,
      currency: fees?.currency ?? discounts?.currency ?? 'USD',
      expiresAt: date(row.expiration),
      shipmentIds: (Array.isArray(row.shipmentIds) ? row.shipmentIds : []).map(text).filter((value): value is string => value !== null),
    })
  }
  return { options, skipped }
}

export interface ParsedShipment {
  shipmentId: string
  status: string
  destinationFc: string | null
  confirmationId: string | null
  placementOptionId: string | null
  selectedTransportOptionId: string | null
  selectedWindowId: string | null
  trackingNumber: string | null
  trackingJson: JsonObject | null
}
export function parseShipment(body: JsonObject): ParsedShipment | null {
  const shipmentId = text(body.shipmentId)
  if (!shipmentId) return null
  const tracking = object(body.trackingDetails)
  const spd = list(object(tracking.spdTrackingDetail).spdTrackingItems)
  const ltl = object(tracking.ltlTrackingDetail)
  return {
    shipmentId,
    status: (text(body.status) ?? 'UNKNOWN').toUpperCase(),
    destinationFc: text(object(body.destination).warehouseId),
    confirmationId: text(body.shipmentConfirmationId),
    placementOptionId: text(body.placementOptionId),
    selectedTransportOptionId: text(body.selectedTransportationOptionId),
    selectedWindowId: text(object(body.selectedDeliveryWindow).deliveryWindowOptionId),
    trackingNumber: text(spd[0]?.trackingId) ?? text(ltl.billOfLadingNumber),
    trackingJson: Object.keys(tracking).length ? tracking : null,
  }
}
export const parseBoxIds = (body: JsonObject) =>
  list(body.boxes)
    .map(box => text(box.boxId))
    .filter((id): id is string => id !== null)
export const parseShipmentItems = (body: JsonObject) =>
  list(body.items)
    .map(item => ({ sku: text(item.msku), fnsku: text(item.fnsku), quantity: number(item.quantity) }))
    .filter((item): item is { sku: string; fnsku: string | null; quantity: number } => item.sku !== null && item.quantity !== null && item.quantity >= 0)

export interface ParsedTransport {
  shipmentId: string
  transportOptionId: string
  carrier: string | null
  mode: string | null
  shippingMode: ShippingMode | null
  solution: string | null
  cost: number | null
  currency: string
  eta: unknown
  preconditions: string[]
  voidableUntil: Date | null
  expiresAt: Date | null
}
export function parseTransportOptions(body: JsonObject): ParsedTransport[] {
  const parsed: ParsedTransport[] = []
  for (const row of list(body.transportationOptions)) {
    const shipmentId = text(row.shipmentId)
    const transportOptionId = text(row.transportationOptionId)
    if (!shipmentId || !transportOptionId) continue
    const quote = object(row.quote)
    const cost = money(quote.cost)
    const carrier = object(row.carrier)
    const mode = text(row.shippingMode)
    parsed.push({
      shipmentId,
      transportOptionId,
      carrier: text(carrier.name) ?? text(carrier.alphaCode),
      mode,
      shippingMode: shippingModeOf(mode),
      solution: text(row.shippingSolution),
      cost: cost?.amount ?? null,
      currency: cost?.code ?? 'USD',
      eta: row.carrierAppointment ?? null,
      preconditions: (Array.isArray(row.preconditions) ? row.preconditions : []).map(text).filter((value): value is string => value !== null),
      voidableUntil: date(quote.voidableUntil),
      expiresAt: date(quote.expiration),
    })
  }
  return parsed
}
export const parseWindows = (body: JsonObject) =>
  list(body.deliveryWindowOptions)
    .map(row => ({ optionId: text(row.deliveryWindowOptionId), start: date(row.startDate), end: date(row.endDate), availabilityType: text(row.availabilityType), validUntil: date(row.validUntil) }))
    .filter((row): row is { optionId: string; start: Date; end: Date; availabilityType: string | null; validUntil: Date | null } => row.optionId !== null && row.start !== null && row.end !== null)

/** v0 货件明细：每个 SKU 的发出与接收数量。 */
export function parseReceived(body: JsonObject) {
  const rows = list(object(body.payload ?? body).ItemData ?? body.ItemData)
  return rows
    .map(row => ({ sku: text(row.SellerSKU), shipped: number(row.QuantityShipped), received: number(row.QuantityReceived) }))
    .filter((row): row is { sku: string; shipped: number | null; received: number | null } => row.sku !== null)
}
export function parseEligibility(body: JsonObject) {
  const eligible = body.isEligibleForProgram
  return {
    eligible: typeof eligible === 'boolean' ? eligible : null,
    reasons: (Array.isArray(body.ineligibilityReasonList) ? body.ineligibilityReasonList : []).map(text).filter((value): value is string => value !== null),
  }
}
