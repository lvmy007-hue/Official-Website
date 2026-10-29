import { Injectable } from '@nestjs/common'
import type { InventoryAgeSnapshot, InventoryPlanningSnapshot } from '@prisma/client'
import type { InventoryPolicy } from '@nova/api-contracts'
import { US_MARKETPLACE_ID } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere, type ResolvedScope } from '../auth'
import { buildRow, type BuiltRow, type StrandedInfo } from './inventory-row'
import { plusDays, type OrderWindows } from './inventory-rules'

// 库存健康的数据装配：一次读出范围内的库存记录，再批量补齐规划报告、库龄快照、滞留快照、商品名与订单汇总，
// 逐行交给 buildRow（纯函数）。每个查询都带租户与店铺条件，行级安全同时生效。

export const INVENTORY_LOAD_LIMIT = 5000
const REPORT_TAKE = 20_000
const asDate = (date: string) => new Date(`${date}T00:00:00Z`)
const key = (storeId: string, value: string) => `${storeId}|${value}`

export interface LoadArgs {
  tenantId: string
  scope: ResolvedScope
  today: string
  policy: InventoryPolicy | null
  /** 只读这些库存记录（详情页）；不传则读范围内全部。 */
  ids?: string[]
  limit?: number
}

export interface LoadResult {
  items: BuiltRow[]
  truncated: boolean
}

@Injectable()
export class InventoryLoaderService {
  constructor(private readonly prisma: PrismaService) {}

  async load(args: LoadArgs): Promise<LoadResult> {
    const { tenantId, scope, today, policy } = args
    const limit = args.limit ?? INVENTORY_LOAD_LIMIT
    const records = await this.prisma.fbaInventoryRecord.findMany({
      where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope), ...(args.ids ? { id: { in: args.ids } } : {}) },
      orderBy: [{ sellerSku: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      include: { sellerAccount: { select: { displayName: true } } },
    })
    const truncated = records.length > limit
    const kept = truncated ? records.slice(0, limit) : records
    if (kept.length === 0) return { items: [], truncated }

    const storeIds = [...new Set(kept.map(record => record.sellerAccountId))]
    const asins = [...new Set(kept.map(record => record.asin).filter(Boolean))]
    const [planning, ages, stranded, products, orders] = await Promise.all([
      this.latestPlanning(tenantId, storeIds),
      this.latestAges(tenantId, storeIds),
      this.latestStranded(tenantId, storeIds),
      this.prisma.fbaProduct.findMany({ where: { tenantId, sellerAccountId: { in: storeIds } }, select: { sellerAccountId: true, sellerSku: true, title: true, brand: true }, take: REPORT_TAKE }),
      this.orderWindows(tenantId, storeIds, asins, today),
    ])
    const productMap = new Map(products.map(product => [key(product.sellerAccountId, product.sellerSku), product]))
    const items = kept.map(record =>
      buildRow({
        record,
        product: productMap.get(key(record.sellerAccountId, record.sellerSku)) ?? null,
        planning: planning.get(key(record.sellerAccountId, record.sellerSku)) ?? null,
        age: ages.get(key(record.sellerAccountId, record.sellerSku)) ?? null,
        stranded: stranded.get(key(record.sellerAccountId, record.sellerSku)) ?? null,
        orders: orders.get(key(record.sellerAccountId, record.asin)) ?? null,
        policy,
        today,
      }),
    )
    return { items, truncated }
  }

  // 每个店铺只取“最新一份快照日期”的行；该日期之后没有新报告时，页面上的日期会如实显示。
  private async latestPlanning(tenantId: string, storeIds: string[]) {
    const latest = await this.prisma.inventoryPlanningSnapshot.groupBy({ by: ['sellerAccountId'], where: { tenantId, sellerAccountId: { in: storeIds } }, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    if (pairs.length === 0) return new Map<string, InventoryPlanningSnapshot>()
    const rows = await this.prisma.inventoryPlanningSnapshot.findMany({ where: { tenantId, OR: pairs }, take: REPORT_TAKE })
    return new Map(rows.map(row => [key(row.sellerAccountId, row.sku), row]))
  }

  private async latestAges(tenantId: string, storeIds: string[]) {
    const latest = await this.prisma.inventoryAgeSnapshot.groupBy({ by: ['sellerAccountId'], where: { tenantId, sellerAccountId: { in: storeIds } }, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    if (pairs.length === 0) return new Map<string, InventoryAgeSnapshot>()
    const rows = await this.prisma.inventoryAgeSnapshot.findMany({ where: { tenantId, OR: pairs }, take: REPORT_TAKE })
    return new Map(rows.map(row => [key(row.sellerAccountId, row.sku), row]))
  }

  private async latestStranded(tenantId: string, storeIds: string[]): Promise<Map<string, StrandedInfo>> {
    const where = { tenantId, source: 'STRANDED', sellerAccountId: { in: storeIds } }
    const latest = await this.prisma.inventoryDailySnapshot.groupBy({ by: ['sellerAccountId'], where, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    const result = new Map<string, StrandedInfo>()
    if (pairs.length === 0) return result
    const rows = await this.prisma.inventoryDailySnapshot.findMany({
      where: { tenantId, source: 'STRANDED', OR: pairs },
      select: { sellerAccountId: true, sku: true, stranded: true, strandedReason: true },
      take: REPORT_TAKE,
    })
    for (const row of rows) result.set(key(row.sellerAccountId, row.sku), { qty: row.stranded, reason: row.strandedReason })
    return result
  }

  /** 近 90 天（到昨天为止）的订单汇总，按店铺 × ASIN 聚合：7、30、60、90 天销量，最早出现日期，近 30 天断货日。 */
  private async orderWindows(tenantId: string, storeIds: string[], asins: string[], today: string): Promise<Map<string, OrderWindows>> {
    const result = new Map<string, OrderWindows>()
    if (asins.length === 0) return result
    const yesterday = asDate(plusDays(today, -1))
    const base = { tenantId, sellerAccountId: { in: storeIds }, asin: { in: asins } }
    const within = (days: number) => ({ ...base, summaryDate: { gte: asDate(plusDays(today, -days)), lte: yesterday } })
    const sums = (days: number) => this.prisma.asinDailySummary.groupBy({ by: ['sellerAccountId', 'asin'], where: within(days), _sum: { units: true } })
    const [g7, g30, g60, g90, first, stock] = await Promise.all([
      sums(7),
      sums(30),
      sums(60),
      sums(90),
      this.prisma.asinDailySummary.groupBy({ by: ['sellerAccountId', 'asin'], where: within(90), _min: { summaryDate: true } }),
      this.prisma.asinDailySummary.groupBy({ by: ['sellerAccountId', 'asin'], where: { ...within(30), inventoryAvailable: 0 }, _sum: { units: true }, _count: { _all: true } }),
    ])
    const toMap = <T extends { sellerAccountId: string; asin: string }>(rows: T[]) => new Map(rows.map(row => [key(row.sellerAccountId, row.asin), row]))
    const m7 = toMap(g7)
    const m30 = toMap(g30)
    const m60 = toMap(g60)
    const m90 = toMap(g90)
    const mStock = toMap(stock)
    for (const row of first) {
      if (!row._min.summaryDate) continue
      const k = key(row.sellerAccountId, row.asin)
      result.set(k, {
        units7: m7.get(k)?._sum.units ?? 0,
        units30: m30.get(k)?._sum.units ?? 0,
        units60: m60.get(k)?._sum.units ?? 0,
        units90: m90.get(k)?._sum.units ?? 0,
        firstSeen: row._min.summaryDate.toISOString().slice(0, 10),
        stockoutDays30: mStock.get(k)?._count._all ?? 0,
        stockoutUnits30: mStock.get(k)?._sum.units ?? 0,
      })
    }
    return result
  }
}
