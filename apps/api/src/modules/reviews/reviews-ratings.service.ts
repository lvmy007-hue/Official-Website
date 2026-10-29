import { Injectable } from '@nestjs/common'
import {
  REVIEWS_LIMITS,
  REVIEWS_MARKETPLACE_ID,
  REVIEWS_RATINGS_BASIS,
  ratingDeltaOf,
  recentRatingPoints,
  type RatingRow,
  type RatingSnapshotLite,
  type RatingsSummary,
  type RatingsTabResponse,
} from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { decodeOffset, keyOf, memberNames, num, pageOf, textCompare, titlesOf, ymd, type ReviewsTabInput } from './reviews-common'

const SOURCE_LABEL = '文件导入'
const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并导入评分文件后，才有评分记录'
const NOTE_NONE = '尚无记录，请先导入评分文件'
const NOTE_FILTERED = '没有符合筛选条件的商品；可以放宽筛选条件'

interface Snapshot {
  sellerAccountId: string
  asin: string
  avgRating: number | null
  ratingCount: number | null
  distribution: Record<string, number> | null
  date: string
  sourceFileName: string
  importedBy: string
}
interface Entry {
  key: string
  storeId: string
  asin: string
  history: Snapshot[]
}

/** JSON 里的星级分布只认键 1 到 5、值是不小于 0 的整数，其余当作没有。 */
function distributionOf(value: unknown): Record<string, number> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const out: Record<string, number> = {}
  for (const star of ['1', '2', '3', '4', '5']) {
    const item = (value as Record<string, unknown>)[star]
    if (typeof item === 'number' && Number.isInteger(item) && item >= 0) out[star] = item
  }
  return Object.keys(out).length > 0 ? out : null
}

const lite = (item: Snapshot): RatingSnapshotLite => ({ date: item.date, avgRating: item.avgRating, ratingCount: item.ratingCount })
const latestOf = (entry: Entry): Snapshot => entry.history[entry.history.length - 1]

/** 空值永远排在最后，不随升降序翻转（没有数据不是最小也不是最大）。 */
function compareNullable(a: number | string | null, b: number | string | null, dir: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  const order = typeof a === 'string' && typeof b === 'string' ? textCompare(a, b) : Number(a) - Number(b)
  return dir === 'asc' ? order : -order
}

/** 评分概况（05 章 5.7）：评分只来自文件导入；每个店铺 × ASIN 一行最新评分，带与上一次采集的对比和最近 12 个采集点。 */
@Injectable()
export class ReviewsRatingsService {
  constructor(private readonly prisma: PrismaService) {}

  private async loadHistory(tenantId: string, storeIds: readonly string[]): Promise<{ entries: Entry[]; truncated: boolean }> {
    const found = await this.prisma.reviewMetricSnapshot.findMany({
      where: { tenantId, sellerAccountId: { in: [...storeIds] } },
      select: { sellerAccountId: true, asin: true, avgRating: true, ratingCount: true, distributionJson: true, captureDate: true, sourceFileName: true, importedBy: true },
      orderBy: [{ captureDate: 'desc' }, { id: 'asc' }],
      take: REVIEWS_LIMITS.ratingRowsMax + 1,
    })
    const truncated = found.length > REVIEWS_LIMITS.ratingRowsMax
    const map = new Map<string, Entry>()
    // 输入按采集日期从新到旧；历史要从旧到新，所以前插
    for (const row of found.slice(0, REVIEWS_LIMITS.ratingRowsMax)) {
      const key = keyOf(row.sellerAccountId, row.asin)
      const entry = map.get(key) ?? { key, storeId: row.sellerAccountId, asin: row.asin, history: [] }
      entry.history.unshift({
        sellerAccountId: row.sellerAccountId,
        asin: row.asin,
        avgRating: num(row.avgRating),
        ratingCount: row.ratingCount,
        distribution: distributionOf(row.distributionJson),
        date: ymd(row.captureDate),
        sourceFileName: row.sourceFileName,
        importedBy: row.importedBy,
      })
      map.set(key, entry)
    }
    return { entries: [...map.values()], truncated }
  }

  /** 商品目录里的（店铺，ASIN）数。 */
  private async catalogCount(tenantId: string, storeIds: readonly string[]): Promise<number> {
    if (storeIds.length === 0) return 0
    const groups = await this.prisma.fbaProduct.groupBy({
      by: ['sellerAccountId', 'asin'],
      where: { tenantId, sellerAccountId: { in: [...storeIds] }, marketplaceId: REVIEWS_MARKETPLACE_ID },
      orderBy: [{ sellerAccountId: 'asc' }, { asin: 'asc' }],
      take: 20_000,
    })
    return groups.length
  }

  private summaryOf(entries: readonly Entry[], catalogAsins: number): RatingsSummary {
    const latest = entries.map(latestOf)
    const ratings = latest.map(item => item.avgRating).filter((value): value is number => value !== null)
    const dates = latest.map(item => item.date).sort()
    return {
      catalogAsins,
      withRating: entries.length,
      latestCapture: dates.length > 0 ? dates[dates.length - 1] : null,
      lowestRating: ratings.length > 0 ? Math.min(...ratings) : null,
      below4: ratings.length > 0 ? ratings.filter(value => value < 4).length : null,
    }
  }

  async tab(input: ReviewsTabInput): Promise<RatingsTabResponse> {
    const { tenantId, query, stores, visible } = input
    const storeIds = visible.map(store => store.id)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const [history, catalogAsins] = await Promise.all([this.loadHistory(tenantId, storeIds), this.catalogCount(tenantId, storeIds)])
    const summary = this.summaryOf(history.entries, catalogAsins)
    // 搜标题要先取全部标题；不搜时只取当前页的标题
    const titles = query.q
      ? await titlesOf(
          this.prisma,
          tenantId,
          storeIds,
          history.entries.map(entry => entry.asin),
        )
      : new Map<string, string>()
    const needle = query.q?.trim().toLowerCase()
    const matched = history.entries.filter(entry => {
      const latest = latestOf(entry)
      if (query.ratingBelow !== undefined && !(latest.avgRating !== null && latest.avgRating < query.ratingBelow)) return false
      if (needle && !entry.asin.toLowerCase().includes(needle) && !(titles.get(entry.key) ?? '').toLowerCase().includes(needle)) return false
      return true
    })
    const sortKey = (entry: Entry): number | string | null => {
      const latest = latestOf(entry)
      switch (query.sort.field) {
        case 'avgRating':
          return latest.avgRating
        case 'ratingCount':
          return latest.ratingCount
        case 'captureDate':
          return latest.date
        case 'delta':
          return ratingDeltaOf(entry.history.map(lite)).ratingDelta
        default:
          return entry.asin
      }
    }
    const sorted = [...matched].sort(
      (a, b) =>
        compareNullable(sortKey(a), sortKey(b), query.sort.dir) ||
        textCompare(a.asin, b.asin) ||
        textCompare(names.get(a.storeId) ?? '', names.get(b.storeId) ?? '') ||
        textCompare(a.storeId, b.storeId),
    )
    const capped = sorted.length > REVIEWS_LIMITS.ratingListMax
    const list = capped ? sorted.slice(0, REVIEWS_LIMITS.ratingListMax) : sorted
    const { page, pageInfo } = pageOf(list, offset, query.pageSize, binding)
    const pageTitles = query.q
      ? titles
      : await titlesOf(
          this.prisma,
          tenantId,
          storeIds,
          page.map(entry => entry.asin),
        )
    const importers = await memberNames(
      this.prisma,
      tenantId,
      page.map(entry => latestOf(entry).importedBy),
    )
    const items = page.map((entry): RatingRow => {
      const latest = latestOf(entry)
      const delta = ratingDeltaOf(entry.history.map(lite))
      return {
        storeId: entry.storeId,
        storeName: names.get(entry.storeId) ?? '',
        asin: entry.asin,
        title: pageTitles.get(entry.key) ?? null,
        avgRating: latest.avgRating,
        ratingCount: latest.ratingCount,
        captureDate: latest.date,
        distribution: latest.distribution,
        sourceLabel: SOURCE_LABEL,
        sourceFileName: latest.sourceFileName,
        importedBy: importers.get(latest.importedBy) ?? null,
        ratingDelta: delta.ratingDelta,
        countDelta: delta.countDelta,
        previousDate: delta.previousDate,
        trend: recentRatingPoints(entry.history.map(lite)),
      }
    })
    let state: RatingsTabResponse['state'] = 'OK'
    let note: string | null = null
    if (stores.length === 0) {
      state = 'NOT_CONNECTED'
      note = NOTE_NO_STORE
    } else if (history.entries.length === 0) {
      state = 'NO_DATA'
      note = NOTE_NONE
    } else if (matched.length === 0) {
      state = 'NO_DATA'
      note = NOTE_FILTERED
    }
    return { tab: 'ratings', state, note, items, pageInfo, summary, stores, truncated: history.truncated || capped, basis: REVIEWS_RATINGS_BASIS }
  }
}
