import { Injectable } from '@nestjs/common'
import { ORDERS_PERMISSION, OrderNetIncomeBodySchema, type OrderNetIncomeResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { loadOrderFacts, summarizeOrder, type FactRow } from './orders-facts'

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))

// 订单列表的“净收益”异步列（P6-28 冻结：毛利改为异步列）：主列表先返回，这一列只对当前屏幕上的行批量取（一次最多 100 行）。
// 口径与订单详情一致（财务交易合计，summarizeOrder）；需要 orders.read 与 field.profit，企业与店铺范围与列表一致，范围外的订单不出现。
@Injectable()
export class OrdersNetIncomeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async netIncome(req: RequestWithContext, rawQuery: Record<string, string>, rawBody: unknown): Promise<OrderNetIncomeResponse> {
    // 先做权限检查再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ORDERS_PERMISSION, rawQuery)
    await this.context.authorize(req, 'field.profit')
    const body = OrderNetIncomeBodySchema.parse(rawBody ?? {})
    const orders = await this.prisma.order.findMany({
      where: { tenantId: context.tenantId, ...storeWhere(scope), id: { in: [...new Set(body.ids)] } },
      select: {
        id: true,
        sellerAccountId: true,
        amazonOrderId: true,
        purchaseDate: true,
        status: true,
        amount: true,
        currency: true,
        isReplacement: true,
        replacedOrderId: true,
        replacementReason: true,
      },
    })
    const factRows: FactRow[] = orders.map(row => ({ ...row, amount: num(row.amount) }))
    const facts = await loadOrderFacts(this.prisma, context.tenantId, factRows)
    const rows: OrderNetIncomeResponse['rows'] = {}
    factRows.forEach((row, index) => {
      const summary = summarizeOrder(row, facts)
      rows[orders[index].id] = { net: { value: summary.netIncome.value, currency: summary.currency } }
    })
    return { rows }
  }
}
