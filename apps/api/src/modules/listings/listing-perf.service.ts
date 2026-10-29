import { Injectable } from '@nestjs/common'
import {
  BR_FRESHNESS_KEYS,
  CATALOG_FRESHNESS_KEY,
  LISTING_PENDING_COLUMNS,
  LISTING_PERF_BASIS,
  LISTING_PERF_READ,
  ListingPerfQuerySchema,
  compareListingRows,
  isListingSort,
  productFilterWhere,
  type ListingGate,
  type ListingPerfResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { addDays, eachDay, resolvePeriods, todayIn, validZone } from '../overview'
import { baseWhere, loadAdsSales, loadDaily, loadFilterOptions, loadProducts, loadRecentUnits, loadReturns, loadSellable, loadTraffic } from './listing-perf-load'
import { anomalySummary, buildListingRows, demandDaysOf, preferTraffic, trendPoints } from './listing-perf-math'
import { decodeOffset, pageOf } from './listing-perf-page'

const NOTE_NEVER = '可见范围内还没有同步到商品；连接店铺并同步商品目录后才会出现'
const NOTE_FILTERED = '没有符合筛选条件的商品；可以放宽筛选条件'
const NOTE_NO_TRAFFIC = '所选日期范围内没有销售与流量记录：数据中心的销售与流量每天同步一次，店铺缺品牌分析角色或还没有同步时没有这份数据，会话、浏览量、转化率、销量、销售额因此为空'
const NOTE_NO_ADS = '范围内没有广告销售额：广告账户没有绑定店铺，或被推广商品日报表还没有同步'
const NOTE_ADS_RESTRICTED = '需要“广告”读取权限才能查看广告销售'
const NOTE_NO_RETURNS = '退货记录还没有同步（退货报告同步后显示）；这里不会用 0 代替'
const NOTE_RETURNS_RESTRICTED = '需要“退货”读取权限才能查看退货率'
const NOTE_NO_STOCK = '范围内还没有库存记录，可售天数同步库存后显示'
const NOTE_STOCK_RESTRICTED = '需要“库存”读取权限才能查看可售天数'

/** 刊登表现（05 章 5.3）：商品记录来自目录同步，流量与销售来自销售与流量表，广告、退货、库存各来自自己的汇总；筛选在数据库，排序与分页在内存里（偏移游标，签名并绑定全部条件）。 */
@Injectable()
export class ListingPerfService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async performance(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<ListingPerfResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const { context, scope } = await this.context.authorizeScoped(req, LISTING_PERF_READ, rawQuery)
    const query = ListingPerfQuerySchema.parse(rawQuery)
    const canAds = hasPermission(context.permissions, 'ads.read')
    const canReturns = hasPermission(context.permissions, 'returns.read')
    const canStock = hasPermission(context.permissions, 'inventory.read')
    const tenantId = context.tenantId
    const tenant = await this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
    const today = todayIn(validZone(tenant?.timezone), now)
    const periods = resolvePeriods({ from: query.from, to: query.to, compare: query.compare, compareFrom: query.compareFrom, compareTo: query.compareTo }, today)
    const { period, previous } = periods
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)

    const base = baseWhere(tenantId, scope)
    const filterWhere = productFilterWhere({
      q: query.q,
      brand: query.brand,
      category: query.category,
      status: query.status,
      fulfillment: query.fulfillment,
      ownerId: query.ownerId,
    }) as Prisma.FbaProductWhereInput
    const { records, truncated: productsTruncated } = await loadProducts(this.prisma, { ...base, ...filterWhere })
    const asins = [...new Set(records.map(record => record.asin))]
    const demandDays = demandDaysOf(period.days)
    const demandFrom = addDays(period.to, 1 - demandDays)

    const [current, before, daily, ads, returns, recentUnits, stock, names, options, freshness] = await Promise.all([
      loadTraffic(this.prisma, tenantId, scope, asins, period.from, period.to),
      loadTraffic(this.prisma, tenantId, scope, asins, previous.from, previous.to),
      loadDaily(this.prisma, tenantId, scope, asins, period.from, period.to),
      canAds ? loadAdsSales(this.prisma, tenantId, scope, asins, period.from, period.to) : Promise.resolve(null),
      canReturns ? loadReturns(this.prisma, tenantId, scope, asins, period.from, period.to) : Promise.resolve(null),
      loadRecentUnits(this.prisma, tenantId, scope, asins, demandFrom, period.to),
      canStock ? loadSellable(this.prisma, tenantId, scope) : Promise.resolve(null),
      memberNames(
        this.prisma,
        tenantId,
        records.map(record => record.ownerUserId),
      ),
      loadFilterOptions(this.prisma, base, tenantId),
      sourceFreshness(this.prisma, tenantId, scope, [...BR_FRESHNESS_KEYS, 'inventory.api', CATALOG_FRESHNESS_KEY], now),
    ])

    const currentFacts = preferTraffic(current.groups)
    const rows = buildListingRows({
      records,
      current: currentFacts,
      previous: preferTraffic(before.groups),
      ads,
      returns,
      recentUnits,
      stock,
      demandDays,
      names,
      formerLabel: FORMER_MEMBER_LABEL,
    })
    // 异常分布按“除异常筛选以外的全部条件”统计：点某类异常筛选后，分布本身不跟着变
    const anomalies = anomalySummary(rows)
    const anomaly = query.anomaly
    const shown = anomaly ? rows.filter(row => row.anomalies.includes(anomaly)) : rows
    const field = isListingSort(query.sort.field) ? query.sort.field : 'sales'
    const sorted = [...shown].sort((a, b) => compareListingRows(a, b, field, query.sort.dir))
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)

    let state: ListingPerfResponse['state'] = 'OK'
    let note: string | null = null
    if (shown.length === 0) {
      const any = records.length > 0 || (await this.prisma.fbaProduct.findFirst({ where: base, select: { id: true } }))
      state = any ? 'NO_DATA' : 'NOT_CONNECTED'
      note = any ? NOTE_FILTERED : NOTE_NEVER
    }
    const points = trendPoints(eachDay(period.from, period.to), daily.groups)
    const trendHasData = points.some(point => point.sessions !== null || point.units !== null || point.sales !== null)

    return {
      state,
      note,
      items: page,
      pageInfo,
      range: { from: period.from, to: period.to, days: period.days, defaulted: periods.defaulted },
      previousRange: { from: previous.from, to: previous.to, days: previous.days },
      currency: 'USD',
      trend: { state: trendHasData ? 'OK' : 'NO_DATA', note: trendHasData ? null : NOTE_NO_TRAFFIC, points },
      anomalies,
      gates: {
        traffic: currentFacts.size > 0 ? { state: 'OK', note: null } : { state: 'NO_DATA', note: NOTE_NO_TRAFFIC },
        ads: this.gate(canAds, ads === null ? null : ads.size, NOTE_ADS_RESTRICTED, NOTE_NO_ADS),
        returns: canReturns && returns === null ? { state: 'NOT_CONNECTED', note: NOTE_NO_RETURNS } : this.gate(canReturns, returns?.size ?? 0, NOTE_RETURNS_RESTRICTED, null),
        stock: this.gate(canStock, stock === null ? null : stock.size, NOTE_STOCK_RESTRICTED, NOTE_NO_STOCK),
      },
      pending: LISTING_PENDING_COLUMNS,
      filterOptions: options,
      truncated: productsTruncated || current.truncated || before.truncated || daily.truncated,
      freshness,
      basis: LISTING_PERF_BASIS,
    }
  }

  /** 权限在先（没有就是“无权限”），再看有没有数据；`empty` 为 null 表示有权限就算可用（退货页的“没有退货”是真实的 0 条）。 */
  private gate(allowed: boolean, size: number | null, restricted: string, empty: string | null): ListingGate {
    if (!allowed) return { state: 'RESTRICTED', note: restricted }
    if (empty !== null && (size === null || size === 0)) return { state: 'NO_DATA', note: empty }
    return { state: 'OK', note: null }
  }
}
