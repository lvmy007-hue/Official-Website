import { Injectable } from '@nestjs/common'
import {
  BA_HISTORY_PERIODS,
  BA_PERIOD_OPTIONS_LIMIT,
  BA_ROW_LIMIT,
  BA_TERM_COMPETITOR_PENDING,
  BA_TERM_GROUP_BASIS,
  BA_TERM_GROUPS,
  BaTermsQuerySchema,
  ScopeSearchSchema,
  ownTopOf,
  recentPeriodStarts,
  termGroupOf,
  type BaPeriod,
  type BaTermGroup,
  type BaTermHistoryPoint,
  type BaTermRow,
  type BaTermSlot,
  type BaTermsResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'
import { BrandAccessService } from './brand-access.service'
import { asDay, dayOf, loadProducts, num, toStarts } from './brand-load'
import { decodeOffset, pageOf } from './business-reports-page'

// 热门搜索词（P4-04，04 章 4.7，R-37）：搜索频率排名、点击份额前三的商品；与上一周期对比出机会词与风险词。
// 热门搜索词是全市场数据，企业下多家店铺会各存一份相同的行，这里按（部门、搜索词）去重，取排名最靠前的一行。
// “我方是否进前三”由商品目录里的我方 ASIN 判断；没有同步到我方商品时不判断（ownAsinCount 为 0，页面写明原因）。

interface TermRecord {
  department: string
  searchTerm: string
  rank: number | null
  slots: BaTermSlot[]
}

type TermSlotRow = {
  clickedAsin1: string | null
  clickedTitle1: string | null
  clickShare1: { toString(): string } | null
  conversionShare1: { toString(): string } | null
  clickedAsin2: string | null
  clickedTitle2: string | null
  clickShare2: { toString(): string } | null
  conversionShare2: { toString(): string } | null
  clickedAsin3: string | null
  clickedTitle3: string | null
  clickShare3: { toString(): string } | null
  conversionShare3: { toString(): string } | null
}

function slotsOf(row: TermSlotRow, own: ReadonlySet<string>): BaTermSlot[] {
  const raw = [
    { rank: 1, asin: row.clickedAsin1, title: row.clickedTitle1, click: row.clickShare1, conversion: row.conversionShare1 },
    { rank: 2, asin: row.clickedAsin2, title: row.clickedTitle2, click: row.clickShare2, conversion: row.conversionShare2 },
    { rank: 3, asin: row.clickedAsin3, title: row.clickedTitle3, click: row.clickShare3, conversion: row.conversionShare3 },
  ]
  return raw
    .filter(slot => slot.asin !== null || slot.title !== null || slot.click !== null)
    .map(slot => ({ rank: slot.rank, asin: slot.asin, title: slot.title, clickShare: num(slot.click), conversionShare: num(slot.conversion), own: slot.asin !== null && own.has(slot.asin) }))
}

const SELECT = {
  department: true,
  searchTerm: true,
  searchFrequencyRank: true,
  clickedAsin1: true,
  clickedTitle1: true,
  clickShare1: true,
  conversionShare1: true,
  clickedAsin2: true,
  clickedTitle2: true,
  clickShare2: true,
  conversionShare2: true,
  clickedAsin3: true,
  clickedTitle3: true,
  clickShare3: true,
  conversionShare3: true,
} as const

async function loadTerms(
  prisma: PrismaService,
  tenantId: string,
  scope: ResolvedScope,
  kind: BaPeriod,
  start: string,
  own: ReadonlySet<string>,
): Promise<{ records: Map<string, TermRecord>; truncated: boolean }> {
  const found = await prisma.brandSearchTerm.findMany({
    where: { tenantId, ...storeWhere(scope), reportPeriod: kind, periodStart: asDay(start) },
    select: SELECT,
    orderBy: [{ searchFrequencyRank: { sort: 'asc', nulls: 'last' } }, { searchTerm: 'asc' }, { department: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const records = new Map<string, TermRecord>()
  for (const row of found.slice(0, BA_ROW_LIMIT)) {
    const key = `${row.department}|${row.searchTerm}`
    if (!records.has(key)) records.set(key, { department: row.department, searchTerm: row.searchTerm, rank: row.searchFrequencyRank, slots: slotsOf(row, own) })
  }
  return { records, truncated: found.length > BA_ROW_LIMIT }
}

const topOf = (record: TermRecord, own: ReadonlySet<string>) =>
  ownTopOf(
    record.slots.map(slot => ({ asin: slot.asin, clickShare: slot.clickShare })),
    own,
  )

@Injectable()
export class BrandTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
  ) {}

  async terms(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BaTermsResponse> {
    const access = await this.access.resolve(req, rawQuery)
    const query = BaTermsQuerySchema.parse({
      period: rawQuery.period,
      periodStart: rawQuery.periodStart,
      q: rawQuery.q,
      filter: rawQuery.filter,
      term: rawQuery.term,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const [products, starts] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      this.prisma.brandSearchTerm.findMany({
        where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: BA_PERIOD_OPTIONS_LIMIT,
      }),
    ])
    const own = new Set(products.map(product => product.asin))
    const period = this.access.periodOf(query.period, query.periodStart, toStarts(starts))
    const none = { records: new Map<string, TermRecord>(), truncated: false }
    const [current, previous] = period.start
      ? await Promise.all([
          loadTerms(this.prisma, access.tenantId, access.scope, query.period, period.start, own),
          period.previousStart ? loadTerms(this.prisma, access.tenantId, access.scope, query.period, period.previousStart, own) : Promise.resolve(none),
        ])
      : [none, none]
    const header = await this.access.header(access, 'search-terms', { period, hasData: current.records.size > 0, truncated: current.truncated || previous.truncated }, now)
    const wanted = query.q?.toLowerCase()
    const all = [...current.records.entries()].map(([key, record]) => {
      const here = { rank: record.rank, ...topOf(record, own) }
      const before = previous.records.get(key)
      const prior = before ? { rank: before.rank, ...topOf(before, own) } : null
      const group = own.size > 0 ? termGroupOf(here, prior) : null
      const row: BaTermRow = {
        key,
        department: record.department,
        searchTerm: record.searchTerm,
        rank: record.rank,
        previousRank: before?.rank ?? null,
        rankChange: record.rank !== null && before?.rank != null ? before.rank - record.rank : null,
        slots: record.slots,
        inTop3: here.inTop3,
        group,
      }
      return row
    })
    const counts = {
      top3: all.filter(row => row.inTop3).length,
      ...(Object.fromEntries(BA_TERM_GROUPS.map(group => [group, all.filter(row => row.group === group).length])) as Record<BaTermGroup, number>),
    }
    const filtered = all.filter(row => {
      if (wanted && !row.searchTerm.includes(wanted)) return false
      if (query.filter === 'TOP3') return row.inTop3
      return query.filter === 'ALL' || row.group === query.filter
    })
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { page, pageInfo } = pageOf(filtered, offset, query.pageSize, binding)
    const history = query.term && period.start ? await this.history(access.tenantId, access.scope, query.period, period.start, query.term.toLowerCase(), own) : null
    return { ...header, groupCounts: counts, groupBasis: BA_TERM_GROUP_BASIS, competitorNote: BA_TERM_COMPETITOR_PENDING, items: page, pageInfo, history, ownAsinCount: own.size }
  }

  /** 一个搜索词最近若干周期的排名与我方份额（同一个周期里多个部门取排名最靠前的一行）。 */
  private async history(tenantId: string, scope: ResolvedScope, kind: BaPeriod, start: string, term: string, own: ReadonlySet<string>): Promise<{ term: string; points: BaTermHistoryPoint[] }> {
    const starts = recentPeriodStarts(kind, start, BA_HISTORY_PERIODS).reverse()
    const found = await this.prisma.brandSearchTerm.findMany({
      where: { tenantId, ...storeWhere(scope), reportPeriod: kind, searchTerm: term, periodStart: { in: starts.map(asDay) } },
      select: { ...SELECT, periodStart: true },
      orderBy: [{ periodStart: 'asc' }, { searchFrequencyRank: { sort: 'asc', nulls: 'last' } }, { department: 'asc' }],
      take: BA_ROW_LIMIT,
    })
    const byPeriod = new Map<string, TermRecord>()
    for (const row of found) {
      const key = dayOf(row.periodStart)
      if (!byPeriod.has(key)) byPeriod.set(key, { department: row.department, searchTerm: row.searchTerm, rank: row.searchFrequencyRank, slots: slotsOf(row, own) })
    }
    return {
      term,
      points: starts.map(periodStart => {
        const record = byPeriod.get(periodStart)
        const top = record ? topOf(record, own) : null
        return { periodStart, rank: record?.rank ?? null, ownBestClickShare: top?.bestClickShare ?? null, inTop3: top?.inTop3 ?? false }
      }),
    }
  }
}
