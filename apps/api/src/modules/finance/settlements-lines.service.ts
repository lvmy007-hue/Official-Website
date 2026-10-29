import { Injectable } from '@nestjs/common'
import {
  SETTLEMENT_PENDING_LABEL,
  SETTLEMENT_READ,
  SettlementExceptionsQuerySchema,
  SettlementLinesQuerySchema,
  type SettlementExceptionsResponse,
  type SettlementLinesResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { EXCEPTION_SELECT, LINE_SELECT, exceptionRow, existingOrders, findSettlement, lineRow, num } from './settlements-common'

const NOT_FILTERS = ['pageSize', 'sort', 'cursor']
const filtered = (query: object) => Object.entries(query).some(([key, value]) => !NOT_FILTERS.includes(key) && value !== undefined)
const money = (value: number) => value.toFixed(2)

// 结算单的交易明细（来自结算报告）与核对异常清单（07 章 7.7）：游标分页。订单链接需要“订单”读取权限，没有时只显示订单号。
@Injectable()
export class SettlementsLinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async lines(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<SettlementLinesResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, {})
    const query = SettlementLinesQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const settlement = await findSettlement(this.prisma, tenantId, scope, id)
    const canViewOrders = hasPermission(context.permissions, 'orders.read')
    // 游标绑定到这张结算单：拿别的结算单的游标来翻页会被拒绝
    const binding = bindingOf(tenantId, { ...query, settlementId: settlement.id })
    const rows = await this.prisma.settlementLine.findMany({
      where: {
        AND: [{ tenantId, settlementId: settlement.id }, query.category ? { category: query.category } : {}, this.cursor.after(query.cursor, query.sort, binding) as Prisma.SettlementLineWhereInput],
      },
      orderBy: this.cursor.orderBy(query.sort),
      take: query.pageSize + 1,
      select: LINE_SELECT,
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const orderIds = page.items.flatMap(row => (row.amazonOrderId ? [row.amazonOrderId] : []))
    const skus = [...new Set(page.items.flatMap(row => (row.sku ? [row.sku] : [])))]
    const [found, products, feeEvents] = await Promise.all([
      canViewOrders ? existingOrders(this.prisma, tenantId, scope, orderIds) : Promise.resolve(new Set<string>()),
      skus.length > 0
        ? this.prisma.fbaProduct.findMany({ where: { tenantId, sellerAccountId: settlement.sellerAccountId, sellerSku: { in: skus } }, select: { sellerSku: true, asin: true }, take: skus.length })
        : Promise.resolve([]),
      // 费用类明细对得上的费用事件：同一结算单、同一订单、同一金额
      orderIds.length > 0
        ? this.prisma.fbaFeeEvent.findMany({
            where: { tenantId, sellerAccountId: settlement.sellerAccountId, settlementId: settlement.externalSettlementId, amazonOrderId: { in: [...new Set(orderIds)] } },
            select: { id: true, amazonOrderId: true, amount: true },
            orderBy: [{ postedAt: 'asc' }, { id: 'asc' }],
            take: 5000,
          })
        : Promise.resolve([]),
    ])
    const asinOf = new Map(products.map(product => [product.sellerSku, product.asin]))
    const feeOf = new Map<string, string>()
    for (const event of feeEvents) {
      const key = `${event.amazonOrderId}|${money(num(event.amount) ?? 0)}`
      if (!feeOf.has(key)) feeOf.set(key, event.id)
    }
    const items = page.items.map(row =>
      lineRow(row, {
        asin: row.sku ? (asinOf.get(row.sku) ?? null) : null,
        orderFound: row.amazonOrderId ? found.has(row.amazonOrderId) : false,
        feeEventId: row.category === 'FEE' && row.amazonOrderId ? (feeOf.get(`${row.amazonOrderId}|${money(num(row.amount) ?? 0)}`) ?? null) : null,
      }),
    )
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : filtered(query) ? '没有符合条件的交易明细；可以放宽筛选条件' : settlement.txnCount === 0 ? SETTLEMENT_PENDING_LABEL.NO_REPORT : '这张结算单的结算报告里没有金额明细',
      items,
      pageInfo: page.pageInfo,
      canViewOrders,
    }
  }

  async exceptions(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<SettlementExceptionsResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, SETTLEMENT_READ, {})
    const query = SettlementExceptionsQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const settlement = await findSettlement(this.prisma, tenantId, scope, id)
    const canViewOrders = hasPermission(context.permissions, 'orders.read')
    const binding = bindingOf(tenantId, { ...query, settlementId: settlement.id })
    const rows = await this.prisma.reconciliationException.findMany({
      where: {
        AND: [
          { tenantId, reconciliation: { settlementId: settlement.id } },
          query.kind ? { kind: query.kind } : {},
          query.category ? { category: query.category } : {},
          query.status ? { status: query.status } : {},
          this.cursor.after(query.cursor, query.sort, binding) as Prisma.ReconciliationExceptionWhereInput,
        ],
      },
      orderBy: this.cursor.orderBy(query.sort),
      take: query.pageSize + 1,
      select: EXCEPTION_SELECT,
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const found = canViewOrders
      ? await existingOrders(
          this.prisma,
          tenantId,
          scope,
          page.items.flatMap(row => (row.amazonOrderId ? [row.amazonOrderId] : [])),
        )
      : new Set<string>()
    const items = page.items.map(row => exceptionRow(row, row.amazonOrderId ? found.has(row.amazonOrderId) : false))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : filtered(query) ? '没有符合条件的异常；可以放宽筛选条件' : '这张结算单没有核对异常（待核对的结算单要等报告与财务交易都到齐才会核对）',
      items,
      pageInfo: page.pageInfo,
      canViewOrders,
    }
  }
}
