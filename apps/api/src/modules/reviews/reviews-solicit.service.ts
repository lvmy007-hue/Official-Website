import { Injectable } from '@nestjs/common'
import {
  EligibleQuerySchema,
  REVIEWS_GROWTH_BASIS,
  REVIEWS_LIMITS,
  REVIEWS_SOLICIT_BASIS,
  SCOPE_PARAM_KEYS,
  SOLICITATION_STATUS_LABEL,
  SOLICITATION_STATUSES,
  ratingGrowthOf,
  solicitCoverageOf,
  type RatingGrowthRow,
  type SolicitCoverage,
  type SolicitTabResponse,
  type SolicitationStatus,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { localDate } from '../overview'
import { NOTE_NO_STORE } from './reviews-feedback'
import { DAY_MS, chunk, keyOf, num, textCompare, titlesOf, ymd, zoneOf, type ReviewsTabInput } from './reviews-common'
import { deliveredOrders } from './reviews-delivery'
import { ReviewsEligibleService } from './reviews-eligible.service'

const NOTE_NO_DELIVERY = '近 90 天没有已送达的订单：订单的包裹送达时间来自订单同步，等订单同步到送达信息后才会出现可请求的订单'
const RECENT_MAX = 20
const statusOf = (value: string): SolicitationStatus => ((SOLICITATION_STATUSES as readonly string[]).includes(value) ? (value as SolicitationStatus) : 'FAILED')

/** 请求评价页签（05 章 5.7）：可请求订单（第一页）、请求覆盖率、请求后评分数增长、最近的请求记录。 */
@Injectable()
export class ReviewsSolicitService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eligible: ReviewsEligibleService,
  ) {}

  /** 请求后评分数增长：近 90 天被请求过的 ASIN，对照请求前后各一次评分导入。 */
  private async growth(tenantId: string, stores: ReviewsTabInput['stores'], since: Date, now: Date): Promise<RatingGrowthRow[]> {
    const names = new Map(stores.map(store => [store.id, store.name]))
    const sent = await this.prisma.solicitationRequest.findMany({
      where: { tenantId, sellerAccountId: { in: stores.map(store => store.id) }, status: 'REQUESTED', sentAt: { gte: since, lte: now } },
      select: { sellerAccountId: true, asins: true, sentAt: true },
      orderBy: [{ sentAt: 'asc' }, { id: 'asc' }],
      take: REVIEWS_LIMITS.ratingRowsMax,
    })
    const byAsin = new Map<string, { storeId: string; asin: string; orders: number; first: Date }>()
    for (const request of sent)
      for (const asin of new Set(request.asins)) {
        const key = keyOf(request.sellerAccountId, asin)
        const entry = byAsin.get(key)
        if (entry) entry.orders += 1
        else byAsin.set(key, { storeId: request.sellerAccountId, asin, orders: 1, first: request.sentAt as Date })
      }
    const top = [...byAsin.values()].sort((a, b) => b.orders - a.orders || textCompare(a.asin, b.asin) || textCompare(a.storeId, b.storeId)).slice(0, REVIEWS_LIMITS.growthAsinsMax)
    if (top.length === 0) return []
    const topStores = [...new Set(top.map(item => item.storeId))]
    const snapshots = new Map<string, Array<{ date: string; avgRating: number | null; ratingCount: number | null }>>()
    for (const part of chunk([...new Set(top.map(item => item.asin))], 500)) {
      const rows = await this.prisma.reviewMetricSnapshot.findMany({
        where: { tenantId, sellerAccountId: { in: topStores }, asin: { in: part } },
        select: { sellerAccountId: true, asin: true, avgRating: true, ratingCount: true, captureDate: true },
        orderBy: [{ captureDate: 'asc' }, { id: 'asc' }],
        take: REVIEWS_LIMITS.ratingRowsMax,
      })
      for (const row of rows) {
        const key = keyOf(row.sellerAccountId, row.asin)
        snapshots.set(key, [...(snapshots.get(key) ?? []), { date: ymd(row.captureDate), avgRating: num(row.avgRating), ratingCount: row.ratingCount }])
      }
    }
    const zone = await zoneOf(this.prisma, tenantId)
    const titles = await titlesOf(
      this.prisma,
      tenantId,
      topStores,
      top.map(item => item.asin),
    )
    return top.map(item => {
      const growth = ratingGrowthOf(snapshots.get(keyOf(item.storeId, item.asin)) ?? [], localDate(item.first, zone))
      return {
        storeId: item.storeId,
        storeName: names.get(item.storeId) ?? '',
        asin: item.asin,
        title: titles.get(keyOf(item.storeId, item.asin)) ?? null,
        requestedOrders: item.orders,
        firstRequestAt: item.first.toISOString(),
        ...growth,
      }
    })
  }

  private async coverage(tenantId: string, stores: ReviewsTabInput['stores'], eligibleByStore: ReadonlyMap<string, number>, since: Date, now: Date) {
    const storeIds = stores.map(store => store.id)
    const [delivered, requested] = await Promise.all([
      deliveredOrders(this.prisma, tenantId, storeIds, { from: since, to: now }, REVIEWS_LIMITS.ratingRowsMax),
      this.prisma.solicitationRequest.groupBy({
        by: ['sellerAccountId'],
        where: { tenantId, sellerAccountId: { in: storeIds }, status: 'REQUESTED', sentAt: { gte: since, lte: now } },
        _count: { _all: true },
        orderBy: { sellerAccountId: 'asc' },
        take: 500,
      }),
    ])
    const deliveredBy = new Map<string, number>()
    for (const row of delivered.rows) deliveredBy.set(row.storeId, (deliveredBy.get(row.storeId) ?? 0) + 1)
    const requestedBy = new Map(requested.map(row => [row.sellerAccountId, row._count._all]))
    const rows = stores.map((store): SolicitCoverage => {
      const deliveredOrdersCount = deliveredBy.get(store.id) ?? 0
      const requestedOrders = requestedBy.get(store.id) ?? 0
      return {
        storeId: store.id,
        storeName: store.name,
        deliveredOrders: deliveredOrdersCount,
        requestedOrders,
        coverage: solicitCoverageOf(deliveredOrdersCount, requestedOrders),
        eligibleNow: eligibleByStore.get(store.id) ?? 0,
      }
    })
    return { rows, truncated: delivered.truncated }
  }

  async tab(input: ReviewsTabInput): Promise<SolicitTabResponse> {
    const { tenantId, rawQuery, stores, visible, now } = input
    const since = new Date(now.getTime() - REVIEWS_LIMITS.coverageDays * DAY_MS)
    // 第一页与“可请求订单”接口用同一份条件（范围参数、店铺、搜索、页大小），游标可以直接拿去翻页
    const eligibleRaw = Object.fromEntries(Object.entries(rawQuery).filter(([key]) => [...SCOPE_PARAM_KEYS, 'storeId', 'q', 'pageSize'].includes(key)))
    const eligibleQuery = EligibleQuerySchema.parse(eligibleRaw)
    const scan = await this.eligible.scan(tenantId, visible, now)
    const page = this.eligible.pageOfRows(tenantId, scan.rows, eligibleQuery)
    const eligibleByStore = new Map<string, number>()
    for (const row of scan.rows) eligibleByStore.set(row.storeId, (eligibleByStore.get(row.storeId) ?? 0) + 1)
    const [coverage, growth, recent] = await Promise.all([
      this.coverage(tenantId, visible, eligibleByStore, since, now),
      this.growth(tenantId, visible, since, now),
      this.prisma.solicitationRequest.findMany({
        where: { tenantId, sellerAccountId: { in: visible.map(store => store.id) } },
        select: { amazonOrderId: true, sellerAccountId: true, status: true, requestedAt: true, failureCode: true },
        orderBy: [{ requestedAt: 'desc' }, { id: 'asc' }],
        take: RECENT_MAX,
      }),
    ])
    const names = new Map(stores.map(store => [store.id, store.name]))
    const delivered = coverage.rows.reduce((sum, row) => sum + row.deliveredOrders, 0)
    let state: SolicitTabResponse['state'] = 'OK'
    let note: string | null = null
    if (stores.length === 0) {
      state = 'NOT_CONNECTED'
      note = NOTE_NO_STORE
    } else if (scan.rows.length === 0 && delivered === 0 && recent.length === 0) {
      state = 'NO_DATA'
      note = NOTE_NO_DELIVERY
    }
    return {
      tab: 'solicit',
      state,
      note,
      items: page.items,
      pageInfo: page.pageInfo,
      coverage: coverage.rows,
      growth,
      recent: recent.map(row => ({
        amazonOrderId: row.amazonOrderId,
        storeName: names.get(row.sellerAccountId) ?? '',
        status: statusOf(row.status),
        statusLabel: SOLICITATION_STATUS_LABEL[statusOf(row.status)],
        requestedAt: row.requestedAt.toISOString(),
        failureCode: row.failureCode,
      })),
      stores,
      truncated: scan.truncated || coverage.truncated,
      basis: REVIEWS_SOLICIT_BASIS,
      growthBasis: REVIEWS_GROWTH_BASIS,
    }
  }
}
