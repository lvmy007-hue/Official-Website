import { Injectable } from '@nestjs/common'
import { FirstMileCreateBodySchema, FirstMileOutboundBodySchema, FirstMileUpdateBodySchema, shipmentDateIssues, type FirstMileActionResult, type FirstMileItemInput } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { assertNotFuture, dayText, FM_WRITE, isUniqueViolation, parseDay, stateConflict, todayText } from './first-mile-common'
import { assertChannelUsable, assertShipmentRefs } from './first-mile-refs'
import { snapshotOf } from './first-mile-rows'
import { refreshTransitStats } from './transit-refresh'

const dayOrNull = (text: string | null | undefined) => (text ? parseDay(text) : null)
const itemData = (tenantId: string, item: FirstMileItemInput) => ({
  tenantId,
  sku: item.sku,
  purchaseOrderId: item.purchaseOrderId ?? null,
  quantity: item.quantity,
  cartons: item.cartons ?? null,
  volumeCbm: item.volumeCbm ?? null,
  weightKg: item.weightKg ?? null,
  goodsValue: item.goodsValue ?? null,
})
const conflictOnWaybill = (error: unknown): never => {
  if (isUniqueViolation(error)) throw appError('CONFLICT', '这个货代下已经有相同的运单号', { fieldErrors: { waybillNo: ['运单号已存在'] } })
  throw error
}

// 头程运单的新建、修改与出库（06 章 6.10）。每个写入都带版本号（别人先改了会提示刷新）并写审计；
// 费用已分摊后明细与费用锁定，出库后明细锁定；实际日期不能是未来。
@Injectable()
export class FirstMileWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async create(req: RequestWithContext, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileCreateBodySchema.parse(rawBody)
    for (const [field, label] of [
      ['shipDate', '发货日'],
      ['ataPort', '实际到港日'],
      ['ataDelivery', '实际交付日'],
    ] as const) {
      const value = body[field]
      if (value) assertNotFuture(value, label, field)
    }
    const { items, ...fields } = body
    try {
      const created = await this.prisma.$transaction(async tx => {
        await assertShipmentRefs(tx, context.tenantId, {
          forwarderId: body.forwarderId,
          requireActiveForwarder: true,
          warehouseId: body.warehouseId,
          linkedInboundShipmentIds: body.linkedInboundShipmentIds,
          items,
        })
        if (fields.carrierChannelId) await assertChannelUsable(tx, context.tenantId, fields.carrierChannelId)
        const row = await tx.firstMileShipment.create({
          data: {
            tenantId: context.tenantId,
            forwarderId: fields.forwarderId,
            waybillNo: fields.waybillNo,
            mode: fields.mode,
            containerNo: fields.containerNo || null,
            shipDate: dayOrNull(fields.shipDate),
            etaPort: dayOrNull(fields.etaPort),
            ataPort: dayOrNull(fields.ataPort),
            customsStatus: fields.customsStatus,
            etaDelivery: dayOrNull(fields.etaDelivery),
            ataDelivery: dayOrNull(fields.ataDelivery),
            estimatedCost: fields.estimatedCost ?? null,
            carrierChannelId: fields.carrierChannelId || null,
            estimatedAt: fields.carrierChannelId && fields.estimatedCost != null ? new Date() : null,
            currency: fields.currency,
            linkedInboundShipmentIds: [...new Set(fields.linkedInboundShipmentIds)],
            warehouseId: fields.warehouseId || null,
            note: fields.note || null,
            createdBy: context.userId,
            items: { create: items.map(item => itemData(context.tenantId, item)) },
          },
        })
        await refreshTransitStats(tx, context.tenantId, row.forwarderId, row.mode)
        await this.audit.record(req, { action: 'FIRST_MILE_CREATED', resourceType: 'FirstMileShipment', resourceId: row.id, after: { ...snapshotOf(row), itemCount: items.length } }, { client: tx })
        return row
      })
      return { id: created.id, version: created.version }
    } catch (error) {
      return conflictOnWaybill(error)
    }
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version, items, ...changes } = FirstMileUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const before = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { _count: { select: { costs: true, allocations: true } } } })
    if (!before) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    const merged = {
      shipDate: changes.shipDate === undefined ? dayText(before.shipDate) : changes.shipDate,
      etaPort: changes.etaPort === undefined ? dayText(before.etaPort) : changes.etaPort,
      ataPort: changes.ataPort === undefined ? dayText(before.ataPort) : changes.ataPort,
      etaDelivery: changes.etaDelivery === undefined ? dayText(before.etaDelivery) : changes.etaDelivery,
      ataDelivery: changes.ataDelivery === undefined ? dayText(before.ataDelivery) : changes.ataDelivery,
    }
    const issue = shipmentDateIssues(merged)[0]
    if (issue) throw appError('VALIDATION_FAILED', issue.message, { fieldErrors: { [issue.path]: [issue.message] } })
    for (const [field, label] of [
      ['shipDate', '发货日'],
      ['ataPort', '实际到港日'],
      ['ataDelivery', '实际交付日'],
    ] as const) {
      if (changes[field]) assertNotFuture(changes[field] as string, label, field)
    }
    if (items && before.outboundAt) throw stateConflict('这张运单已出库，明细不能再修改')
    if (items && before._count.allocations > 0) throw stateConflict('费用已分摊，请先撤销分摊再修改明细')
    if (changes.currency && changes.currency !== before.currency && before._count.costs > 0) {
      throw appError('VALIDATION_FAILED', '已经录入费用，不能再改币种', { fieldErrors: { currency: ['已经录入费用，不能再改币种'] } })
    }
    if (changes.warehouseId !== undefined && (changes.warehouseId || null) !== before.warehouseId && before.outboundAt) throw stateConflict('这张运单已出库，不能再换仓库')

    const data: Prisma.FirstMileShipmentUncheckedUpdateManyInput = {
      ...(changes.forwarderId !== undefined ? { forwarderId: changes.forwarderId } : {}),
      ...(changes.waybillNo !== undefined ? { waybillNo: changes.waybillNo } : {}),
      ...(changes.mode !== undefined ? { mode: changes.mode } : {}),
      ...(changes.containerNo !== undefined ? { containerNo: changes.containerNo || null } : {}),
      ...(changes.shipDate !== undefined ? { shipDate: dayOrNull(changes.shipDate) } : {}),
      ...(changes.etaPort !== undefined ? { etaPort: dayOrNull(changes.etaPort) } : {}),
      ...(changes.ataPort !== undefined ? { ataPort: dayOrNull(changes.ataPort) } : {}),
      ...(changes.customsStatus !== undefined ? { customsStatus: changes.customsStatus } : {}),
      ...(changes.etaDelivery !== undefined ? { etaDelivery: dayOrNull(changes.etaDelivery) } : {}),
      ...(changes.ataDelivery !== undefined ? { ataDelivery: dayOrNull(changes.ataDelivery) } : {}),
      ...(changes.estimatedCost !== undefined ? { estimatedCost: changes.estimatedCost } : {}),
      ...(changes.carrierChannelId !== undefined ? { carrierChannelId: changes.carrierChannelId || null } : {}),
      // 预估依据渠道且给了金额才记“采用时间”；手工改金额、清空渠道或清空金额则清掉
      ...(changes.estimatedCost !== undefined || changes.carrierChannelId !== undefined
        ? {
            estimatedAt:
              (changes.carrierChannelId !== undefined ? changes.carrierChannelId || null : before.carrierChannelId) !== null && (changes.estimatedCost ?? before.estimatedCost) !== null
                ? new Date()
                : null,
          }
        : {}),
      ...(changes.currency !== undefined ? { currency: changes.currency } : {}),
      ...(changes.linkedInboundShipmentIds !== undefined ? { linkedInboundShipmentIds: [...new Set(changes.linkedInboundShipmentIds)] } : {}),
      ...(changes.warehouseId !== undefined ? { warehouseId: changes.warehouseId || null } : {}),
      ...(changes.note !== undefined ? { note: changes.note || null } : {}),
    }
    try {
      const after = await this.prisma.$transaction(async tx => {
        await assertShipmentRefs(tx, tenantId, {
          forwarderId: changes.forwarderId && changes.forwarderId !== before.forwarderId ? changes.forwarderId : undefined,
          requireActiveForwarder: true,
          warehouseId: changes.warehouseId && changes.warehouseId !== before.warehouseId ? changes.warehouseId : undefined,
          linkedInboundShipmentIds: changes.linkedInboundShipmentIds,
          items,
        })
        if (changes.carrierChannelId && changes.carrierChannelId !== before.carrierChannelId) await assertChannelUsable(tx, tenantId, changes.carrierChannelId)
        const row = await updateWithVersion(tx.firstMileShipment, { id, tenantId }, version, data as Record<string, unknown>, { label: '头程运单' })
        if (items) {
          await tx.firstMileShipmentItem.deleteMany({ where: { tenantId, shipmentId: id } })
          await tx.firstMileShipmentItem.createMany({ data: items.map(item => ({ ...itemData(tenantId, item), shipmentId: id })) })
        }
        // 货代、运输方式、发货日、实际交付日变化后，新旧两组的时效统计都要重算
        await refreshTransitStats(tx, tenantId, row.forwarderId, row.mode)
        if (row.forwarderId !== before.forwarderId || row.mode !== before.mode) await refreshTransitStats(tx, tenantId, before.forwarderId, before.mode)
        await this.audit.record(
          req,
          {
            action: 'FIRST_MILE_UPDATED',
            resourceType: 'FirstMileShipment',
            resourceId: id,
            before: snapshotOf(before),
            after: snapshotOf(row),
            detail: items ? { itemsReplaced: items.length } : undefined,
          },
          { client: tx },
        )
        return row
      })
      return { id, version: after.version }
    } catch (error) {
      return conflictOnWaybill(error)
    }
  }

  /** 出库：按明细在所选国内仓记“头程发货”出库流水（数量为负），并标记运单已出库。库存不够时整张拒绝。 */
  async outbound(req: RequestWithContext, id: string, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileOutboundBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { items: true } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    if (shipment.outboundAt) throw stateConflict('这张运单已经出库')
    if (!shipment.warehouseId) throw stateConflict('这张运单没有选择出库的国内仓，请先编辑运单选择仓库')
    if (shipment.items.length === 0) throw stateConflict('运单没有明细，无法出库')
    const day = body.outboundAt ?? todayText()
    assertNotFuture(day, '出库日期', 'outboundAt')
    const warehouseId = shipment.warehouseId
    const after = await this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.firstMileShipment, { id, tenantId }, body.version, { outboundAt: new Date() }, { label: '头程运单' })
      const short: string[] = []
      for (const item of shipment.items) {
        const sum = await tx.inventoryMovement.aggregate({ where: { tenantId, warehouseId, sellerSku: item.sku }, _sum: { quantity: true, lockedForShipment: true } })
        const available = (sum._sum.quantity ?? 0) - (sum._sum.lockedForShipment ?? 0)
        if (item.quantity > available) short.push(`${item.sku} 需要 ${item.quantity}，可用 ${available}`)
      }
      if (short.length > 0) throw appError('VALIDATION_FAILED', `国内仓可用库存不足，没有出库：${short.slice(0, 5).join('；')}`, { fieldErrors: { items: short.slice(0, 5) } })
      for (const item of shipment.items) {
        await tx.inventoryMovement.create({
          data: {
            tenantId,
            warehouseId,
            sellerSku: item.sku,
            movementType: 'FIRST_MILE_OUT',
            quantity: -item.quantity,
            referenceType: 'FIRST_MILE',
            referenceId: id,
            reasonCode: 'FIRST_MILE_OUT',
            occurredAt: parseDay(day),
            notes: `头程运单 ${shipment.waybillNo}`,
            createdBy: context.userId,
          },
        })
      }
      await this.audit.record(
        req,
        {
          action: 'FIRST_MILE_OUTBOUND',
          resourceType: 'FirstMileShipment',
          resourceId: id,
          before: { outbound: false },
          after: { outbound: true },
          detail: { warehouseId, outboundAt: day, skus: shipment.items.length },
        },
        { client: tx },
      )
      return row
    })
    return { id, version: after.version, message: `已按 ${shipment.items.length} 个 SKU 在国内仓记出库` }
  }
}
