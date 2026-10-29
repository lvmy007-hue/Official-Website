import { Injectable } from '@nestjs/common'
import {
  ASIN360_PENDING_SECTIONS,
  ASIN360_TRAFFIC_BASIS,
  Asin360PeriodQuerySchema,
  BA_NO_DATA_NOTE,
  BRAND_ANALYTICS_READ,
  SALES_TRAFFIC_ASIN_FRESHNESS_KEY,
  SALES_TRAFFIC_REPORT_FRESHNESS_KEY,
  ScopeSearchSchema,
  baReportOf,
  type Asin360CatalogFunnel,
  type Asin360SearchFunnel,
  type Asin360TrafficDaily,
  type Asin360TrafficResponse,
  type BaPeriod,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { sourceFreshness } from '../inventory'
import { eachDay } from '../overview'
import { ProductAccessService } from './product-access.service'
import { brandEmpty, everSynced, loadCatalogMetrics, loadCatalogStarts, loadSqpStarts, loadSqpTerms, loadTrafficDaily, rangeFor, type Target } from './product-traffic-load'
import { coreTerms, funnelStages, preferKiosk, resolveFunnelPeriod, summarizeTraffic, trafficPoints } from './product-traffic-math'

const SQP_KEY = baReportOf('search-query').freshnessKey
const CATALOG_KEY = baReportOf('catalog').freshnessKey
const NEED_BRAND = '需要“品牌分析”读取权限才能查看搜索词与目录表现'
const TRAFFIC_KEYS = [SALES_TRAFFIC_ASIN_FRESHNESS_KEY, SALES_TRAFFIC_REPORT_FRESHNESS_KEY]

const emptyFunnel = (state: Asin360SearchFunnel['state'], note: string): Asin360SearchFunnel => ({
  state,
  note,
  period: null,
  stages: funnelStages([], null),
  terms: [],
  termCount: 0,
  breakpoints: { state: 'INSUFFICIENT', note: '', counts: { CLICK: 0, CART: 0, PURCHASE: 0 }, medians: null },
  truncated: false,
})

// ASIN 360“流量转化”页签（05 章 5.2 第 2 个页签，P4-08）：逐日会话、浏览量、转化率、购物车（推荐报价）获得率；
// 品牌分析的核心搜索词份额漏斗与断点诊断；目录表现漏斗。设备拆分、加购率与小时级流量没有数据来源，写“尚未接入”。
// 顺序：先校验 products.read，再按成员数据范围找商品（范围外与不存在都是 404），最后才解析参数；品牌分析区块另需 analytics.brand.read（没有权限是“受限”，不是 403）。
@Injectable()
export class ProductTrafficService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async traffic(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360TrafficResponse> {
    const { context, scope, product } = await this.access.resolve(req, id)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const { period: kind, periodStart } = Asin360PeriodQuerySchema.parse({ period: rawQuery.period, periodStart: rawQuery.periodStart })
    const target: Target = { tenantId: context.tenantId, storeId: product.sellerAccountId, asin: product.asin.toUpperCase() }
    const range = await rangeFor(this.prisma, context.tenantId, dates, now)
    const brand = hasPermission(context.permissions, BRAND_ANALYTICS_READ)
    const [daily, searchFunnel, catalogFunnel, freshness] = await Promise.all([
      this.daily({ ...target, asin: product.asin }, range),
      brand ? this.search(target, kind, periodStart) : Promise.resolve(emptyFunnel('RESTRICTED', NEED_BRAND)),
      brand ? this.catalog(target, kind, periodStart) : Promise.resolve<Asin360CatalogFunnel>({ state: 'RESTRICTED', note: NEED_BRAND, period: null, current: null, previous: null }),
      sourceFreshness(this.prisma, context.tenantId, scope, [...TRAFFIC_KEYS, SQP_KEY, CATALOG_KEY], now),
    ])
    return { range, daily, searchFunnel, catalogFunnel, pending: [...ASIN360_PENDING_SECTIONS.traffic], freshness, basis: ASIN360_TRAFFIC_BASIS }
  }

  private async daily(target: Target, range: { from: string; to: string }): Promise<Asin360TrafficDaily> {
    const { rows, truncated } = await loadTrafficDaily(this.prisma, target, range.from, range.to)
    const points = trafficPoints(eachDay(range.from, range.to), preferKiosk(rows))
    const summary = summarizeTraffic(points)
    if (summary) {
      return { state: 'OK', note: truncated ? '读取行数达到上限，汇总只含已读到的部分' : null, points, summary, truncated }
    }
    const { synced } = await everSynced(this.prisma, target, TRAFFIC_KEYS)
    return {
      state: synced ? 'NO_DATA' : 'NOT_CONNECTED',
      note: synced
        ? '所选日期范围内这个 ASIN 没有销售与流量记录（数据中心按日同步，通常滞后 2 到 3 天）'
        : '这家店还没有同步过“按 ASIN”的销售与流量：数据中心需要品牌分析角色，同步任务每日自动执行，数据会自动出现',
      points,
      summary: null,
      truncated: false,
    }
  }

  private async search(target: Target, kind: BaPeriod, requested: string | undefined): Promise<Asin360SearchFunnel> {
    const period = resolveFunnelPeriod(kind, requested, await loadSqpStarts(this.prisma, target, kind))
    if (!period) {
      const empty = await brandEmpty(this.prisma, target, SQP_KEY, null)
      return emptyFunnel(empty.state, empty.note)
    }
    const [current, previous] = await Promise.all([
      loadSqpTerms(this.prisma, target, kind, period.start),
      period.previousStart ? loadSqpTerms(this.prisma, target, kind, period.previousStart) : Promise.resolve({ rows: [], truncated: false }),
    ])
    if (current.rows.length === 0) {
      const empty = await brandEmpty(this.prisma, target, SQP_KEY, `所选周期（${period.start} 起）内这个 ASIN 没有搜索词数据；${BA_NO_DATA_NOTE}`)
      return { ...emptyFunnel(empty.state, empty.note), period }
    }
    const { terms, breakpoints } = coreTerms(current.rows)
    return {
      state: 'OK',
      note: null,
      period,
      stages: funnelStages(current.rows, previous.rows.length > 0 ? previous.rows : null),
      terms,
      termCount: current.rows.length,
      breakpoints,
      truncated: current.truncated || previous.truncated,
    }
  }

  private async catalog(target: Target, kind: BaPeriod, requested: string | undefined): Promise<Asin360CatalogFunnel> {
    const available = await loadCatalogStarts(this.prisma, target, kind)
    const period = resolveFunnelPeriod(kind, requested, available)
    if (!period) {
      const empty = await brandEmpty(this.prisma, target, CATALOG_KEY, null)
      return { ...empty, period: null, current: null, previous: null }
    }
    const [current, previous] = await Promise.all([
      loadCatalogMetrics(this.prisma, target, kind, period.start),
      period.previousStart ? loadCatalogMetrics(this.prisma, target, kind, period.previousStart) : Promise.resolve(null),
    ])
    const view = { kind: period.kind, start: period.start, end: period.end, previousStart: period.previousStart }
    if (!current) {
      const empty = await brandEmpty(this.prisma, target, CATALOG_KEY, `所选周期（${period.start} 起）内这个 ASIN 没有目录表现数据；${BA_NO_DATA_NOTE}`)
      return { ...empty, period: view, current: null, previous }
    }
    return { state: 'OK', note: null, period: view, current, previous }
  }
}
