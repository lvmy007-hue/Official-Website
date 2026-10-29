import { Injectable } from '@nestjs/common'
import {
  STOCK_COUNT_STATUS_LABEL,
  StockCountApprovalBodySchema,
  StockCountBodySchema,
  StockCountListQuerySchema,
  type StockCountLine,
  type StockCountListResponse,
  type StockCountRow,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { Prisma, type StockCount } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService } from '../auth'
import { assertNotFuture, dayText, isoText, isUniqueViolation, parseDay, stateConflict, STOCK_COUNT_APPROVE, STOCK_COUNT_WRITE, WAREHOUSE_READ } from './procurement-common'
import { summarizeStock } from './warehouse-math'

const linesOf = (json: Prisma.JsonValue): StockCountLine[] => (Array.isArray(json) ? (json as unknown as StockCountLine[]) : [])

// 盘点：录入盘点数 → 提交审批 → 另一个人通过后，按差异在国内仓记“库存调整”流水（盘盈带当前单位成本，盘亏只减数量）。
// 系统数量在保存时按流水合计固定下来；过账用的是这份差异，所以保存之后到审批之前如果仓里又有进出，审批会因库存不足被拒绝并要求重新盘点。
@Injectable()
export class StockCountService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<StockCountListResponse> {
    const context = await this.context.authorize(req, WAREHOUSE_READ)
    const query = StockCountListQuerySchema.parse(rawQuery)
    const where: Prisma.StockCountWhereInput = { tenantId: context.tenantId, ...(query.warehouseId ? { warehouseId: query.warehouseId } : {}), ...(query.status ? { status: query.status } : {}) }
    const [rows, total] = await Promise.all([
      this.prisma.stockCount.findMany({
        where,
        include: { warehouse: { select: { name: true } } },
        orderBy: [{ countedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.stockCount.count({ where }),
    ])
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.flatMap(row => [row.createdBy, row.approvedBy]),
    )
    const mayApprove = hasPermission(context.permissions, STOCK_COUNT_APPROVE)
    const items: StockCountRow[] = rows.map(row => {
      const lines = linesOf(row.linesJson)
      return {
        id: row.id,
        warehouseId: row.warehouseId,
        warehouseName: row.warehouse.name,
        status: row.status,
        statusLabel: STOCK_COUNT_STATUS_LABEL[row.status] ?? row.status,
        countedAt: dayText(row.countedAt) as string,
        lines,
        diffTotal: lines.reduce((sum, line) => sum + line.diff, 0),
        note: row.note,
        reviewNote: row.reviewNote,
        createdByName: nameOrFormer(names, row.createdBy),
        approvedByName: row.approvedBy ? nameOrFormer(names, row.approvedBy) : null,
        approvedAt: isoText(row.approvedAt),
        canApprove: mayApprove && row.status === 'PENDING_APPROVAL' && row.createdBy !== context.userId,
      }
    })
    return { items, total, page: query.page, pageSize: query.pageSize }
  }

  /** 保存或提交盘点：同一仓同一天只有一张盘点单，“盘点中”时可以反复保存。 */
  async save(req: RequestWithContext, rawBody: unknown): Promise<{ id: string; status: string; statusLabel: string }> {
    const context = await this.context.authorize(req, STOCK_COUNT_WRITE)
    const body = StockCountBodySchema.parse(rawBody)
    assertNotFuture(body.countedAt, '盘点日期')
    const skus = body.lines.map(line => line.sellerSku)
    if (new Set(skus.map(sku => sku.toLowerCase())).size !== skus.length) throw appError('VALIDATION_FAILED', '同一个 SKU 只能录入一次', { fieldErrors: { lines: ['SKU 重复'] } })
    const warehouse = await this.prisma.warehouse.findFirst({
      where: { id: body.warehouseId, tenantId: context.tenantId, kind: { in: ['DOMESTIC', 'TRANSIT'] }, status: 'ACTIVE' },
      select: { id: true },
    })
    if (!warehouse) throw appError('VALIDATION_FAILED', '所选仓库不存在或不是有效的国内仓', { fieldErrors: { warehouseId: ['所选仓库不存在或不是有效的国内仓'] } })
    const sums = await this.prisma.inventoryMovement.groupBy({
      by: ['sellerSku'],
      where: { tenantId: context.tenantId, warehouseId: warehouse.id, sellerSku: { in: skus } },
      _sum: { quantity: true },
      orderBy: { sellerSku: 'asc' },
      take: 1000,
    })
    const system = new Map(sums.map(row => [row.sellerSku, row._sum.quantity ?? 0]))
    const lines: StockCountLine[] = body.lines.map(line => {
      const systemQty = system.get(line.sellerSku) ?? 0
      return { sellerSku: line.sellerSku, systemQty, countedQty: line.countedQty, diff: line.countedQty - systemQty }
    })
    const status = body.submit ? 'PENDING_APPROVAL' : 'COUNTING'
    const countedAt = parseDay(body.countedAt)
    try {
      const row = await this.prisma.$transaction(async tx => {
        const existing = await tx.stockCount.findFirst({ where: { tenantId: context.tenantId, warehouseId: warehouse.id, countedAt } })
        if (existing && existing.status !== 'COUNTING') throw stateConflict('这一天这个仓库的盘点单已经提交或过账，不能再修改', existing.status)
        const data = { status, linesJson: lines as unknown as Prisma.InputJsonValue, note: body.note ?? null, reviewNote: null, createdBy: context.userId }
        const saved = existing
          ? await tx.stockCount.update({ where: { id: existing.id }, data })
          : await tx.stockCount.create({ data: { tenantId: context.tenantId, warehouseId: warehouse.id, countedAt, ...data } })
        await this.audit.record(
          req,
          {
            action: body.submit ? 'STOCK_COUNT_SUBMITTED' : 'STOCK_COUNT_SAVED',
            resourceType: 'StockCount',
            resourceId: saved.id,
            after: { warehouseId: warehouse.id, countedAt: body.countedAt, lineCount: lines.length, status },
          },
          { client: tx },
        )
        return saved
      })
      return { id: row.id, status: row.status, statusLabel: STOCK_COUNT_STATUS_LABEL[row.status] ?? row.status }
    } catch (error) {
      if (isUniqueViolation(error)) throw appError('CONFLICT', '这一天这个仓库的盘点单刚被别人创建，请刷新后继续')
      throw error
    }
  }

  async approve(req: RequestWithContext, id: string, rawBody: unknown): Promise<{ id: string; status: string; statusLabel: string }> {
    const context = await this.context.authorize(req, STOCK_COUNT_APPROVE)
    const body = StockCountApprovalBodySchema.parse(rawBody)
    const count = await this.prisma.stockCount.findFirst({ where: { id, tenantId: context.tenantId }, include: { warehouse: { select: { costMethod: true } } } })
    if (!count) throw appError('RESOURCE_NOT_FOUND', '盘点单不存在')
    if (count.status !== 'PENDING_APPROVAL') throw stateConflict('这张盘点单不在待审批状态', count.status)
    if (count.createdBy === context.userId) throw appError('TENANT_ACCESS_DENIED', '录入盘点的人不能审批自己的盘点单，请换一位有审批权限的成员')
    const approved = body.decision === 'APPROVED'
    const status = approved ? 'POSTED' : 'COUNTING'
    await this.prisma.$transaction(async tx => {
      const settled = await tx.stockCount.updateMany({
        where: { id, tenantId: context.tenantId, status: 'PENDING_APPROVAL' },
        data: { status, reviewNote: body.comment ?? null, ...(approved ? { approvedBy: context.userId, approvedAt: new Date() } : {}) },
      })
      if (settled.count === 0) throw stateConflict('这张盘点单已被处理', count.status)
      if (approved) await this.post(tx, context.tenantId, context.userId, count)
      await this.audit.record(
        req,
        {
          action: approved ? 'STOCK_COUNT_APPROVED' : 'STOCK_COUNT_REJECTED',
          resourceType: 'StockCount',
          resourceId: id,
          before: { status: count.status },
          after: { status },
          ...(body.comment ? { reason: body.comment } : {}),
        },
        { client: tx },
      )
    })
    return { id, status, statusLabel: STOCK_COUNT_STATUS_LABEL[status] ?? status }
  }

  /** 过账：每个有差异的 SKU 记一条库存调整流水。盘盈带当前单位成本（算不出就留空）；盘亏不能让在库变成负数。 */
  private async post(tx: Prisma.TransactionClient, tenantId: string, userId: string, count: StockCount & { warehouse: { costMethod: string } }) {
    const lines = linesOf(count.linesJson).filter(line => line.diff !== 0)
    if (!lines.length) return
    const moves = await tx.inventoryMovement.findMany({
      where: { tenantId, warehouseId: count.warehouseId, sellerSku: { in: lines.map(line => line.sellerSku) } },
      select: { sellerSku: true, occurredAt: true, quantity: true, lockedForShipment: true, unitCost: true, currency: true },
      take: 20000,
    })
    const method = count.warehouse.costMethod === 'FIFO' ? 'FIFO' : 'WEIGHTED_AVERAGE'
    const now = new Date()
    for (const line of lines) {
      const own = moves.filter(move => move.sellerSku === line.sellerSku).map(move => ({ ...move, unitCost: move.unitCost === null ? null : move.unitCost.toNumber() }))
      const summary = summarizeStock(own, method, now)
      if (summary.onHand + line.diff < 0) {
        throw appError('DATA_CONDITION_FAILED', `${line.sellerSku} 在盘点保存之后库存又发生了变化（现在在库 ${summary.onHand}，差异 ${line.diff}），请驳回后重新盘点`, {
          details: { status: count.status },
        })
      }
      const cost = line.diff > 0 && summary.unitCost !== null && summary.currency ? { unitCost: new Prisma.Decimal(summary.unitCost).toDecimalPlaces(6), currency: summary.currency } : {}
      await tx.inventoryMovement.create({
        data: {
          tenantId,
          warehouseId: count.warehouseId,
          sellerSku: line.sellerSku,
          movementType: 'ADJUSTMENT',
          quantity: line.diff,
          referenceType: 'STOCK_COUNT',
          referenceId: count.id,
          reasonCode: 'STOCK_COUNT',
          occurredAt: now,
          notes: `盘点 ${dayText(count.countedAt)}：系统 ${line.systemQty}，实盘 ${line.countedQty}`,
          createdBy: userId,
          ...cost,
        },
      })
    }
  }
}
