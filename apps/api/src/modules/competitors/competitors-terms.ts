import { COMPETITOR_LIMITS, weightedClickShare, type CompetitorCandidateTerm } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { chunk, num, ymd } from './competitors-common'

// 搜索词侧的取数与计算（P4-12）：我方商品的核心搜索词来自“搜索查询表现”（按搜索量取前 20），竞品的点击份额来自“热门搜索词”里点击前三的份额。
// 热门搜索词只给前三，所以竞品在我方核心词里的点击份额是下限；份额一律按搜索量重新加权，不对份额取平均。

export interface CoreTerm {
  term: string
  volume: number | null
}

export interface HotSlot {
  slot: 1 | 2 | 3
  asin: string
  title: string | null
  clickShare: number | null
  conversionShare: number | null
}

/** 小写后的搜索词 → 点击前三的竞品（同一个词在多个部门里重复时，同一个 ASIN 取份额更大的那条）。 */
export type HotMap = Map<string, HotSlot[]>

const WEEK = 'WEEK'

/** 热门搜索词与搜索查询表现里都有数据的最近一个周（店铺级），没有返回 null。 */
export async function latestCommonWeek(prisma: PrismaService, tenantId: string, storeId: string, ownAsins?: readonly string[]): Promise<Date | null> {
  const base = { tenantId, sellerAccountId: storeId, reportPeriod: WEEK }
  const [hot, mine] = await Promise.all([
    prisma.brandSearchTerm.findMany({ where: base, distinct: ['periodStart'], select: { periodStart: true }, orderBy: { periodStart: 'desc' }, take: COMPETITOR_LIMITS.sharePeriods }),
    prisma.brandSearchQueryPerformance.findMany({
      where: { ...base, ...(ownAsins ? { asin: { in: [...ownAsins] } } : {}) },
      distinct: ['periodStart'],
      select: { periodStart: true },
      orderBy: { periodStart: 'desc' },
      take: COMPETITOR_LIMITS.sharePeriods,
    }),
  ])
  const have = new Set(mine.map(row => row.periodStart.getTime()))
  const common = hot.map(row => row.periodStart.getTime()).filter(time => have.has(time))
  return common.length > 0 ? new Date(Math.max(...common)) : null
}

/** 店铺里有热门搜索词数据的最近若干个周（新到旧）。 */
export async function recentHotWeeks(prisma: PrismaService, tenantId: string, storeId: string, count: number): Promise<Date[]> {
  const rows = await prisma.brandSearchTerm.findMany({
    where: { tenantId, sellerAccountId: storeId, reportPeriod: WEEK },
    distinct: ['periodStart'],
    select: { periodStart: true },
    orderBy: { periodStart: 'desc' },
    take: count,
  })
  return rows.map(row => row.periodStart)
}

/** 我方商品在某个周的核心搜索词（搜索量前 20；没有搜索量的词无法加权，不取）。ownAsins 不传表示店铺里全部商品（推荐候选用，最多取搜索量靠前的 100 个商品）。 */
export async function loadCoreTerms(prisma: PrismaService, tenantId: string, storeId: string, start: Date, ownAsins?: readonly string[]): Promise<Map<string, CoreTerm[]>> {
  if (ownAsins && ownAsins.length === 0) return new Map()
  const rows = await prisma.brandSearchQueryPerformance.findMany({
    where: { tenantId, sellerAccountId: storeId, reportPeriod: WEEK, periodStart: start, ...(ownAsins ? { asin: { in: [...ownAsins] } } : {}), searchVolume: { gt: 0 } },
    select: { asin: true, searchQuery: true, searchVolume: true },
    orderBy: [{ searchVolume: 'desc' }, { searchQuery: 'asc' }],
    take: COMPETITOR_LIMITS.termRowsMax,
  })
  const out = new Map<string, CoreTerm[]>()
  for (const row of rows) {
    const list = out.get(row.asin) ?? []
    if (!ownAsins && !out.has(row.asin) && out.size >= COMPETITOR_LIMITS.candidateAsinsMax) continue
    if (list.length < COMPETITOR_LIMITS.coreTerms && !list.some(item => item.term.toLowerCase() === row.searchQuery.toLowerCase())) {
      list.push({ term: row.searchQuery, volume: row.searchVolume })
      out.set(row.asin, list)
    }
  }
  return out
}

const slotsOf = (row: {
  clickedAsin1: string | null
  clickedTitle1: string | null
  clickShare1: unknown
  conversionShare1: unknown
  clickedAsin2: string | null
  clickedTitle2: string | null
  clickShare2: unknown
  conversionShare2: unknown
  clickedAsin3: string | null
  clickedTitle3: string | null
  clickShare3: unknown
  conversionShare3: unknown
}): HotSlot[] => {
  const dec = (value: unknown) => num(value as { toString(): string } | null)
  const raw: Array<[1 | 2 | 3, string | null, string | null, unknown, unknown]> = [
    [1, row.clickedAsin1, row.clickedTitle1, row.clickShare1, row.conversionShare1],
    [2, row.clickedAsin2, row.clickedTitle2, row.clickShare2, row.conversionShare2],
    [3, row.clickedAsin3, row.clickedTitle3, row.clickShare3, row.conversionShare3],
  ]
  return raw.filter(item => item[1]).map(([slot, asin, title, click, conv]) => ({ slot, asin: String(asin).toUpperCase(), title, clickShare: dec(click), conversionShare: dec(conv) }))
}

/** 读取若干个周里这些词的热门搜索词行；返回“周起始日 → 词表”。 */
export async function loadHotTerms(prisma: PrismaService, tenantId: string, storeId: string, starts: readonly Date[], terms: readonly string[]): Promise<Map<string, HotMap>> {
  const out = new Map<string, HotMap>()
  if (starts.length === 0 || terms.length === 0) return out
  const variants = [...new Set(terms.flatMap(term => [term, term.toLowerCase()]))]
  for (const part of chunk(variants, 500)) {
    const rows = await prisma.brandSearchTerm.findMany({
      where: { tenantId, sellerAccountId: storeId, reportPeriod: WEEK, periodStart: { in: [...starts] }, searchTerm: { in: part } },
      take: Math.min(19_999, starts.length * part.length * 4),
      orderBy: [{ periodStart: 'desc' }, { searchTerm: 'asc' }, { department: 'asc' }],
    })
    for (const row of rows) {
      const map = out.get(ymd(row.periodStart)) ?? new Map<string, HotSlot[]>()
      out.set(ymd(row.periodStart), map)
      const key = row.searchTerm.toLowerCase()
      const list = map.get(key) ?? []
      for (const slot of slotsOf(row)) {
        const same = list.find(item => item.asin === slot.asin)
        if (!same) list.push(slot)
        else if ((slot.clickShare ?? 0) > (same.clickShare ?? 0)) Object.assign(same, slot)
      }
      map.set(key, list)
    }
  }
  return out
}

export interface ShareResult {
  share: number | null
  hit: number
  total: number
  terms: CompetitorCandidateTerm[]
}

/** 某个竞品在我方这个商品核心词里的点击份额（下限）与命中的词。 */
export function shareOf(core: readonly CoreTerm[], hot: HotMap | undefined, asin: string): ShareResult {
  const hits: CompetitorCandidateTerm[] = []
  const inputs = core.map(item => {
    const slot = hot?.get(item.term.toLowerCase())?.find(entry => entry.asin === asin)
    if (slot && (slot.clickShare ?? 0) > 0) hits.push({ term: item.term, slot: slot.slot, clickShare: slot.clickShare, conversionShare: slot.conversionShare, volume: item.volume })
    return { volume: item.volume, share: slot?.clickShare ?? null }
  })
  const result = weightedClickShare(inputs)
  hits.sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0) || a.term.localeCompare(b.term))
  return { ...result, terms: hits }
}
