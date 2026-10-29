import { Injectable } from '@nestjs/common'
import {
  FIRST_MILE_COST_LABEL,
  FirstMileCostBodySchema,
  FirstMileMilestoneBodySchema,
  FirstMileMilestoneImportBodySchema,
  FirstMileVersionQuerySchema,
  type FirstMileActionResult,
  type MilestoneImportResponse,
} from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { assertNotFuture, FM_WRITE, isUniqueViolation, parseDay, stateConflict } from './first-mile-common'
import { parseMilestoneFile } from './milestone-file'

const LOCKED = '费用已分摊，不能再增删费用，请先撤销分摊'

// 运输节点与费用明细（06 章 6.10）：节点由我方录入或导入货代文件；费用逐笔录入，币种必须与运单一致。
// 每次写入都带运单版本号并让它加一：同一时刻别人改了运单或做了分摊，这里会提示刷新而不是悄悄覆盖。
@Injectable()
export class FirstMileRecordService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  private async load(tenantId: string, id: string) {
    const shipment = await this.prisma.firstMileShipment.findFirst({ where: { id, tenantId }, include: { _count: { select: { allocations: true } } } })
    if (!shipment) throw appError('RESOURCE_NOT_FOUND', '头程运单不存在')
    return shipment
  }

  async addMilestone(req: RequestWithContext, id: string, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileMilestoneBodySchema.parse(rawBody)
    const occurredAt = new Date(body.occurredAt)
    if (occurredAt.getTime() > Date.now() + 86_400_000) throw appError('VALIDATION_FAILED', '节点发生时间不能晚于今天', { fieldErrors: { occurredAt: ['不能晚于今天'] } })
    await this.load(context.tenantId, id)
    try {
      const row = await this.prisma.$transaction(async tx => {
        const next = await updateWithVersion(tx.firstMileShipment, { id, tenantId: context.tenantId }, body.version, {}, { label: '头程运单' })
        await tx.firstMileMilestone.create({
          data: {
            tenantId: context.tenantId,
            shipmentId: id,
            milestone: body.milestone,
            occurredAt,
            location: body.location || null,
            source: 'MANUAL',
            note: body.note || null,
            createdBy: context.userId,
          },
        })
        await this.audit.record(
          req,
          { action: 'FIRST_MILE_MILESTONE_ADDED', resourceType: 'FirstMileShipment', resourceId: id, after: { milestone: body.milestone, occurredAt: occurredAt.toISOString() } },
          { client: tx },
        )
        return next
      })
      return { id, version: row.version }
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '这个节点在同一时间已经录过了', { fieldErrors: { milestone: ['同一节点同一时间只能录一次'] } })
      throw error
    }
  }

  /** 只能删除我方手工录入的节点；货代文件导入的节点保持与文件一致，不在这里删。 */
  async deleteMilestone(req: RequestWithContext, id: string, milestoneId: string, rawQuery: Record<string, string>): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version } = FirstMileVersionQuerySchema.parse(rawQuery)
    await this.load(context.tenantId, id)
    const milestone = await this.prisma.firstMileMilestone.findFirst({ where: { id: milestoneId, tenantId: context.tenantId, shipmentId: id } })
    if (!milestone) throw appError('RESOURCE_NOT_FOUND', '节点不存在')
    if (milestone.source !== 'MANUAL') throw stateConflict('只能删除手工录入的节点')
    const row = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.firstMileShipment, { id, tenantId: context.tenantId }, version, {}, { label: '头程运单' })
      await tx.firstMileMilestone.delete({ where: { id: milestoneId } })
      await this.audit.record(
        req,
        { action: 'FIRST_MILE_MILESTONE_DELETED', resourceType: 'FirstMileShipment', resourceId: id, before: { milestone: milestone.milestone, occurredAt: milestone.occurredAt.toISOString() } },
        { client: tx },
      )
      return next
    })
    return { id, version: row.version }
  }

  async importMilestones(req: RequestWithContext, id: string, rawBody: unknown): Promise<MilestoneImportResponse> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileMilestoneImportBodySchema.parse(rawBody)
    const shipment = await this.load(context.tenantId, id)
    const parsed = parseMilestoneFile(body.content, shipment.waybillNo)
    if (parsed.errors.length > 0) throw appError('VALIDATION_FAILED', '文件内容有误，没有导入任何数据', { fieldErrors: { content: parsed.errors } })
    const outcome = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.firstMileShipment, { id, tenantId: context.tenantId }, body.version, {}, { label: '头程运单' })
      // 同一节点同一时间已存在的行跳过（重复导入同一份文件不会重复），其余写入
      const created = await tx.firstMileMilestone.createMany({
        data: parsed.rows.map(row => ({
          tenantId: context.tenantId,
          shipmentId: id,
          milestone: row.milestone,
          occurredAt: row.occurredAt,
          location: row.location,
          note: row.note,
          source: 'FILE_IMPORT',
          createdBy: context.userId,
        })),
        skipDuplicates: true,
      })
      await this.audit.record(
        req,
        { action: 'FIRST_MILE_MILESTONES_IMPORTED', resourceType: 'FirstMileShipment', resourceId: id, after: { fileName: body.fileName, rows: parsed.rows.length, imported: created.count } },
        { client: tx },
      )
      return { version: next.version, imported: created.count }
    })
    return { imported: outcome.imported, skippedDuplicates: parsed.rows.length - outcome.imported, sourceFileName: body.fileName, version: outcome.version }
  }

  async addCost(req: RequestWithContext, id: string, rawBody: unknown): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const body = FirstMileCostBodySchema.parse(rawBody)
    assertNotFuture(body.incurredAt, '费用发生日', 'incurredAt')
    const shipment = await this.load(context.tenantId, id)
    if (shipment._count.allocations > 0) throw stateConflict(LOCKED)
    const row = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.firstMileShipment, { id, tenantId: context.tenantId }, body.version, {}, { label: '头程运单' })
      await tx.firstMileCost.create({
        data: {
          tenantId: context.tenantId,
          shipmentId: id,
          item: body.item,
          amount: new Prisma.Decimal(body.amount),
          currency: shipment.currency,
          incurredAt: parseDay(body.incurredAt),
          note: body.note || null,
          createdBy: context.userId,
        },
      })
      await this.audit.record(
        req,
        { action: 'FIRST_MILE_COST_ADDED', resourceType: 'FirstMileShipment', resourceId: id, after: { item: FIRST_MILE_COST_LABEL[body.item], amount: body.amount, currency: shipment.currency } },
        { client: tx },
      )
      return next
    })
    return { id, version: row.version }
  }

  async deleteCost(req: RequestWithContext, id: string, costId: string, rawQuery: Record<string, string>): Promise<FirstMileActionResult> {
    const context = await this.context.authorize(req, FM_WRITE)
    const { version } = FirstMileVersionQuerySchema.parse(rawQuery)
    const shipment = await this.load(context.tenantId, id)
    if (shipment._count.allocations > 0) throw stateConflict(LOCKED)
    const cost = await this.prisma.firstMileCost.findFirst({ where: { id: costId, tenantId: context.tenantId, shipmentId: id } })
    if (!cost) throw appError('RESOURCE_NOT_FOUND', '费用记录不存在')
    const row = await this.prisma.$transaction(async tx => {
      const next = await updateWithVersion(tx.firstMileShipment, { id, tenantId: context.tenantId }, version, {}, { label: '头程运单' })
      await tx.firstMileCost.delete({ where: { id: costId } })
      await this.audit.record(
        req,
        {
          action: 'FIRST_MILE_COST_DELETED',
          resourceType: 'FirstMileShipment',
          resourceId: id,
          before: { item: FIRST_MILE_COST_LABEL[cost.item as keyof typeof FIRST_MILE_COST_LABEL], amount: cost.amount.toString(), currency: cost.currency },
        },
        { client: tx },
      )
      return next
    })
    return { id, version: row.version }
  }
}
