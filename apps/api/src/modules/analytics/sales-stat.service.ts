import { Injectable } from '@nestjs/common'
import {
  availableInventoryOf,
  bucketsBetween,
  bucketStartOf,
  daysInRange,
  describeBusinessRule,
  SalesStatQuerySchema,
  SS_BUCKET_MAX,
  STOCK_REPORT_LIMIT,
  US_MARKETPLACE_ID,
  type SsResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { loadActiveMetrics } from '../../platform/metric-config'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate, dateText } from '../overview'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { catalogWhere, loadCatalog } from './product-performance-load'
import { foldSalesStat, rowOf, skuKey, sortStatRows, summaryOf, type DailyCell, type Draft, type StatRef, type StockFigure } from './sales-stat-math'

// 销量统计（P6-25，16 章第 2.2 节）：每个日期一列、最后一列小计；维度 ASIN、父 ASIN、SKU、店铺、负责人；粒度日、周、月（周起始日读业务口径）。
// 可用库存与周转天数是固定列：可用库存按业务口径（P6-31）把库存接口的各数量相加，周转天数 = 可用库存 ÷ 范围内日均销量。
// 权限先于参数校验；汇总行是对符合筛选的全部行合计；内存聚合单元超过上限时 truncated = true，页面提示缩小范围，不静默少算。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))

function matches(draft: Draft, needle: string): boolean {
  const text = draft.refs.flatMap(ref => [ref.asin, ref.parentAsin, ref.sku, ref.title, ref.storeName])
  return text.some(item => item?.toLowerCase().includes(needle))
}

@Injectable()
export class SalesStatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  async query(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<SsResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const input = SalesStatQuerySchema.parse(rawQuery)
    const { tenantId, scope } = access
    const metrics = await loadActiveMetrics(this.prisma, tenantId)
    const weekDay = metrics.rules.config.weekStart.day
    const range = this.access.rangeOf(access, input.granularity)
    const buckets = bucketsBetween(range.from, range.to, input.granularity, weekDay)
    if (buckets.length > SS_BUCKET_MAX) throw appError('VALIDATION_FAILED', `日期列最多 ${SS_BUCKET_MAX} 个，当前范围有 ${buckets.length} 个，请缩小日期范围或改用周、月粒度`, { status: 422 })

    const [catalog, storeRows, summary, inventory] = await Promise.all([
      loadCatalog(this.prisma, catalogWhere(tenantId, scope)),
      this.prisma.sellerAccount.findMany({ where: { tenantId, ...storeWhere(scope, 'id') }, select: { id: true, displayName: true }, orderBy: { id: 'asc' }, take: 500 }),
      this.prisma.asinDailySummary.groupBy({
        by: ['sellerAccountId', 'asin', 'summaryDate'],
        where: { tenantId, ...storeWhere(scope), currency: 'USD', summaryDate: { gte: asDate(range.from), lte: asDate(range.to) } },
        _sum: { units: true, salesAmount: true },
        orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { summaryDate: 'asc' }],
        take: STOCK_REPORT_LIMIT + 1,
      }),
      this.prisma.fbaInventoryRecord.findMany({
        where: { tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(scope) },
        select: {
          sellerAccountId: true,
          sellerSku: true,
          fulfillableQuantity: true,
          reservedQuantity: true,
          inboundWorkingQuantity: true,
          inboundShippedQuantity: true,
          inboundReceivingQuantity: true,
        },
        orderBy: [{ id: 'asc' }],
        take: STOCK_REPORT_LIMIT + 1,
      }),
    ])
    const storeNames = new Map(storeRows.map(row => [row.id, row.displayName]))
    const refs: StatRef[] = catalog.products.map(product => ({
      storeId: product.storeId,
      storeName: product.storeName,
      asin: product.asin,
      sku: product.sku,
      title: product.title,
      imageUrl: product.imageUrl,
      parentAsin: product.parentAsin,
      ownerUserId: product.ownerUserId,
    }))
    const daily: DailyCell[] = summary
      .slice(0, STOCK_REPORT_LIMIT)
      .filter(row => storeNames.has(row.sellerAccountId))
      .map(row => ({ storeId: row.sellerAccountId, asin: row.asin, date: dateText(row.summaryDate), units: row._sum.units, sales: num(row._sum.salesAmount) }))
    const stock = new Map<string, StockFigure>()
    for (const row of inventory.slice(0, STOCK_REPORT_LIMIT)) {
      const available = availableInventoryOf(metrics.rules.config.availableInventory, {
        sellable: row.fulfillableQuantity,
        reserved: row.reservedQuantity,
        inboundWorking: row.inboundWorkingQuantity,
        inboundShipped: row.inboundShippedQuantity,
        inboundReceiving: row.inboundReceivingQuantity,
      })
      stock.set(skuKey(row.sellerAccountId, row.sellerSku), { available })
    }
    const truncated = catalog.truncated || summary.length > STOCK_REPORT_LIMIT || inventory.length > STOCK_REPORT_LIMIT
    const drafts = foldSalesStat({ dimension: input.dimension, refs, stores: storeNames, daily, bucketOf: date => bucketStartOf(date, input.granularity, weekDay) })
    const needle = input.q?.toLowerCase()
    const kept = needle ? drafts.filter(draft => matches(draft, needle)) : drafts
    const owners =
      input.dimension === 'owner'
        ? await memberNames(
            this.prisma,
            tenantId,
            kept.map(draft => draft.ref.ownerUserId),
          )
        : new Map<string, string>()
    const days = daysInRange(range.from, range.to)
    const rows = kept.map(draft => rowOf(draft, buckets, input.metric, stock, days, owners, storeNames))
    const sorted = sortStatRows(rows, input.sort.field as 'total', input.sort.dir)
    const start = (input.page - 1) * input.pageSize
    const header = await this.access.header(
      access,
      { range, hasData: daily.length > 0, truncated, latestDate: daily.reduce<string | null>((max, cell) => (max === null || cell.date > max ? cell.date : max), null) },
      now,
    )
    const split = rows.some(row => row.gap !== null)
    return {
      ...header,
      note: header.note ?? (split ? '多个 SKU 共用的 ASIN 在 SKU 维度下没有数值，合计不含它们的销量；请切换到 ASIN 维度查看' : null),
      dimension: input.dimension,
      metric: input.metric,
      granularity: input.granularity,
      buckets,
      weekStart: weekDay,
      inventoryBasis: describeBusinessRule('availableInventory', metrics.rules.config.availableInventory),
      rows: sorted.slice(start, start + input.pageSize),
      summary: summaryOf(rows, buckets.length),
      total: sorted.length,
      page: input.page,
      pageSize: input.pageSize,
    }
  }
}
