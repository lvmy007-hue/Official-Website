import { Injectable } from '@nestjs/common'
import {
  cancelledByLabel,
  orderFulfillmentLabel,
  orderStatusLabel,
  type BuyerInfoState,
  type OrderIdentityResponse,
  type OrderItemsResponse,
  type OrderPackagesResponse,
  type OrderTimelineResponse,
} from '@nova/api-contracts'
import { canSeeField } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { OrderAccessService, type OrderHeader } from './orders-access.service'
import { loadOrderFacts, summarizeOrder, type FactRow } from './orders-facts'
import { ORDER_LIST_FRESHNESS_KEYS } from './orders-list.service'
import { buildTimeline, promiseBasis } from './orders-detail-math'

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
export const factRowOf = (order: OrderHeader): FactRow => ({ ...order, amount: num(order.amount) })

// 订单详情：身份区与概览、订单行、履约与包裹、时间线（07 章 7.1）。退款、财务、买家信息在别的服务里。
@Injectable()
export class OrdersDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: OrderAccessService,
  ) {}

  async identity(req: RequestWithContext, id: string): Promise<OrderIdentityResponse> {
    const { context, scope, order } = await this.access.resolve(req, id)
    const key = { orderId: order.id, orderPurchaseDate: order.purchaseDate }
    const [facts, items, packages, piiCount, cancellation, freshness] = await Promise.all([
      loadOrderFacts(this.prisma, context.tenantId, [factRowOf(order)]),
      this.prisma.orderItem.findMany({ where: { tenantId: context.tenantId, ...key }, select: { quantityOrdered: true }, take: 500 }),
      this.prisma.orderPackage.findMany({ where: { tenantId: context.tenantId, ...key }, select: { carrier: true, shippingService: true, shipDate: true }, take: 100 }),
      this.prisma.order.count({ where: { id: order.id, purchaseDate: order.purchaseDate, tenantId: context.tenantId, piiCiphertext: { not: null } } }),
      this.prisma.orderCancellation.findFirst({ where: { tenantId: context.tenantId, ...key }, select: { cancelledAt: true } }),
      sourceFreshness(this.prisma, context.tenantId, scope, ORDER_LIST_FRESHNESS_KEYS),
    ])
    const summary = summarizeOrder(factRowOf(order), facts)
    const shipDates = packages.flatMap(pack => (pack.shipDate ? [pack.shipDate] : [])).sort((a, b) => a.getTime() - b.getTime())
    const allowed = canSeeField(context.permissions, 'buyer')
    return {
      order: {
        id: order.id,
        amazonOrderId: order.amazonOrderId,
        sellerAccountId: order.sellerAccountId,
        storeName: order.sellerAccount.displayName,
        marketplaceId: order.marketplaceId,
        salesChannel: order.salesChannel,
        programs: order.programs,
        purchaseDate: order.purchaseDate.toISOString(),
        status: order.status,
        statusLabel: orderStatusLabel(order.status),
        fulfillmentStatus: order.fulfillmentStatus,
        fulfillmentLabel: orderFulfillmentLabel(order.fulfillmentStatus),
        fulfillmentNetwork: order.fulfillment === 'AFN' || order.fulfillment === 'MFN' ? order.fulfillment : null,
        amount: num(order.amount),
        currency: order.currency,
        units: items.length > 0 ? items.reduce((total, item) => total + item.quantityOrdered, 0) : null,
        lineCount: items.length,
        isReplacement: order.isReplacement,
        replacedOrderId: order.replacedOrderId,
        replacementReason: order.replacementReason,
      },
      settlement: summary.settlement,
      refund: summary.refund,
      returnCount: summary.returnCount,
      risks: summary.risks.map(risk => risk.kind),
      ...(canSeeField(context.permissions, 'profit') ? { netIncome: { ...summary.netIncome, currency: summary.currency } } : {}),
      overview: {
        promise: {
          latestShipDate: order.latestShipDate?.toISOString() ?? null,
          earliestDelivery: order.earliestDelivery?.toISOString() ?? null,
          latestDelivery: order.latestDelivery?.toISOString() ?? null,
        },
        basis: promiseBasis(packages),
        keyTimes: [
          { key: 'purchase', label: '下单', at: order.purchaseDate.toISOString() },
          { key: 'latestShip', label: '最晚发货', at: order.latestShipDate?.toISOString() ?? null },
          { key: 'shipped', label: '发货', at: (order.shippedAt ?? shipDates[0])?.toISOString() ?? null },
          { key: 'earliestDelivery', label: '最早送达', at: order.earliestDelivery?.toISOString() ?? null },
          { key: 'latestDelivery', label: '最晚送达', at: order.latestDelivery?.toISOString() ?? null },
          { key: 'cancelled', label: '取消', at: cancellation?.cancelledAt?.toISOString() ?? null },
        ],
      },
      buyerInfo: {
        access: allowed ? 'ALLOWED' : 'RESTRICTED',
        state: allowed ? buyerState(piiCount > 0, order.piiExpiresAt) : 'NOT_SYNCED',
        expiresAt: allowed ? (order.piiExpiresAt?.toISOString() ?? null) : null,
      },
      freshness,
    }
  }

  async items(req: RequestWithContext, id: string): Promise<OrderItemsResponse> {
    const { context, order } = await this.access.resolve(req, id)
    const key = { orderId: order.id, orderPurchaseDate: order.purchaseDate }
    const [rows, cancellation] = await Promise.all([
      this.prisma.orderItem.findMany({ where: { tenantId: context.tenantId, ...key }, orderBy: { orderItemId: 'asc' }, take: 500 }),
      this.prisma.orderCancellation.findFirst({ where: { tenantId: context.tenantId, ...key } }),
    ])
    const skus = [...new Set(rows.flatMap(row => (row.sellerSku ? [row.sellerSku] : [])))]
    const products = skus.length
      ? await this.prisma.fbaProduct.findMany({
          where: { tenantId: context.tenantId, sellerAccountId: order.sellerAccountId, sellerSku: { in: skus } },
          select: { id: true, sellerSku: true },
          take: 500,
        })
      : []
    const productOf = new Map(products.map(product => [product.sellerSku, product.id]))
    return {
      items: rows.map(row => {
        const price = num(row.itemPrice)
        return {
          orderItemId: row.orderItemId,
          asin: row.asin,
          sku: row.sellerSku,
          title: row.title,
          condition: row.condition,
          quantityOrdered: row.quantityOrdered,
          quantityShipped: row.quantityShipped,
          itemPrice: price,
          unitPrice: price !== null && row.quantityOrdered > 0 ? Math.round((price / row.quantityOrdered) * 100) / 100 : null,
          promotionDiscount: num(row.promotionDiscount),
          taxAmount: num(row.taxAmount),
          currency: row.currency,
          itemStatus: row.itemStatus,
          productId: row.sellerSku ? (productOf.get(row.sellerSku) ?? null) : null,
        }
      }),
      cancellation: cancellation
        ? {
            cancelledBy: cancellation.cancelledBy,
            cancelledByLabel: cancelledByLabel(cancellation.cancelledBy),
            reasonCode: cancellation.reasonCode,
            requestedAt: cancellation.requestedAt?.toISOString() ?? null,
            cancelledAt: cancellation.cancelledAt?.toISOString() ?? null,
          }
        : null,
      associatedItems: { state: 'NOT_CONNECTED', note: '关联商品（例如保修）的字段同步器尚未读取，接入后显示' },
    }
  }

  async packages(req: RequestWithContext, id: string): Promise<OrderPackagesResponse> {
    const { context, order } = await this.access.resolve(req, id)
    const rows = await this.prisma.orderPackage.findMany({
      where: { tenantId: context.tenantId, orderId: order.id, orderPurchaseDate: order.purchaseDate },
      orderBy: [{ shipDate: 'asc' }, { packageId: 'asc' }],
      take: 200,
    })
    return {
      packages: rows.map(row => ({
        packageId: row.packageId,
        carrier: row.carrier || null,
        trackingNumber: row.trackingNumber || null,
        shippingService: row.shippingService,
        packageStatus: row.packageStatus,
        shipDate: row.shipDate?.toISOString() ?? null,
        deliveredAt: row.deliveredAt?.toISOString() ?? null,
        fulfillmentCenter: row.fulfillmentCenter,
      })),
      tracking: { state: 'NOT_CONNECTED', note: '逐段物流节点需要追踪接口，尚未接入；这里只显示包裹状态与发货、送达时间' },
    }
  }

  async timeline(req: RequestWithContext, id: string): Promise<OrderTimelineResponse> {
    const { context, order } = await this.access.resolve(req, id)
    const key = { tenantId: context.tenantId, orderId: order.id, orderPurchaseDate: order.purchaseDate }
    const [history, cancellation, packages] = await Promise.all([
      this.prisma.orderStatusHistory.findMany({ where: key, orderBy: { occurredAt: 'asc' }, take: 500 }),
      this.prisma.orderCancellation.findFirst({ where: key }),
      this.prisma.orderPackage.findMany({ where: key, select: { carrier: true, trackingNumber: true, shipDate: true }, take: 200 }),
    ])
    return {
      items: buildTimeline({ purchaseDate: order.purchaseDate, history, cancellation, packages }),
      push: { state: 'NOT_CONNECTED', note: '订单变更推送（ORDER_CHANGE）的接收端按计划暂缓，目前只有接口同步留下的状态变化；接入后推送事件会出现在这里' },
    }
  }
}

function buyerState(hasCiphertext: boolean, expiresAt: Date | null, now = new Date()): BuyerInfoState {
  if (hasCiphertext) return expiresAt && expiresAt.getTime() > now.getTime() ? 'AVAILABLE' : 'EXPIRED'
  return expiresAt ? 'EXPIRED' : 'NOT_SYNCED'
}
