import { Injectable } from '@nestjs/common'
import {
  EligibleQuerySchema,
  REVIEWS_LIMITS,
  REVIEWS_READ,
  eligibleDeliveredRange,
  solicitationWindowOf,
  type EligibleOrderRow,
  type EligibleQuery,
  type ReviewStoreRef,
  type SolicitTabResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { assertStoreInScope, ContextService } from '../auth'
import { decodeOffset, chunk, keyOf, pageOf, storesOf, textCompare } from './reviews-common'
import { deliveredOrders } from './reviews-delivery'

export type EligiblePage = Pick<SolicitTabResponse, 'items' | 'pageInfo' | 'truncated'>
export interface EligibleScan {
  rows: EligibleOrderRow[]
  truncated: boolean
}

const CANCELLED_STATUS = 'Canceled'
const CANCELLED_FULFILLMENT = 'CANCELLED'
const ID_CHUNK = 2000

/**
 * 可请求评价的订单（05 章 5.7）：非取消订单、全部包裹都已送达、最晚送达时间在送达后第 5 至 30 天内，
 * 还没有请求记录（上次发送失败的可以再次请求，lastStatus 为 FAILED）。读订单只读订单号、下单日期、ASIN 与包裹送达时间，不读买家信息。
 */
@Injectable()
export class ReviewsEligibleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 范围内全部可请求订单（最多扫描 eligibleScanMax 个订单）；排序与分页由调用方做。 */
  async scan(tenantId: string, stores: readonly ReviewStoreRef[], now: Date): Promise<EligibleScan> {
    const storeIds = stores.map(store => store.id)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const delivered = await deliveredOrders(this.prisma, tenantId, storeIds, eligibleDeliveredRange(now), REVIEWS_LIMITS.eligibleScanMax)
    if (delivered.rows.length === 0) return { rows: [], truncated: delivered.truncated }
    const times = delivered.rows.map(row => row.purchaseDate.getTime())
    const purchaseRange = { gte: new Date(Math.min(...times)), lte: new Date(Math.max(...times)) }
    const orderIds = delivered.rows.map(row => row.orderId)
    // 订单：只选订单号、下单日期与状态（不选买家信息列）
    const orders = new Map<string, { amazonOrderId: string; purchaseDate: Date; cancelled: boolean }>()
    for (const part of chunk(orderIds, ID_CHUNK)) {
      const found = await this.prisma.order.findMany({
        where: { tenantId, sellerAccountId: { in: storeIds }, id: { in: part }, purchaseDate: purchaseRange },
        select: { id: true, sellerAccountId: true, amazonOrderId: true, purchaseDate: true, status: true, fulfillmentStatus: true },
        take: ID_CHUNK,
      })
      for (const order of found) {
        const cancelled = order.status === CANCELLED_STATUS || order.fulfillmentStatus === CANCELLED_FULFILLMENT
        orders.set(keyOf(order.sellerAccountId, order.id), { amazonOrderId: order.amazonOrderId, purchaseDate: order.purchaseDate, cancelled })
      }
    }
    const asins = new Map<string, Set<string>>()
    for (const part of chunk(orderIds, ID_CHUNK)) {
      const items = await this.prisma.orderItem.findMany({
        where: { tenantId, sellerAccountId: { in: storeIds }, orderId: { in: part }, orderPurchaseDate: purchaseRange, asin: { not: null } },
        select: { sellerAccountId: true, orderId: true, asin: true },
        take: 19_999,
      })
      for (const item of items) {
        const key = keyOf(item.sellerAccountId, item.orderId)
        asins.set(key, (asins.get(key) ?? new Set()).add(item.asin as string))
      }
    }
    // 已有请求记录的订单（失败的除外）不再可请求
    const requests = new Map<string, string>()
    const amazonIds = [...orders.values()].map(order => order.amazonOrderId)
    for (const part of chunk(amazonIds, ID_CHUNK)) {
      const found = await this.prisma.solicitationRequest.findMany({
        where: { tenantId, sellerAccountId: { in: storeIds }, amazonOrderId: { in: part } },
        select: { sellerAccountId: true, amazonOrderId: true, status: true },
        take: ID_CHUNK,
      })
      for (const request of found) requests.set(keyOf(request.sellerAccountId, request.amazonOrderId), request.status)
    }
    const rows: EligibleOrderRow[] = []
    for (const row of delivered.rows) {
      const order = orders.get(keyOf(row.storeId, row.orderId))
      if (!order || order.cancelled) continue
      const status = requests.get(keyOf(row.storeId, order.amazonOrderId))
      if (status !== undefined && status !== 'FAILED') continue
      const window = solicitationWindowOf(row.deliveredAt, now)
      if (window.state !== 'OPEN' || window.daysLeft === null) continue
      rows.push({
        storeId: row.storeId,
        storeName: names.get(row.storeId) ?? '',
        amazonOrderId: order.amazonOrderId,
        purchaseDate: order.purchaseDate.toISOString(),
        deliveredAt: row.deliveredAt.toISOString(),
        dayAfterDelivery: window.daysSince,
        daysLeft: window.daysLeft,
        asins: [...(asins.get(keyOf(row.storeId, row.orderId)) ?? [])].sort(textCompare),
        lastStatus: status === 'FAILED' ? 'FAILED' : null,
      })
    }
    return { rows, truncated: delivered.truncated }
  }

  /** 过滤（订单号或 ASIN）、排序、取一页。 */
  pageOfRows(tenantId: string, rows: readonly EligibleOrderRow[], query: EligibleQuery): Omit<EligiblePage, 'truncated'> {
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const needle = query.q?.trim().toLowerCase()
    const matched = needle ? rows.filter(row => row.amazonOrderId.toLowerCase().includes(needle) || row.asins.some(asin => asin.toLowerCase().includes(needle))) : [...rows]
    const sign = query.sort.dir === 'desc' ? -1 : 1
    const value = (row: EligibleOrderRow): string => (query.sort.field === 'purchaseDate' ? row.purchaseDate : row.deliveredAt)
    matched.sort((a, b) => sign * textCompare(value(a), value(b)) || textCompare(a.amazonOrderId, b.amazonOrderId) || textCompare(a.storeId, b.storeId))
    const { page, pageInfo } = pageOf(matched, offset, query.pageSize, binding)
    return { items: page, pageInfo }
  }

  /** GET /reviews/solicitations/eligible */
  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<EligiblePage> {
    const { context, scope } = await this.context.authorizeScoped(req, REVIEWS_READ, rawQuery)
    const query = EligibleQuerySchema.parse(rawQuery)
    if (query.storeId) assertStoreInScope(scope, query.storeId)
    const stores = (await storesOf(this.prisma, context.tenantId, scope)).filter(store => !query.storeId || store.id === query.storeId)
    const scanned = await this.scan(context.tenantId, stores, now)
    return { ...this.pageOfRows(context.tenantId, scanned.rows, query), truncated: scanned.truncated }
  }
}
