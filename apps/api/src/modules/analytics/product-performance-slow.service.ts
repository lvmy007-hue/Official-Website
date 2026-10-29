import { Injectable } from '@nestjs/common'
import {
  PP_METRICS,
  PP_SLOW_KEYS,
  PP_UNIT_LIMIT,
  ProductPerformanceAsyncSchema,
  ProductPerformanceTrendSchema,
  US_MARKETPLACE_ID,
  type PpAsyncResponse,
  type PpMetricKey,
  type PpTrendResponse,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate, dateText, eachDay } from '../overview'
import { BusinessReportsAccessService, type BrAccess } from './business-reports-access.service'
import { allowedBy, capsOf, type Caps } from './product-performance-dim'
import { unitKey } from './product-performance-load'
import { loadMembers, type Members } from './product-performance-members'

// 商品表现宽表的迷你趋势与慢指标（P6-22，异步列）：主数据先返回，这里按可见行（一次最多 100 行）批量取。
// 库存（可售、在途、可售天数）、售后（退货率、退款率、评分）各自按权限降级；没有来源的值写原因，不估算也不当 0。

const num = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits
type Rows = PpAsyncResponse['rows']

function put(rows: Rows, rowIds: readonly string[], key: PpMetricKey, value: number | null) {
  for (const id of rowIds) rows[id] = { ...(rows[id] ?? {}), [key]: value }
}

@Injectable()
export class ProductPerformanceSlowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BusinessReportsAccessService,
  ) {}

  /** 迷你趋势：逐日一个指标，范围就是页面的日期范围。 */
  async trend(req: RequestWithContext, rawQuery: Record<string, string>, rawBody: unknown, now = new Date()): Promise<PpTrendResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const input = ProductPerformanceTrendSchema.parse(rawBody ?? {})
    const caps = capsOf(access.permissions)
    if (input.metric === 'adSpend' && !caps.ads) throw appError('TENANT_ACCESS_DENIED', '广告花费趋势需要广告读取权限', { status: 403 })
    const { tenantId, scope } = access
    const { from, to } = access.periods.period
    const members = await loadMembers(this.prisma, tenantId, scope, input.dimension, input.ids)
    const field = { sales: 'salesAmount', units: 'units', sessions: 'sessions', adSpend: 'adsSpend' }[input.metric] as 'salesAmount' | 'units' | 'sessions' | 'adsSpend'
    const days = eachDay(from, to)
    const rows: PpTrendResponse['rows'] = {}
    if (members.asins.length > 0) {
      const found = await this.prisma.asinDailySummary.groupBy({
        by: ['sellerAccountId', 'asin', 'summaryDate'],
        where: { tenantId, ...storeWhere(scope), asin: { in: members.asins }, sellerAccountId: { in: members.storeIds }, currency: 'USD', summaryDate: { gte: asDate(from), lte: asDate(to) } },
        _sum: { [field]: true },
        orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }, { summaryDate: 'asc' }],
        take: PP_UNIT_LIMIT + 1,
      })
      const perRow = new Map<string, Map<string, number>>()
      for (const row of found.slice(0, PP_UNIT_LIMIT)) {
        const value = num((row._sum as Record<string, { toString(): string } | null>)[field])
        if (value === null) continue
        for (const id of members.rowsByUnit.get(unitKey(row.sellerAccountId, row.asin)) ?? []) {
          const series = perRow.get(id) ?? new Map<string, number>()
          const day = dateText(row.summaryDate)
          series.set(day, (series.get(day) ?? 0) + value)
          perRow.set(id, series)
        }
      }
      for (const id of members.byRow.keys()) rows[id] = { trend: days.map(day => (perRow.get(id)?.has(day) ? round(perRow.get(id)!.get(day)!, 2) : null)) }
      return { metric: input.metric, days, rows, truncated: members.truncated || found.length > PP_UNIT_LIMIT }
    }
    return { metric: input.metric, days, rows, truncated: members.truncated }
  }

  /** 慢指标：库存与售后。只算请求且有权限的列。 */
  async slow(req: RequestWithContext, rawQuery: Record<string, string>, rawBody: unknown, now = new Date()): Promise<PpAsyncResponse> {
    const access = await this.access.resolve(req, rawQuery, now)
    const input = ProductPerformanceAsyncSchema.parse(rawBody ?? {})
    const caps = capsOf(access.permissions)
    const requested = (input.metrics ?? PP_SLOW_KEYS) as PpMetricKey[]
    const wanted = new Set(PP_SLOW_KEYS.filter(key => requested.includes(key) && allowedBy(caps, PP_METRICS[key].require)))
    const members = await loadMembers(this.prisma, access.tenantId, access.scope, input.dimension, input.ids)
    const result: PpAsyncResponse = { rows: {}, gaps: {}, truncated: members.truncated }
    if (wanted.size === 0 || members.asins.length === 0) return result
    const sold = await this.soldByRow(access, members, input.dimension)
    if (wanted.has('fbaAvailable') || wanted.has('inbound') || wanted.has('daysOfSupply')) await this.inventory(access, members, wanted, sold, result)
    if (wanted.has('returnRate')) await this.returns(access, members, sold, result)
    if (wanted.has('refundRate')) await this.refunds(access, caps, members, result)
    if (wanted.has('rating')) await this.ratings(access, members, result)
    return result
  }

  /** 每一行本期的销量：行下各 店铺 × ASIN 的销量相加；SKU 维度下 ASIN 在店铺里有多个 SKU 时，ASIN 销量拆不到 SKU，这一行没有销量（不估算）。 */
  private async soldByRow(access: BrAccess, members: Members, dimension: string): Promise<Map<string, number>> {
    const units = await this.unitsSold(access, members)
    const shared = new Set<string>()
    if (dimension === 'sku') {
      const counts = await this.prisma.fbaProduct.groupBy({
        by: ['sellerAccountId', 'asin'],
        where: { tenantId: access.tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(access.scope), sellerAccountId: { in: members.storeIds }, asin: { in: members.asins } },
        _count: { _all: true },
        orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
        take: PP_UNIT_LIMIT,
      })
      for (const row of counts) if (row._count._all > 1) shared.add(unitKey(row.sellerAccountId, row.asin))
    }
    const sold = new Map<string, number>()
    for (const [unit, rowIds] of members.rowsByUnit) {
      if (shared.has(unit) || !units.has(unit)) continue
      for (const id of rowIds) sold.set(id, (sold.get(id) ?? 0) + units.get(unit)!)
    }
    return sold
  }

  private async unitsSold(access: BrAccess, members: Members): Promise<Map<string, number>> {
    const { from, to } = access.periods.period
    const found = await this.prisma.asinDailySummary.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: {
        tenantId: access.tenantId,
        ...storeWhere(access.scope),
        asin: { in: members.asins },
        sellerAccountId: { in: members.storeIds },
        currency: 'USD',
        summaryDate: { gte: asDate(from), lte: asDate(to) },
      },
      _sum: { units: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: PP_UNIT_LIMIT,
    })
    return new Map(found.map(row => [unitKey(row.sellerAccountId, row.asin), row._sum.units ?? 0]))
  }

  private async inventory(access: BrAccess, members: Members, wanted: ReadonlySet<PpMetricKey>, sold: ReadonlyMap<string, number>, result: PpAsyncResponse) {
    const skus = [...new Set([...members.byRow.values()].flat().map(ref => ref.sku))]
    const found = await this.prisma.fbaInventoryRecord.findMany({
      where: { tenantId: access.tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(access.scope), sellerAccountId: { in: members.storeIds }, sellerSku: { in: skus } },
      select: { sellerAccountId: true, sellerSku: true, fulfillableQuantity: true, inboundWorkingQuantity: true, inboundShippedQuantity: true, inboundReceivingQuantity: true },
      orderBy: [{ id: 'asc' }],
      take: PP_UNIT_LIMIT + 1,
    })
    if (found.length > PP_UNIT_LIMIT) result.truncated = true
    const bySku = new Map(found.slice(0, PP_UNIT_LIMIT).map(row => [`${row.sellerAccountId}|${row.sellerSku}`, row]))
    const days = access.periods.period.days
    for (const [id, refs] of members.byRow) {
      const hits = refs.flatMap(ref => (bySku.has(`${ref.storeId}|${ref.sku}`) ? [bySku.get(`${ref.storeId}|${ref.sku}`)!] : []))
      if (hits.length === 0) continue
      const available = hits.reduce((sum, row) => sum + row.fulfillableQuantity, 0)
      if (wanted.has('fbaAvailable')) put(result.rows, [id], 'fbaAvailable', available)
      if (wanted.has('inbound'))
        put(
          result.rows,
          [id],
          'inbound',
          hits.reduce((sum, row) => sum + row.inboundWorkingQuantity + row.inboundShippedQuantity + row.inboundReceivingQuantity, 0),
        )
      const units = sold.get(id) ?? 0
      if (wanted.has('daysOfSupply') && units > 0) put(result.rows, [id], 'daysOfSupply', round(available / (units / days), 1))
    }
  }

  private async returns(access: BrAccess, members: Members, sold: ReadonlyMap<string, number>, result: PpAsyncResponse) {
    const base = { tenantId: access.tenantId, marketplaceId: US_MARKETPLACE_ID, ...storeWhere(access.scope) }
    if (!(await this.prisma.fbaReturnCase.findFirst({ where: base, select: { id: true } }))) {
      result.gaps.returnRate = '这些店铺还没有同步过退货记录，退货率尚未接入'
      return
    }
    const { from, to } = access.periods.period
    const found = await this.prisma.fbaReturnCase.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { ...base, sellerAccountId: { in: members.storeIds }, asin: { in: members.asins }, returnDate: { gte: asDate(from), lt: new Date(asDate(to).getTime() + 86_400_000) } },
      _sum: { quantity: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: PP_UNIT_LIMIT,
    })
    const perRow = new Map<string, number>()
    for (const row of found) for (const id of members.rowsByUnit.get(unitKey(row.sellerAccountId, row.asin)) ?? []) perRow.set(id, (perRow.get(id) ?? 0) + (row._sum.quantity ?? 0))
    for (const id of members.byRow.keys()) {
      const units = sold.get(id) ?? 0
      if (units > 0) put(result.rows, [id], 'returnRate', round((perRow.get(id) ?? 0) / units, 6))
    }
  }

  private async refunds(access: BrAccess, caps: Caps, members: Members, result: PpAsyncResponse) {
    if (!caps.profit) return
    const { from, to } = access.periods.period
    const found = await this.prisma.profitDaily.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: {
        tenantId: access.tenantId,
        basis: 'ORDERED',
        ...storeWhere(access.scope),
        sellerAccountId: { in: members.storeIds },
        asin: { in: members.asins },
        profitDate: { gte: asDate(from), lte: asDate(to) },
      },
      _sum: { refunds: true, revenue: true },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: PP_UNIT_LIMIT,
    })
    const perRow = new Map<string, { refunds: number; revenue: number }>()
    for (const row of found) {
      if (row.asin === null) continue
      for (const id of members.rowsByUnit.get(unitKey(row.sellerAccountId, row.asin)) ?? []) {
        const held = perRow.get(id) ?? { refunds: 0, revenue: 0 }
        perRow.set(id, { refunds: held.refunds + (num(row._sum.refunds) ?? 0), revenue: held.revenue + (num(row._sum.revenue) ?? 0) })
      }
    }
    for (const [id, value] of perRow) if (value.revenue > 0) put(result.rows, [id], 'refundRate', round(value.refunds / value.revenue, 6))
  }

  /** 评分：每个 店铺 × ASIN 取最近一次评分文件的值，多个 ASIN 按评分数加权。 */
  private async ratings(access: BrAccess, members: Members, result: PpAsyncResponse) {
    const found = await this.prisma.reviewMetricSnapshot.findMany({
      where: { tenantId: access.tenantId, ...storeWhere(access.scope), sellerAccountId: { in: members.storeIds }, asin: { in: members.asins }, avgRating: { not: null } },
      select: { sellerAccountId: true, asin: true, avgRating: true, ratingCount: true },
      orderBy: [{ captureDate: 'desc' }, { id: 'asc' }],
      take: PP_UNIT_LIMIT,
    })
    const latest = new Map<string, { rating: number; count: number }>()
    for (const row of found) {
      const key = unitKey(row.sellerAccountId, row.asin)
      if (!latest.has(key)) latest.set(key, { rating: num(row.avgRating)!, count: row.ratingCount ?? 0 })
    }
    if (latest.size === 0) {
      result.gaps.rating = '还没有导入评分文件，评分尚未接入'
      return
    }
    const perRow = new Map<string, { weighted: number; count: number; plain: number; n: number }>()
    for (const [key, value] of latest) {
      for (const id of members.rowsByUnit.get(key) ?? []) {
        const held = perRow.get(id) ?? { weighted: 0, count: 0, plain: 0, n: 0 }
        perRow.set(id, { weighted: held.weighted + value.rating * value.count, count: held.count + value.count, plain: held.plain + value.rating, n: held.n + 1 })
      }
    }
    for (const [id, value] of perRow) put(result.rows, [id], 'rating', round(value.count > 0 ? value.weighted / value.count : value.plain / value.n, 2))
  }
}
