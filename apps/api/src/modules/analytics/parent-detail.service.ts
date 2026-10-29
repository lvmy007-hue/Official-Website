import { Injectable } from '@nestjs/common'
import {
  ASIN_TREND_TOP,
  ParentMatrixQuerySchema,
  type MatrixRow,
  type BrCommon,
  type ParentFigure,
  type ParentIdentityResponse,
  type ParentMatrixResponse,
  type ParentTrafficResponse,
  type ParentTrendResponse,
  type ParentTrendSeries,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { InventoryLoaderService, InventoryPolicyService } from '../inventory'
import { asDate, eachDay, nullableSum } from '../overview'
import { pivotOf, scaleOf, trafficRows } from './asin-analytics-math'
import { preferredMap } from './asin-analytics-selection.service'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { loadFamilyDaily } from './business-reports-load'
import { figuresOf, pointsOf, type BrRow } from './business-reports-math'
import { ParentContextService, type ParentContext } from './parent-context.service'
import { stockOf } from './parent-stock'

// 父体详情（P4-03）的身份区、子体贡献矩阵、子体趋势、流量分布。父体的数字 = 名下子体（ASIN）相加，来源取舍与 P4-02 一致。

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits
const NO_POLICY = '还没有生效的补货策略，库存风险无法计算；先在补货策略里配置'
const NO_STOCK = '这些子体还没有库存记录（库存同步后显示）'
const NEED_INVENTORY = '需要“库存”读取权限才能查看库存风险'
const NEED_PROFIT = '需要“利润”读取权限才能查看净利润'

interface Loaded {
  rows: BrRow[]
  byAsin: Map<string, BrRow[]>
  truncated: boolean
}

@Injectable()
export class ParentDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly parents: ParentContextService,
    private readonly access: BusinessReportsAccessService,
    private readonly loader: InventoryLoaderService,
    private readonly policies: InventoryPolicyService,
  ) {}

  private async daily(ctx: ParentContext, from = ctx.range.from, to = ctx.range.to): Promise<Loaded> {
    const loaded = await loadFamilyDaily(
      this.prisma,
      ctx.access.tenantId,
      ctx.access.scope,
      ctx.members.map(member => member.asin),
      from,
      to,
    )
    const byAsin = preferredMap(loaded.rows)
    return { rows: [...byAsin.values()].flat(), byAsin, truncated: loaded.truncated }
  }

  private header(ctx: ParentContext, loaded: Loaded, now: Date): Promise<BrCommon> {
    const withData = pointsOf(loaded.rows).filter(point => point.source !== null)
    return this.access.header(ctx.access, { range: ctx.range, hasData: withData.length > 0, truncated: loaded.truncated || ctx.membersTruncated, latestDate: withData.at(-1)?.date ?? null }, now)
  }

  async identity(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentIdentityResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const loaded = await this.daily(ctx)
    const figures = figuresOf(loaded.rows)
    const header = await this.header(ctx, loaded, now)
    const own = ctx.family.products.find(product => product.asin === ctx.parentAsin)
    const first = (pick: (product: (typeof ctx.family.products)[number]) => string | null) => (own ? pick(own) : null) ?? ctx.family.products.map(pick).find(Boolean) ?? null
    const storeIds = new Set(ctx.family.products.map(product => product.sellerAccountId))
    const asins = ctx.members.map(member => member.asin)
    const [netProfit, riskChildren] = await Promise.all([this.netProfit(ctx, asins), this.riskChildren(ctx, asins)])
    return {
      ...header,
      parentAsin: ctx.parentAsin,
      title: own?.title ?? null,
      imageUrl: first(product => product.imageUrl),
      brand: first(product => product.brand),
      category: first(product => product.categoryPath),
      variationTheme: ctx.family.variationTheme,
      childCount: ctx.members.length,
      storeNames: header.stores.filter(store => storeIds.has(store.sellerAccountId)).map(store => store.storeName),
      sales: figures.orderedSales,
      conversion: figures.unitSessionPct,
      netProfit,
      riskChildren,
      membersTruncated: ctx.membersTruncated,
    }
  }

  private async netProfit(ctx: ParentContext, asins: string[]): Promise<ParentFigure> {
    const { permissions, tenantId, scope } = ctx.access
    if (!hasPermission(permissions, 'profit.read') || !hasPermission(permissions, 'field.profit')) return { state: 'RESTRICTED', value: null, note: NEED_PROFIT }
    const where = { tenantId, ...storeWhere(scope), asin: { in: asins }, basis: 'ORDERED', currency: 'USD', profitDate: { gte: asDate(ctx.range.from), lte: asDate(ctx.range.to) } }
    const [all, costed] = await Promise.all([
      this.prisma.profitDaily.count({ where }),
      this.prisma.profitDaily.aggregate({ where: { ...where, profit: { not: null } }, _sum: { profit: true }, _count: { profit: true } }),
    ])
    if (all === 0) return { state: 'NO_DATA', value: null, note: '所选日期范围内没有利润记录（利润日表尚未计算，或这段时间没有销售）' }
    if (costed._count.profit === 0) return { state: 'NO_DATA', value: null, note: '有销售记录但成本还没录入，无法计算净利润' }
    return {
      state: 'OK',
      value: round(Number(costed._sum.profit!.toString()), 2),
      note: costed._count.profit < all ? `只合计已有成本的 ${costed._count.profit} / ${all} 行，缺成本的行没有计入` : null,
    }
  }

  private async riskChildren(ctx: ParentContext, asins: string[]): Promise<ParentFigure> {
    if (!hasPermission(ctx.access.permissions, 'inventory.read')) return { state: 'RESTRICTED', value: null, note: NEED_INVENTORY }
    const stock = await stockOf(this.loader, this.policies, { tenantId: ctx.access.tenantId, scope: ctx.access.scope, today: ctx.access.today, asins: new Set(asins) })
    if (stock.byAsin.size === 0) return { state: 'NO_DATA', value: null, note: NO_STOCK }
    if (!stock.hasPolicy) return { state: 'NOT_CONNECTED', value: null, note: NO_POLICY }
    return {
      state: 'OK',
      value: [...stock.byAsin.values()].filter(row => row.risk === 'HIGH' || row.risk === 'MEDIUM').length,
      note: `在 ${stock.byAsin.size} 个有库存记录的子体中，高风险与中风险的个数`,
    }
  }

  async matrix(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentMatrixResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const query = ParentMatrixQuerySchema.parse({ metric: rawQuery.metric, pivot: rawQuery.pivot })
    const loaded = await this.daily(ctx)
    const header = await this.header(ctx, loaded, now)
    const figures = new Map(ctx.members.map(member => [member.asin, figuresOf(loaded.byAsin.get(member.asin) ?? [])]))
    const total = nullableSum([...figures.values()].map(figure => figure.orderedSales))
    const canSeeRisk = hasPermission(ctx.access.permissions, 'inventory.read')
    const stock = canSeeRisk
      ? await stockOf(this.loader, this.policies, { tenantId: ctx.access.tenantId, scope: ctx.access.scope, today: ctx.access.today, asins: new Set(ctx.members.map(member => member.asin)) })
      : null
    const rows = ctx.members
      .map<MatrixRow>(member => {
        const figure = figures.get(member.asin)!
        return {
          asin: member.asin,
          title: member.title,
          productId: member.productId,
          attributes: member.attributes,
          sales: figure.orderedSales,
          units: figure.unitsOrdered,
          sessions: figure.sessions,
          conversion: figure.unitSessionPct,
          share: figure.orderedSales === null || total === null || total <= 0 ? null : round(figure.orderedSales / total, 6),
          risk: stock?.byAsin.get(member.asin)?.risk ?? null,
        }
      })
      .sort((a, b) => (a.sales === b.sales ? (a.asin < b.asin ? -1 : 1) : a.sales === null ? 1 : b.sales === null ? -1 : b.sales - a.sales))
    const riskState = !stock
      ? { state: 'RESTRICTED' as const, note: NEED_INVENTORY }
      : stock.byAsin.size === 0
        ? { state: 'NO_DATA' as const, note: NO_STOCK }
        : !stock.hasPolicy
          ? { state: 'NOT_CONNECTED' as const, note: NO_POLICY }
          : { state: 'OK' as const, note: null }
    return { ...header, parentAsin: ctx.parentAsin, metric: query.metric, rows, scale: scaleOf(rows, query.metric), riskState, pivot: pivotOf(rows, query.pivot) }
  }

  async trend(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentTrendResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const loaded = await this.daily(ctx)
    const header = await this.header(ctx, loaded, now)
    const dates = eachDay(ctx.range.from, ctx.range.to)
    const sales = new Map(ctx.members.map(member => [member.asin, figuresOf(loaded.byAsin.get(member.asin) ?? []).orderedSales]))
    const ranked = [...ctx.members].sort((a, b) => {
      const left = sales.get(a.asin) ?? null
      const right = sales.get(b.asin) ?? null
      return left === right ? (a.asin < b.asin ? -1 : 1) : left === null ? 1 : right === null ? -1 : right - left
    })
    const series = (asin: string) => {
      const points = pointsOf(loaded.byAsin.get(asin) ?? [], dates)
      return { sales: points.map(point => point.orderedSales), sessions: points.map(point => point.sessions), units: points.map(point => point.unitsOrdered) }
    }
    const top = ranked.slice(0, ASIN_TREND_TOP).map<ParentTrendSeries>(member => ({ asin: member.asin, title: member.title, ...series(member.asin) }))
    const rest = ranked.slice(ASIN_TREND_TOP).map(member => series(member.asin))
    const merge = (pick: (item: ReturnType<typeof series>) => Array<number | null>) => dates.map((_, index) => nullableSum(rest.map(item => pick(item)[index] ?? null)))
    const others = rest.length === 0 ? null : { count: rest.length, sales: merge(item => item.sales), sessions: merge(item => item.sessions), units: merge(item => item.units) }
    return { ...header, parentAsin: ctx.parentAsin, dates, series: top, others }
  }

  async traffic(req: RequestWithContext, rawQuery: Record<string, string>, parentAsin: string, now = new Date()): Promise<ParentTrafficResponse> {
    const ctx = await this.parents.resolve(req, rawQuery, parentAsin, now)
    const compare = ctx.access.periods.compare
    const [loaded, before] = await Promise.all([this.daily(ctx), compare ? this.daily(ctx, compare.from, compare.to) : Promise.resolve(null)])
    const header = await this.header(ctx, loaded, now)
    const sessionsOf = (data: Loaded) => new Map(ctx.members.map(member => [member.asin, figuresOf(data.byAsin.get(member.asin) ?? []).sessions]))
    const current = sessionsOf(loaded)
    const previous = before ? sessionsOf(before) : null
    return {
      ...header,
      truncated: header.truncated || Boolean(before?.truncated),
      parentAsin: ctx.parentAsin,
      compareRange: compare ? { from: compare.from, to: compare.to } : null,
      totalSessions: nullableSum([...current.values()]),
      compareTotalSessions: previous ? nullableSum([...previous.values()]) : null,
      rows: trafficRows(ctx.members, current, previous),
    }
  }
}
