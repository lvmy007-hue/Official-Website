import { AWD_ORDER_STATUSES, AWD_SHIPMENT_STATUSES, awdDeliveryMode, awdPackageUnits, type AwdAddress, type AwdOrderStatus, type AwdPackageInput } from '@nova/api-contracts'
import type { JsonObject } from '../../types'
import { fromAmazonPackages } from './packages'

// 上游仓储（AWD）接口响应的解析（I-08）。只做字段搬运与类型收敛：缺失的字段一律是 null，不补 0——
// “亚马逊没给”和“亚马逊说是 0”在补货计算里含义完全不同（前者是尚未接入，后者是确实没有）。

const record = (value: unknown): JsonObject => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {})
const text = (value: unknown) => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null)
const whole = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null)
const stamp = (value: unknown): Date | null => {
  const t = text(value)
  if (!t) return null
  const date = new Date(t)
  return Number.isNaN(date.getTime()) ? null : date
}
const day = (value: unknown): Date | null => {
  const date = stamp(value)
  return date ? new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())) : null
}
/** 响应偶尔会包一层 payload（与其他卖家接口一致）：两种形状都接受。 */
const root = (body: unknown): JsonObject => {
  const top = record(body)
  return top.payload && typeof top.payload === 'object' ? record(top.payload) : top
}

export interface ParsedAwdInventory {
  sku: string
  onhandQty: number | null
  availableQty: number | null
  reservedForReplenishment: number | null
  inboundToAwdQty: number | null
  outboundToFbaInTransit: number | null
  expiryDate: Date | null
  expirations: Array<{ expiration: string | null; onhandQuantity: number | null }>
}

/** 库存列表的一页；没有 SKU 的行计入 skipped。有效期取“有在库数量”的最早到期日。 */
export function parseAwdInventory(body: unknown): { rows: ParsedAwdInventory[]; nextToken: string | null; skipped: number } {
  const top = root(body)
  const rows: ParsedAwdInventory[] = []
  let skipped = 0
  for (const item of Array.isArray(top.inventory) ? top.inventory : []) {
    const entry = record(item)
    const sku = text(entry.sku)
    if (!sku) {
      skipped += 1
      continue
    }
    const details = record(entry.inventoryDetails)
    const expirations = (Array.isArray(entry.expirationDetails) ? entry.expirationDetails : []).map(raw => {
      const detail = record(raw)
      return { expiration: text(detail.expiration)?.slice(0, 10) ?? null, onhandQuantity: whole(detail.onhandQuantity) }
    })
    const dated = expirations.filter(detail => detail.expiration && (detail.onhandQuantity ?? 0) > 0).map(detail => detail.expiration as string)
    rows.push({
      sku,
      onhandQty: whole(entry.totalOnhandQuantity),
      availableQty: whole(details.availableDistributableQuantity),
      reservedForReplenishment: whole(details.reservedDistributableQuantity),
      inboundToAwdQty: whole(entry.totalInboundQuantity),
      outboundToFbaInTransit: whole(details.replenishmentQuantity),
      expiryDate: dated.length ? day(dated.sort()[0]) : null,
      expirations,
    })
  }
  return { rows, nextToken: text(top.nextToken), skipped }
}

export interface ParsedShipmentSummary {
  shipmentId: string
  orderId: string | null
  updatedAt: Date | null
}

export function parseShipmentSummaries(body: unknown): { summaries: ParsedShipmentSummary[]; nextToken: string | null; skipped: number } {
  const top = root(body)
  const summaries: ParsedShipmentSummary[] = []
  let skipped = 0
  for (const item of Array.isArray(top.shipments) ? top.shipments : []) {
    const entry = record(item)
    const shipmentId = text(entry.shipmentId)
    if (!shipmentId) {
      skipped += 1
      continue
    }
    summaries.push({ shipmentId, orderId: text(entry.orderId), updatedAt: stamp(entry.updatedAt) })
  }
  return { summaries, nextToken: text(top.nextToken), skipped }
}

export interface ParsedShipment {
  shipmentId: string
  orderId: string | null
  externalReferenceId: string | null
  status: string
  carrier: string | null
  trackingNumber: string | null
  destinationRegion: string | null
  destinationAddress: AwdAddress | null
  shipBy: Date | null
  warehouseReferenceId: string | null
  amazonCreatedAt: Date | null
  amazonUpdatedAt: Date | null
  items: Array<{ sku: string; expectedQty: number | null; receivedQty: number | null; unit: string | null }>
}

const addressOf = (value: unknown): AwdAddress | null => {
  const a = record(value)
  const name = text(a.name)
  const addressLine1 = text(a.addressLine1)
  const stateOrRegion = text(a.stateOrRegion)
  const countryCode = text(a.countryCode)
  if (!name || !addressLine1 || !stateOrRegion || !countryCode) return null
  const optional = (key: string) => (text(a[key]) ? { [key]: text(a[key]) as string } : {})
  return { name, addressLine1, stateOrRegion, countryCode, ...optional('addressLine2'), ...optional('city'), ...optional('postalCode'), ...optional('phoneNumber') }
}

/** 单个货件详情（skuQuantities=SHOW）。货件状态不在已知枚举里时记为 UNKNOWN，不丢行。 */
export function parseShipment(body: unknown): { shipment: ParsedShipment | null; skipped: number } {
  const top = root(body)
  const shipmentId = text(top.shipmentId)
  if (!shipmentId) return { shipment: null, skipped: 1 }
  let skipped = 0
  const status = text(top.shipmentStatus)
  const carrier = record(top.carrierCode)
  const items: ParsedShipment['items'] = []
  for (const raw of Array.isArray(top.shipmentSkuQuantities) ? top.shipmentSkuQuantities : []) {
    const entry = record(raw)
    const sku = text(entry.sku)
    if (!sku) {
      skipped += 1
      continue
    }
    const expected = record(entry.expectedQuantity)
    const received = record(entry.receivedQuantity)
    items.push({ sku, expectedQty: whole(expected.quantity), receivedQty: whole(received.quantity), unit: text(expected.unitOfMeasurement) ?? text(received.unitOfMeasurement) })
  }
  return {
    shipment: {
      shipmentId,
      orderId: text(top.orderId),
      externalReferenceId: text(top.externalReferenceId),
      status: status && (AWD_SHIPMENT_STATUSES as readonly string[]).includes(status) ? status : 'UNKNOWN',
      carrier: text(carrier.carrierCodeValue),
      trackingNumber: text(top.trackingId),
      destinationRegion: text(top.destinationRegion),
      destinationAddress: addressOf(top.destinationAddress),
      shipBy: stamp(top.shipBy),
      warehouseReferenceId: text(top.warehouseReferenceId),
      amazonCreatedAt: stamp(top.createdAt),
      amazonUpdatedAt: stamp(top.updatedAt),
      items,
    },
    skipped,
  }
}

export interface ParsedAwdOrder {
  orderId: string
  status: AwdOrderStatus
  externalReferenceId: string | null
  originAddress: AwdAddress | null
  packages: AwdPackageInput[]
  packagesRaw: unknown
  preferredRegion: string | null
  destinationRegion: string | null
  shipmentId: string | null
  expectedUnits: number | null
  deliveryMode: string | null
  amazonCreatedAt: Date | null
  amazonUpdatedAt: Date | null
}

/** 入库订单详情。订单状态不在已知枚举里时返回 null（调用方保持原状态并告警），不猜测。 */
export function parseAwdOrder(body: unknown): { order: ParsedAwdOrder | null; skipped: number; unknownStatus: string | null } {
  const top = root(body)
  const orderId = text(top.orderId)
  const status = text(top.orderStatus)
  if (!orderId) return { order: null, skipped: 1, unknownStatus: null }
  if (!status || !(AWD_ORDER_STATUSES as readonly string[]).includes(status)) return { order: null, skipped: 0, unknownStatus: status ?? '' }
  const { packages, skipped } = fromAmazonPackages(top.packagesToInbound)
  const destination = record(top.destinationDetails)
  return {
    order: {
      orderId,
      status: status as AwdOrderStatus,
      externalReferenceId: text(top.externalReferenceId),
      originAddress: addressOf(top.originAddress),
      packages,
      packagesRaw: top.packagesToInbound ?? null,
      preferredRegion: text(record(top.preferences).destinationRegion),
      destinationRegion: text(destination.destinationRegion),
      shipmentId: text(destination.shipmentId),
      // 有包装解析不了时总件数不完整，宁可不给数字
      expectedUnits: packages.length > 0 && skipped === 0 ? awdPackageUnits(packages) : null,
      deliveryMode: awdDeliveryMode(packages),
      amazonCreatedAt: stamp(top.createdAt),
      amazonUpdatedAt: stamp(top.updatedAt),
    },
    skipped,
    unknownStatus: null,
  }
}
