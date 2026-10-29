import { Injectable } from '@nestjs/common'
import {
  COMPETITOR_BASIS,
  COMPETITOR_FRESHNESS_KEY,
  COMPETITOR_GAP_BASIS,
  COMPETITOR_SHARE_BASIS,
  COMPETITORS_READ,
  CompetitorListQuerySchema,
  type CompetitorListResponse,
  type CompetitorSort,
  type RankInput,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { decodeOffset, keyOf, pageOf, storesOf, ymd } from './competitors-common'
import { loadLatestSnapshots, loadOwnPrices, loadOwnProducts, loadOwnRanks, loadWatches, type WatchRow } from './competitors-load'
import { buildRow, compareRows, matchesQuery, summaryOf } from './competitors-rows'
import { latestCommonWeek, loadCoreTerms, loadHotTerms, shareOf, type CoreTerm, type HotMap, type ShareResult } from './competitors-terms'

const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并同步后，才能关注竞品'
const NOTE_NONE = '还没有关注任何竞品；可以在“搜索词推荐”里加入热门搜索词里点击靠前的商品，或手工添加竞品 ASIN'
const NOTE_FILTERED = '没有符合筛选条件的竞品；可以放宽筛选条件'

/** 竞品列表（05 章 5.6）：以关注记录为底，价格与目录属性来自同步器的最近快照，没有就是“尚无记录”；点击份额按我方核心搜索词重新加权（下限）。 */
@Injectable()
export class CompetitorsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  /** 每个（店铺，我方 ASIN）在最近一个有数据的周里，各竞品的点击份额。 */
  private async sharesOf(tenantId: string, watches: readonly WatchRow[]): Promise<Map<string, ShareResult>> {
    const out = new Map<string, ShareResult>()
    const byStore = new Map<string, WatchRow[]>()
    for (const watch of watches) if (watch.ownAsin !== '') byStore.set(watch.sellerAccountId, [...(byStore.get(watch.sellerAccountId) ?? []), watch])
    for (const [storeId, list] of byStore) {
      const ownAsins = [...new Set(list.map(watch => watch.ownAsin))]
      const week = await latestCommonWeek(this.prisma, tenantId, storeId, ownAsins)
      if (!week) continue
      const core = await loadCoreTerms(this.prisma, tenantId, storeId, week, ownAsins)
      const terms = [...new Set([...core.values()].flatMap(items => items.map(item => item.term)))]
      const hot: HotMap | undefined = (await loadHotTerms(this.prisma, tenantId, storeId, [week], terms)).get(ymd(week))
      for (const watch of list) {
        const mine: CoreTerm[] = core.get(watch.ownAsin) ?? []
        if (mine.length > 0) out.set(`${watch.id}`, shareOf(mine, hot, watch.asin))
      }
    }
    return out
  }

  async list(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<CompetitorListResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, COMPETITORS_READ, rawQuery)
    const query = CompetitorListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const binding = bindingOf(tenantId, query)
    const offset = decodeOffset(query.cursor, binding)
    const stores = await storesOf(this.prisma, tenantId, scope)
    const storeIds = stores.map(store => store.id)
    const names = new Map(stores.map(store => [store.id, store.name]))
    const watches = await loadWatches(this.prisma, tenantId, scope, { reason: query.reason })
    const ownAsins = [...new Set(watches.rows.map(row => row.ownAsin).filter(asin => asin !== ''))]
    const [snapshots, products, prices, ranks, shares, freshness] = await Promise.all([
      loadLatestSnapshots(this.prisma, tenantId, storeIds, [...new Set(watches.rows.map(row => row.asin))], now),
      loadOwnProducts(this.prisma, tenantId, storeIds, ownAsins),
      loadOwnPrices(this.prisma, tenantId, storeIds, ownAsins, now),
      loadOwnRanks(this.prisma, tenantId, storeIds, ownAsins, now),
      this.sharesOf(tenantId, watches.rows),
      sourceFreshness(this.prisma, tenantId, scope, [COMPETITOR_FRESHNESS_KEY], now),
    ])
    const rows = watches.rows
      .map(watch =>
        buildRow({
          watch,
          storeName: names.get(watch.sellerAccountId) ?? '',
          snapshot: snapshots.get(keyOf(watch.sellerAccountId, watch.asin)),
          own: products.get(keyOf(watch.sellerAccountId, watch.ownAsin)),
          ownPrice: prices.get(keyOf(watch.sellerAccountId, watch.ownAsin)),
          ownRanks: (ranks.get(keyOf(watch.sellerAccountId, watch.ownAsin)) ?? []) as RankInput[],
          share: shares.get(watch.id) ?? null,
        }),
      )
      .filter(row => matchesQuery(row, query.q))
    const field = query.sort.field as CompetitorSort
    const sorted = [...rows].sort((a, b) => compareRows(a, b, field, query.sort.dir))
    const { page, pageInfo } = pageOf(sorted, offset, query.pageSize, binding)
    let state: CompetitorListResponse['state'] = 'OK'
    let note: string | null = null
    if (stores.length === 0) {
      state = 'NOT_CONNECTED'
      note = NOTE_NO_STORE
    } else if (rows.length === 0) {
      state = 'NO_DATA'
      note = watches.rows.length === 0 && !query.q && !query.reason ? NOTE_NONE : NOTE_FILTERED
    }
    return {
      state,
      note,
      items: page,
      pageInfo,
      summary: summaryOf(rows),
      stores,
      truncated: watches.truncated,
      freshness,
      basis: `${COMPETITOR_BASIS}${COMPETITOR_SHARE_BASIS}${COMPETITOR_GAP_BASIS}`,
    }
  }
}
