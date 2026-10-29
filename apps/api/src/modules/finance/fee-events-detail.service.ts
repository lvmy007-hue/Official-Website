import { Injectable } from '@nestjs/common'
import { FEE_CATEGORIES, FEE_CATEGORY_LABEL, FEE_EVENTS_READ, feeSourceOf, feeSubtypeLabel, feeTransactionStatusLabel, type FeeCategory, type FeeEventDetailResponse } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { EVENT_SELECT, FEE_ENTITY_TYPE, FEE_HISTORY_KIND, FEE_ID_PATTERN, SIBLING_LIMIT, eventRow, loadShipmentIds, relatedOf, shipmentKeyOf } from './fee-events-common'

const HISTORY_LIMIT = 20
const num = (value: { toString(): string }) => Number(value.toString())

// 费用事件的证据（“查看证据”）：这条费用明细本身、来源交易（类型、状态、关联标识）、同一笔交易里的其他明细、对账变更记录，以及能链到的订单。
// 报告类的费用事件（仓储费、入仓不合规）没有来源交易，transaction 为 null。
@Injectable()
export class FeeEventsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<FeeEventDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, FEE_EVENTS_READ, {})
    if (!FEE_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '费用事件不存在')
    const row = await this.prisma.fbaFeeEvent.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope), feeCategory: { in: [...FEE_CATEGORIES] } }, select: EVENT_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '费用事件不存在')
    const tenantId = context.tenantId
    const fromFinance = Boolean(row.sourceRecordId) && feeSourceOf(row.sourceEventId) === 'FINANCE_API'
    const [transaction, siblings, events, order, shipments] = await Promise.all([
      fromFinance
        ? this.prisma.fbaFinancialTransaction.findFirst({
            where: { tenantId, sellerAccountId: row.sellerAccountId, externalTransactionId: row.sourceRecordId as string, postedAt: row.postedAt },
            select: { externalTransactionId: true, transactionType: true, transactionStatus: true, amount: true, currency: true, postedAt: true, description: true, relatedIdentifiers: true },
          })
        : null,
      fromFinance
        ? this.prisma.fbaFeeEvent.findMany({
            where: { tenantId, sellerAccountId: row.sellerAccountId, sourceRecordId: row.sourceRecordId, postedAt: row.postedAt, id: { not: row.id }, feeCategory: { in: [...FEE_CATEGORIES] } },
            orderBy: { id: 'asc' },
            take: SIBLING_LIMIT + 1,
            select: { id: true, feeCategory: true, feeSubtype: true, amount: true, currency: true },
          })
        : [],
      this.prisma.entityEvent.findMany({
        where: { tenantId, entityType: FEE_ENTITY_TYPE, entityId: row.id, kind: FEE_HISTORY_KIND },
        orderBy: { occurredAt: 'desc' },
        take: HISTORY_LIMIT,
        select: { occurredAt: true, title: true, actorId: true },
      }),
      // 只有读订单的权限才给订单链接（订单页自己也会校验）
      row.amazonOrderId && hasPermission(context.permissions, 'orders.read')
        ? this.prisma.order.findFirst({ where: { tenantId, sellerAccountId: row.sellerAccountId, amazonOrderId: row.amazonOrderId }, select: { id: true } })
        : null,
      loadShipmentIds(this.prisma, tenantId, [row]),
    ])
    const names = await memberNames(
      this.prisma,
      tenantId,
      events.map(event => event.actorId),
    )
    return {
      event: eventRow(row, shipments.get(shipmentKeyOf(row)) ?? null),
      transaction: transaction
        ? {
            transactionId: transaction.externalTransactionId,
            transactionType: transaction.transactionType,
            transactionStatus: transaction.transactionStatus,
            transactionStatusLabel: feeTransactionStatusLabel(transaction.transactionStatus),
            amount: num(transaction.amount),
            currency: transaction.currency,
            postedAt: transaction.postedAt.toISOString(),
            description: transaction.description,
            relatedIdentifiers: relatedOf(transaction.relatedIdentifiers),
          }
        : null,
      siblings: siblings.slice(0, SIBLING_LIMIT).map(item => ({
        id: item.id,
        categoryLabel: FEE_CATEGORY_LABEL[item.feeCategory as FeeCategory] ?? item.feeCategory,
        subtypeLabel: feeSubtypeLabel(item.feeSubtype),
        amount: num(item.amount),
        currency: item.currency,
      })),
      siblingsTruncated: siblings.length > SIBLING_LIMIT,
      history: events.map(event => ({ at: event.occurredAt.toISOString(), title: event.title, actorName: event.actorId ? nameOrFormer(names, event.actorId) : null })),
      orderId: order?.id ?? null,
    }
  }
}
