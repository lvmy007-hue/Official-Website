import { Injectable } from '@nestjs/common'
import {
  BA_HISTORY_PERIODS,
  BA_NO_BRAND_LABEL,
  BA_PERIOD_OPTIONS_LIMIT,
  BA_REPEAT_NOTE,
  BA_ROW_LIMIT,
  BaRepeatQuerySchema,
  ScopeSearchSchema,
  recentPeriodStarts,
  shareDelta,
  weightedAverage,
  type BaRepeatFigures,
  type BaRepeatResponse,
  type BaRepeatRow,
  type BaRepeatSort,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf } from '../../platform/query'
import { storeWhere } from '../auth'
import { BrandAccessService } from './brand-access.service'
import { asDay, dayOf, loadProducts, num, toStarts, usd, type ProductRef } from './brand-load'
import { sumNullable } from './brand-sqp-math'
import { decodeOffset, pageOf, sortByNumber } from './business-reports-page'

// 重复购买（P4-04，04 章 4.7，R-39）：每个 ASIN（或品牌）在所选周期的订单数、独立买家数、复购买家占比、复购销售额。
// 汇总时：订单数、买家数、复购销售额相加；复购买家占比按独立买家数加权；复购销售额占比 = 复购销售额合计 ÷ 由各行倒推的销售额合计（只用两个数都有的行）。
// 官方没给的值是 null（不补 0）；复购销售额只认美元。

interface RepeatRow {
  periodStart: string
  asin: string
  orders: number | null
  uniqueCustomers: number | null
  repeatCustomersPct: number | null
  repeatRevenue: number | null
  repeatRevenuePct: number | null
}

const SORT_VALUE: Record<BaRepeatSort, (row: BaRepeatRow) => number | null> = {
  orders: row => row.orders,
  uniqueCustomers: row => row.uniqueCustomers,
  repeatCustomersPct: row => row.repeatCustomersPct,
  repeatRevenue: row => row.repeatRevenue,
  repeatRevenuePct: row => row.repeatRevenuePct,
  repeatCustomersChange: row => row.repeatCustomersChange,
}

/** 复购买家占比：按独立买家数加权；没有任何一行带买家数时，只有一行带占比才直接用它（多行没有权重不能平均）。 */
function pctOf(rows: readonly RepeatRow[]): number | null {
  const weighted = weightedAverage(rows.map(row => ({ value: row.repeatCustomersPct, weight: row.uniqueCustomers })))
  if (weighted !== null) return weighted
  const present = rows.flatMap(row => (row.repeatCustomersPct === null ? [] : [row.repeatCustomersPct]))
  return present.length === 1 ? present[0]! : null
}

export function figuresOf(rows: readonly RepeatRow[]): BaRepeatFigures {
  const withShare = rows.filter(row => row.repeatRevenue !== null && row.repeatRevenuePct !== null && row.repeatRevenuePct > 0)
  const totalRevenue = withShare.reduce((sum, row) => sum + row.repeatRevenue! / row.repeatRevenuePct!, 0)
  const repeatRevenue = withShare.reduce((sum, row) => sum + row.repeatRevenue!, 0)
  const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6)
  return {
    orders: sumNullable(rows.map(row => row.orders)),
    uniqueCustomers: sumNullable(rows.map(row => row.uniqueCustomers)),
    repeatCustomersPct: pctOf(rows),
    repeatRevenue: round(sumNullable(rows.map(row => row.repeatRevenue))),
    repeatRevenuePct: totalRevenue > 0 ? round(repeatRevenue / totalRevenue) : null,
  }
}

const brandOf = (product: ProductRef | undefined) => product?.brand ?? BA_NO_BRAND_LABEL

@Injectable()
export class BrandRepeatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: BrandAccessService,
  ) {}

  async repeat(req: RequestWithContext, rawQuery: Record<string, string>, now = new Date()): Promise<BaRepeatResponse> {
    const access = await this.access.resolve(req, rawQuery)
    const query = BaRepeatQuerySchema.parse({
      period: rawQuery.period,
      periodStart: rawQuery.periodStart,
      dimension: rawQuery.dimension,
      brand: rawQuery.brand,
      q: rawQuery.q,
      sort: rawQuery.sort,
      cursor: rawQuery.cursor,
      pageSize: rawQuery.pageSize,
    })
    const [products, starts] = await Promise.all([
      loadProducts(this.prisma, access.tenantId, access.scope),
      this.prisma.brandRepeatPurchase.findMany({
        where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period },
        distinct: ['periodStart'],
        select: { periodStart: true },
        orderBy: { periodStart: 'desc' },
        take: BA_PERIOD_OPTIONS_LIMIT,
      }),
    ])
    const period = this.access.periodOf(query.period, query.periodStart, toStarts(starts))
    const byAsin = new Map(products.map(product => [product.asin, product]))
    const trendStarts = period.start ? recentPeriodStarts(query.period, period.start, BA_HISTORY_PERIODS).reverse() : []
    const found = trendStarts.length
      ? await this.prisma.brandRepeatPurchase.findMany({
          where: { tenantId: access.tenantId, ...storeWhere(access.scope), reportPeriod: query.period, periodStart: { in: trendStarts.map(asDay) } },
          select: { periodStart: true, asin: true, orders: true, uniqueCustomers: true, repeatCustomersPct: true, repeatRevenue: true, repeatRevenuePct: true, currency: true },
          orderBy: [{ periodStart: 'asc' }, { asin: 'asc' }, { sellerAccountId: 'asc' }],
          take: BA_ROW_LIMIT + 1,
        })
      : []
    const rows = found
      .slice(0, BA_ROW_LIMIT)
      .map<RepeatRow>(row => ({
        periodStart: dayOf(row.periodStart),
        asin: row.asin,
        orders: row.orders,
        uniqueCustomers: row.uniqueCustomers,
        repeatCustomersPct: num(row.repeatCustomersPct),
        repeatRevenue: usd(row.repeatRevenue, row.currency),
        repeatRevenuePct: num(row.repeatRevenuePct),
      }))
      .filter(row => !query.brand || brandOf(byAsin.get(row.asin)) === query.brand)
    const here = rows.filter(row => row.periodStart === period.start)
    const prior = rows.filter(row => row.periodStart === period.previousStart)
    const header = await this.access.header(access, 'repeat-purchase', { period, hasData: here.length > 0, truncated: found.length > BA_ROW_LIMIT }, now)
    const labelOf = (row: RepeatRow) => (query.dimension === 'ASIN' ? row.asin : brandOf(byAsin.get(row.asin)))
    const groupBy = (list: readonly RepeatRow[]) => {
      const map = new Map<string, RepeatRow[]>()
      for (const row of list) map.set(labelOf(row), [...(map.get(labelOf(row)) ?? []), row])
      return map
    }
    const before = groupBy(prior)
    const wanted = query.q?.toLowerCase()
    const items = [...groupBy(here).entries()]
      .map<BaRepeatRow>(([label, list]) => {
        const figures = figuresOf(list)
        const earlier = before.has(label) ? figuresOf(before.get(label)!).repeatCustomersPct : null
        const product = query.dimension === 'ASIN' ? byAsin.get(label) : undefined
        return {
          ...figures,
          key: label,
          label,
          asin: query.dimension === 'ASIN' ? label : null,
          title: product?.title ?? null,
          productId: product?.id ?? null,
          asins: new Set(list.map(row => row.asin)).size,
          previousRepeatCustomersPct: earlier,
          repeatCustomersChange: shareDelta(figures.repeatCustomersPct, earlier),
        }
      })
      .filter(row => !wanted || row.label.toLowerCase().includes(wanted) || (row.title ?? '').toLowerCase().includes(wanted))
    const binding = bindingOf(access.tenantId, { ...ScopeSearchSchema.parse(rawQuery), ...query })
    const offset = decodeOffset(query.cursor, binding)
    const { page, pageInfo } = pageOf(sortByNumber(items, SORT_VALUE[query.sort.field as BaRepeatSort], query.sort.dir), offset, query.pageSize, binding)
    return {
      ...header,
      dimension: query.dimension,
      summary: figuresOf(here),
      trend: trendStarts.map(periodStart => ({ periodStart, ...figuresOf(rows.filter(row => row.periodStart === periodStart)) })),
      items: page,
      pageInfo,
      repeatNote: BA_REPEAT_NOTE,
    }
  }
}
