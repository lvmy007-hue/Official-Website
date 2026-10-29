import { Injectable } from '@nestjs/common'
import {
  ASIN360_COMPETITOR_TERM_LIMIT,
  ASIN360_COMPETITORS_BASIS,
  ASIN360_PENDING_SECTIONS,
  ASIN360_PRICING_BASIS,
  Asin360PeriodQuerySchema,
  BA_NO_DATA_NOTE,
  SALES_TRAFFIC_ASIN_FRESHNESS_KEY,
  SALES_TRAFFIC_REPORT_FRESHNESS_KEY,
  ScopeSearchSchema,
  baReportOf,
  type Asin360CompetitorsResponse,
  type Asin360PricingResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { storeWhere } from '../auth'
import { asDate, dateText, eachDay } from '../overview'
import { ProductAccessService } from './product-access.service'
import { averagePrice, competitorRows, pricingPoints, type SalesDay } from './product-market-math'
import { brandEmpty, everSynced, loadHotTerms, loadSqpStarts, loadSqpTerms, loadTrafficDaily, rangeFor, type Target } from './product-traffic-load'
import { preferKiosk, resolveFunnelPeriod, summarizeTraffic, trafficPoints } from './product-traffic-math'

const SQP_KEY = baReportOf('search-query').freshnessKey
const TERMS_KEY = baReportOf('search-terms').freshnessKey
const MAX_SUMMARY_ROWS = 1200
const num = (value: { toString(): string }) => Number(value.toString())

// ASIN 360“定价与购物车”“竞品”页签（05 章 5.2 第 9、10 个页签，P4-08）。
// 定价：标价（目录与库存同步的最近一次值）、成交均价与推荐报价（购物车）获得率逐日；推荐报价价格、竞争报价、价格历史与价格事件没有数据来源，写“尚未接入”（P4-11）。
// 竞品：核心搜索词在热门搜索词里点击份额前三的对比；关注竞品的价格、排名与推荐报价状态由竞品监控提供（P4-12），尚未接入。
// 顺序：先校验 products.read 与页签权限，再按成员数据范围找商品（范围外与不存在都是 404），最后才解析参数。
@Injectable()
export class ProductMarketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async pricing(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360PricingResponse> {
    const { context, product } = await this.access.resolve(req, id, 'pricing.read')
    const dates = ScopeSearchSchema.parse(rawQuery)
    const range = await rangeFor(this.prisma, context.tenantId, dates, now)
    const target: Target = { tenantId: context.tenantId, storeId: product.sellerAccountId, asin: product.asin }
    const [summary, traffic] = await Promise.all([
      this.prisma.asinDailySummary.findMany({
        where: { tenantId: context.tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin, summaryDate: { gte: asDate(range.from), lte: asDate(range.to) } },
        select: { summaryDate: true, units: true, salesAmount: true, currency: true },
        orderBy: { summaryDate: 'asc' },
        take: MAX_SUMMARY_ROWS,
      }),
      loadTrafficDaily(this.prisma, target, range.from, range.to),
    ])
    const days = eachDay(range.from, range.to)
    const sales = new Map<string, SalesDay>(summary.map(row => [dateText(row.summaryDate), { units: row.units, sales: num(row.salesAmount) }]))
    const trafficByDate = preferKiosk(traffic.rows)
    const points = pricingPoints(days, sales, trafficByDate)
    const hasData = summary.length > 0 || points.some(point => point.buyBoxPct !== null)
    const synced = hasData ? true : (await everSynced(this.prisma, target, [SALES_TRAFFIC_ASIN_FRESHNESS_KEY, SALES_TRAFFIC_REPORT_FRESHNESS_KEY])).synced
    return {
      range,
      currency: summary.at(-1)?.currency ?? product.currency,
      listPrice: { value: product.price === null ? null : num(product.price), currency: product.currency, updatedAt: product.sourceUpdatedAt.toISOString() },
      daily: {
        state: hasData ? 'OK' : synced ? 'NO_DATA' : 'NOT_CONNECTED',
        note: hasData ? null : '所选日期范围内这个 ASIN 没有销售记录，也没有同步到推荐报价（购物车）获得率',
        points,
        avgPrice: averagePrice(points),
        buyBoxPct: summarizeTraffic(trafficPoints(days, trafficByDate))?.buyBoxPct ?? null,
      },
      pending: [...ASIN360_PENDING_SECTIONS.pricing],
      basis: ASIN360_PRICING_BASIS,
    }
  }

  async competitors(req: RequestWithContext, id: string, rawQuery: Record<string, string>): Promise<Asin360CompetitorsResponse> {
    const { context, scope, product } = await this.access.resolve(req, id, 'competitors.read')
    const { period: kind, periodStart } = Asin360PeriodQuerySchema.parse({ period: rawQuery.period, periodStart: rawQuery.periodStart })
    const target: Target = { tenantId: context.tenantId, storeId: product.sellerAccountId, asin: product.asin.toUpperCase() }
    const base = { pending: [...ASIN360_PENDING_SECTIONS.competitors], basis: ASIN360_COMPETITORS_BASIS }
    const none = (state: 'NOT_CONNECTED' | 'NO_DATA', note: string, period: Asin360CompetitorsResponse['terms']['period'] = null): Asin360CompetitorsResponse => ({
      ...base,
      terms: { state, note, period, rows: [] },
    })

    const period = resolveFunnelPeriod(kind, periodStart, await loadSqpStarts(this.prisma, target, kind))
    if (!period) {
      const empty = await brandEmpty(this.prisma, target, SQP_KEY, null)
      return none(empty.state, `没有这个 ASIN 的搜索查询表现数据，取不到核心搜索词：${empty.note}`)
    }
    const queries = await loadSqpTerms(this.prisma, target, kind, period.start)
    const terms = queries.rows.slice(0, ASIN360_COMPETITOR_TERM_LIMIT).map(row => row.searchQuery)
    if (terms.length === 0) return none('NO_DATA', `所选周期（${period.start} 起）内这个 ASIN 没有搜索词数据；${BA_NO_DATA_NOTE}`, period)

    const hot = await loadHotTerms(this.prisma, target, kind, period.start, terms)
    if (hot.length === 0) {
      const empty = await brandEmpty(this.prisma, target, TERMS_KEY, '热门搜索词报告里没有这个 ASIN 的核心搜索词（热门搜索词只含搜索频率排名靠前的词），或所选周期还没有这份报告')
      return none(empty.state, empty.note, period)
    }
    const asins = [...new Set(hot.flatMap(row => row.slots.flatMap(slot => (slot.asin ? [slot.asin.toUpperCase()] : []))))]
    const mine = await this.prisma.fbaProduct.findMany({
      where: { tenantId: context.tenantId, ...storeWhere(scope), asin: { in: asins } },
      distinct: ['asin'],
      select: { asin: true },
      orderBy: { asin: 'asc' },
      take: 100,
    })
    const own = new Set(mine.map(row => row.asin.toUpperCase()))
    return { ...base, terms: { state: 'OK', note: null, period, rows: competitorRows(terms, hot, product.asin, own) } }
  }
}
