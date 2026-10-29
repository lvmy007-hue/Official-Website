import { Injectable } from '@nestjs/common'
import { PoApprovalBodySchema, PoVersionBodySchema, PurchaseOrderCreateBodySchema, PurchaseOrderUpdateBodySchema, poStatusLabel, type PoActionResult, type PoLineInput } from '@nova/api-contracts'
import type { PurchaseOrder } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { totalOf } from './po-rows'
import { isUniqueViolation, parseDay, PO_APPROVE, PO_WRITE, stateConflict } from './procurement-common'

const lineData = (line: PoLineInput, currency: string) => ({
  sellerSku: line.sellerSku,
  asin: line.asin ?? null,
  title: line.title ?? null,
  quantity: line.quantity,
  unitCost: line.unitCost ?? null,
  currency,
})
const result = (order: Pick<PurchaseOrder, 'id' | 'status' | 'version'>): PoActionResult => ({
  id: order.id,
  status: order.status as PoActionResult['status'],
  statusLabel: poStatusLabel(order.status),
  version: order.version,
})
const snapshot = (order: Pick<PurchaseOrder, 'status' | 'approvalStatus' | 'expectedDate' | 'notes'>) => ({
  status: order.status,
  approvalStatus: order.approvalStatus,
  expectedDate: order.expectedDate?.toISOString().slice(0, 10) ?? null,
  notes: order.notes,
})

function assertDistinctSkus(lines: readonly PoLineInput[]) {
  const seen = new Set<string>()
  for (const line of lines) {
    const key = line.sellerSku.toLowerCase()
    if (seen.has(key)) throw appError('VALIDATION_FAILED', `SKU ${line.sellerSku} 重复，请合并为一行`, { fieldErrors: { lines: [`SKU ${line.sellerSku} 重复`] } })
    seen.add(key)
  }
}

// 采购单的创建、编辑（只有草稿能改）、提交审批与审批。所有更新都带版本号：别人先改了会返回 409，提示刷新后再决定。
// 创建人与提交人不能审批自己的单（权限点本身也是与“创建”分开的）。
@Injectable()
export class PurchaseOrderWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async nextNumber(tenantId: string): Promise<string> {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
    const prefix = `PO-${stamp}-`
    const count = await this.prisma.purchaseOrder.count({ where: { tenantId, number: { startsWith: prefix } } })
    return `${prefix}${String(count + 1).padStart(3, '0')}`
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_WRITE)
    const body = PurchaseOrderCreateBodySchema.parse(rawBody)
    assertDistinctSkus(body.lines)
    const supplier = await this.prisma.supplier.findFirst({ where: { id: body.supplierId, tenantId: context.tenantId, status: 'ACTIVE' } })
    if (!supplier) throw appError('RESOURCE_NOT_FOUND', '供应商不存在或已停用', { fieldErrors: { supplierId: ['供应商不存在或已停用'] } })
    const currency = body.currency ?? supplier.currency
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const number = body.number ?? (await this.nextNumber(context.tenantId))
      try {
        const created = await this.prisma.$transaction(async tx => {
          const order = await tx.purchaseOrder.create({
            data: {
              tenantId: context.tenantId,
              supplierId: supplier.id,
              number,
              status: 'DRAFT',
              currency,
              totalAmount: totalOf(body.lines),
              expectedDate: body.expectedDate ? parseDay(body.expectedDate) : null,
              notes: body.notes ?? null,
              createdById: context.userId,
              lines: { create: body.lines.map(line => lineData(line, currency)) },
            },
          })
          await this.audit.record(
            req,
            { action: 'PURCHASE_ORDER_CREATED', resourceType: 'PurchaseOrder', resourceId: order.id, after: { number, supplierId: supplier.id, lineCount: body.lines.length } },
            { client: tx },
          )
          return order
        })
        return result(created)
      } catch (error) {
        if (!isUniqueViolation(error)) throw error
        if (body.number) throw appError('CONFLICT', `采购单号 ${body.number} 已存在`, { fieldErrors: { number: ['采购单号已存在'] } })
      }
    }
    throw appError('CONFLICT', '生成采购单号时发生冲突，请重试')
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_WRITE)
    const body = PurchaseOrderUpdateBodySchema.parse(rawBody)
    if (body.lines) assertDistinctSkus(body.lines)
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (order.status !== 'DRAFT') throw stateConflict('只有草稿状态的采购单可以编辑', order.status)
    const data: Record<string, unknown> = {}
    if (body.expectedDate !== undefined) data.expectedDate = body.expectedDate === null ? null : parseDay(body.expectedDate)
    if (body.notes !== undefined) data.notes = body.notes
    if (body.lines) data.totalAmount = totalOf(body.lines)
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.purchaseOrder, { id, tenantId: context.tenantId }, body.version, data, { label: '采购单' })
      if (body.lines) {
        await tx.purchaseOrderLine.deleteMany({ where: { purchaseOrderId: id } })
        await tx.purchaseOrderLine.createMany({ data: body.lines.map(line => ({ purchaseOrderId: id, ...lineData(line, order.currency) })) })
      }
      await this.audit.record(
        req,
        {
          action: 'PURCHASE_ORDER_UPDATED',
          resourceType: 'PurchaseOrder',
          resourceId: id,
          before: snapshot(order),
          after: snapshot(next),
          detail: body.lines ? { lineCount: body.lines.length } : undefined,
        },
        { client: tx },
      )
      return next
    })
    return result(updated)
  }

  /** 提交审批：每一行都要有单价（没有价格的单没法审批）。重新提交被驳回的单，审批记录追加一轮。 */
  async submit(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_WRITE)
    const body = PoVersionBodySchema.parse(rawBody)
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId }, include: { lines: true } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (order.status !== 'DRAFT') throw stateConflict('只有草稿状态的采购单可以提交审批', order.status)
    const missing = order.lines.filter(line => line.unitCost === null).map(line => line.sellerSku)
    if (missing.length)
      throw appError('VALIDATION_FAILED', `提交审批前每一行都要填写单价，还缺：${missing.slice(0, 5).join('、')}${missing.length > 5 ? ' 等' : ''}`, {
        fieldErrors: { lines: ['请先填写所有商品行的单价'] },
      })
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.purchaseOrder,
        { id, tenantId: context.tenantId },
        body.version,
        { status: 'PENDING_APPROVAL', approvalStatus: 'PENDING', submittedAt: new Date() },
        { label: '采购单' },
      )
      const last = await tx.purchaseApproval.findFirst({ where: { purchaseOrderId: id }, orderBy: { step: 'desc' }, select: { step: true } })
      await tx.purchaseApproval.create({ data: { tenantId: context.tenantId, purchaseOrderId: id, step: (last?.step ?? 0) + 1, submittedBy: context.userId } })
      await this.audit.record(req, { action: 'PURCHASE_ORDER_SUBMITTED', resourceType: 'PurchaseOrder', resourceId: id, before: snapshot(order), after: snapshot(next) }, { client: tx })
      return next
    })
    return result(updated)
  }

  /** 审批：通过后订单进入“已下单”；驳回退回草稿（意见必填），可修改后重新提交。 */
  async approve(req: RequestWithContext, id: string, rawBody: unknown): Promise<PoActionResult> {
    const context = await this.context.authorize(req, PO_APPROVE)
    const body = PoApprovalBodySchema.parse(rawBody)
    const order = await this.prisma.purchaseOrder.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!order) throw appError('RESOURCE_NOT_FOUND', '采购单不存在')
    if (order.status !== 'PENDING_APPROVAL') throw stateConflict('这张采购单不在待审批状态', order.status)
    const pending = await this.prisma.purchaseApproval.findFirst({ where: { purchaseOrderId: id, decision: 'PENDING' }, orderBy: { step: 'desc' } })
    if (!pending) throw stateConflict('没有待处理的审批记录', order.status)
    if (order.createdById === context.userId || pending.submittedBy === context.userId) throw appError('TENANT_ACCESS_DENIED', '创建或提交这张采购单的人不能审批它，请换一位有审批权限的成员')
    const approved = body.decision === 'APPROVED'
    const updated = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(
        tx.purchaseOrder,
        { id, tenantId: context.tenantId },
        body.version,
        approved ? { status: 'ORDERED', approvalStatus: 'APPROVED', orderedAt: new Date() } : { status: 'DRAFT', approvalStatus: 'REJECTED' },
        { label: '采购单' },
      )
      const decided = await tx.purchaseApproval.updateMany({
        where: { id: pending.id, tenantId: context.tenantId, decision: 'PENDING' },
        data: { decision: body.decision, approverId: context.userId, comment: body.comment ?? null, decidedAt: new Date() },
      })
      if (decided.count === 0) throw stateConflict('这条审批已被处理', order.status)
      await this.audit.record(
        req,
        {
          action: approved ? 'PURCHASE_ORDER_APPROVED' : 'PURCHASE_ORDER_REJECTED',
          resourceType: 'PurchaseOrder',
          resourceId: id,
          before: snapshot(order),
          after: snapshot(next),
          ...(body.comment ? { reason: body.comment } : {}),
        },
        { client: tx },
      )
      return next
    })
    return result(updated)
  }
}
