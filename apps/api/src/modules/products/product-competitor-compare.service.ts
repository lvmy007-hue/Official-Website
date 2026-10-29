import { Injectable } from '@nestjs/common'
import {
  ASIN360_COMPETITOR_COMPARE_BASIS,
  ASIN360_COMPETITOR_COMPARE_LIMIT,
  COMPETITOR_MARKETPLACE_ID,
  COMPETITOR_RATING_NOTE,
  COMPETITORS_READ,
  ScopeSearchSchema,
  type Asin360CompareParty,
  type Asin360CompetitorCompareResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { addDays, asDate } from '../overview'
import { ProductAccessService } from './product-access.service'
import { lastPerDay, latestOfSeries, mergeSeries, pickClassification, type Timed } from './product-competitor-compare-math'
import { rangeFor } from './product-traffic-load'

const ROW_CAP = 4000
const num = (value: { toString(): string }) => Number(value.toString())

// ASIN 360 竞品对比（P6-21，16 章 3.1 第 8 项）：本品与绑定的竞品（竞品监控里“对应我方商品”是本 ASIN 的关注项）并列，比较价格、销售排名、评分、评论数的逐日趋势。
// 竞品快照来自商品目录与竞争摘要官方接口；评分与评论数只有我方商品有来源（P4-13 文件导入），竞品没有，不估算。
// 顺序：先校验 products.read 与 competitors.read，再按成员数据范围找商品，最后才解析参数。
@Injectable()
export class ProductCompetitorCompareService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async compare(req: RequestWithContext, id: string, rawQuery: Record<string, string>, now = new Date()): Promise<Asin360CompetitorCompareResponse> {
    const { context, product } = await this.access.resolve(req, id, COMPETITORS_READ)
    const dates = ScopeSearchSchema.parse(rawQuery)
    const range = await rangeFor(this.prisma, context.tenantId, dates, now)
    const since = asDate(range.from)
    const until = asDate(addDays(range.to, 1))
    const tenantId = context.tenantId
    const storeId = product.sellerAccountId
    const ownAsin = product.asin.toUpperCase()

    const watches = await this.prisma.watchedAsin.findMany({
      where: { tenantId, sellerAccountId: storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, ownAsin },
      select: { asin: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: ASIN360_COMPETITOR_COMPARE_LIMIT + 1,
    })
    const truncated = watches.length > ASIN360_COMPETITOR_COMPARE_LIMIT
    const rivals = [...new Set(watches.slice(0, ASIN360_COMPETITOR_COMPARE_LIMIT).map(row => row.asin.toUpperCase()))]

    const canRating = hasPermission(context.permissions, 'reviews.read')
    const [snapshots, ownPrices, ownRanks, ratings] = await Promise.all([
      rivals.length > 0
        ? this.prisma.competitorSnapshot.findMany({
            where: { tenantId, sellerAccountId: storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, asin: { in: rivals }, observedAt: { gte: since, lt: until } },
            select: { asin: true, title: true, price: true, currency: true, rank: true, rankClassificationId: true, rankClassificationName: true, observedAt: true },
            orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
            take: ROW_CAP,
          })
        : Promise.resolve([]),
      this.prisma.priceSnapshot.findMany({
        where: { tenantId, sellerAccountId: storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID, sellerSku: product.sellerSku, observedAt: { gte: since, lt: until } },
        select: { price: true, observedAt: true },
        orderBy: [{ observedAt: 'asc' }, { id: 'asc' }],
        take: ROW_CAP,
      }),
      this.prisma.salesRankSnapshot.findMany({
        where: { tenantId, sellerAccountId: storeId, asin: ownAsin, snapshotDate: { gte: since, lt: until } },
        select: { classificationId: true, classificationName: true, rank: true, snapshotDate: true },
        orderBy: [{ snapshotDate: 'asc' }, { classificationId: 'asc' }],
        take: ROW_CAP,
      }),
      canRating
        ? this.prisma.reviewMetricSnapshot.findMany({
            where: { tenantId, sellerAccountId: storeId, asin: { in: [ownAsin, ...rivals] }, captureDate: { gte: since, lt: until } },
            select: { asin: true, avgRating: true, ratingCount: true, captureDate: true },
            orderBy: [{ captureDate: 'asc' }, { id: 'asc' }],
            take: ROW_CAP,
          })
        : Promise.resolve([]),
    ])

    const classification = pickClassification(
      snapshots.map(row => (row.rank === null ? null : row.rankClassificationId)),
      ownRanks.map(row => row.classificationId),
    )
    const className =
      snapshots.find(row => row.rankClassificationId === classification)?.rankClassificationName ?? ownRanks.find(row => row.classificationId === classification)?.classificationName ?? null
    const ratingMaps = (asin: string) => {
      const mine = ratings.filter(row => row.asin === asin)
      const avg: Timed[] = mine.flatMap(row => (row.avgRating === null ? [] : [{ at: row.captureDate, value: num(row.avgRating) }]))
      const count: Timed[] = mine.flatMap(row => (row.ratingCount === null ? [] : [{ at: row.captureDate, value: row.ratingCount }]))
      return { rating: lastPerDay(avg), ratingCount: lastPerDay(count) }
    }

    const own = (() => {
      const found = ratingMaps(ownAsin)
      const points = mergeSeries({
        price: lastPerDay(ownPrices.map(row => ({ at: row.observedAt, value: num(row.price) }))),
        rank: lastPerDay(ownRanks.filter(row => row.classificationId === classification).map(row => ({ at: row.snapshotDate, value: row.rank }))),
        ...found,
      })
      const party: Asin360CompareParty = {
        asin: ownAsin,
        isOwn: true,
        title: product.title,
        currency: product.currency,
        rankName: className,
        latest: { ...latestOfSeries(points), observedAt: null },
        points,
        ratingNote: !canRating ? '需要“评价”读取权限才能看评分与评论数' : found.rating.size + found.ratingCount.size > 0 ? null : '所选范围内没有评分记录（评分与评分数来自文件导入，导入后显示）',
      }
      return party
    })()

    const parties: Asin360CompareParty[] = [
      own,
      ...rivals.map((asin): Asin360CompareParty => {
        const rows = snapshots.filter(row => row.asin.toUpperCase() === asin)
        const found = ratingMaps(asin)
        const points = mergeSeries({
          price: lastPerDay(rows.flatMap(row => (row.price === null ? [] : [{ at: row.observedAt, value: num(row.price) }]))),
          rank: lastPerDay(rows.flatMap(row => (row.rank === null || row.rankClassificationId !== classification ? [] : [{ at: row.observedAt, value: row.rank }]))),
          ...found,
        })
        const last = rows.at(-1)
        return {
          asin,
          isOwn: false,
          title: last?.title ?? null,
          currency: last?.currency ?? 'USD',
          rankName: className,
          latest: { ...latestOfSeries(points), observedAt: last?.observedAt.toISOString() ?? null },
          points,
          ratingNote: found.rating.size + found.ratingCount.size > 0 ? null : COMPETITOR_RATING_NOTE,
        }
      }),
    ]

    const hasRivalData = parties.slice(1).some(party => party.points.some(point => point.price !== null || point.rank !== null))
    const note =
      rivals.length === 0
        ? '还没有为这个商品关注竞品：在“竞品监控”里添加竞品并指定对应我方商品后，这里会并列比较价格、排名与评分'
        : hasRivalData
          ? null
          : '已关注竞品，但所选范围内还没有同步到快照（新关注的竞品要等下一次同步，每 6 小时一次）'
    return { state: note === null ? 'OK' : 'NO_DATA', note, range: { from: range.from, to: range.to }, parties, truncated, basis: ASIN360_COMPETITOR_COMPARE_BASIS }
  }
}
