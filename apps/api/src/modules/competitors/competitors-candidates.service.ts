import { Injectable } from '@nestjs/common'
import {
  COMPETITOR_BASIS,
  COMPETITOR_FRESHNESS_KEY,
  COMPETITOR_LIMITS,
  COMPETITOR_MARKETPLACE_ID,
  COMPETITOR_SHARE_BASIS,
  COMPETITORS_READ,
  type CompetitorCandidate,
  type CompetitorCandidatesResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService } from '../auth'
import { sourceFreshness } from '../inventory'
import { keyOf, storesOf, ymd } from './competitors-common'
import { loadOwnProducts } from './competitors-load'
import { latestCommonWeek, loadCoreTerms, loadHotTerms, shareOf, type CoreTerm, type HotMap } from './competitors-terms'

const NOTE_NO_STORE = '还没有接入亚马逊店铺；接入店铺并同步后，才能从搜索词里推荐竞品'
const NOTE_NO_WEEK = '还没有同时具备“热门搜索词”和“搜索查询表现”的周数据；需要品牌分析角色并同步这两份报告后才能推荐'
const NOTE_EMPTY = '最近一个周里没有可以推荐的竞品：点击靠前的商品都是我方商品，或者已经在关注列表里'

interface Pending {
  storeId: string
  asin: string
  title: string | null
  /** 对应的我方商品 → 这个竞品出现的那些词的搜索量合计（取合计最大的我方商品）。 */
  volumeByOwn: Map<string, number>
}

/**
 * 搜索词推荐（05 章 5.6）：在最近一个同时有“热门搜索词”和“搜索查询表现”的周里，找我方各商品核心搜索词中点击份额前三的非我方商品。
 * 候选按在我方核心词里的点击份额（下限）从高到低排，最多 50 条；已经关注的（同一个我方对应商品）不再出现。
 */
@Injectable()
export class CompetitorsCandidatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  private async storeCandidates(tenantId: string, storeId: string, storeName: string, core: Map<string, CoreTerm[]>, hot: HotMap): Promise<CompetitorCandidate[]> {
    const pending = new Map<string, Pending>()
    for (const [ownAsin, terms] of core) {
      for (const term of terms) {
        for (const slot of hot.get(term.term.toLowerCase()) ?? []) {
          if (slot.asin === ownAsin) continue
          const entry = pending.get(slot.asin) ?? { storeId, asin: slot.asin, title: null, volumeByOwn: new Map<string, number>() }
          entry.title = entry.title ?? slot.title
          entry.volumeByOwn.set(ownAsin, (entry.volumeByOwn.get(ownAsin) ?? 0) + (term.volume ?? 0))
          pending.set(slot.asin, entry)
        }
      }
    }
    const asins = [...pending.keys()]
    if (asins.length === 0) return []
    const [mine, watched] = await Promise.all([
      loadOwnProducts(this.prisma, tenantId, [storeId], asins),
      this.prisma.watchedAsin.findMany({
        where: { tenantId, sellerAccountId: storeId, marketplaceId: COMPETITOR_MARKETPLACE_ID },
        select: { asin: true, ownAsin: true },
        take: COMPETITOR_LIMITS.listMax,
      }),
    ])
    const watchedKeys = new Set(watched.map(row => `${row.asin}|${row.ownAsin}`))
    const ownTitles = await loadOwnProducts(this.prisma, tenantId, [storeId], [...core.keys()])
    const out: CompetitorCandidate[] = []
    for (const entry of pending.values()) {
      if (mine.has(keyOf(storeId, entry.asin))) continue // 我方自己的商品不是竞品
      const [ownAsin] = [...entry.volumeByOwn].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] ?? []
      if (!ownAsin || watchedKeys.has(`${entry.asin}|${ownAsin}`)) continue
      const result = shareOf(core.get(ownAsin) ?? [], hot, entry.asin)
      out.push({
        storeId,
        storeName,
        asin: entry.asin,
        title: entry.title,
        ownAsin,
        ownTitle: ownTitles.get(keyOf(storeId, ownAsin))?.title ?? null,
        terms: result.terms.slice(0, COMPETITOR_LIMITS.candidateTermsShown),
        termCount: result.terms.length,
        clickShare: result.share,
        clickShareTerms: { hit: result.hit, total: result.total },
      })
    }
    return out
  }

  async candidates(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<CompetitorCandidatesResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, COMPETITORS_READ, rawQuery)
    const tenantId = context.tenantId
    const stores = await storesOf(this.prisma, tenantId, scope)
    const freshness = await sourceFreshness(this.prisma, tenantId, scope, [COMPETITOR_FRESHNESS_KEY], now)
    const basis = `${COMPETITOR_BASIS}${COMPETITOR_SHARE_BASIS}`
    if (stores.length === 0) return { state: 'NOT_CONNECTED', note: NOTE_NO_STORE, period: null, items: [], truncated: false, freshness, basis }
    const all: CompetitorCandidate[] = []
    let latest: Date | null = null
    for (const store of stores.slice(0, COMPETITOR_LIMITS.candidateStoresMax)) {
      const week = await latestCommonWeek(this.prisma, tenantId, store.id)
      if (!week) continue
      latest = latest && latest.getTime() >= week.getTime() ? latest : week
      const core = await loadCoreTerms(this.prisma, tenantId, store.id, week)
      const terms = [...new Set([...core.values()].flatMap(items => items.map(item => item.term)))]
      const hot = (await loadHotTerms(this.prisma, tenantId, store.id, [week], terms)).get(ymd(week))
      if (hot) all.push(...(await this.storeCandidates(tenantId, store.id, store.name, core, hot)))
    }
    all.sort((a, b) => (b.clickShare ?? -1) - (a.clickShare ?? -1) || b.termCount - a.termCount || a.asin.localeCompare(b.asin) || a.storeId.localeCompare(b.storeId))
    const items = all.slice(0, COMPETITOR_LIMITS.candidatesMax)
    const truncated = all.length > items.length || stores.length > COMPETITOR_LIMITS.candidateStoresMax
    if (!latest) return { state: 'NO_DATA', note: NOTE_NO_WEEK, period: null, items: [], truncated: false, freshness, basis }
    const period = { kind: 'WEEK' as const, start: ymd(latest) }
    return items.length === 0 ? { state: 'NO_DATA', note: NOTE_EMPTY, period, items, truncated, freshness, basis } : { state: 'OK', note: null, period, items, truncated, freshness, basis }
  }
}
