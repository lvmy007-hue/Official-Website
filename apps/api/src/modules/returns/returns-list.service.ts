import { Injectable } from '@nestjs/common'
import {
  RETURN_DEFAULT_DAYS,
  RETURNS_PERMISSION,
  ReturnListQuerySchema,
  returnDispositionView,
  resolveReason,
  returnReceiptState,
  returnReimbursementView,
  type ReturnListQuery,
  type ReturnListResponse,
  type ReturnListRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { keyOf } from '../orders'
import { addDays, todayIn, validZone, zonedDayStart } from '../overview'
import { buildReturnFilters } from './returns-filters'
import { loadReturnContext, refundViewOf } from './returns-facts'
import { ReturnsReasonMapService } from './returns-reason-map.service'

export const RETURN_FRESHNESS_KEYS = ['rpt.customer-returns', 'orders.api', 'finance.transactions'] as const

const LIST_SELECT = {
  id: true,
  sellerAccountId: true,
  amazonOrderId: true,
  returnDate: true,
  asin: true,
  sellerSku: true,
  quantity: true,
  reason: true,
  disposition: true,
  detailedDisposition: true,
  fulfillmentCenterId: true,
  licensePlateNumber: true,
  reportStatus: true,
  reimbursementStatus: true,
  reimbursementCaseId: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.FbaReturnCaseSelect

// 退货列表（07 章 7.2）：游标分页，默认只看最近 90 天（按退货日期）。每页退货一次装配订单与财务交易，退款金额是订单口径。
// 列表里没有买家备注（只在详情里、默认隐藏）。
@Injectable()
export class ReturnsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
    private readonly reasons: ReturnsReasonMapService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnListResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, RETURNS_PERMISSION, rawQuery)
    const query = ReturnListQuerySchema.parse(rawQuery)
    const tenant = await this.prisma.tenant.findFirst({ where: { id: context.tenantId }, select: { timezone: true } })
    const zone = validZone(tenant?.timezone)
    const defaulted = !(query.from && query.to)
    const to = query.to ?? todayIn(zone)
    const from = query.from ?? addDays(to, 1 - RETURN_DEFAULT_DAYS)
    const sort = { field: 'returnDate', dir: query.sort.dir } as const
    const binding = bindingOf(context.tenantId, query)

    const filters = await buildReturnFilters(this.prisma, { tenantId: context.tenantId, scope, query, from: zonedDayStart(from, zone), to: zonedDayStart(addDays(to, 1), zone) })
    const [rows, freshness, overrides] = await Promise.all([
      this.prisma.fbaReturnCase.findMany({
        where: { AND: [filters.where, this.cursor.after(query.cursor, sort, binding) as Prisma.FbaReturnCaseWhereInput] },
        orderBy: this.cursor.orderBy(sort),
        take: query.pageSize + 1,
        select: LIST_SELECT,
      }),
      sourceFreshness(this.prisma, context.tenantId, scope, RETURN_FRESHNESS_KEYS),
      this.reasons.index(context.tenantId),
    ])
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const facts = await loadReturnContext(this.prisma, context.tenantId, page.items)
    const items = page.items.map((row): ReturnListRow => {
      const order = facts.orders.get(keyOf(row.sellerAccountId, row.amazonOrderId))
      const refund = refundViewOf(facts, row.sellerAccountId, row.amazonOrderId)
      const reason = row.reason?.trim() ? resolveReason(row.reason, overrides) : null
      return {
        id: row.id,
        amazonOrderId: row.amazonOrderId,
        orderId: order?.id ?? null,
        returnDate: row.returnDate.toISOString(),
        sellerAccountId: row.sellerAccountId,
        storeName: row.sellerAccount.displayName,
        asin: row.asin,
        sku: row.sellerSku,
        quantity: row.quantity,
        reason: row.reason,
        reasonLabel: reason?.label ?? null,
        reasonCategory: reason?.category ?? null,
        disposition: returnDispositionView(row.detailedDisposition, row.disposition),
        fulfillmentCenterId: row.fulfillmentCenterId,
        licensePlateNumber: row.licensePlateNumber || null,
        refund: { state: refund.state, amount: refund.amount, firstRefundAt: refund.firstRefundAt },
        receipt: returnReceiptState(refund, refund.firstRefundAt, row.returnDate),
        currency: order?.currency ?? refund.currency,
        reimbursement: returnReimbursementView(row),
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

const NOT_FILTERS = ['pageSize', 'sort', 'cursor', 'from', 'to', 'compare', 'compareFrom', 'compareTo', 'displayCurrency', 'marketplaceId', 'storeIds', 'legalEntityIds']

function emptyNote(query: ReturnListQuery) {
  const filtered = Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)
  return filtered ? '没有符合条件的退货记录；可以放宽筛选条件或扩大退货日期范围' : '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）'
}
