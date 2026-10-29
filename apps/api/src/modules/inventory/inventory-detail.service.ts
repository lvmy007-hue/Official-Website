import { Injectable } from '@nestjs/common'
import {
  InventoryLedgerQuerySchema,
  ScopeQuerySchema,
  SnapshotCompareQuerySchema,
  US_MARKETPLACE_ID,
  type InboundShipmentItem,
  type InventoryDetailResponse,
  type InventoryInboundResponse,
  type InventoryLedgerResponse,
  type InventorySnapshotsResponse,
  type InventoryStructureResponse,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { inventoryFreshness } from './inventory-freshness'
import { SNAPSHOT_LABELS, ledgerReferenceKind, snapshotValues, structurePoints, type DailyRow } from './inventory-detail-math'
import { InventoryItemService } from './inventory-item.service'
import { suggestionsFor } from './inventory-advice'
import { plusDays } from './inventory-rules'

const LEDGER_SORT = { field: 'eventDate', dir: 'desc' } as const
const DAILY_TAKE = 20_000
const PLAN_TAKE = 100
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const dateText = (date: Date) => date.toISOString().slice(0, 10)
const DAILY_SELECT = { snapshotDate: true, source: true, sellable: true, inbound: true, reserved: true, unsellable: true, researching: true } as const

// 库存详情前半部分：概览与“库存结构趋势、历史快照、库存台账、入仓与在途”四个页签。
// 每个接口都先走 InventoryItemService.resolve（权限检查 → 范围内读取这条库存记录 → 404），再校验各自的参数。
@Injectable()
export class InventoryDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly items: InventoryItemService,
    private readonly cursor: CursorService,
  ) {}

  async identity(req: RequestWithContext, id: string): Promise<InventoryDetailResponse> {
    const { context, scope, today, policy, item } = await this.items.resolve(req, id)
    const { row } = item
    return {
      row,
      policy,
      suggestions: suggestionsFor({
        assessment: row.assessment,
        demand: row.demand,
        sellable: row.quantity.sellable,
        inboundCounted: row.quantity.inboundCounted,
        policy,
        action: row.advice.ourAction,
        strandedReason: row.status.strandedReason,
        agedQty: item.agedQty,
        ageSurcharge: row.age.surchargeEstimate,
        today,
      }),
      freshness: await inventoryFreshness(this.prisma, context.tenantId, scope),
      productId:
        (
          await this.prisma.fbaProduct.findFirst({
            where: { tenantId: context.tenantId, sellerAccountId: row.sellerAccountId, marketplaceId: US_MARKETPLACE_ID, sellerSku: row.sku },
            select: { id: true },
          })
        )?.id ?? null,
    }
  }

  async structure(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<InventoryStructureResponse> {
    const { context, today, item } = await this.items.resolve(req, id)
    const query = ScopeQuerySchema.parse(rawQuery)
    const to = query.to ?? today
    const from = query.from ?? plusDays(to, -89)
    const rows = await this.prisma.inventoryDailySnapshot.findMany({
      where: { tenantId: context.tenantId, sellerAccountId: item.row.sellerAccountId, sku: item.row.sku, snapshotDate: { gte: asDate(from), lte: asDate(to) } },
      select: DAILY_SELECT,
      orderBy: { snapshotDate: 'asc' },
      take: DAILY_TAKE,
    })
    const points = structurePoints(rows)
    return {
      state: points.length ? 'OK' : 'NO_DATA',
      note: points.length ? null : '所选时间范围内没有库存日快照；库存同步任务按日留存，运行后这里会出现趋势',
      from,
      to,
      points,
    }
  }

  async snapshots(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<InventorySnapshotsResponse> {
    const { context, item } = await this.items.resolve(req, id)
    const query = SnapshotCompareQuerySchema.parse(rawQuery)
    const base = { tenantId: context.tenantId, sellerAccountId: item.row.sellerAccountId, sku: item.row.sku }
    const picked = [query.a, query.b].filter((date): date is string => Boolean(date)).map(asDate)
    const [dates, daily, planning, ages] = await Promise.all([
      this.prisma.inventoryDailySnapshot.findMany({ where: base, select: { snapshotDate: true }, distinct: ['snapshotDate'], orderBy: { snapshotDate: 'desc' }, take: 180 }),
      this.prisma.inventoryDailySnapshot.findMany({ where: { ...base, snapshotDate: { in: picked } }, select: DAILY_SELECT, take: 100 }),
      this.prisma.inventoryPlanningSnapshot.findMany({ where: { ...base, snapshotDate: { in: picked } }, take: 10 }),
      this.prisma.inventoryAgeSnapshot.findMany({ where: { ...base, snapshotDate: { in: picked } }, take: 10 }),
    ])
    const side = (date: string | undefined) => {
      if (!date) return { date: '', found: false, values: snapshotValues([], null, null) }
      const dailyRows: DailyRow[] = daily.filter(row => dateText(row.snapshotDate) === date)
      const planningRow = planning.find(row => dateText(row.snapshotDate) === date) ?? null
      const ageRow = ages.find(row => dateText(row.snapshotDate) === date) ?? null
      return { date, found: dailyRows.length > 0 || Boolean(planningRow) || Boolean(ageRow), values: snapshotValues(dailyRows, planningRow, ageRow) }
    }
    return { availableDates: dates.map(row => dateText(row.snapshotDate)), labels: SNAPSHOT_LABELS, a: side(query.a), b: side(query.b) }
  }

  async ledger(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<InventoryLedgerResponse> {
    const { context, item } = await this.items.resolve(req, id)
    const query = InventoryLedgerQuerySchema.parse(rawQuery)
    const empty = { items: [], pageInfo: { pageSize: query.pageSize, nextCursor: null, hasMore: false, approxTotal: null } }
    if (!item.row.fnsku) return { state: 'NO_DATA', note: '这条库存记录没有 FNSKU，无法关联库存台账', ...empty }
    const binding = bindingOf(context.tenantId, { inventoryId: id })
    const rows = await this.prisma.inventoryLedgerEntry.findMany({
      where: {
        AND: [
          { tenantId: context.tenantId, sellerAccountId: item.row.sellerAccountId, fnsku: item.row.fnsku },
          this.cursor.after(query.cursor, LEDGER_SORT, binding) as Prisma.InventoryLedgerEntryWhereInput,
        ],
      },
      orderBy: this.cursor.orderBy(LEDGER_SORT),
      take: query.pageSize + 1,
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: LEDGER_SORT, binding })
    const hasAny = page.items.length > 0 || Boolean(query.cursor)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : '尚无库存台账记录；台账报告同步后这里会列出每一笔库存变动',
      items: page.items.map(entry => ({
        id: entry.id,
        eventDate: dateText(entry.eventDate),
        eventType: entry.eventType,
        reasonCode: entry.reasonCode,
        disposition: entry.disposition,
        fulfillmentCenter: entry.fulfillmentCenter,
        quantity: entry.quantity,
        referenceId: entry.referenceId,
        referenceKind: entry.referenceId ? ledgerReferenceKind(entry.eventType) : null,
      })),
      pageInfo: page.pageInfo,
    }
  }

  async inbound(req: RequestWithContext, id: string): Promise<InventoryInboundResponse> {
    const { context, item } = await this.items.resolve(req, id)
    const plans = await this.prisma.fbaInboundPlan.findMany({
      where: { tenantId: context.tenantId, sellerAccountId: item.row.sellerAccountId },
      orderBy: { createdAt: 'desc' },
      take: PLAN_TAKE,
      include: { shipments: { orderBy: { createdAt: 'asc' }, take: 50 } },
    })
    const shipments: InboundShipmentItem[] = []
    for (const plan of plans) {
      const planQuantity = quantityOf(plan.items, item.row.sku)
      if (planQuantity === 0) continue
      const base = { planId: plan.id, planName: plan.name, planStatus: plan.status, planQuantity }
      if (plan.shipments.length === 0) shipments.push({ ...base, shipmentId: null, shipmentStatus: null, destinationFc: null, unitsExpected: null, unitsReceived: null, receiveProgress: null })
      for (const shipment of plan.shipments) {
        shipments.push({
          ...base,
          shipmentId: shipment.shipmentId,
          shipmentStatus: shipment.status,
          destinationFc: shipment.destinationFc,
          unitsExpected: shipment.unitsExpected,
          unitsReceived: shipment.unitsReceived,
          receiveProgress: shipment.unitsExpected > 0 ? Math.round((shipment.unitsReceived / shipment.unitsExpected) * 1000) / 1000 : null,
        })
      }
    }
    const q = item.row.quantity
    return {
      counts: {
        working: q.inboundWorking,
        shipped: q.inboundShipped,
        receiving: q.inboundReceiving,
        total: q.inboundTotal,
        counted: q.inboundCounted,
      },
      shipments,
      eta: { state: 'NOT_CONNECTED', note: '预计到仓时间需要承运商与货件跟踪数据，尚未接入', workPackage: 'P2a-11 / P2a-12' },
    }
  }
}

/** 入仓计划的商品行（JSON：[{ sellerSku, quantity }]）里指定 SKU 的计划数量；格式不对的行忽略。 */
export function quantityOf(items: unknown, sku: string): number {
  if (!Array.isArray(items)) return 0
  return items.reduce<number>((total, entry) => {
    const record = entry as { sellerSku?: unknown; quantity?: unknown }
    return record && record.sellerSku === sku && typeof record.quantity === 'number' ? total + record.quantity : total
  }, 0)
}
