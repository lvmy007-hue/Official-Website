import { Injectable } from '@nestjs/common'
import {
  RETURN_ANALYSIS_BASIS,
  RETURN_ANALYSIS_ROW_CAP,
  RETURN_MATRIX_MONTHS,
  RETURN_REFUND_ORDER_CAP,
  latestMonths,
  monthOf,
  shareOf,
  type ReturnCrossMonthRefund,
  type ReturnCrossMonthResponse,
  type ReturnMatrix,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { localDate } from '../overview'
import { keyOf } from '../orders'
import { ReturnsAnalysisContextService } from './returns-analysis-context'
import { loadReturnContext, refundViewOf } from './returns-facts'

interface Pair {
  orderMonth: string
  returnMonth: string
  units: number
}

function matrixOf(pairs: readonly Pair[]): ReturnMatrix {
  const orderMonths = latestMonths(
    pairs.map(pair => pair.orderMonth),
    RETURN_MATRIX_MONTHS,
  )
  const returnMonths = latestMonths(
    pairs.map(pair => pair.returnMonth),
    RETURN_MATRIX_MONTHS,
  )
  const cells = orderMonths.map(() => returnMonths.map(() => 0))
  let hiddenUnits = 0
  for (const pair of pairs) {
    const row = orderMonths.indexOf(pair.orderMonth)
    const column = returnMonths.indexOf(pair.returnMonth)
    if (row < 0 || column < 0) hiddenUnits += pair.units
    else cells[row]![column] = (cells[row]![column] ?? 0) + pair.units
  }
  return { orderMonths, returnMonths, cells, hiddenUnits }
}

// 跨月退货（P6-13，M-702）：下单月与退货月不同的退货件数占比，下单月 × 退货月矩阵，以及跨月退货的退款金额占比。
// 月份边界按企业时区；缺下单时间的退货不进分子分母，单独计数。退款金额按订单口径（同一订单只算一次），最多核对 RETURN_REFUND_ORDER_CAP 个最近的订单。
@Injectable()
export class ReturnsCrossMonthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ctx: ReturnsAnalysisContextService,
  ) {}

  async crossMonth(req: RequestWithContext, rawQuery: Record<string, string>): Promise<ReturnCrossMonthResponse> {
    const a = await this.ctx.open(req, rawQuery, 'basis')
    const orderBy = { [a.dateField]: 'desc' } as Prisma.FbaReturnCaseOrderByWithRelationInput
    const [records, extraUnknown, freshness] = await Promise.all([
      this.prisma.fbaReturnCase.findMany({
        where: a.where,
        select: { sellerAccountId: true, amazonOrderId: true, quantity: true, returnDate: true, orderPurchasedAt: true },
        orderBy,
        take: RETURN_ANALYSIS_ROW_CAP,
      }),
      a.timeBasis === 'order' ? this.ctx.unknown(a.unknownWhere) : Promise.resolve({ units: 0, rows: 0 }),
      this.ctx.freshness(a.tenantId, a.scope),
    ])

    const pairs = new Map<string, Pair>()
    const crossOrders = new Map<string, boolean>()
    let computableUnits = 0
    let crossMonthUnits = 0
    let missingUnits = 0
    let missingRows = 0
    for (const record of records) {
      if (!record.orderPurchasedAt) {
        missingUnits += record.quantity
        missingRows += 1
        continue
      }
      const orderMonth = monthOf(localDate(record.orderPurchasedAt, a.zone))
      const returnMonth = monthOf(localDate(record.returnDate, a.zone))
      const cross = orderMonth !== returnMonth
      computableUnits += record.quantity
      if (cross) crossMonthUnits += record.quantity
      const key = `${orderMonth}|${returnMonth}`
      const pair = pairs.get(key) ?? { orderMonth, returnMonth, units: 0 }
      pair.units += record.quantity
      pairs.set(key, pair)
      const orderKey = keyOf(record.sellerAccountId, record.amazonOrderId)
      crossOrders.set(orderKey, (crossOrders.get(orderKey) ?? false) || cross)
    }

    const empty = records.length === 0 && extraUnknown.rows === 0
    const refund = await this.refundOf(a.tenantId, records, crossOrders)
    return {
      state: empty ? 'NO_DATA' : 'OK',
      note: empty ? '所选日期范围内尚无退货记录；店铺授权并完成客户退货报告同步后显示（报告每天同步一次）' : null,
      range: { from: a.from, to: a.to, defaulted: a.defaulted },
      timeBasis: a.timeBasis,
      unknownOrderUnits: missingUnits + extraUnknown.units,
      unknownOrderRows: missingRows + extraUnknown.rows,
      basis: RETURN_ANALYSIS_BASIS.crossMonth,
      freshness,
      totals: { computableUnits, crossMonthUnits, share: computableUnits > 0 ? shareOf(crossMonthUnits, computableUnits) : null },
      refund,
      matrix: matrixOf([...pairs.values()]),
      truncated: records.length >= RETURN_ANALYSIS_ROW_CAP,
    }
  }

  /** 跨月退货的退款金额占比：按订单去重，最多核对最近的 RETURN_REFUND_ORDER_CAP 个订单，币种不一致时不做除法。 */
  private async refundOf(
    tenantId: string,
    records: ReadonlyArray<{ sellerAccountId: string; amazonOrderId: string; returnDate: Date }>,
    crossOrders: ReadonlyMap<string, boolean>,
  ): Promise<ReturnCrossMonthRefund> {
    const none = (state: ReturnCrossMonthRefund['state'], note: string, sampledOrders = 0): ReturnCrossMonthRefund => ({
      state,
      currency: null,
      crossMonthAmount: null,
      totalAmount: null,
      share: null,
      sampledOrders,
      note,
    })
    if (crossOrders.size === 0) return none('NO_DATA', '没有能确定下单月的退货订单')
    const sampled = new Map<string, { sellerAccountId: string; amazonOrderId: string; returnDate: Date }>()
    for (const record of records) {
      const key = keyOf(record.sellerAccountId, record.amazonOrderId)
      if (crossOrders.has(key) && !sampled.has(key)) sampled.set(key, record)
      if (sampled.size >= RETURN_REFUND_ORDER_CAP) break
    }
    const context = await loadReturnContext(this.prisma, tenantId, [...sampled.values()])
    let total = 0
    let cross = 0
    const currencies = new Set<string>()
    let priced = 0
    for (const [key, row] of sampled) {
      const view = refundViewOf(context, row.sellerAccountId, row.amazonOrderId)
      if (view.amount === null || view.amount <= 0) continue
      priced += 1
      currencies.add(view.currency)
      total += view.amount
      if (crossOrders.get(key)) cross += view.amount
    }
    if (priced === 0) return none('NO_DATA', '核对的订单还没有退款金额（财务交易未同步或尚未退款）', sampled.size)
    if (currencies.size > 1) return none('MIXED_CURRENCY', '核对的订单含多个币种，不做合并除法；请按店铺筛选后再看', sampled.size)
    const partial = crossOrders.size > sampled.size
    return {
      state: partial ? 'PARTIAL' : 'OK',
      currency: [...currencies][0] ?? null,
      crossMonthAmount: Math.round(cross * 100) / 100,
      totalAmount: Math.round(total * 100) / 100,
      share: total > 0 ? shareOf(cross, total) : null,
      sampledOrders: sampled.size,
      note: partial ? `订单较多，只核对了最近的 ${sampled.size} 个订单（共 ${crossOrders.size} 个）的退款金额，占比为这部分订单的口径` : null,
    }
  }
}
