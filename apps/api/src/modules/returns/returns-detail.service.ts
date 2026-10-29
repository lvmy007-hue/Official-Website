import { Injectable } from '@nestjs/common'
import {
  classifyFinanceLine,
  financeLineLabel,
  isRefundTransaction,
  kindsFromText,
  lineBelongsTo,
  orderStatusLabel,
  returnDispositionView,
  resolveReason,
  returnReceiptState,
  returnReimbursementView,
  type CommentView,
  type ReturnDetailResponse,
  type ReturnFeeLine,
  type ReturnTimelineItem,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { keyOf } from '../orders'
import { ReturnsAccessService } from './returns-access.service'
import { loadReturnContext, refundViewOf } from './returns-facts'
import { RETURN_FRESHNESS_KEYS } from './returns-list.service'
import { ReturnsReasonMapService, type ReasonMapIndex } from './returns-reason-map.service'

const round2 = (value: number) => Math.round(value * 100) / 100

/** 退货原因三层：代码（报告原值）、中文释义、大类；报告没给原因时三项都为空。 */
function reasonOf(raw: string | null, overrides: ReasonMapIndex): ReturnDetailResponse['reason'] {
  if (!raw?.trim()) return { code: raw, label: null, category: null }
  const view = resolveReason(raw, overrides)
  return { code: raw, label: view.label, category: view.category }
}

/**
 * 买家备注在详情里的样子（P6-14）：没有保留期记录表示没有留言（或已按保留期清除）；保留期已过表示已过期；否则有内容但要经统一出口查看明文。
 * 升级前遗留的明文备注在存量加密任务处理之前也显示为“没有”：宁可暂时看不到，也不在这里返回明文。
 */
export function commentViewOf(row: { customerCommentsExpiresAt: Date | null; customerCommentsKinds: string | null }, now = new Date()): CommentView {
  const until = row.customerCommentsExpiresAt
  if (!until) return { state: 'NONE', kinds: [], retainedUntil: null }
  const expired = until.getTime() <= now.getTime()
  return { state: expired ? 'EXPIRED' : 'AVAILABLE', kinds: expired ? [] : kindsFromText(row.customerCommentsKinds), retainedUntil: until.toISOString() }
}

// 退货详情（07 章 7.2）：订单与商品、退货原因与买家备注、处置、退款与相关费用、关联赔付、同单其他退货、处理时间线。
// 退款与费用来自订单的财务交易（订单口径）；报告没有退款金额；时间线只有我方已有的记录（下单、退款入账、收到退货、导入）。
@Injectable()
export class ReturnsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ReturnsAccessService,
    private readonly reasons: ReturnsReasonMapService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<ReturnDetailResponse> {
    const { context, scope, row } = await this.access.resolve(req, id)
    const tenantId = context.tenantId
    const [ctx, product, siblings, freshness, overrides] = await Promise.all([
      loadReturnContext(this.prisma, tenantId, [row]),
      this.prisma.fbaProduct.findFirst({ where: { tenantId, sellerAccountId: row.sellerAccountId, sellerSku: row.sellerSku }, select: { id: true, title: true, imageUrl: true } }),
      this.prisma.fbaReturnCase.findMany({
        where: { tenantId, sellerAccountId: row.sellerAccountId, amazonOrderId: row.amazonOrderId, id: { not: row.id } },
        orderBy: { returnDate: 'asc' },
        select: { id: true, asin: true, sellerSku: true, quantity: true, returnDate: true, disposition: true, detailedDisposition: true },
        take: 50,
      }),
      sourceFreshness(this.prisma, tenantId, scope, RETURN_FRESHNESS_KEYS),
      this.reasons.index(tenantId),
    ])
    const order = ctx.orders.get(keyOf(row.sellerAccountId, row.amazonOrderId)) ?? null
    const refund = refundViewOf(ctx, row.sellerAccountId, row.amazonOrderId)
    const own = <T extends { sellerAccountId: string; amazonOrderId: string }>(items: readonly T[]) =>
      items.filter(item => item.sellerAccountId === row.sellerAccountId && item.amazonOrderId === row.amazonOrderId)
    const refundTxs = own(ctx.facts.transactions).filter(tx => isRefundTransaction(tx.transactionType))
    const currency = order?.currency ?? refund.currency
    const fees = refundFees(own(ctx.facts.lines), refundTxs, currency)
    return {
      record: {
        id: row.id,
        returnDate: row.returnDate.toISOString(),
        quantity: row.quantity,
        sellerAccountId: row.sellerAccountId,
        storeName: row.sellerAccount.displayName,
        asin: row.asin,
        sku: row.sellerSku,
        fnsku: row.fnsku || null,
        licensePlateNumber: row.licensePlateNumber || null,
        fulfillmentCenterId: row.fulfillmentCenterId,
        reportStatus: row.reportStatus,
        importedAt: row.syncedAt.toISOString(),
      },
      order: {
        id: order?.id ?? null,
        amazonOrderId: row.amazonOrderId,
        purchaseDate: order?.purchaseDate.toISOString() ?? null,
        amount: order?.amount ?? null,
        currency,
        statusLabel: order ? orderStatusLabel(order.status) : null,
        isReplacement: order?.isReplacement ?? false,
      },
      product: { productId: product?.id ?? null, title: product?.title ?? null, imageUrl: product?.imageUrl ?? null },
      reason: reasonOf(row.reason, overrides),
      buyerComments: commentViewOf(row),
      disposition: returnDispositionView(row.detailedDisposition, row.disposition),
      refund: {
        state: refund.state,
        amount: refund.amount,
        firstRefundAt: refund.firstRefundAt,
        currency,
        items: refundTxs.map(tx => ({ postedAt: tx.postedAt.toISOString(), amount: tx.amount, currency: tx.currency, status: tx.transactionStatus })),
        fees: fees.lines,
        feeTotal: fees.total,
      },
      receipt: returnReceiptState(refund, refund.firstRefundAt, row.returnDate),
      reimbursement: returnReimbursementView(row),
      siblings: siblings.map(item => ({
        id: item.id,
        asin: item.asin,
        sku: item.sellerSku,
        quantity: item.quantity,
        returnDate: item.returnDate.toISOString(),
        disposition: returnDispositionView(item.detailedDisposition, item.disposition),
      })),
      timeline: timelineOf({
        purchaseDate: order?.purchaseDate ?? null,
        refunds: refundTxs.map(tx => ({ at: tx.postedAt, amount: tx.amount, currency: tx.currency })),
        returnDate: row.returnDate,
        quantity: row.quantity,
        importedAt: row.syncedAt,
      }),
      freshness,
    }
  }
}

/** 相关费用：退款交易下的费用类明细（例如退款佣金），加上名称里带 return 的费用（例如退货处理费），按明细编号去重。 */
export function refundFees(
  lines: ReadonlyArray<{ sourceEventId: string | null; path: string; amount: number; postedAt: Date }>,
  refunds: ReadonlyArray<{ externalTransactionId: string }>,
  currency: string,
): { lines: ReturnFeeLine[]; total: number | null } {
  const seen = new Set<string>()
  const picked = lines.filter(line => {
    const key = line.sourceEventId ?? `${line.path}|${line.postedAt.toISOString()}|${line.amount}`
    if (seen.has(key)) return false
    const underRefund = refunds.some(tx => lineBelongsTo(line, tx.externalTransactionId)) && classifyFinanceLine(line.path) === 'FEE'
    if (!underRefund && !/return/i.test(line.path)) return false
    seen.add(key)
    return true
  })
  if (picked.length === 0) return { lines: [], total: null }
  const out = picked.map(line => ({ label: financeLineLabel(line.path), amount: line.amount, currency, postedAt: line.postedAt.toISOString() }))
  return { lines: out, total: round2(out.reduce((sum, line) => sum + line.amount, 0)) }
}

export function timelineOf(input: {
  purchaseDate: Date | null
  refunds: ReadonlyArray<{ at: Date; amount: number; currency: string }>
  returnDate: Date
  quantity: number
  importedAt: Date
}): ReturnTimelineItem[] {
  const items: ReturnTimelineItem[] = []
  if (input.purchaseDate) items.push({ at: input.purchaseDate.toISOString(), kind: 'ORDER', title: '客户下单', source: '订单接口' })
  for (const refund of input.refunds) items.push({ at: refund.at.toISOString(), kind: 'REFUND', title: `退款入账 ${Math.abs(refund.amount).toFixed(2)} ${refund.currency}`, source: '财务交易' })
  items.push({ at: input.returnDate.toISOString(), kind: 'RETURN_RECEIVED', title: `亚马逊仓库处理退货 ${input.quantity} 件`, source: '客户退货报告' })
  items.push({ at: input.importedAt.toISOString(), kind: 'IMPORTED', title: '退货记录同步到本系统', source: '本系统' })
  return items.sort((a, b) => a.at.localeCompare(b.at))
}
