import { Injectable } from '@nestjs/common'
import { COST_COVERAGES, COST_LIST_LIMIT, CostListQuerySchema, coverageOf, type CostCoverage, type CostListResponse, type CostRow } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere } from '../auth'
import { CostsAccessService } from './costs-access.service'
import { asDay, COST_SELECT, liteOf, tenantToday } from './costs-common'
import { loadRates } from './costs-fx'
import { compareText, decodeOffset, pageOf } from './costs-page'
import { EMPTY_SUMMARY, rowOf, type SkuSummary } from './costs-row'

// 商品成本列表（05 章 5.9）：每个 SKU 一行——当前各项成本、折合美元、到岸成本合计、覆盖状态、最近变更。
// SKU 的范围：成员范围内店铺的商品，加上（拥有全部店铺范围时）已有成本版本的 SKU；受限范围的成员只看到自己范围内店铺的商品。
// 汇总在数据库里做（按 SKU 与状态分组），每页只为这一页的 SKU 读生效版本；超过 COST_LIST_LIMIT 个 SKU 或分组只汇总前面一部分并提示。

type Counter = Record<CostCoverage, number>

@Injectable()
export class CostsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CostsAccessService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now: Date = new Date()): Promise<CostListResponse> {
    const access = await this.access.read(req, rawQuery)
    const query = CostListQuerySchema.parse(rawQuery)
    const { tenantId, scope } = access
    const today = await tenantToday(this.prisma, tenantId, now)
    const todayDate = asDay(today)
    const limit = COST_LIST_LIMIT + 1

    const [products, versionSkus, byStatus, activeProduct] = await Promise.all([
      this.prisma.fbaProduct.groupBy({ by: ['sellerSku'], where: { tenantId, ...storeWhere(scope) }, orderBy: { sellerSku: 'asc' }, take: limit }),
      scope.unrestricted ? this.prisma.costVersion.groupBy({ by: ['sku'], where: { tenantId }, orderBy: { sku: 'asc' }, take: limit }) : Promise.resolve([]),
      this.prisma.costVersion.groupBy({ by: ['sku', 'status'], where: { tenantId }, _count: { _all: true }, _max: { updatedAt: true }, orderBy: [{ sku: 'asc' }, { status: 'asc' }], take: limit }),
      this.prisma.costVersion.groupBy({
        by: ['sku'],
        where: { tenantId, status: 'ACTIVE', unitProductCost: { not: null }, effectiveFrom: { lte: todayDate } },
        _max: { effectiveFrom: true },
        orderBy: { sku: 'asc' },
        take: limit,
      }),
    ])
    const truncated = [products, versionSkus, byStatus, activeProduct].some(rows => rows.length > COST_LIST_LIMIT)

    const summaries = new Map<string, SkuSummary>()
    const summaryOf = (sku: string) => summaries.get(sku) ?? { ...EMPTY_SUMMARY }
    for (const group of byStatus.slice(0, COST_LIST_LIMIT)) {
      const entry = summaryOf(group.sku)
      if (group.status === 'ACTIVE') entry.activeCount += group._count._all
      if (group.status === 'DRAFT') entry.draftCount += group._count._all
      const changed = group._max.updatedAt
      if (changed && (!entry.lastChangedAt || changed > entry.lastChangedAt)) entry.lastChangedAt = changed
      summaries.set(group.sku, entry)
    }
    for (const group of activeProduct.slice(0, COST_LIST_LIMIT)) {
      const from = group._max.effectiveFrom
      if (from) summaries.set(group.sku, { ...summaryOf(group.sku), productEffectiveFrom: from.toISOString().slice(0, 10) })
    }

    const universe = [...new Set([...products.slice(0, COST_LIST_LIMIT).map(item => item.sellerSku), ...versionSkus.slice(0, COST_LIST_LIMIT).map(item => item.sku)])].sort(compareText)
    const coverageOfSku = (sku: string) => coverageOf({ productEffectiveFrom: summaryOf(sku).productEffectiveFrom, hasDraft: summaryOf(sku).draftCount > 0, today })
    const summary = Object.fromEntries(COST_COVERAGES.map(item => [item, 0])) as Counter
    let draftSkus = 0
    for (const sku of universe) {
      summary[coverageOfSku(sku)] += 1
      if (summaryOf(sku).draftCount > 0) draftSkus += 1
    }

    const needle = query.q?.toLowerCase()
    const matched = universe.filter(sku => {
      if (needle && !sku.toLowerCase().includes(needle)) return false
      if (query.coverage && coverageOfSku(sku) !== query.coverage) return false
      if (query.draft !== undefined && summaryOf(sku).draftCount > 0 !== query.draft) return false
      return true
    })
    const binding = bindingOf(tenantId, query)
    const { page, pageInfo } = pageOf(matched, decodeOffset(query.cursor, binding), query.pageSize, binding)

    const items = await this.rowsFor(access, page, summaryOf, today, todayDate)
    const filtered = Boolean(needle || query.coverage || query.draft !== undefined)
    return {
      state: universe.length === 0 ? 'NO_DATA' : 'OK',
      note:
        universe.length === 0
          ? '尚无记录：还没有商品，也没有成本版本。同步商品后会在这里出现，也可以先录入或导入成本。'
          : matched.length === 0 && filtered
            ? '没有符合条件的 SKU；可以放宽筛选条件'
            : null,
      today,
      items,
      pageInfo,
      summary,
      draftSkus,
      truncated,
      canWrite: access.canWrite,
    }
  }

  /** 这一页 SKU 的行：读它们生效中且已到生效日的版本，各项成本取最新一条；折合美元用今天的汇率。 */
  private async rowsFor(
    access: { tenantId: string; scope: Parameters<typeof storeWhere>[0] },
    skus: readonly string[],
    summaryOf: (sku: string) => SkuSummary,
    today: string,
    todayDate: Date,
  ): Promise<CostRow[]> {
    if (skus.length === 0) return []
    const { tenantId, scope } = access
    const [versions, products] = await Promise.all([
      this.prisma.costVersion.findMany({
        where: { tenantId, sku: { in: [...skus] }, status: 'ACTIVE', effectiveFrom: { lte: todayDate } },
        select: COST_SELECT,
        orderBy: [{ sku: 'asc' }, { versionNo: 'desc' }],
        take: 20_000,
      }),
      this.prisma.fbaProduct.findMany({
        where: { tenantId, sellerSku: { in: [...skus] }, ...storeWhere(scope) },
        select: { sellerSku: true, title: true, asin: true },
        orderBy: { updatedAt: 'desc' },
        take: 2000,
      }),
    ])
    const rates = await loadRates(this.prisma, tenantId, new Set(versions.map(version => version.currency)), today)
    const bySku = new Map<string, ReturnType<typeof liteOf>[]>()
    for (const version of versions) bySku.set(version.sku, [...(bySku.get(version.sku) ?? []), liteOf(version)])
    const titleOf = new Map<string, { title: string; asin: string }>()
    for (const product of products) if (!titleOf.has(product.sellerSku)) titleOf.set(product.sellerSku, { title: product.title, asin: product.asin })
    return skus.map(sku => rowOf({ sku, title: titleOf.get(sku)?.title ?? null, asin: titleOf.get(sku)?.asin ?? null, versions: bySku.get(sku) ?? [], summary: summaryOf(sku), rates, today }))
  }
}
