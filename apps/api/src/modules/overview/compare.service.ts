import { Injectable } from '@nestjs/common'
import { AsinRankQuerySchema, type AsinRankResponse, type AsinRankRow, type DashState, type StoreCompareResponse, type VolatilityResponse, type WaterfallResponse } from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { changeRatio, consecutiveDecliners, driverWaterfall, safeDivide, storeWaterfall, type AsinPeriodSales } from './aggregate'
import { NOTE_ADS, NOTE_FORBIDDEN, NOTE_PROFIT } from './kpi-cards'
import { OverviewContextService } from './overview-context.service'
import { period, previousPeriod } from './period'
import { asinSalesTotal, asinsSeenBefore, asinTotals, asinTotalsFor, storeValues, totalValues, type AsinTotals } from './summary-queries'

export const RANK_SIZE = 10
/** 利润率、利润变化需要逐个 ASIN 计算，只在销售额靠前的这么多个 ASIN 里排名。 */
export const RANK_CANDIDATES = 1000
/** 瀑布里比较两个期间的候选 ASIN 数（各取销售额最高的这么多个，再补齐另一期的数）。 */
const WATERFALL_CANDIDATES = 500
const WATERFALL_TOP = 5
/** 波动异常：只在上上期销售额靠前的这么多个 ASIN 内检查，最多列出这么多行。 */
const VOLATILITY_CANDIDATES = 1000
const VOLATILITY_SIZE = 50
const NOTE_INVENTORY = '库存风险数来自库存规则引擎（P2a-06），目前尚未接入'
const NOTE_HEALTH = '账户健康状态来自账户健康同步（P5），目前尚未接入'

// 经营控制台第三、四行：店铺经营对比、ASIN 排名、增长归因瀑布（04 章 4.1 第 5、6 项）。
@Injectable()
export class CompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly base: OverviewContextService,
  ) {}

  async storeCompare(req: RequestWithContext, query: Record<string, string>): Promise<StoreCompareResponse> {
    const request = await this.base.prepare(req, query)
    const { period, compare } = request.periods
    const [stores, current, previous, previousTotal] = await Promise.all([
      this.base.stores(request),
      storeValues(this.prisma, request.ctx, period.from, period.to),
      compare ? storeValues(this.prisma, request.ctx, compare.from, compare.to) : Promise.resolve(null),
      compare ? totalValues(this.prisma, request.ctx, compare.from, compare.to) : Promise.resolve(null),
    ])
    const comparable = previousTotal?.hasRows === true
    const rows = stores
      .map(store => {
        const now = current.get(store.id)
        const before = previous?.get(store.id)
        const sales = now?.sales ?? 0
        const profit = request.canSeeProfit ? (now?.profit ?? null) : null
        return {
          storeId: store.id,
          storeName: store.displayName,
          sales,
          compareSales: comparable ? (before?.sales ?? 0) : null,
          salesChange: comparable ? changeRatio(sales, before?.sales ?? 0) : null,
          profit,
          margin: safeDivide(profit, sales),
          adsShare: safeDivide(now?.adsSpend ?? null, sales),
        }
      })
      .sort((a, b) => b.sales - a.sales || a.storeName.localeCompare(b.storeName))
    const some = (pick: (row: (typeof rows)[number]) => number | null) => rows.some(row => pick(row) !== null)
    const profitState: DashState = !request.canSeeProfit ? 'RESTRICTED' : some(row => row.profit) ? 'OK' : 'NOT_CONNECTED'
    const adsState: DashState = some(row => row.adsShare) ? 'OK' : 'NOT_CONNECTED'
    return {
      period,
      compare,
      rows,
      columns: { profit: profitState, ads: adsState, inventoryRisk: 'NOT_CONNECTED', accountHealth: 'NOT_CONNECTED' },
      notes: {
        profit: profitState === 'RESTRICTED' ? NOTE_FORBIDDEN : profitState === 'NOT_CONNECTED' ? NOTE_PROFIT : null,
        ads: adsState === 'OK' ? null : NOTE_ADS,
        inventoryRisk: NOTE_INVENTORY,
        accountHealth: NOTE_HEALTH,
      },
    }
  }

  private rankRow(current: AsinTotals, before: AsinTotals | undefined, canSeeProfit: boolean, hasCompare: boolean): AsinRankRow {
    const profit = canSeeProfit ? current.profit : null
    const beforeProfit = canSeeProfit ? (before?.profit ?? null) : null
    return {
      asin: current.asin,
      sku: current.sku,
      units: current.units,
      sales: current.sales,
      profit,
      margin: safeDivide(profit, current.sales),
      profitChange: hasCompare && profit !== null && beforeProfit !== null ? profit - beforeProfit : null,
      salesChange: hasCompare ? changeRatio(current.sales, before?.sales ?? 0) : null,
    }
  }

  async asinRank(req: RequestWithContext, query: Record<string, string>): Promise<AsinRankResponse> {
    const request = await this.base.prepare(req, query)
    const { rankBy } = AsinRankQuerySchema.parse(query)
    const { period, compare } = request.periods
    const empty = (state: DashState, note: string): AsinRankResponse => ({ period, compare, rankBy, state, note, top: [], bottom: [], candidateLimit: null })
    if (rankBy !== 'sales' && !request.canSeeProfit) return empty('RESTRICTED', NOTE_FORBIDDEN)

    const pick = async (): Promise<{ top: AsinTotals[]; bottom: AsinTotals[]; candidateLimit: number | null }> => {
      const range = [request.ctx, period.from, period.to] as const
      if (rankBy === 'sales' || rankBy === 'profit') {
        const order = rankBy
        const [top, tail] = await Promise.all([
          asinTotals(this.prisma, ...range, { order, direction: 'desc', take: RANK_SIZE }),
          asinTotals(this.prisma, ...range, { order, direction: 'asc', take: RANK_SIZE * 2 }),
        ])
        const taken = new Set(top.map(item => item.asin))
        return { top, bottom: tail.filter(item => !taken.has(item.asin)).slice(0, RANK_SIZE), candidateLimit: null }
      }
      // 利润率、利润变化：在销售额靠前的候选 ASIN 里计算
      const candidates = (await asinTotals(this.prisma, ...range, { order: 'sales', direction: 'desc', take: RANK_CANDIDATES })).filter(item => item.profit !== null)
      const before =
        compare && rankBy === 'profitChange'
          ? await asinTotalsFor(
              this.prisma,
              request.ctx,
              compare.from,
              compare.to,
              candidates.map(item => item.asin),
            )
          : new Map<string, AsinTotals>()
      const score = (item: AsinTotals): number | null =>
        rankBy === 'margin' ? safeDivide(item.profit, item.sales) : before.has(item.asin) && before.get(item.asin)!.profit !== null ? item.profit! - before.get(item.asin)!.profit! : null
      const scored = candidates.map(item => ({ item, value: score(item) })).filter((entry): entry is { item: AsinTotals; value: number } => entry.value !== null)
      scored.sort((a, b) => b.value - a.value || a.item.asin.localeCompare(b.item.asin))
      const top = scored.slice(0, RANK_SIZE).map(entry => entry.item)
      const taken = new Set(top.map(item => item.asin))
      const bottom = [...scored]
        .reverse()
        .map(entry => entry.item)
        .filter(item => !taken.has(item.asin))
        .slice(0, RANK_SIZE)
      return { top, bottom, candidateLimit: RANK_CANDIDATES }
    }
    const { top, bottom, candidateLimit } = await pick()
    if (top.length === 0) {
      if (rankBy === 'sales') return empty('NO_DATA', '所选范围内没有 ASIN 销售记录')
      if (rankBy === 'profitChange' && !compare) return empty('NO_DATA', '利润变化需要先选择对比期')
      return empty('NOT_CONNECTED', NOTE_PROFIT)
    }
    const before = compare
      ? await asinTotalsFor(
          this.prisma,
          request.ctx,
          compare.from,
          compare.to,
          [...top, ...bottom].map(item => item.asin),
        )
      : new Map<string, AsinTotals>()
    const build = (items: AsinTotals[]) => items.map(item => this.rankRow(item, before.get(item.asin), request.canSeeProfit, compare !== null))
    return { period, compare, rankBy, state: 'OK', note: null, top: build(top), bottom: build(bottom), candidateLimit }
  }

  /** 波动异常：三个等长且首尾相接的期间（本期、上期、上上期），找销售额连续两期下降的 ASIN。与对比期选择无关。 */
  async volatility(req: RequestWithContext, query: Record<string, string>): Promise<VolatilityResponse> {
    const request = await this.base.prepare(req, query)
    const current = request.periods.period
    const previous = period(request.periods.previous.from, request.periods.previous.to)
    const earlierSpan = previousPeriod(previous)
    const earlier = period(earlierSpan.from, earlierSpan.to)
    const header = { period: current, previous, earlier }
    const base = await asinTotals(this.prisma, request.ctx, earlier.from, earlier.to, { order: 'sales', direction: 'desc', take: VOLATILITY_CANDIDATES })
    if (base.length === 0) return { ...header, state: 'NO_DATA', note: '上上期没有 ASIN 销售记录，无法做三期对比', rows: [], candidateLimit: null }
    const asins = base.map(item => item.asin)
    const [now, before] = await Promise.all([asinTotalsFor(this.prisma, request.ctx, current.from, current.to, asins), asinTotalsFor(this.prisma, request.ctx, previous.from, previous.to, asins)])
    const rows = consecutiveDecliners(
      base.map(item => ({ asin: item.asin, sku: item.sku, earlier: item.sales, previous: before.get(item.asin)?.sales ?? 0, current: now.get(item.asin)?.sales ?? 0 })),
      VOLATILITY_SIZE,
    )
    return { ...header, state: 'OK', note: null, rows, candidateLimit: base.length >= VOLATILITY_CANDIDATES ? VOLATILITY_CANDIDATES : null }
  }

  async growthWaterfall(req: RequestWithContext, query: Record<string, string>): Promise<WaterfallResponse> {
    const request = await this.base.prepare(req, query)
    // 没有选择对比期时按上一期拆解，并在说明里写明
    const { period } = request.periods
    const compare = request.periods.compare ?? request.periods.previous
    const [current, previous] = await Promise.all([totalValues(this.prisma, request.ctx, period.from, period.to), totalValues(this.prisma, request.ctx, compare.from, compare.to)])
    const total = current.values.sales - previous.values.sales
    const header = { period, compare, base: previous.values.sales, current: current.values.sales, total }
    if (!previous.hasRows) return { ...header, state: 'NO_DATA', note: '对比期没有订单记录，无法拆解增长', byStore: [], byDriver: [] }

    const [stores, storeNow, storeBefore, curTop, prevTop, curAsinTotal, prevAsinTotal] = await Promise.all([
      this.base.stores(request),
      storeValues(this.prisma, request.ctx, period.from, period.to),
      storeValues(this.prisma, request.ctx, compare.from, compare.to),
      asinTotals(this.prisma, request.ctx, period.from, period.to, { order: 'sales', direction: 'desc', take: WATERFALL_CANDIDATES }),
      asinTotals(this.prisma, request.ctx, compare.from, compare.to, { order: 'sales', direction: 'desc', take: WATERFALL_CANDIDATES }),
      asinSalesTotal(this.prisma, request.ctx, period.from, period.to),
      asinSalesTotal(this.prisma, request.ctx, compare.from, compare.to),
    ])
    const asins = [...new Set([...curTop, ...prevTop].map(item => item.asin))]
    const [curRest, prevRest, seen] = await Promise.all([
      asinTotalsFor(
        this.prisma,
        request.ctx,
        period.from,
        period.to,
        asins.filter(asin => !curTop.some(item => item.asin === asin)),
      ),
      asinTotalsFor(
        this.prisma,
        request.ctx,
        compare.from,
        compare.to,
        asins.filter(asin => !prevTop.some(item => item.asin === asin)),
      ),
      asinsSeenBefore(this.prisma, request.ctx, period.from, asins),
    ])
    const salesOf = (top: AsinTotals[], rest: Map<string, AsinTotals>, asin: string) => top.find(item => item.asin === asin)?.sales ?? rest.get(asin)?.sales ?? 0
    const candidates: AsinPeriodSales[] = asins.map(asin => ({ asin, current: salesOf(curTop, curRest, asin), previous: salesOf(prevTop, prevRest, asin) }))
    // 新品：本期有销售，而此前（含对比期）的汇总里从没出现过
    const newAsins = new Set(candidates.filter(item => item.current > 0 && item.previous === 0 && !seen.has(item.asin)).map(item => item.asin))
    return {
      ...header,
      state: 'OK',
      note: request.periods.compare ? null : '没有选择对比期，按上一期拆解',
      byStore: storeWaterfall(stores.map(store => ({ storeId: store.id, storeName: store.displayName, current: storeNow.get(store.id)?.sales ?? 0, previous: storeBefore.get(store.id)?.sales ?? 0 }))),
      byDriver: driverWaterfall({ totalChange: total, asinTotalChange: curAsinTotal - prevAsinTotal, candidates, newAsins, topCount: WATERFALL_TOP }),
    }
  }
}
