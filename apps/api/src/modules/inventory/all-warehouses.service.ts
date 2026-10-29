import { Injectable } from '@nestjs/common'
import {
  AllWarehousesQuerySchema,
  AW_COLUMNS,
  INVENTORY_REPORT_PERMISSION,
  STOCK_REPORT_LIMIT,
  US_MARKETPLACE_ID,
  WAREHOUSE_PERMISSION,
  type AwColumnKey,
  type AwResponse,
  type CostPoint,
} from '@nova/api-contracts'
import { canSeeField, hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { Stacker, priced, sortRows, summaryOf } from './all-warehouses-math'
import { sourceFreshness } from './inventory-freshness'
import { InventoryPolicyService } from './inventory-policy.service'
import { indexCosts } from './movement-math'

// 跨仓总览（P6-25，16 章第 4 节）：按 SKU 聚合 FBA、AWD、国内仓、头程在途，可以展开到每个仓。
// “在途”和“已到仓”互斥（验收要求）：国内仓库存来自流水（头程出库时已扣减）；头程在途只含“已出库、未送达、没有关联亚马逊货件”的运单，
// 关联了亚马逊货件的由 FBA 入库中计入；AWD 发往 FBA 在途与 FBA 入库中是同一批货，只展示不计入合计。
// 国内仓与头程不按店铺划分，只对有仓库读取权限的成员显示；货值需要成本字段权限。

const DOMESTIC_KINDS = ['DOMESTIC', 'TRANSIT']
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date) => date.toISOString().slice(0, 10)
const num = (value: { toString(): string } | null) => (value === null ? null : Number(value.toString()))

@Injectable()
export class AllWarehousesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly policies: InventoryPolicyService,
  ) {}

  async report(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AwResponse> {
    // 先做权限检查再解析参数
    const { context, scope } = await this.context.authorizeScoped(req, INVENTORY_REPORT_PERMISSION, rawQuery)
    const input = AllWarehousesQuerySchema.parse(rawQuery)
    const { tenantId } = context
    const withWarehouse = hasPermission(context.permissions, WAREHOUSE_PERMISSION)
    const costRestricted = !canSeeField(context.permissions, 'cost')
    const today = await this.policies.todayOf(tenantId)
    const stacker = new Stacker()
    const truncated = (
      await Promise.all([
        this.loadFba(tenantId, scope, stacker),
        this.loadAwd(tenantId, scope, stacker),
        withWarehouse ? this.loadDomestic(tenantId, stacker) : false,
        withWarehouse ? this.loadTransit(tenantId, stacker) : false,
      ])
    ).some(Boolean)
    const base = stacker.rows()
    const needle = input.q?.toLowerCase()
    const matched = needle ? base.filter(row => row.sku.toLowerCase().includes(needle) || (row.title ?? '').toLowerCase().includes(needle)) : base
    const costs = costRestricted
      ? null
      : indexCosts(
          await this.costPoints(
            tenantId,
            matched.map(row => row.sku),
            today,
          ),
        )
    const rows = priced(matched, costs, today)
    const sorted = sortRows(rows, input.sort.field as 'sku', input.sort.dir)
    const start = (input.page - 1) * input.pageSize
    const restrictions: AwResponse['restrictions'] = withWarehouse
      ? []
      : [{ metrics: AW_COLUMNS.filter(item => item.need === 'warehouse').map(item => item.key as AwColumnKey), reason: '需要仓库读取权限' }]
    return {
      state: base.length ? 'OK' : 'NO_DATA',
      note: base.length ? null : '尚无库存数据：店铺授权并完成库存同步（FBA、AWD）、国内仓入库后这里按 SKU 汇总各仓数量',
      items: sorted.slice(start, start + input.pageSize),
      total: sorted.length,
      page: input.page,
      pageSize: input.pageSize,
      summary: summaryOf(rows),
      restrictions,
      costRestricted,
      truncated,
      freshness: await sourceFreshness(this.prisma, tenantId, scope, ['inventory.api']),
    }
  }

  private async loadFba(tenantId: string, scope: ResolvedScope, stacker: Stacker): Promise<boolean> {
    const [records, products, stores] = await Promise.all([
      this.prisma.fbaInventoryRecord.findMany({
        where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
        select: {
          sellerAccountId: true,
          sellerSku: true,
          fulfillableQuantity: true,
          reservedQuantity: true,
          unfulfillableQuantity: true,
          inboundWorkingQuantity: true,
          inboundShippedQuantity: true,
          inboundReceivingQuantity: true,
        },
        orderBy: [{ id: 'asc' }],
        take: STOCK_REPORT_LIMIT + 1,
      }),
      this.prisma.fbaProduct.findMany({
        where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
        select: { sellerSku: true, title: true },
        orderBy: [{ id: 'asc' }],
        take: STOCK_REPORT_LIMIT,
      }),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, take: 500 }),
    ])
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    for (const row of records.slice(0, STOCK_REPORT_LIMIT)) {
      stacker.add({
        sku: row.sellerSku,
        kind: 'FBA',
        ownerId: row.sellerAccountId,
        label: names.get(row.sellerAccountId) ?? '',
        cells: {
          fbaSellable: row.fulfillableQuantity,
          fbaReserved: row.reservedQuantity,
          fbaUnsellable: row.unfulfillableQuantity,
          fbaInbound: row.inboundWorkingQuantity + row.inboundShippedQuantity + row.inboundReceivingQuantity,
        },
      })
    }
    for (const product of products) stacker.title(product.sellerSku, product.title)
    return records.length > STOCK_REPORT_LIMIT || products.length >= STOCK_REPORT_LIMIT
  }

  /** AWD：每个店铺与 SKU 取最近一天的快照。 */
  private async loadAwd(tenantId: string, scope: ResolvedScope, stacker: Stacker): Promise<boolean> {
    const [rows, stores] = await Promise.all([
      this.prisma.awdInventory.findMany({
        where: { tenantId, ...storeWhere(scope) },
        select: { sellerAccountId: true, sku: true, snapshotDate: true, onhandQty: true, inboundToAwdQty: true, outboundToFbaInTransit: true },
        orderBy: [{ snapshotDate: 'desc' }, { id: 'asc' }],
        take: STOCK_REPORT_LIMIT + 1,
      }),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, take: 500 }),
    ])
    const names = new Map(stores.map(store => [store.id, store.displayName]))
    const seen = new Set<string>()
    for (const row of rows.slice(0, STOCK_REPORT_LIMIT)) {
      const key = `${row.sellerAccountId}|${row.sku}`
      if (seen.has(key)) continue
      seen.add(key)
      stacker.add({
        sku: row.sku,
        kind: 'AWD',
        ownerId: row.sellerAccountId,
        label: names.get(row.sellerAccountId) ?? '',
        cells: { awdOnhand: row.onhandQty, awdInbound: row.inboundToAwdQty, awdToFba: row.outboundToFbaInTransit },
      })
    }
    return rows.length > STOCK_REPORT_LIMIT
  }

  /** 国内仓在库：流水数量汇总（同一个仓同一个 SKU 一行）；在库为 0 的 SKU 不列出。 */
  private async loadDomestic(tenantId: string, stacker: Stacker): Promise<boolean> {
    const warehouses = await this.prisma.warehouse.findMany({
      where: { tenantId, kind: { in: DOMESTIC_KINDS }, status: 'ACTIVE' },
      select: { id: true, name: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 50,
    })
    if (warehouses.length === 0) return false
    const groups = await this.prisma.inventoryMovement.groupBy({
      by: ['warehouseId', 'sellerSku'],
      where: { tenantId, warehouseId: { in: warehouses.map(row => row.id) } },
      _sum: { quantity: true },
      orderBy: [{ warehouseId: 'asc' }, { sellerSku: 'asc' }],
      take: STOCK_REPORT_LIMIT + 1,
    })
    const names = new Map(warehouses.map(row => [row.id, row.name]))
    for (const group of groups.slice(0, STOCK_REPORT_LIMIT)) {
      const onhand = group._sum.quantity ?? 0
      if (!group.warehouseId || onhand === 0) continue
      stacker.add({ sku: group.sellerSku, kind: 'DOMESTIC', ownerId: group.warehouseId, label: names.get(group.warehouseId) ?? '', cells: { domesticOnhand: onhand } })
    }
    return groups.length > STOCK_REPORT_LIMIT
  }

  /** 头程在途：已出库、未送达、没有关联亚马逊货件的运单明细（关联了的由 FBA 入库中计入，不重复）。 */
  private async loadTransit(tenantId: string, stacker: Stacker): Promise<boolean> {
    const items = await this.prisma.firstMileShipmentItem.findMany({
      where: { tenantId, shipment: { outboundAt: { not: null }, ataDelivery: null, linkedInboundShipmentIds: { isEmpty: true } } },
      select: { sku: true, quantity: true, shipmentId: true, shipment: { select: { waybillNo: true } } },
      orderBy: [{ id: 'asc' }],
      take: STOCK_REPORT_LIMIT + 1,
    })
    for (const item of items.slice(0, STOCK_REPORT_LIMIT)) {
      stacker.add({ sku: item.sku, kind: 'FIRST_MILE', ownerId: item.shipmentId, label: item.shipment.waybillNo, cells: { firstMileTransit: item.quantity } })
    }
    return items.length > STOCK_REPORT_LIMIT
  }

  private async costPoints(tenantId: string, skus: readonly string[], today: string): Promise<CostPoint[]> {
    if (skus.length === 0) return []
    const rows = await this.prisma.costVersion.findMany({
      where: { tenantId, status: 'ACTIVE', sku: { in: [...skus] }, effectiveFrom: { lte: asDate(today) } },
      select: { sku: true, versionNo: true, effectiveFrom: true, currency: true, unitProductCost: true, unitFirstMileCost: true, unitDutyCost: true, unitOtherCost: true },
      orderBy: [{ sku: 'asc' }, { versionNo: 'asc' }],
      take: STOCK_REPORT_LIMIT,
    })
    return rows.map(row => ({
      sku: row.sku,
      versionNo: row.versionNo,
      effectiveFrom: dateText(row.effectiveFrom),
      currency: row.currency,
      unitProductCost: num(row.unitProductCost),
      unitFirstMileCost: num(row.unitFirstMileCost),
      unitDutyCost: num(row.unitDutyCost),
      unitOtherCost: num(row.unitOtherCost),
    }))
  }
}
