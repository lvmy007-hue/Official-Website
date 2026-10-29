import { Injectable } from '@nestjs/common'
import { ORDER_DEFAULT_DAYS, ORDERS_PERMISSION, OrderListQuerySchema, orderFulfillmentLabel, orderStatusLabel, type OrderListResponse, type OrderListRow } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'
import { loadOrderFacts, summarizeOrder, type FactRow } from './orders-facts'
import { buildOrderFilters } from './orders-filters'

export const ORDER_LIST_FRESHNESS_KEYS = ['orders.api', 'finance.transactions', 'rpt.fulfilled-shipments', 'rpt.shipment-replacement'] as const
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

const LIST_SELECT = {
  id: true,
  sellerAccountId: true,
  amazonOrderId: true,
  purchaseDate: true,
  status: true,
  fulfillmentStatus: true,
  amount: true,
  currency: true,
  earliestDelivery: true,
  latestDelivery: true,
  isReplacement: true,
  replacedOrderId: true,
  replacementReason: true,
  sellerAccount: { select: { displayName: true } },
  items: { select: { quantityOrdered: true } },
  packages: { select: { carrier: true, trackingNumber: true }, orderBy: { shipDate: 'asc' } },
} satisfies Prisma.OrderSelect

// 订单列表（07 章 7.1）：游标分页，只看亚马逊物流订单的数据；默认只看最近 30 天，避免没有时间范围时扫全表。
// 每页订单的退款、结算、退货、风险一次装配（orders-facts）；净收益是异步列，走 POST /orders/net-income（orders-net-income.service），列表响应里没有。
@Injectable()
export class OrdersListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<OrderListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ORDERS_PERMISSION, rawQuery)
    const query = OrderListQuerySchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? todayIn(zone)
    const from = query.from ?? addDays(to, 1 - ORDER_DEFAULT_DAYS)
    const sort = { field: 'purchaseDate', dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)

    const filters = await buildOrderFilters(this.prisma, { tenantId: context.tenantId, scope, query, from: zonedDayStart(from, zone), to: zonedDayStart(addDays(to, 1), zone) })
    const [rows, freshness] = await Promise.all([
      this.prisma.order.findMany({
        where: { AND: [filters.where, this.cursor.after(query.cursor, sort, binding) as Prisma.OrderWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: LIST_SELECT,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, ORDER_LIST_FRESHNESS_KEYS),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const factRows: FactRow[] = page.items.map(row => ({ ...row, amount: num(row.amount) }))
    const facts = await loadOrderFacts(this.prisma, context.tenantId, factRows)
    const items = page.items.map((row, index): OrderListRow => {
      const summary = summarizeOrder(factRows[index], facts)
      const carriers = [...new Set(row.packages.map(pack => pack.carrier).filter(Boolean))]
      const trackings = row.packages.map(pack => pack.trackingNumber).filter(Boolean)
      return {
        id: row.id,
        amazonOrderId: row.amazonOrderId,
        purchaseDate: row.purchaseDate.toISOString(),
        sellerAccountId: row.sellerAccountId,
        storeName: row.sellerAccount.displayName,
        amount: num(row.amount),
        currency: row.currency,
        units: row.items.length > 0 ? row.items.reduce((total, item) => total + item.quantityOrdered, 0) : null,
        status: row.status,
        statusLabel: orderStatusLabel(row.status),
        fulfillmentStatus: row.fulfillmentStatus,
        fulfillmentLabel: orderFulfillmentLabel(row.fulfillmentStatus),
        earliestDelivery: row.earliestDelivery?.toISOString() ?? null,
        latestDelivery: row.latestDelivery?.toISOString() ?? null,
        carrier: carriers.length > 0 ? carriers.join('、') : null,
        trackingNumber: trackings[0] ?? null,
        trackingCount: trackings.length,
        refund: summary.refund,
        returnCount: summary.returnCount,
        isReplacement: row.isReplacement,
        settlement: summary.settlement,
        risks: summary.risks.map(risk => risk.kind),
      }
    })
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : emptyNote(query),
      items,
      pageInfo: page.pageInfo,
      range: { from, to, defaulted },
      filterLimited: filters.limited,
      freshness,
    }
  }
}

function emptyNote(query: ReturnType<typeof OrderListQuerySchema.parse>) {
  const filtered = Object.entries(query).some(
    ([key, value]) => !['pageSize', 'sort', 'cursor', 'from', 'to', 'compare', 'displayCurrency', 'marketplaceId', 'storeIds', 'legalEntityIds'].includes(key) && value !== undefined,
  )
  return filtered ? '没有符合条件的订单；可以放宽筛选条件或扩大下单日期范围' : '所选日期范围内尚无订单记录；店铺授权并完成订单同步后显示（订单每 15 分钟补偿同步一次）'
}
