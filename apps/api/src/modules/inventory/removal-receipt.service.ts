import { Injectable } from '@nestjs/common'
import { RemovalReceiptBodySchema, type RemovalReceiptResponse } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { InventoryPolicyService } from './inventory-policy.service'
import { parseRemovalId, reconcile, removalTypeOf } from './removal-math'

const PERMISSION = 'inventory.removal.receive'
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)

// 退回件收货核对（06 章 6.5）：只记录国内仓实际收到的数量，不调用亚马逊、不改库存。
// 应收取自订单已发货数量；同一天同一 SKU 再次登记视为更正当天的登记，审计里留下前后值。
@Injectable()
export class RemovalReceiptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly policies: InventoryPolicyService,
  ) {}

  async receive(req: RequestWithContext, id: string, rawBody: unknown): Promise<RemovalReceiptResponse> {
    // 权限检查先于参数校验：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, PERMISSION, {})
    const body = RemovalReceiptBodySchema.parse(rawBody)
    const parsed = parseRemovalId(id)
    if (!parsed || (!scope.unrestricted && !scope.sellerAccountIds.includes(parsed.sellerAccountId))) throw appError('RESOURCE_NOT_FOUND', '移除订单不存在')
    const tenantId = context.tenantId
    const where = { tenantId, sellerAccountId: parsed.sellerAccountId }
    const lines = await this.prisma.removalOrder.findMany({ where: { ...where, orderId: parsed.orderId }, select: { sku: true, type: true, shippedQty: true }, take: 500 })
    if (lines.length === 0) throw appError('RESOURCE_NOT_FOUND', '移除订单不存在')
    const type = removalTypeOf(lines[0].type)
    if (type !== 'RETURN') throw appError('CONFLICT', '只有“退回”类移除订单需要登记收货；弃置订单的商品由亚马逊销毁')
    const own = lines.filter(line => line.sku === body.sku)
    if (own.length === 0) throw appError('VALIDATION_FAILED', '这个 SKU 不在该移除订单里', { fieldErrors: { sku: ['请选择订单里的 SKU'] } })
    if (own.reduce((total, line) => total + line.shippedQty, 0) <= 0) throw appError('CONFLICT', '这个 SKU 还没有发货数量，亚马逊发出退回件后才能登记收货')
    const today = await this.policies.todayOf(tenantId)
    const receivedAt = body.receivedAt ?? today
    if (receivedAt > today) throw appError('VALIDATION_FAILED', '收货日期不能晚于今天', { fieldErrors: { receivedAt: ['不能晚于今天'] } })

    const key = {
      tenantId_sellerAccountId_removalOrderId_sku_receivedAt: { tenantId, sellerAccountId: parsed.sellerAccountId, removalOrderId: parsed.orderId, sku: body.sku, receivedAt: asDate(receivedAt) },
    }
    const row = await this.prisma.$transaction(async tx => {
      const before = await tx.removalReceipt.findUnique({ where: key })
      const data = { receivedQty: body.receivedQty, sellableQty: body.sellableQty, damagedQty: body.damagedQty, note: body.note ?? null, receivedBy: context.userId }
      const saved = await tx.removalReceipt.upsert({
        where: key,
        create: { ...data, tenantId, sellerAccountId: parsed.sellerAccountId, removalOrderId: parsed.orderId, sku: body.sku, receivedAt: asDate(receivedAt) },
        update: data,
      })
      await this.audit.record(
        req,
        {
          action: before ? 'REMOVAL_RECEIPT_CORRECTED' : 'REMOVAL_RECEIPT_RECORDED',
          resourceType: 'RemovalOrder',
          resourceId: id,
          before: before ? { receivedQty: before.receivedQty, sellableQty: before.sellableQty, damagedQty: before.damagedQty, note: before.note } : undefined,
          after: { sku: body.sku, receivedAt, receivedQty: body.receivedQty, sellableQty: body.sellableQty, damagedQty: body.damagedQty },
        },
        { client: tx },
      )
      return saved
    })
    const all = await this.prisma.removalReceipt.findMany({ where: { ...where, removalOrderId: parsed.orderId, sku: body.sku }, take: 500 })
    const names = await memberNames(this.prisma, tenantId, [row.receivedBy])
    return {
      receipt: {
        id: row.id,
        sku: row.sku,
        receivedQty: row.receivedQty,
        sellableQty: row.sellableQty,
        damagedQty: row.damagedQty,
        note: row.note,
        receivedAt,
        receivedBy: nameOrFormer(names, row.receivedBy),
      },
      reconciliation: reconcile(type, own, all)[0],
    }
  }
}
