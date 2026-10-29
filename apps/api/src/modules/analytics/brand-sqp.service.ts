import { Injectable } from '@nestjs/common'
import {
  BA_ASIN_OPTIONS,
  BA_HISTORY_PERIODS,
  BA_PERIOD_OPTIONS_LIMIT,
  BA_TREND_TERMS,
  BaSqpQuerySchema,
  ScopeSearchSchema,
  baQuadrantOf,
  breakpointOf,
  recentPeriodStarts,
  shareDelta,
  type BaAsinOption,
  type BaQueryRow,
  type BaSearchQueryResponse,
  type BaShareSet,
  type BaSqpSort,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere } from '../auth'
import { BrandAccessService } from './brand-access.service'
import { loadAdvertising, loadProducts, toStarts, type ProductRef } from './brand-load'
import { loadSqpAsinCounts, loadSqpGroups, loadSqpTrend, type SqpFilter } from './brand-sqp-load'
import { breakpointsOf, funnelOf, overviewOf, priceRowsOf, quadrantOf, sharesOf, shippingRowsOf, trendOf, type SqpGroup } from './brand-sqp-math'
import { decodeOffset, pageOf, sortByNumber } from './business-reports-page'

// 搜索查询表现（P4-04，04 章 4.7，R-35）：一个周期里，所选 ASIN（或品牌下全部 ASIN）的搜索词漏斗、价格与配送速度对比、象限、断点诊断与词根总览。
// 全部指标在“全部搜索词”上算（词表的搜索关键词只过滤列表，不改变汇总）；趋势用所选周期搜索量最高的前 500 个词逐期对比。

const SORT_VALUE: Record<BaSqpSort, (row: BaQueryRow) => number | null> = {
  searchVolume: row => row.searchVolume,
  impressionShare: row => row.shares.impression,
  clickShare: row => row.shares.click,
  cartAddShare: row => row.shares.cartAdd,
  purchaseShare: row => row.shares.purchase,
  purchaseShareChange: row => row.changes.purchase,
  ownPurchases: row => row.ownPurchases,
}

const changesOf = (now: BaShareSet, before: BaShareSet | null): BaShareSet => ({
  impression: before ? shareDelta(now.impression, before.impression) : null,
  click: before ? shareDelta(now.click, before.click) : null,
  cartAdd: before ? shareDelta(now.cartAdd, before.cartAdd) : null,
  purchase: before ? shareDelta(now.purchase, before.purchase) : null,
})

@Injectable()
export class BrandSqpService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
  ) {}

  async search(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BaSearchQueryResponse> {
    const access = await this.access.resolve(req, rawQuery)
    const query = BaSqpQuerySchema.parse({
      period: rawQuery.period,
      periodStart: rawQuery.periodStart,
      dimension: rawQuery.dimension,
      asin: rawQuery.asin,
      brand: rawQuery.brand,
      q: rawQuery.q,
      sort: rawQuery.sort,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const base: SqpFilter = { tenantId: access.tenantId, scope: access.scope, kind: query.period, asins: null }
    const [products, starts] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      this.prisma.brandSearchQueryPerformance.findMany({
        where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: BA_PERIOD_OPTIONS_LIMIT,
      }),
    ])
    const period = this.access.periodOf(query.period, query.periodStart, toStarts(starts))
    const options = period.start ? await loadSqpAsinCounts(this.prisma, base, period.start, BA_ASIN_OPTIONS) : []
    const byAsin = new Map(products.map(product => [product.asin, product]))
    const asinOptions = options.map<BaAsinOption>(item => ({ asin: item.asin, title: byAsin.get(item.asin)?.title ?? null, brand: byAsin.get(item.asin)?.brand ?? null, terms: item.terms }))
    const brandOptions = [...new Set(asinOptions.flatMap(item => (item.brand ? [item.brand] : [])))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    const selection = selectionOf(query, asinOptions, products)
    const head = (hasData: boolean, truncated: boolean) => this.access.header(access, 'search-query', { period, hasData, truncated }, now)
    const shell = { dimension: query.dimension, selection: { asin: selection.asin, brand: selection.brand }, asinOptions, brandOptions }
    if (!period.start || selection.asins?.length === 0) return this.empty(await head(false, false), shell, query.pageSize)

    const filter: SqpFilter = { ...base, asins: selection.asins }
    const [current, previous] = await Promise.all([
      loadSqpGroups(this.prisma, filter, period.start),
      period.previousStart ? loadSqpGroups(this.prisma, filter, period.previousStart) : Promise.resolve({ groups: [] as SqpGroup[], truncated: false }),
    ])
    if (current.groups.length === 0) return this.empty(await head(false, false), shell, query.pageSize)

    const trendStarts = recentPeriodStarts(query.period, period.start, BA_HISTORY_PERIODS).reverse()
    const top = current.groups.slice(0, BA_TREND_TERMS).map(group => group.searchQuery)
    const [trendRows, header] = await Promise.all([loadSqpTrend(this.prisma, filter, trendStarts, top), head(true, current.truncated || previous.truncated)])

    const shared = new Map(current.groups.map(group => [group.searchQuery, sharesOf(group)]))
    const before = new Map(previous.groups.map(group => [group.searchQuery, sharesOf(group)]))
    const summaries = current.groups.map(group => ({ searchQuery: group.searchQuery, volume: group.volume, shares: shared.get(group.searchQuery)! }))
    const quadrant = quadrantOf(summaries)
    const breakpoints = breakpointsOf(summaries)
    const wanted = query.q?.toLowerCase()
    const rows = current.groups
      .filter(group => !wanted || group.searchQuery.includes(wanted))
      .map<BaQueryRow>(group => {
        const shares = shared.get(group.searchQuery)!
        return {
          key: group.searchQuery,
          searchQuery: group.searchQuery,
          searchVolume: group.volume,
          searchScore: group.score,
          shares,
          changes: changesOf(shares, before.get(group.searchQuery) ?? null),
          ownPurchases: group.own.purchases,
          marketPurchases: group.total.purchases,
          advertising: 'NONE',
          quadrant: baQuadrantOf(group.volume, shares.purchase, quadrant.medians),
          breakpoint: breakpointOf(shares, breakpoints.medians),
        }
      })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const sorted = sortByNumber(rows, SORT_VALUE[query.sort.field as BaSqpSort], query.sort.dir)
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    const advertising = await loadAdvertising(
      this.prisma,
      access.tenantId,
      access.scope,
      page.map(row => row.searchQuery),
    )
    return {
      ...header,
      ...shell,
      funnel: funnelOf(current.groups, previous.groups),
      trend: trendOf(trendRows, trendStarts),
      trendNote: `搜索量最高的前 ${BA_TREND_TERMS} 个词（按所选周期的搜索量取），逐期对比同一批词的搜索量与份额；比整体口径稳定，但不是全部搜索词`,
      price: priceRowsOf(current.groups),
      priceNote: '每个搜索词的价格是官方给的中位价；这里按搜索量加权平均（不是全部购买的整体中位数），我方是所选 ASIN 的平均',
      shipping: shippingRowsOf(current.groups),
      quadrant,
      breakpoints,
      overview: overviewOf(current.groups),
      items: page.map(row => ({ ...row, advertising: advertising.get(row.searchQuery) ?? 'NONE' })),
      pageInfo,
    }
  }

  /** 没有可用数据时的响应：各块都是“没有”的形状，不放示例数字。 */
  private empty(
    header: Awaited<ReturnType<BrandAccessService['header']>>,
    shell: Pick<BaSearchQueryResponse, 'dimension' | 'selection' | 'asinOptions' | 'brandOptions'>,
    pageSize: number,
  ): BaSearchQueryResponse {
    return {
      ...header,
      ...shell,
      funnel: funnelOf([], []),
      trend: [],
      trendNote: '',
      price: priceRowsOf([]),
      priceNote: '',
      shipping: shippingRowsOf([]),
      quadrant: quadrantOf([]),
      breakpoints: breakpointsOf([]),
      overview: overviewOf([]),
      items: [],
      pageInfo: { pageSize, nextCursor: null, hasMore: false, approxTotal: 0 },
    }
  }
}

/** 所选 ASIN 集合：ASIN 维度取指定或第一个有数据的 ASIN；品牌维度取该品牌的全部商品（没选品牌是范围内全部 ASIN，asins 为 null）。 */
function selectionOf(
  query: { dimension: 'ASIN' | 'BRAND'; asin?: string; brand?: string },
  options: readonly BaAsinOption[],
  products: readonly ProductRef[],
): { asin: string | null; brand: string | null; asins: string[] | null } {
  if (query.dimension === 'ASIN') {
    const asin = query.asin ?? options[0]?.asin ?? null
    return { asin, brand: null, asins: asin ? [asin] : [] }
  }
  if (!query.brand) return { asin: null, brand: null, asins: null }
  return { asin: null, brand: query.brand, asins: products.filter(product => product.brand === query.brand).map(product => product.asin) }
}
