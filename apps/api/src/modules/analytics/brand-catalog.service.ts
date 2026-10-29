import { Injectable } from '@nestjs/common'
import {
  BA_PERIOD_OPTIONS_LIMIT,
  BA_ROW_LIMIT,
  BaCatalogQuerySchema,
  ScopeSearchSchema,
  ratioOf,
  type BaCatalogFunnel,
  type BaCatalogResponse,
  type BaCatalogRow,
  type BaCatalogSort,
  type BaPeriod,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'
import { BrandAccessService } from './brand-access.service'
import { asDay, loadProducts, num, toStarts, usd } from './brand-load'
import { sumNullable } from './brand-sqp-math'
import { decodeOffset, pageOf, sortByNumber } from './business-reports-page'

// 目录表现（P4-04，04 章 4.7，R-36）：每个 ASIN 在所选周期的搜索漏斗（展示 → 点击 → 加购 → 购买）。
// 各步转化率由次数重算（点击率 = 点击 ÷ 展示，加购率 = 加购 ÷ 点击，购买率 = 购买 ÷ 加购）；同一个 ASIN 在多家店铺都有时次数相加。
// 与业务报告对照：同周期同 ASIN 的订购销售额与会话（数据中心优先），用来看“搜索带来的销售额占订购销售额的比例”。

const COMPARE_NOTE =
  '对照数据来自业务报告（数据中心优先，没有再用报告补充），只统计美元；搜索带来的销售额与订购销售额同为美元口径可以相除，搜索点击与会话不是同一口径（一个会话可含多次点击），只是量级参照'

const SORT_VALUE: Record<BaCatalogSort, (row: BaCatalogRow) => number | null> = {
  impressions: row => row.impressions,
  clicks: row => row.clicks,
  cartAdds: row => row.cartAdds,
  purchases: row => row.purchases,
  searchTrafficSales: row => row.searchTrafficSales,
  clickRate: row => row.clickRate,
  purchaseRate: row => row.purchaseRate,
}

interface CatalogGroup {
  asin: string
  impressions: number | null
  clicks: number | null
  cartAdds: number | null
  purchases: number | null
  searchTrafficSales: number | null
}

const funnelOf = (group: Omit<CatalogGroup, 'asin'>): BaCatalogFunnel => ({
  ...group,
  clickRate: ratioOf(group.clicks, group.impressions),
  cartAddRate: ratioOf(group.cartAdds, group.clicks),
  purchaseRate: ratioOf(group.purchases, group.cartAdds),
})

async function loadGroups(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  kind: BaPeriod,
  start: string,
  asins: readonly string[] | null,
): Promise<{ groups: CatalogGroup[]; truncated: boolean }> {
  const found = await prisma.brandSearchCatalogPerformance.groupBy({
    by: ['asin'],
    where: { tenantId, ...storeWhere(scope), reportPeriod: kind, periodStart: asDay(start), OR: [{ currency: null }, { currency: 'USD' }], ...(asins ? { asin: { in: [...asins] } } : {}) },
    _sum: { impressions: true, clicks: true, cartAdds: true, purchases: true, searchTrafficSales: true },
    orderBy: [{ _sum: { purchases: 'desc' } }, { asin: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const groups = found.slice(0, BA_ROW_LIMIT).map<CatalogGroup>(row => ({
    asin: row.asin,
    impressions: row._sum.impressions,
    clicks: row._sum.clicks,
    cartAdds: row._sum.cartAdds,
    purchases: row._sum.purchases,
    searchTrafficSales: usd(row._sum.searchTrafficSales, 'USD'),
  }))
  return { groups, truncated: found.length > BA_ROW_LIMIT }
}

@Injectable()
export class BrandCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
  ) {}

  async catalog(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BaCatalogResponse> {
    const access = await this.access.resolve(req, rawQuery)
    const query = BaCatalogQuerySchema.parse({
      period: rawQuery.period,
      periodStart: rawQuery.periodStart,
      brand: rawQuery.brand,
      q: rawQuery.q,
      sort: rawQuery.sort,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const [products, starts] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      this.prisma.brandSearchCatalogPerformance.findMany({
        where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: BA_PERIOD_OPTIONS_LIMIT,
      }),
    ])
    const period = this.access.periodOf(query.period, query.periodStart, toStarts(starts))
    const byAsin = new Map(products.map(product => [product.asin, product]))
    const brandAsins = query.brand ? products.filter(product => product.brand === query.brand).map(product => product.asin) : null
    const empty = { impressions: null, clicks: null, cartAdds: null, purchases: null, searchTrafficSales: null }
    const [current, previous] =
      period.start && brandAsins?.length !== 0
        ? await Promise.all([
            loadGroups(this.prisma, access.tenantId, access.scope, query.period, period.start, brandAsins),
            period.previousStart ? loadGroups(this.prisma, access.tenantId, access.scope, query.period, period.previousStart, brandAsins) : Promise.resolve({ groups: [], truncated: false }),
          ])
        : [
            { groups: [] as CatalogGroup[], truncated: false },
            { groups: [] as CatalogGroup[], truncated: false },
          ]
    const header = await this.access.header(access, 'catalog', { period, hasData: current.groups.length > 0, truncated: current.truncated || previous.truncated }, now)
    const before = new Map(previous.groups.map(group => [group.asin, funnelOf(group)]))
    const wanted = query.q?.toLowerCase()
    const rows = current.groups
      .filter(group => !wanted || group.asin.toLowerCase().includes(wanted) || (byAsin.get(group.asin)?.title ?? '').toLowerCase().includes(wanted))
      .map<BaCatalogRow>(group => {
        const product = byAsin.get(group.asin)
        const prior = before.get(group.asin)
        return {
          ...funnelOf(group),
          key: group.asin,
          asin: group.asin,
          title: product?.title ?? null,
          productId: product?.id ?? null,
          brand: product?.brand ?? null,
          previous: prior ? { clickRate: prior.clickRate, cartAddRate: prior.cartAddRate, purchaseRate: prior.purchaseRate } : null,
          allSales: null,
          sessions: null,
          searchSalesShare: null,
          clicksPerSession: null,
        }
      })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { page, pageInfo } = pageOf(sortByNumber(rows, SORT_VALUE[query.sort.field as BaCatalogSort], query.sort.dir), offset, query.pageSize, binding)
    const compare = await this.compare(
      access.tenantId,
      access.scope,
      period.start,
      period.end,
      page.map(row => row.asin),
    )
    const total = funnelOf(
      current.groups.length === 0
        ? empty
        : {
            impressions: sumNullable(current.groups.map(group => group.impressions)),
            clicks: sumNullable(current.groups.map(group => group.clicks)),
            cartAdds: sumNullable(current.groups.map(group => group.cartAdds)),
            purchases: sumNullable(current.groups.map(group => group.purchases)),
            searchTrafficSales: sumNullable(current.groups.map(group => group.searchTrafficSales)),
          },
    )
    return {
      ...header,
      summary: total,
      items: page.map(row => withCompare(row, compare.get(row.asin))),
      pageInfo,
      compareNote: COMPARE_NOTE,
    }
  }

  /** 页面上这些 ASIN 同周期的订购销售额与会话：数据中心优先，同一 ASIN 没有数据中心行才用报告行。 */
  private async compare(
    tenantId: string,
    scope: ResolvedScope,
    start: string | null,
    end: string | null,
    asins: readonly string[],
  ): Promise<Map<string, { sales: number | null; sessions: number | null }>> {
    const result = new Map<string, { sales: number | null; sessions: number | null }>()
    if (!start || !end || asins.length === 0) return result
    const found = await this.prisma.salesTrafficAsinDaily.groupBy({
      by: ['asin', 'source'],
      where: { tenantId, ...storeWhere(scope), asin: { in: [...asins] }, asinGranularity: 'CHILD', currency: 'USD', date: { gte: asDay(start), lte: asDay(end) } },
      _sum: { orderedSales: true, sessions: true },
      orderBy: [{ asin: 'asc' }, { source: 'asc' }],
      take: BA_ROW_LIMIT,
    })
    for (const source of ['DATA_KIOSK', 'REPORT']) {
      for (const row of found.filter(item => item.source === source)) {
        if (!result.has(row.asin)) result.set(row.asin, { sales: num(row._sum.orderedSales), sessions: row._sum.sessions })
      }
    }
    return result
  }
}

function withCompare(row: BaCatalogRow, compare: { sales: number | null; sessions: number | null } | undefined): BaCatalogRow {
  if (!compare) return row
  return { ...row, allSales: compare.sales, sessions: compare.sessions, searchSalesShare: ratioOf(row.searchTrafficSales, compare.sales), clicksPerSession: ratioOf(row.clicks, compare.sessions) }
}
