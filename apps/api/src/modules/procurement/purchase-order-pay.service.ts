import { Injectable } from '@nestjs/common'
import { PoPaymentBodySchema, poStatusLabel, purchaseOrderActions, type PoActionResult, type PoStatus } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { assertNotFuture, parseDay, PO_PAY, stateConflict } from './procurement-common'

/** 付款状态：按“已付”合计与订单合计比较；订单合计缺失（有行没填单价）时只能判断有没有付过。 */
export function paymentStatusOf(paid: Prisma.Decimal, total: Prisma.Decimal | null): 'UNPAID' | 'PARTIAL' | 'PAID' {
  if (paid.lte(0)) return 'UNPAID'
  if (total !== null && paid.gte(total)) return 'PAID'
  return 'PARTIAL'
}

// 付款：登记“计划付款”（只有金额与计划日期）或“实际付款”（有付款日，可挂凭证附件）。
// 给出 paymentId 表示把已有计划标为已付。已付与计划的合计不能超过订单合计。
@Injectable()
export class PurchaseOrderPayService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async pay(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_PAY)
    const body = PoPaymentBodySchema.parse(rawBody)
    if (body.paidAt) assertNotFuture(body.paidAt, '付款日期')
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId }, include: { payments: true } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (!purchaseOrderActions(order).includes('PAY')) throw stateConflict('当前状态不能登记付款（需要已下单及之后的状态）', order.status)
    if (body.currency && body.currency !== order.currency)
      throw appError('VALIDATION_FAILED', `付款币种必须与订单币种一致（${order.currency}）`, { fieldErrors: { currency: [`应为 ${order.currency}`] } })
    if (body.voucherAttachmentId) {
      const voucher = await this.prisma.attachment.findFirst({ where: { id: body.voucherAttachmentId, tenantId: context.tenantId, entityType: 'PURCHASE_ORDER', entityId: id }, select: { id: true } })
      if (!voucher) throw appError('VALIDATION_FAILED', '付款凭证必须是这张采购单已上传的附件', { fieldErrors: { voucherAttachmentId: ['付款凭证必须是这张采购单已上传的附件'] } })
    }
    const plan = body.paymentId ? order.payments.find(item => item.id === body.paymentId) : undefined
    if (body.paymentId) {
      if (!plan) throw appError('RESOURCE_NOT_FOUND', '计划付款不存在')
      if (plan.status !== 'PLANNED') throw stateConflict('这笔付款已经登记为已付', order.status)
      if (!body.paidAt) throw appError('VALIDATION_FAILED', '标记已付需要填写付款日期', { fieldErrors: { paidAt: ['请填写付款日期'] } })
    }
    const amount = new Prisma.Decimal(body.amount)
    const others = order.payments.filter(item => item.id !== plan?.id).reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0))
    if (order.totalAmount !== null && others.plus(amount).gt(order.totalAmount)) {
      throw appError('VALIDATION_FAILED', `付款与计划合计 ${others.plus(amount).toString()} 将超过订单合计 ${order.totalAmount.toString()}`, { fieldErrors: { amount: ['超过订单合计'] } })
    }
    const isPaid = Boolean(body.paidAt)
    const paidSum = order.payments
      .filter(item => item.status === 'PAID' && item.id !== plan?.id)
      .reduce((sum, item) => sum.plus(item.amount), new Prisma.Decimal(0))
      .plus(isPaid ? amount : 0)
    const nextStatus = paymentStatusOf(paidSum, order.totalAmount)

    const next = await this.prisma.$transaction(async tx => {
      const updated = await updateWithVersion(tx.purchaseOrder, { id, tenantId: context.tenantId }, body.version, { paymentStatus: nextStatus }, { label: '采购单' })
      const data = {
        kind: body.kind,
        amount,
        method: body.method ?? null,
        status: isPaid ? 'PAID' : 'PLANNED',
        plannedAt: body.plannedAt ? parseDay(body.plannedAt) : (plan?.plannedAt ?? null),
        paidAt: body.paidAt ? parseDay(body.paidAt) : null,
        voucherAttachmentId: body.voucherAttachmentId ?? null,
        note: body.note ?? null,
      }
      let paymentId: string
      if (plan) {
        const settled = await tx.purchasePayment.updateMany({ where: { id: plan.id, tenantId: context.tenantId, status: 'PLANNED' }, data })
        if (settled.count === 0) throw stateConflict('这笔付款已经登记为已付', order.status)
        paymentId = plan.id
      } else {
        paymentId = (await tx.purchasePayment.create({ data: { tenantId: context.tenantId, purchaseOrderId: id, currency: order.currency, createdBy: context.userId, ...data } })).id
      }
      await this.audit.record(
        req,
        {
          action: 'PURCHASE_PAYMENT_RECORDED',
          resourceType: 'PurchaseOrder',
          resourceId: id,
          before: { paymentStatus: order.paymentStatus },
          after: { paymentStatus: nextStatus },
          detail: { paymentId, kind: body.kind, status: data.status, amount: amount.toString(), currency: order.currency },
        },
        { client: tx },
      )
      return updated
    })
    return { id, status: next.status as PoStatus, statusLabel: poStatusLabel(next.status), version: next.version }
  }
}
