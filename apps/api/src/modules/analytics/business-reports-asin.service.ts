import { Injectable } from '@nestjs/common'
import { BrAsinQuerySchema, BrTrendsQuerySchema, ScopeSearchSchema, type BrAsinRow, type BrAsinResponse, type BrAsinSort, type BrTrendsResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { eachDay } from '../overview'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { loadAsinDaily, loadAsinGroups, loadProductRefs, preferGroups, type ProductRef } from './business-reports-load'
import { figuresOf, pointsOf, preferredRows } from './business-reports-math'
import { decodeOffset, pageOf, sortByNumber } from './business-reports-page'

// 按 ASIN 的销售与流量（P4-02，04 章 4.5 第 3、4、5 个页签）与单个 ASIN 的逐日趋势：层级 = 父体、子体（ASIN）、SKU。
// 数据库先按 店铺 × ASIN × SKU × 来源 汇总范围内的合计，内存里取舍来源、算比率、排序，再按位置切页（游标）。
// 同一个键两个来源都有时整段范围只用数据中心的合计（不逐日混合，ASIN 层级没有逐日读取）；比率用范围合计相除，购物车获得率是日值的简单平均。

const ratio = (top: number | null, bottom: number | null, digits: number): number | null => {
  if (top === null || bottom === null || bottom <= 0) return null
  const factor = 10 ** digits
  return Math.round((top / bottom) * factor) / factor
}

const SORT_VALUE: Record<BrAsinSort, (row: BrAsinRow) => number | null> = {
  orderedSales: row => row.orderedSales,
  unitsOrdered: row => row.unitsOrdered,
  sessions: row => row.sessions,
  pageViews: row => row.pageViews,
  unitSessionPct: row => row.unitSessionPct,
  avgPrice: row => row.avgPrice,
  buyBoxPct: row => row.buyBoxPct,
}

@Injectable()
export class BusinessReportsAsinService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BrAsinResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const query = BrAsinQuerySchema.parse({ level: rawQuery.level, q: rawQuery.q, sort: rawQuery.sort, cursor: rawQuery.cursor, pageSize: rawQuery.pageSize })
    const { period } = access.periods
    const range = { from: period.from, to: period.to, days: period.days, defaulted: access.periods.defaulted }
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { groups, truncated } = await loadAsinGroups(this.prisma, access.tenantId, access.scope, query.level, period.from, period.to, query.q)
    const merged = preferGroups(groups)
    const header = await this.access.header(access, { range, hasData: merged.length > 0 || offset > 0, truncated, latestDate: null }, now)
    const names = new Map(header.stores.map(store => [store.sellerAccountId, store.storeName]))
    const drafts = merged.map<BrAsinRow>(group => ({
      key: `${group.sellerAccountId}|${group.asin}|${group.sku}`,
      asin: group.asin,
      sku: query.level === 'SKU' && group.sku ? group.sku : null,
      parentAsin: null,
      title: null,
      storeName: names.get(group.sellerAccountId) ?? null,
      productId: null,
      orderedSales: group.orderedSales === null ? null : Math.round(group.orderedSales * 100) / 100,
      unitsOrdered: group.units,
      ordersCount: group.ordersCount,
      sessions: group.sessions,
      pageViews: group.pageViews,
      unitSessionPct: ratio(group.units, group.sessions, 6),
      avgPrice: ratio(group.orderedSales, group.units, 4),
      buyBoxPct: group.buyBoxPct === null ? null : Math.round(group.buyBoxPct * 1e6) / 1e6,
    }))
    const sorted = sortByNumber(drafts, SORT_VALUE[query.sort.field as BrAsinSort], query.sort.dir)
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    const refs =
      query.level === 'PARENT' ? [] : await loadProductRefs(this.prisma, access.tenantId, access.scope, { asins: page.map(row => row.asin), skus: page.flatMap(row => (row.sku ? [row.sku] : [])) })
    return { ...header, level: query.level, items: page.map(row => withProduct(row, refs, query.level === 'SKU')), pageInfo }
  }

  async trends(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BrTrendsResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const { asin } = BrTrendsQuerySchema.parse({ asin: rawQuery.asin })
    const { period } = access.periods
    const range = { from: period.from, to: period.to, days: period.days, defaulted: access.periods.defaulted }
    const [loaded, refs] = await Promise.all([
      loadAsinDaily(this.prisma, access.tenantId, access.scope, asin, period.from, period.to),
      loadProductRefs(this.prisma, access.tenantId, access.scope, { asins: [asin], skus: [] }),
    ])
    const rows = preferredRows(loaded.rows)
    const points = pointsOf(rows, eachDay(period.from, period.to))
    const withData = points.filter(point => point.source !== null)
    const header = await this.access.header(
      access,
      { range, hasData: withData.length > 0, truncated: loaded.truncated, latestDate: withData.length > 0 ? withData[withData.length - 1]!.date : null },
      now,
    )
    const product = refs[0]
    return { ...header, asin, title: product?.title ?? null, productId: product?.id ?? null, points, totals: figuresOf(rows) }
  }
}

/** 补上商品目录里的标题、父体与 ASIN 360 编号：先按 店铺 + SKU（SKU 层级）或 店铺 + ASIN 找，再退到范围内任意店铺的同 ASIN。 */
function withProduct(row: BrAsinRow, refs: readonly ProductRef[], bySku: boolean): BrAsinRow {
  const store = row.key.split('|')[0]!
  const found =
    (bySku && row.sku ? refs.find(ref => ref.sellerAccountId === store && ref.sellerSku === row.sku) : undefined) ??
    refs.find(ref => ref.sellerAccountId === store && ref.asin === row.asin) ??
    refs.find(ref => ref.asin === row.asin)
  return found ? { ...row, title: found.title, parentAsin: found.parentAsin, productId: found.id } : row
}
