import { Injectable } from '@nestjs/common'
import type { InventoryRow } from '@nova/api-contracts'
import type { AmazonRestockRecommendation } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { type ResolvedScope } from '../auth'
import { InventoryLoaderService } from '../inventory'
import { loadOverrideIndex } from './replenishment-forecast-load'
import type { SubscribeInput } from './replenishment-math'
import type { ResolvedOverride } from './replenishment-override'

// 补货建议的数据装配：库存行（含需求预测）沿用库存健康的装配结果，再补齐商品类型、订阅省快照与亚马逊补货建议。
// 每个查询都带租户与店铺条件，行级安全同时生效。

const TAKE = 20_000
const key = (storeId: string, value: string) => `${storeId}|${value}`
const dateText = (value: Date) => value.toISOString().slice(0, 10)

export interface SkuInput {
  row: InventoryRow
  category: string | null
  subscribe: SubscribeInput | null
  restock: AmazonRestockRecommendation | null
  /** 上游仓储（AWD）里这个 SKU 的可用量与在途入库量之和；店铺没有 AWD 快照、或这个 SKU 没有记录时为 null（不按 0 算）。 */
  awdQty: number | null
  /** 适用于这个 SKU 的人工预测规则（P6-09）：SKU 规则与所属品类的规则，去年同期规则已换算成日销。 */
  overrides: ResolvedOverride[]
}

export interface LoadedInputs {
  items: SkuInput[]
  truncated: boolean
  restockSnapshotDate: string | null
}

@Injectable()
export class ReplenishmentLoaderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryLoaderService,
  ) {}

  async load(args: { tenantId: string; scope: ResolvedScope; today: string; ids?: string[] }): Promise<LoadedInputs> {
    const { tenantId, scope, today } = args
    const { items, truncated } = await this.inventory.load({ tenantId, scope, today, policy: null, ids: args.ids, limit: args.ids ? args.ids.length : undefined })
    if (items.length === 0) return { items: [], truncated, restockSnapshotDate: null }
    const storeIds = [...new Set(items.map(item => item.row.sellerAccountId))]
    const [products, offers, restocks, awd] = await Promise.all([
      this.prisma.fbaProduct.findMany({ where: { tenantId, sellerAccountId: { in: storeIds } }, select: { sellerAccountId: true, sellerSku: true, productType: true }, take: TAKE }),
      this.latestOffers(tenantId, storeIds),
      this.latestRestocks(tenantId, storeIds),
      this.latestAwd(tenantId, storeIds),
    ])
    const categories = new Map(products.map(product => [key(product.sellerAccountId, product.sellerSku), product.productType]))
    const snapshotDates = [...restocks.values()].map(row => dateText(row.snapshotDate)).sort()
    const overrideOf = await loadOverrideIndex(
      this.prisma,
      tenantId,
      today,
      items.map(({ row }) => ({ sellerAccountId: row.sellerAccountId, sku: row.sku, asin: row.asin, category: categories.get(key(row.sellerAccountId, row.sku)) ?? null })),
    )
    return {
      items: items.map(({ row }) => {
        const category = categories.get(key(row.sellerAccountId, row.sku)) ?? null
        return {
          row,
          category,
          subscribe: offers.get(key(row.sellerAccountId, row.sku)) ?? null,
          restock: restocks.get(key(row.sellerAccountId, row.sku)) ?? null,
          awdQty: awd.get(key(row.sellerAccountId, row.sku)) ?? null,
          overrides: overrideOf({ sellerAccountId: row.sellerAccountId, sku: row.sku, asin: row.asin, category }),
        }
      }),
      truncated,
      restockSnapshotDate: snapshotDates.length ? snapshotDates[snapshotDates.length - 1] : null,
    }
  }

  /** 每个店铺 SKU 取最新一份订阅省报价快照。 */
  private async latestOffers(tenantId: string, storeIds: string[]): Promise<Map<string, SubscribeInput>> {
    const rows = await this.prisma.subscribeSaveOffer.findMany({
      where: { tenantId, sellerAccountId: { in: storeIds } },
      orderBy: [{ snapshotDate: 'desc' }, { id: 'asc' }],
      distinct: ['sellerAccountId', 'sku'],
      take: TAKE,
    })
    return new Map(
      rows.map(row => [
        key(row.sellerAccountId, row.sku),
        {
          forecastNext30: row.forecastNext30,
          shippedUnitsPrevMonth: row.shippedUnitsPrevMonth,
          prevMonthDays: row.prevMonthDays,
          snapshotDate: dateText(row.snapshotDate),
          eligibility: row.eligibility,
        },
      ]),
    )
  }

  private async latestRestocks(tenantId: string, storeIds: string[]): Promise<Map<string, AmazonRestockRecommendation>> {
    const rows = await this.prisma.amazonRestockRecommendation.findMany({
      where: { tenantId, sellerAccountId: { in: storeIds } },
      orderBy: [{ snapshotDate: 'desc' }, { id: 'asc' }],
      distinct: ['sellerAccountId', 'sku'],
      take: TAKE,
    })
    return new Map(rows.map(row => [key(row.sellerAccountId, row.sku), row]))
  }

  /** 每个店铺只用它最近一次 AWD 快照（旧日期的 SKU 不沿用，避免把早已清空的库存算进供给）；两个数量都没报的 SKU 为 null。 */
  private async latestAwd(tenantId: string, storeIds: string[]): Promise<Map<string, number | null>> {
    const latest = await this.prisma.awdInventory.groupBy({ by: ['sellerAccountId'], where: { tenantId, sellerAccountId: { in: storeIds } }, _max: { snapshotDate: true } })
    const pairs = latest.flatMap(item => (item._max.snapshotDate ? [{ sellerAccountId: item.sellerAccountId, snapshotDate: item._max.snapshotDate }] : []))
    if (pairs.length === 0) return new Map()
    const rows = await this.prisma.awdInventory.findMany({ where: { tenantId, OR: pairs }, select: { sellerAccountId: true, sku: true, availableQty: true, inboundToAwdQty: true }, take: TAKE })
    return new Map(rows.map(row => [key(row.sellerAccountId, row.sku), row.availableQty === null && row.inboundToAwdQty === null ? null : (row.availableQty ?? 0) + (row.inboundToAwdQty ?? 0)]))
  }
}
