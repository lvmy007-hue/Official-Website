import { Injectable } from '@nestjs/common'
import {
  RETURN_AWAITING_DAYS,
  RETURN_AWAITING_LOOKBACK_DAYS,
  RETURN_AWAITING_MAX_ROWS,
  RETURNS_PERMISSION,
  ScopeQuerySchema,
  daysSince,
  type ReturnAwaitingResponse,
  type ReturnAwaitingRow,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { ID_SET_LIMIT, keyOf } from '../orders'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'
import { loadReturnContext, refundViewOf } from './returns-facts'
import { RETURN_FRESHNESS_KEYS } from './returns-list.service'

const DAY_MS = 86_400_000
/** 最多对多少个候选订单装配退款金额（再从中取前 RETURN_AWAITING_MAX_ROWS 个真有退款的）。 */
const CANDIDATE_LIMIT = 300

const BASIS =
  `口径：订单第一笔退款入账已满 ${RETURN_AWAITING_DAYS} 天，而且这个订单在客户退货报告里没有任何退货记录。` +
  '退款不等于一定要退货（部分退款客户可以保留商品、卖家也可能设置了免退货退款），所以这是待核实清单，不是赔付结论；赔付机会的正式识别在赔付中心（P2b-03）。'

// 退款后未收到退货的待核实清单（07 章 7.2 “退款后是否已收到退货”，也是 7.3 第 4 类赔付机会的线索）。
// 按退款入账早到晚排（越早越该先核实），最多显示 200 行；退款交易、候选订单触到上限时标记“可能不完整”。
@Injectable()
export class ReturnsAwaitingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async awaiting(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ReturnAwaitingResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, RETURNS_PERMISSION, rawQuery)
    const query = ScopeQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? todayIn(zone, now)
    const from = query.from ?? addDays(to, 1 - RETURN_AWAITING_LOOKBACK_DAYS)
    const matured = new Date(now.getTime() - RETURN_AWAITING_DAYS * DAY_MS)
    const end = new Date(Math.min(zonedDayStart(addDays(to, 1), zone).getTime(), matured.getTime()))
    const store = storeWhere(scope)

    const [refunds, freshness] = await Promise.all([
      this.prisma.fbaFinancialTransaction.findMany({
        where: { tenantId, ...store, transactionType: { contains: 'refund', mode: 'insensitive' }, amazonOrderId: { not: null }, postedAt: { gte: zonedDayStart(from, zone), lt: end } },
        select: { sellerAccountId: true, amazonOrderId: true, postedAt: true },
        orderBy: { postedAt: 'asc' },
        take: ID_SET_LIMIT,
      }),
      sourceFreshness(this.prisma, tenantId, scope, RETURN_FRESHNESS_KEYS),
    ])
    const first = new Map<string, { sellerAccountId: string; amazonOrderId: string; firstRefundAt: Date }>()
    for (const refund of refunds) {
      if (!refund.amazonOrderId) continue
      const key = keyOf(refund.sellerAccountId, refund.amazonOrderId)
      if (!first.has(key)) first.set(key, { sellerAccountId: refund.sellerAccountId, amazonOrderId: refund.amazonOrderId, firstRefundAt: refund.postedAt })
    }
    const base = { thresholdDays: RETURN_AWAITING_DAYS, range: { from, to, defaulted }, basis: BASIS, freshness }
    if (first.size === 0) return { ...base, state: 'NO_DATA', note: '所选范围内尚无满足天数的退款交易记录（财务交易每日同步一次）', items: [], truncated: false }

    const returned = await this.prisma.fbaReturnCase.findMany({
      where: { tenantId, ...store, amazonOrderId: { in: [...new Set([...first.values()].map(item => item.amazonOrderId))] } },
      select: { sellerAccountId: true, amazonOrderId: true },
      distinct: ['sellerAccountId', 'amazonOrderId'],
      take: 20_000,
    })
    const hasReturn = new Set(returned.map(row => keyOf(row.sellerAccountId, row.amazonOrderId)))
    const candidates = [...first.entries()].filter(([key]) => !hasReturn.has(key)).map(([, value]) => value)
    const picked = candidates.slice(0, CANDIDATE_LIMIT)
    const ctx = await loadReturnContext(
      this.prisma,
      tenantId,
      picked.map(item => ({ sellerAccountId: item.sellerAccountId, amazonOrderId: item.amazonOrderId, returnDate: item.firstRefundAt })),
    )
    const real = picked.map(item => ({ item, refund: refundViewOf(ctx, item.sellerAccountId, item.amazonOrderId) })).filter(({ refund }) => refund.state === 'PARTIAL' || refund.state === 'FULL')
    const shown = real.slice(0, RETURN_AWAITING_MAX_ROWS)
    const [stores, items] = await Promise.all([
      this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: [...new Set(shown.map(({ item }) => item.sellerAccountId))] } }, select: { id: true, displayName: true }, take: 500 }),
      this.itemsOf(
        tenantId,
        shown.flatMap(({ item }) => {
          const order = ctx.orders.get(keyOf(item.sellerAccountId, item.amazonOrderId))
          return order ? [{ id: order.id, purchaseDate: order.purchaseDate }] : []
        }),
      ),
    ])
    const storeName = new Map(stores.map(row => [row.id, row.displayName]))
    const rows = shown.map(({ item, refund }): ReturnAwaitingRow => {
      const order = ctx.orders.get(keyOf(item.sellerAccountId, item.amazonOrderId))
      return {
        amazonOrderId: item.amazonOrderId,
        orderId: order?.id ?? null,
        storeName: storeName.get(item.sellerAccountId) ?? '',
        sellerAccountId: item.sellerAccountId,
        firstRefundAt: item.firstRefundAt.toISOString(),
        refundAmount: refund.amount,
        currency: order?.currency ?? refund.currency,
        daysSinceRefund: daysSince(item.firstRefundAt, now),
        items: order ? (items.get(order.id) ?? []) : [],
      }
    })
    return {
      ...base,
      state: rows.length > 0 ? 'OK' : 'NO_DATA',
      note: rows.length > 0 ? null : `所选范围内没有“退款已满 ${RETURN_AWAITING_DAYS} 天仍无退货记录”的订单`,
      items: rows,
      truncated: refunds.length >= ID_SET_LIMIT || candidates.length > CANDIDATE_LIMIT || real.length > RETURN_AWAITING_MAX_ROWS,
    }
  }

  /** 订单行（ASIN、SKU、数量），按订单编号归组。 */
  private async itemsOf(tenantId: string, orders: ReadonlyArray<{ id: string; purchaseDate: Date }>) {
    const out = new Map<string, ReturnAwaitingRow['items']>()
    if (orders.length === 0) return out
    const earliest = new Date(Math.min(...orders.map(order => order.purchaseDate.getTime())))
    const rows = await this.prisma.orderItem.findMany({
      where: { tenantId, orderId: { in: orders.map(order => order.id) }, orderPurchaseDate: { gte: earliest } },
      select: { orderId: true, asin: true, sellerSku: true, quantityOrdered: true },
      take: 2000,
    })
    for (const row of rows) {
      const list = out.get(row.orderId) ?? []
      if (list.length < 5) list.push({ asin: row.asin, sku: row.sellerSku, quantity: row.quantityOrdered })
      out.set(row.orderId, list)
    }
    return out
  }
}
