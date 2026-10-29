import { Injectable } from '@nestjs/common'
import {
  catalogChanges,
  COMPETITOR_BASIS,
  COMPETITOR_FRESHNESS_KEY,
  COMPETITOR_GAP_BASIS,
  COMPETITOR_LIMITS,
  COMPETITOR_MARKETPLACE_ID,
  COMPETITOR_RATING_NOTE,
  COMPETITOR_SHARE_BASIS,
  COMPETITORS_READ,
  CompetitorDetailQuerySchema,
  competitorWindowStart,
  isAsin,
  normalizeAsin,
  type CompetitorDetailResponse,
  type CompetitorSharePoint,
  type CompetitorSnapshotView,
  type RankInput,
} from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { asDay, keyOf, num, storesOf, ymd } from './competitors-common'
import { loadLatestSnapshots, loadOwnPrices, loadOwnProducts, loadOwnRanks, loadWatches, snapshotOf, type OwnPrice, type SnapshotRow } from './competitors-load'
import { rankGapFor } from './competitors-rows'
import { loadCoreTerms, loadHotTerms, recentHotWeeks, shareOf } from './competitors-terms'
import { buildCompare, buildTrend, type OwnSummary, type TimedValue } from './competitors-trend'

const DAY = 86_400_000
const NOT_FOUND = () => appError('RESOURCE_NOT_FOUND', '没有找到这个竞品：它不在你的关注列表里，或不在你可见的店铺范围内')

const viewOf = (row: SnapshotRow): CompetitorSnapshotView => ({
  title: row.title,
  brand: row.brand,
  imageCount: row.imageCount,
  price: row.price,
  currency: row.currency,
  featured: row.featured,
  fulfillment: row.fulfillment,
  memberEligible: row.memberEligible,
  rank: row.rank,
  rankName: row.rankName,
  rankClassificationId: row.rankClassificationId,
  observedAt: row.observedAt.toISOString(),
})

/** 竞品详情（05 章 5.6）：最新属性、价格与名次趋势、目录变化、核心词点击份额趋势、与我方并排对照、我方商品上的其他报价；评分与评分数没有官方来源，固定声明，不显示。 */
@Injectable()
export class CompetitorsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private async shareTrend(tenantId: string, storeId: string, ownAsin: string, asin: string): Promise<CompetitorDetailResponse['shareTrend']> {
    const weeks = await recentHotWeeks(this.prisma, tenantId, storeId, COMPETITOR_LIMITS.sharePeriods)
    if (weeks.length === 0) return { state: 'NO_DATA', note: '这个店铺还没有“热门搜索词”周报数据（需要品牌分析角色并同步）', points: [], coreTerms: 0 }
    // 核心词取我方商品最近一个有搜索查询表现的周，各周都用这一组词（词与权重固定，周与周之间才可比）
    const latestSqp = await this.prisma.brandSearchQueryPerformance.findFirst({
      where: { tenantId, sellerAccountId: storeId, reportPeriod: 'WEEK', asin: ownAsin },
      orderBy: { periodStart: 'desc' },
      select: { periodStart: true },
    })
    if (!latestSqp) return { state: 'NO_DATA', note: '我方对应商品还没有“搜索查询表现”数据，无法确定核心搜索词', points: [], coreTerms: 0 }
    const core = (await loadCoreTerms(this.prisma, tenantId, storeId, latestSqp.periodStart, [ownAsin])).get(ownAsin) ?? []
    if (core.length === 0) return { state: 'NO_DATA', note: '我方对应商品最近一周没有带搜索量的搜索词', points: [], coreTerms: 0 }
    const hot = await loadHotTerms(
      this.prisma,
      tenantId,
      storeId,
      weeks,
      core.map(item => item.term),
    )
    const points: CompetitorSharePoint[] = [...weeks]
      .reverse()
      .map(week => ({ periodStart: ymd(week), ...shareOf(core, hot.get(ymd(week)), asin) }))
      .map(({ periodStart, share, hit, total }) => ({ periodStart, share, hit, total }))
    return { state: 'OK', note: null, points, coreTerms: core.length }
  }

  async detail(req: RequestWithContext, asinParam: string, rawQuery: Record<string, string>, now = new Date()): Promise<CompetitorDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, COMPETITORS_READ, rawQuery)
    const query = CompetitorDetailQuerySchema.parse(rawQuery)
    const asin = normalizeAsin(asinParam)
    if (!isAsin(asin)) throw NOT_FOUND()
    const tenantId = context.tenantId
    const stores = await storesOf(this.prisma, tenantId, scope)
    const store = stores.find(item => item.id === query.storeId)
    if (!store) throw NOT_FOUND()
    const { rows: watchRows } = await loadWatches(this.prisma, tenantId, scope, { storeId: store.id, asin })
    if (watchRows.length === 0) throw NOT_FOUND()
    const ownList = [...new Set(watchRows.map(row => row.ownAsin).filter(value => value !== ''))]
    const requestedOwn = query.ownAsin === undefined ? undefined : query.ownAsin
    if (requestedOwn !== undefined && requestedOwn !== '' && !ownList.includes(requestedOwn)) throw NOT_FOUND()
    const ownAsin = requestedOwn === '' ? null : (requestedOwn ?? ownList[0] ?? null)
    const from = new Date(now.getTime() - query.days * DAY)
    const since = new Date(now.getTime() - COMPETITOR_LIMITS.trendDaysMax * DAY)
    const products = await loadOwnProducts(this.prisma, tenantId, [store.id], ownList)
    const [latestMap, history, ownPrices, ownRanks, ownSummary, offers, freshness] = await Promise.all([
      loadLatestSnapshots(this.prisma, tenantId, [store.id], [asin], now),
      this.prisma.competitorSnapshot.findMany({
        where: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin, observedAt: { gte: since } },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: COMPETITOR_LIMITS.trendRowsMax + 1,
      }),
      ownAsin ? loadOwnPrices(this.prisma, tenantId, [store.id], [ownAsin], now) : Promise.resolve(new Map<string, OwnPrice>()),
      ownAsin ? loadOwnRanks(this.prisma, tenantId, [store.id], [ownAsin], now) : Promise.resolve(new Map<string, RankInput[]>()),
      ownAsin
        ? this.prisma.competitiveSummarySnapshot.findFirst({
            where: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: ownAsin, observedAt: { gte: competitorWindowStart(now) } },
            orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
          })
        : Promise.resolve(null),
      ownAsin
        ? this.prisma.competitiveOffer.findMany({
            where: { tenantId, sellerAccountId: store.id, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: ownAsin, observedAt: { gte: competitorWindowStart(now) } },
            orderBy: [{ observedAt: 'desc' }, { price: 'asc' }, { offerKey: 'asc' }],
            take: COMPETITOR_LIMITS.offersMax * 4,
          })
        : Promise.resolve([]),
      sourceFreshness(this.prisma, tenantId, scope, [COMPETITOR_FRESHNESS_KEY], now),
    ])
    const latest = latestMap.get(keyOf(store.id, asin)) ?? null
    const chronological = history.map(row => snapshotOf(row)).reverse()
    const own = ownAsin ? products.get(keyOf(store.id, ownAsin)) : undefined
    const ownPrice = ownAsin ? ownPrices.get(keyOf(store.id, ownAsin)) : undefined
    const ownRankList = ownAsin ? (ownRanks.get(keyOf(store.id, ownAsin)) ?? []) : []
    const rank = rankGapFor(ownAsin, latest ?? undefined, ownRankList)
    const classification = latest?.rankClassificationId ?? null

    // 趋势：我方价格取最近有记录的一个 SKU 的价格序列；我方名次取与竞品同一分类的每日排名
    const ownSeries: TimedValue[] = []
    const ownRankSeries: TimedValue[] = []
    if (ownAsin) {
      const priceRows = await this.prisma.priceSnapshot.findMany({
        where: { tenantId, sellerAccountId: store.id, asin: ownAsin, observedAt: { gte: since } },
        orderBy: [{ observedAt: 'desc' }, { id: 'asc' }],
        take: COMPETITOR_LIMITS.trendRowsMax,
      })
      const sku = priceRows[0]?.sellerSku
      for (const row of [...priceRows].reverse()) if (row.sellerSku === sku) ownSeries.push({ at: row.observedAt, value: Number(row.price.toString()) })
      if (classification) {
        const rankRows = await this.prisma.salesRankSnapshot.findMany({
          where: { tenantId, sellerAccountId: store.id, asin: ownAsin, classificationId: classification, snapshotDate: { gte: asDay(ymd(since)) } },
          orderBy: { snapshotDate: 'asc' },
          take: COMPETITOR_LIMITS.trendRowsMax,
        })
        for (const row of rankRows) ownRankSeries.push({ at: row.snapshotDate, value: row.rank })
      }
    }
    const trend = buildTrend(
      {
        price: chronological.filter(row => row.price !== null).map(row => ({ at: row.observedAt, value: row.price as number })),
        rank: chronological.filter(row => row.rank !== null && row.rankClassificationId === classification).map(row => ({ at: row.observedAt, value: row.rank as number })),
        ownPrice: ownSeries,
        ownRank: ownRankSeries,
      },
      from,
    )
    const changes = catalogChanges(chronological.map(row => ({ at: row.observedAt.toISOString(), title: row.title, brand: row.brand, imageCount: row.imageCount })))
    const summary: OwnSummary | undefined = ownSummary
      ? { featuredIsOwn: ownSummary.featuredIsOwn, featuredPrice: num(ownSummary.featuredPrice), viewWeightMember: num(ownSummary.viewWeightMember) }
      : undefined
    const newest = offers[0]?.observedAt.getTime()
    const offerItems = offers
      .filter(offer => offer.observedAt.getTime() === newest)
      .slice(0, COMPETITOR_LIMITS.offersMax)
      .map(offer => ({
        fulfillment: offer.fulfillment,
        condition: offer.condition,
        price: Number(offer.price.toString()),
        shipping: num(offer.shipping),
        isFeatured: offer.isFeatured,
        isOwn: offer.isOwn,
      }))
    const noSnapshot = history.length === 0
    return {
      asin,
      store,
      ownAsin,
      ownTitle: own?.title ?? null,
      watches: watchRows.map(row => ({
        id: row.id,
        ownAsin: row.ownAsin === '' ? null : row.ownAsin,
        ownTitle: products.get(keyOf(store.id, row.ownAsin))?.title ?? null,
        reason: row.reason,
        reasonNote: row.note,
        addedAt: row.createdAt.toISOString(),
      })),
      latest: latest ? viewOf(latest) : null,
      trend: {
        state: noSnapshot ? 'NO_DATA' : 'OK',
        note: noSnapshot ? '还没有同步到这个竞品的快照；新关注的竞品要等下一次同步（每 6 小时一次）' : null,
        range: { from: from.toISOString(), to: now.toISOString() },
        points: trend.points,
        truncated: trend.truncated || history.length > COMPETITOR_LIMITS.trendRowsMax,
        currency: latest?.currency ?? 'USD',
      },
      changes: {
        state: noSnapshot ? 'NO_DATA' : 'OK',
        note: noSnapshot ? '还没有同步到快照' : changes.items.length === 0 ? '最近 180 天没有发现标题、品牌或图片数量的变化' : null,
        items: changes.items,
        truncated: changes.truncated,
      },
      shareTrend: ownAsin
        ? await this.shareTrend(tenantId, store.id, ownAsin, asin)
        : { state: 'NOT_APPLICABLE', note: '没有指定我方对应商品，无法计算在核心词中的点击份额', points: [], coreTerms: 0 },
      compare: ownAsin
        ? {
            state: 'OK',
            note: null,
            rows: buildCompare({
              competitor: latest,
              own,
              ownPrice,
              ownSummary: summary,
              ownRank: ownRankList.find(item => item.classificationId === classification) ?? null,
              rankNote: rank.gap === null ? rank.note : null,
            }),
          }
        : { state: 'NOT_APPLICABLE', note: '没有指定我方对应商品，无法并排对照', rows: [] },
      otherOffers: !ownAsin
        ? { state: 'NOT_APPLICABLE', note: '没有指定我方对应商品', observedAt: null, items: [] }
        : offerItems.length === 0
          ? { state: 'NO_DATA', note: '我方对应商品最近 3 天没有竞争报价记录（定价同步器尚未取到，或没有其他卖家）', observedAt: null, items: [] }
          : { state: 'OK', note: '这是我方商品页面上的其他卖家报价，官方接口不提供竞品商品页面上的报价', observedAt: offers[0]?.observedAt.toISOString() ?? null, items: offerItems },
      rating: { state: 'NO_OFFICIAL_SOURCE', note: COMPETITOR_RATING_NOTE },
      freshness,
      basis: `${COMPETITOR_BASIS}${COMPETITOR_SHARE_BASIS}${COMPETITOR_GAP_BASIS}`,
    }
  }
}
