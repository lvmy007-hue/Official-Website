import { US_MARKETPLACE } from '../../connectors/sp-api-v2'
import type { JsonObject } from '../../types'
import { validDate } from '../shared'
import type { CancelledBy, ChargeKind, OrderSkip, ParsedCancellation, ParsedCharge, ParsedItem, ParsedOrder, ParsedPackage, ParsedPii } from './v2026-types'

// 订单接口新版（v2026-01-01）响应解析。字段对照依据官方《Orders API Migration Guide》的属性映射表。
// 原则：新增字段与未知枚举值不报错，只保留原值；没有的数据保持为空，不用 0 或当前时间代替。

const asRecord = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)
const asArray = (value: unknown): JsonObject[] => (Array.isArray(value) ? value.map(asRecord).filter((item): item is JsonObject => item !== null) : [])
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
export function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
const money = (value: unknown) => {
  const record = asRecord(value)
  const amount = num(record?.amount)
  return amount === undefined ? undefined : { amount, currency: text(record?.currencyCode) ?? 'USD' }
}

// 新版状态 → 旧版风格状态。未知值原样保留（官方会陆续增加状态）。
const LEGACY_STATUS: Record<string, string> = {
  UNSHIPPED: 'Unshipped',
  PARTIALLY_SHIPPED: 'PartiallyShipped',
  SHIPPED: 'Shipped',
  CANCELLED: 'Canceled',
  PENDING: 'Pending',
  UNFULFILLABLE: 'Unfulfillable',
  PENDING_AVAILABILITY: 'PendingAvailability',
  INVOICE_UNCONFIRMED: 'InvoiceUnconfirmed',
}
export const legacyStatusOf = (status: string) => LEGACY_STATUS[status] ?? status

const cancelledByOf = (value: unknown): CancelledBy => {
  const requester = String(value ?? '').toUpperCase()
  if (requester.includes('BUYER') || requester.includes('CUSTOMER')) return 'BUYER'
  if (requester.includes('SELLER') || requester.includes('MERCHANT')) return 'SELLER'
  if (requester.includes('AMAZON')) return 'AMAZON'
  return 'UNKNOWN'
}

const chargeKindOf = (type: string): ChargeKind => {
  if (type === 'ITEM' || type === 'SHIPPING' || type === 'TAX') return type
  if (type === 'DISCOUNT') return 'PROMOTION'
  return type === 'COD_FEE' ? 'FEE' : 'OTHER'
}

// 把一行的收入明细拆成逐项金额，带符号（对收入的影响）：折扣为负；税里“折扣对应的税”为负（官方示例：2.00 + 0.40 − 0.24 = 2.16）。
// 细分项之和与小计对不上时退回小计一行，保证每个订单行的明细合计等于接口给出的合计。
function chargesOf(orderItemId: string, item: JsonObject, fallbackCurrency: string): ParsedCharge[] {
  const charges: ParsedCharge[] = []
  const breakdowns = asArray(asRecord(item.proceeds)?.breakdowns)
  for (const breakdown of breakdowns) {
    const type = text(breakdown.type)
    const subtotal = money(breakdown.subtotal)
    if (!type || !subtotal) continue
    const kind = chargeKindOf(type)
    const currency = subtotal.currency || fallbackCurrency
    const signed = (value: number, subtype?: string) => (type === 'DISCOUNT' ? -Math.abs(value) : type === 'TAX' && subtype === 'DISCOUNT' ? -Math.abs(value) : value)
    const expected = type === 'DISCOUNT' ? -Math.abs(subtotal.amount) : subtotal.amount
    const details = asArray(breakdown.detailedBreakdowns)
      .map(detail => ({ subtype: text(detail.subtype) ?? '', value: money(detail.value) }))
      .filter((detail): detail is { subtype: string; value: { amount: number; currency: string } } => detail.value !== undefined && detail.subtype !== '')
    const detailTotal = details.reduce((sum, detail) => sum + signed(detail.value.amount, detail.subtype), 0)
    const expand = (type === 'TAX' || type === 'DISCOUNT') && details.length > 0 && Math.abs(detailTotal - expected) < 0.005
    if (expand)
      for (const detail of details)
        charges.push({
          orderItemId,
          chargeKind: kind,
          componentKey: `${type}:${detail.subtype}`,
          amount: signed(detail.value.amount, detail.subtype),
          currency,
          ...(kind === 'FEE' ? { feeCategory: type } : {}),
        })
    else charges.push({ orderItemId, chargeKind: kind, componentKey: type, amount: expected, currency, ...(kind === 'FEE' ? { feeCategory: type } : {}) })
  }
  return charges
}

function itemOf(raw: JsonObject, orderId: string, index: number, orderCurrency: string): ParsedItem {
  const product = asRecord(raw.product)
  const orderItemId = text(raw.orderItemId) ?? `${orderId}:${text(product?.sellerSku) ?? text(product?.asin) ?? index}`
  const charges = chargesOf(orderItemId, raw, orderCurrency)
  const sumOf = (kind: ChargeKind, key?: string) => {
    const matching = charges.filter(charge => charge.chargeKind === kind && (key === undefined || charge.componentKey === key))
    return matching.length ? matching.reduce((sum, charge) => sum + charge.amount, 0) : undefined
  }
  const discount = sumOf('PROMOTION')
  return {
    orderItemId,
    asin: text(product?.asin),
    sellerSku: text(product?.sellerSku),
    title: text(product?.title),
    condition: text(asRecord(product?.condition)?.conditionType),
    quantityOrdered: num(raw.quantityOrdered) ?? 0,
    quantityShipped: num(asRecord(raw.fulfillment)?.quantityFulfilled) ?? 0,
    itemPrice: sumOf('ITEM', 'ITEM'),
    promotionDiscount: discount === undefined ? undefined : Math.abs(discount),
    taxAmount: sumOf('TAX'),
    currency: charges[0]?.currency ?? orderCurrency,
    itemStatus: text(asRecord(raw.fulfillment)?.status),
    charges,
  }
}

function packagesOf(raw: unknown): ParsedPackage[] {
  return asArray(raw).map((entry, index) => {
    const status = asRecord(entry.packageStatus)
    return {
      packageId: text(entry.packageReferenceId) ?? String(index),
      carrier: text(entry.carrier) ?? '',
      trackingNumber: text(entry.trackingNumber) ?? '',
      shippingService: text(entry.shippingService),
      packageStatus: text(status?.status),
      shipDate: validDate(entry.shipTime) ?? undefined,
    }
  })
}

function piiOf(order: JsonObject): ParsedPii | undefined {
  const buyer = asRecord(order.buyer)
  const recipient = asRecord(order.recipient)
  const address = asRecord(recipient?.deliveryAddress)
  const pii: ParsedPii = {
    buyerName: text(buyer?.buyerName) ?? text(address?.name),
    buyerEmail: text(buyer?.buyerEmail),
    buyerPhone: text(address?.phone),
    addressLine1: text(address?.addressLine1),
    city: text(address?.city),
    state: text(address?.stateOrRegion),
    postalCode: text(address?.postalCode),
    country: text(address?.countryCode),
  }
  return Object.values(pii).some(Boolean) ? pii : undefined
}

function cancellationOf(items: JsonObject[], fulfillmentStatus: string, lastUpdated: Date): ParsedCancellation | undefined {
  const cancelled = fulfillmentStatus === 'CANCELLED'
  const entry = items.map(item => asRecord(item.cancellation)).find(record => record !== null)
  if (!cancelled && !entry) return undefined
  return { cancelledBy: cancelledByOf(entry?.requester), reasonCode: text(entry?.cancelReason) ?? '', ...(cancelled ? { cancelledAt: lastUpdated } : {}) }
}

/** 解析一条订单。缺订单号、缺下单时间（分区列，不能用当前时间兜底）、非美国站的订单返回跳过原因，由调用方计数告警。 */
export function parseOrder(raw: JsonObject): ParsedOrder | OrderSkip {
  const amazonOrderId = text(raw.orderId)
  if (!amazonOrderId) return { skipped: 'NO_ORDER_ID' }
  const purchaseDate = validDate(raw.createdTime)
  if (!purchaseDate) return { skipped: 'NO_PURCHASE_DATE' }
  const marketplaceId = text(asRecord(raw.salesChannel)?.marketplaceId) ?? US_MARKETPLACE
  if (marketplaceId !== US_MARKETPLACE) return { skipped: 'NOT_US_MARKETPLACE' }

  const fulfillment = asRecord(raw.fulfillment)
  const fulfillmentStatus = text(fulfillment?.fulfillmentStatus) ?? 'UNKNOWN'
  const lastUpdated = validDate(raw.lastUpdatedTime) ?? purchaseDate
  const total = money(asRecord(raw.proceeds)?.grandTotal)
  const currency = total?.currency ?? 'USD'
  const associated = asArray(raw.associatedOrders).find(entry => ['REPLACEMENT_ORIGINAL_ID', 'EXCHANGE_ORIGINAL_ID'].includes(String(entry.associationType)))
  const rawItems = asArray(raw.orderItems)
  const packages = packagesOf(raw.packages)
  const fulfilledBy = text(fulfillment?.fulfilledBy)
  const status = legacyStatusOf(fulfillmentStatus)
  const earliestShip = packages
    .map(pack => pack.shipDate)
    .filter((date): date is Date => !!date)
    .sort((a, b) => a.getTime() - b.getTime())[0]

  return {
    amazonOrderId,
    purchaseDate,
    lastUpdated,
    marketplaceId,
    fulfillmentStatus,
    status,
    fulfillment: fulfilledBy === 'AMAZON' ? 'AFN' : fulfilledBy === 'MERCHANT' ? 'MFN' : undefined,
    currency,
    amount: total?.amount,
    latestShipDate: validDate(asRecord(fulfillment?.shipByWindow)?.latestDateTime) ?? undefined,
    earliestDelivery: validDate(asRecord(fulfillment?.deliverByWindow)?.earliestDateTime) ?? undefined,
    latestDelivery: validDate(asRecord(fulfillment?.deliverByWindow)?.latestDateTime) ?? undefined,
    isReplacement: !!associated,
    replacedOrderId: text(associated?.orderId),
    programs: Array.isArray(raw.programs) ? raw.programs.map(String) : [],
    salesChannel: text(asRecord(raw.salesChannel)?.channelName),
    cancellation: cancellationOf(rawItems, fulfillmentStatus, lastUpdated),
    shippedAt: status === 'Shipped' || status === 'PartiallyShipped' ? (earliestShip ?? (status === 'Shipped' ? lastUpdated : undefined)) : undefined,
    items: rawItems.map((item, index) => itemOf(item, amazonOrderId, index, currency)),
    packages,
    pii: piiOf(raw),
  }
}
