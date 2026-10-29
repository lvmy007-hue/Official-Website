import { Injectable } from '@nestjs/common'
import {
  COST_METHOD_LABEL,
  movementTypeLabel,
  WarehouseMovementQuerySchema,
  WarehouseStockQuerySchema,
  type WarehouseMovementResponse,
  type WarehouseOption,
  type WarehouseStockResponse,
} from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { stripSensitiveFields, WAREHOUSE_MOVEMENT_RULES, WAREHOUSE_STOCK_RULES } from '../../platform/field-filter'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { isoText, moneyText, parseDay, WAREHOUSE_READ } from './procurement-common'
import { summarizeStock } from './warehouse-math'

type CostMethod = 'WEIGHTED_AVERAGE' | 'FIFO'
const DOMESTIC_KINDS = ['DOMESTIC', 'TRANSIT']

// 国内仓库存与流水（06 章 6.9）。库存由流水汇总而来，没有单独的“库存表”：流水就是账。
@Injectable()
export class WarehouseReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async warehouses(tenantId: string) {
    return this.prisma.warehouse.findMany({ where: { tenantId, kind: { in: DOMESTIC_KINDS }, status: 'ACTIVE' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 50 })
  }

  async stock(req: RequestWithContext, rawQuery: Record<string, string>): Promise<WarehouseStockResponse> {
    const context = await this.context.authorize(req, WAREHOUSE_READ)
    const query = WarehouseStockQuerySchema.parse(rawQuery)
    const all = await this.warehouses(context.tenantId)
    const options: WarehouseOption[] = all.map(row => ({
      id: row.id,
      name: row.name,
      code: row.code,
      kind: row.kind,
      costMethod: row.costMethod,
      costMethodLabel: COST_METHOD_LABEL[row.costMethod as CostMethod] ?? row.costMethod,
    }))
    const scope = query.warehouseId ? all.filter(row => row.id === query.warehouseId) : all
    const empty = { items: [], total: 0, page: query.page, pageSize: query.pageSize, warehouses: options, totals: { onHand: 0, locked: 0, available: 0 } }
    if (!scope.length) return stripSensitiveFields(empty, context.permissions, WAREHOUSE_STOCK_RULES)

    const groups = await this.prisma.inventoryMovement.groupBy({
      by: ['warehouseId', 'sellerSku'],
      where: { tenantId: context.tenantId, warehouseId: { in: scope.map(row => row.id) }, ...(query.q ? { sellerSku: { contains: query.q, mode: 'insensitive' } } : {}) },
      _sum: { quantity: true, lockedForShipment: true },
      orderBy: [{ warehouseId: 'asc' }, { sellerSku: 'asc' }],
      take: 20000,
    })
    const nameOf = new Map(scope.map(row => [row.id, row.name]))
    // 在库与锁定都为 0 的 SKU 不列出（历史上有过流水，但现在没有库存）
    const live = groups
      .map(group => ({ warehouseId: group.warehouseId as string, sku: group.sellerSku, onHand: group._sum.quantity ?? 0, locked: group._sum.lockedForShipment ?? 0 }))
      .filter(row => row.onHand !== 0 || row.locked !== 0)
      .sort((a, b) => (nameOf.get(a.warehouseId) ?? '').localeCompare(nameOf.get(b.warehouseId) ?? '') || a.sku.localeCompare(b.sku))
    const totals = live.reduce((sum, row) => ({ onHand: sum.onHand + row.onHand, locked: sum.locked + row.locked, available: sum.available + row.onHand - row.locked }), {
      onHand: 0,
      locked: 0,
      available: 0,
    })
    const pageRows = live.slice((query.page - 1) * query.pageSize, query.page * query.pageSize)

    const moves = pageRows.length
      ? await this.prisma.inventoryMovement.findMany({
          where: { tenantId: context.tenantId, OR: pageRows.map(row => ({ warehouseId: row.warehouseId, sellerSku: row.sku })) },
          select: { warehouseId: true, sellerSku: true, occurredAt: true, quantity: true, lockedForShipment: true, unitCost: true, currency: true },
          take: 20000,
        })
      : []
    const methodOf = new Map(scope.map(row => [row.id, row.costMethod as CostMethod]))
    // 待出库：已选这个仓、还没出库的头程运单明细（P2a-11）
    const pending = pageRows.length
      ? await this.prisma.firstMileShipmentItem.findMany({
          where: { tenantId: context.tenantId, sku: { in: pageRows.map(row => row.sku) }, shipment: { outboundAt: null, warehouseId: { in: scope.map(row => row.id) } } },
          select: { sku: true, quantity: true, shipment: { select: { warehouseId: true } } },
          take: 20000,
        })
      : []
    const now = new Date()
    const items = pageRows.map(row => {
      const own = moves
        .filter(move => move.warehouseId === row.warehouseId && move.sellerSku === row.sku)
        .map(move => ({ ...move, unitCost: move.unitCost === null ? null : move.unitCost.toNumber() }))
      const summary = summarizeStock(own, methodOf.get(row.warehouseId) ?? 'WEIGHTED_AVERAGE', now)
      return {
        warehouseId: row.warehouseId,
        warehouseName: nameOf.get(row.warehouseId) ?? '',
        sku: row.sku,
        onHand: summary.onHand,
        locked: summary.locked,
        available: summary.available,
        pendingOutbound: pending.filter(item => item.sku === row.sku && item.shipment.warehouseId === row.warehouseId).reduce((sum, item) => sum + item.quantity, 0),
        ageDays: summary.ageDays,
        value: summary.value === null ? null : String(summary.value),
        valueCurrency: summary.currency,
        valueNote: summary.valueNote,
      }
    })
    return stripSensitiveFields({ items, total: live.length, page: query.page, pageSize: query.pageSize, warehouses: options, totals }, context.permissions, WAREHOUSE_STOCK_RULES)
  }

  async movements(req: RequestWithContext, rawQuery: Record<string, string>): Promise<WarehouseMovementResponse> {
    const context = await this.context.authorize(req, WAREHOUSE_READ)
    const query = WarehouseMovementQuerySchema.parse(rawQuery)
    const all = await this.warehouses(context.tenantId)
    const scope = query.warehouseId ? all.filter(row => row.id === query.warehouseId) : all
    const nameOf = new Map(all.map(row => [row.id, row.name]))
    const where: Prisma.InventoryMovementWhereInput = {
      tenantId: context.tenantId,
      warehouseId: { in: scope.map(row => row.id) },
      ...(query.type ? { movementType: query.type } : {}),
      ...(query.q ? { sellerSku: { contains: query.q, mode: 'insensitive' } } : {}),
      ...(query.from || query.to ? { occurredAt: { ...(query.from ? { gte: parseDay(query.from) } : {}), ...(query.to ? { lt: new Date(parseDay(query.to).getTime() + 86_400_000) } : {}) } } : {}),
    }
    const [rows, total] = await Promise.all([
      this.prisma.inventoryMovement.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.inventoryMovement.count({ where }),
    ])
    const poIds = [...new Set(rows.filter(row => row.referenceType === 'PURCHASE_ORDER' && row.referenceId).map(row => row.referenceId as string))]
    const orders = poIds.length ? await this.prisma.purchaseOrder.findMany({ where: { tenantId: context.tenantId, id: { in: poIds } }, select: { id: true, number: true }, take: 200 }) : []
    const numbers = new Map(orders.map(order => [order.id, order.number]))
    // 头程发货出库（P2a-11）：来源单号显示运单号
    const shipmentIds = [...new Set(rows.filter(row => row.referenceType === 'FIRST_MILE' && row.referenceId).map(row => row.referenceId as string))]
    const shipments = shipmentIds.length
      ? await this.prisma.firstMileShipment.findMany({ where: { tenantId: context.tenantId, id: { in: shipmentIds } }, select: { id: true, waybillNo: true }, take: 200 })
      : []
    for (const shipment of shipments) numbers.set(shipment.id, shipment.waybillNo)
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      rows.map(row => row.createdBy),
    )
    const items = rows.map(row => ({
      id: row.id,
      occurredAt: isoText(row.occurredAt) as string,
      warehouseName: nameOf.get(row.warehouseId ?? '') ?? '',
      sku: row.sellerSku,
      movementType: row.movementType,
      typeLabel: movementTypeLabel(row.movementType),
      quantity: row.quantity,
      lockedForShipment: row.lockedForShipment,
      reasonCode: row.reasonCode,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      referenceNo: (row.referenceType === 'PURCHASE_ORDER' || row.referenceType === 'FIRST_MILE') && row.referenceId ? (numbers.get(row.referenceId) ?? null) : null,
      notes: row.notes,
      operatorName: nameOrFormer(names, row.createdBy),
      unitCost: moneyText(row.unitCost),
      currency: row.currency,
    }))
    return stripSensitiveFields({ items, total, page: query.page, pageSize: query.pageSize }, context.permissions, WAREHOUSE_MOVEMENT_RULES)
  }
}
