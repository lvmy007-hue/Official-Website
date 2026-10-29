import { Injectable } from '@nestjs/common'
import {
  BA_BASKET_BASIS,
  BA_BASKET_ADVICES,
  BA_PERIOD_OPTIONS_LIMIT,
  BA_ROW_LIMIT,
  BaBasketQuerySchema,
  ScopeSearchSchema,
  basketAdviceOf,
  shareDelta,
  type BaBasketAdvice,
  type BaBasketResponse,
  type BaBasketRow,
  type BaBasketSort,
  type BaMatrix,
  type BaPeriod,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere, type ResolvedScope } from '../auth'
import { BrandAccessService } from './brand-access.service'
import { asDay, loadProducts, num, toStarts } from './brand-load'
import { decodeOffset, pageOf, sortByNumber } from './business-reports-page'

// 购物篮分析（P4-04，04 章 4.7，R-38）：买了某个 ASIN 的订单里，同时买了另一个 ASIN 的比例（同篮率）。
// 同篮率是全市场数据，企业下多家店铺会各存一份相同的行，这里按（ASIN、同篮 ASIN）去重，取同篮率最高的一行。
// 建议只是候选，不会自动执行：同篮的是我方另一个 ASIN → 捆绑销售候选；同篮的是别家商品 → 商品定向广告候选。

const SORT_VALUE: Record<BaBasketSort, (row: BaBasketRow) => number | null> = {
  combinationPct: row => row.combinationPct,
  change: row => row.change,
  purchaseRank: row => row.purchaseRank,
}

const MATRIX_SIZE = 15

interface BasketRecord {
  asin: string
  pairedAsin: string
  combinationPct: number | null
  purchaseRank: number | null
}

async function loadBasket(prisma: PrismaService, tenantId: string, scope: ResolvedScope, kind: BaPeriod, start: string): Promise<{ records: Map<string, BasketRecord>; truncated: boolean }> {
  const found = await prisma.brandMarketBasket.findMany({
    where: { tenantId, ...storeWhere(scope), reportPeriod: kind, periodStart: asDay(start) },
    select: { asin: true, pairedAsin: true, combinationPct: true, purchaseRank: true },
    orderBy: [{ combinationPct: { sort: 'desc', nulls: 'last' } }, { asin: 'asc' }, { pairedAsin: 'asc' }],
    take: BA_ROW_LIMIT + 1,
  })
  const records = new Map<string, BasketRecord>()
  for (const row of found.slice(0, BA_ROW_LIMIT)) {
    const key = `${row.asin}|${row.pairedAsin}`
    if (!records.has(key)) records.set(key, { asin: row.asin, pairedAsin: row.pairedAsin, combinationPct: num(row.combinationPct), purchaseRank: row.purchaseRank })
  }
  return { records, truncated: found.length > BA_ROW_LIMIT }
}

/** 同篮率矩阵：取同篮率最高的若干对，行是主 ASIN、列是同篮 ASIN；没有这一对的格子是 null（不是 0）。 */
function matrixOf(rows: readonly BaBasketRow[]): BaMatrix {
  const ranked = [...rows].filter(row => row.combinationPct !== null).sort((a, b) => b.combinationPct! - a.combinationPct! || (a.key < b.key ? -1 : 1))
  const rowKeys: string[] = []
  const columnKeys: string[] = []
  for (const row of ranked) {
    if (rowKeys.length < MATRIX_SIZE && !rowKeys.includes(row.asin)) rowKeys.push(row.asin)
    if (columnKeys.length < MATRIX_SIZE && !columnKeys.includes(row.pairedAsin)) columnKeys.push(row.pairedAsin)
  }
  const cells = new Map(rows.map(row => [row.key, row.combinationPct]))
  const grid = rowKeys.map(asin => columnKeys.map(paired => cells.get(`${asin}|${paired}`) ?? null))
  const values = grid.flat().filter((value): value is number => value !== null)
  return { rows: rowKeys, columns: columnKeys, cells: grid, max: values.length > 0 ? Math.max(...values) : null }
}

@Injectable()
export class BrandBasketService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
  ) {}

  async basket(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BaBasketResponse> {
    const access = await this.access.resolve(req, rawQuery)
    const query = BaBasketQuerySchema.parse({
      period: rawQuery.period,
      periodStart: rawQuery.periodStart,
      asin: rawQuery.asin,
      q: rawQuery.q,
      sort: rawQuery.sort,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const [products, starts] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      this.prisma.brandMarketBasket.findMany({
        where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: BA_PERIOD_OPTIONS_LIMIT,
      }),
    ])
    const period = this.access.periodOf(query.period, query.periodStart, toStarts(starts))
    const none = { records: new Map<string, BasketRecord>(), truncated: false }
    const [current, previous] = period.start
      ? await Promise.all([
          loadBasket(this.prisma, access.tenantId, access.scope, query.period, period.start),
          period.previousStart ? loadBasket(this.prisma, access.tenantId, access.scope, query.period, period.previousStart) : Promise.resolve(none),
        ])
      : [none, none]
    const header = await this.access.header(access, 'market-basket', { period, hasData: current.records.size > 0, truncated: current.truncated || previous.truncated }, now)
    const byAsin = new Map(products.map(product => [product.asin, product]))
    const wanted = query.q?.toLowerCase()
    const rows = [...current.records.entries()]
      .filter(([, record]) => !query.asin || record.asin === query.asin)
      .map<BaBasketRow>(([key, record]) => {
        const base = byAsin.get(record.asin)
        const paired = byAsin.get(record.pairedAsin)
        const before = previous.records.get(key)
        return {
          key,
          asin: record.asin,
          asinTitle: base?.title ?? null,
          asinProductId: base?.id ?? null,
          pairedAsin: record.pairedAsin,
          pairedTitle: paired?.title ?? null,
          pairedOwn: paired !== undefined,
          combinationPct: record.combinationPct,
          previousPct: before?.combinationPct ?? null,
          change: shareDelta(record.combinationPct, before?.combinationPct),
          purchaseRank: record.purchaseRank,
          advice: basketAdviceOf({ pairedOwn: paired !== undefined, combinationPct: record.combinationPct }),
        }
      })
    const visible = rows.filter(row => !wanted || [row.asin, row.pairedAsin, row.asinTitle ?? '', row.pairedTitle ?? ''].some(text => text.toLowerCase().includes(wanted)))
    const adviceCounts = Object.fromEntries(BA_BASKET_ADVICES.map(advice => [advice, visible.filter(row => row.advice === advice).length])) as Record<BaBasketAdvice, number>
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { page, pageInfo } = pageOf(sortByNumber(visible, SORT_VALUE[query.sort.field as BaBasketSort], query.sort.dir), offset, query.pageSize, binding)
    return { ...header, matrix: matrixOf(visible), adviceBasis: BA_BASKET_BASIS, adviceCounts, items: page, pageInfo }
  }
}
