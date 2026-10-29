import { Injectable } from '@nestjs/common'
import { ALLOCATION_METHOD_LABEL, FirstMileAllocateBodySchema, FirstMileVersionQuerySchema, type FirstMileActionResult } from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { allocateCost } from './allocation-math'
import { dayText, FM_WRITE, parseDay, stateConflict, todayText } from './first-mile-common'

// 头程费用分摊与撤销（06 章 6.10）：把运单的实际费用合计按所选口径分摊到 SKU，结果同时写入成本版本草稿。
// 草稿的来源是 FIRST_MILE_ALLOCATION、来源单据是运单编号；它只带“头程成本”一列，采购成本留空，
// 与采购收货生成的草稿合并、生效与替换由商品成本页面（P2b-14）负责。重新分摊要先撤销；草稿已生效或被替换后不能撤销。
@Injectable()
export class FirstMileAllocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async allocate(req: RequestWithContext, id: string, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileAllocateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { items: true, costs: true, _count: { select: { allocations: true } } } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    if (shipment._count.allocations > 0) throw stateConflict('这张运单已经分摊过，要重新分摊请先撤销')
    if (shipment.costs.length === 0) throw stateConflict('还没有录入任何费用，无法分摊')
    if (shipment.items.length === 0) throw stateConflict('运单没有明细，无法分摊')
    const total = shipment.costs.reduce((sum, cost) => sum.plus(cost.amount), new Prisma.Decimal(0))
    const result = allocateCost(shipment.items, body.method, total)
    if (!result.ok) throw appError('VALIDATION_FAILED', `无法${ALLOCATION_METHOD_LABEL[body.method]}分摊：${result.reason}`, { fieldErrors: { method: [result.reason] } })
    // 草稿的生效日期建议取实际交付日，没有就取预计交付日，再没有取今天；真正生效日由商品成本页面确认
    const effectiveFrom = parseDay(dayText(shipment.ataDelivery) ?? dayText(shipment.etaDelivery) ?? todayText())
    const after = await this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.firstMileShipment, { id, tenantId }, body.version, {}, { label: '头程运单' })
      for (const line of result.lines) {
        const latest = await tx.costVersion.findFirst({ where: { tenantId, sku: line.sku }, orderBy: { versionNo: 'desc' }, select: { versionNo: true } })
        const version = await tx.costVersion.create({
          data: {
            tenantId,
            sku: line.sku,
            versionNo: (latest?.versionNo ?? 0) + 1,
            effectiveFrom,
            currency: shipment.currency,
            unitFirstMileCost: line.unitCost,
            source: 'FIRST_MILE_ALLOCATION',
            status: 'DRAFT',
            sourceDocId: id,
          },
        })
        await tx.landedCostAllocation.create({
          data: {
            tenantId,
            firstMileShipmentId: id,
            sku: line.sku,
            method: body.method,
            quantity: line.quantity,
            allocatedAmount: line.amount,
            currency: shipment.currency,
            costVersionId: version.id,
            createdBy: context.userId,
          },
        })
      }
      await this.audit.record(
        req,
        {
          action: 'FIRST_MILE_ALLOCATED',
          resourceType: 'FirstMileShipment',
          resourceId: id,
          after: { method: body.method, total: total.toString(), currency: shipment.currency, skus: result.lines.length },
        },
        { client: tx },
      )
      return row
    })
    return { id, version: after.version, message: `已按${ALLOCATION_METHOD_LABEL[body.method]}分摊 ${total.toString()} ${shipment.currency}，并生成 ${result.lines.length} 条成本版本草稿` }
  }

  async revert(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version } = FirstMileVersionQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, select: { id: true } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    const allocations = await this.prisma.landedCostAllocation.findMany({ where: { tenantId, firstMileShipmentId: id }, include: { costVersion: { select: { status: true } } }, take: 500 })
    if (allocations.length === 0) throw stateConflict('这张运单还没有分摊')
    const locked = allocations.filter(row => row.costVersion && row.costVersion.status !== 'DRAFT')
    if (locked.length > 0) throw stateConflict(`有 ${locked.length} 条成本版本已生效或已被替换，不能撤销分摊；请到商品成本页面处理`)
    const after = await this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.firstMileShipment, { id, tenantId }, version, {}, { label: '头程运单' })
      const versionIds = allocations.flatMap(item => (item.costVersionId ? [item.costVersionId] : []))
      await tx.landedCostAllocation.deleteMany({ where: { tenantId, firstMileShipmentId: id } })
      if (versionIds.length > 0) await tx.costVersion.deleteMany({ where: { tenantId, id: { in: versionIds }, status: 'DRAFT', source: 'FIRST_MILE_ALLOCATION' } })
      await this.audit.record(
        req,
        {
          action: 'FIRST_MILE_ALLOCATION_REVERTED',
          resourceType: 'FirstMileShipment',
          resourceId: id,
          before: { method: allocations[0].method, skus: allocations.length },
          detail: { revertedAt: todayText() },
        },
        { client: tx },
      )
      return row
    })
    return { id, version: after.version, message: '已撤销分摊并删除对应的成本版本草稿' }
  }
}
