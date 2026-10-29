import { Injectable } from '@nestjs/common'
import { ASIN_MEMBER_LIMIT, ASIN_NO_ADS_NOTE, ASIN_RANK_PARENT_NOTE, asinSelectKey, type AsinMetricKey, type AsinSelectRef, type AsinSelection } from '@nova/api-contracts'
import { PrismaService } from '../../platform/prisma.service'
import { eachDay, nullableSum } from '../overview'
import { loadFamily, loadRanksByDay, loadReturnsByDay, loadSummaryDays, type Family } from './asin-analytics-load'
import { assemblePoints, childrenOf, limitChildren, type ChildAsin } from './asin-analytics-math'
import type { BrAccess } from './business-reports-access.service'
import { loadAsinGroups, loadFamilyDaily, preferGroups } from './business-reports-load'
import { figuresOf, pointsOf, preferredRows, type BrRow } from './business-reports-math'

// 一个选中对象（父体或单个 ASIN）的逐日指标（P4-03）：父体 = 名下子体逐日相加。
// 销售与流量只读子体粒度的 ASIN 日表；广告销售、可售库存、近 7 天订购件数读 ASIN 日汇总；退货读退货记录；排名读商品目录快照。

const RETURNS_NOT_SYNCED = '退货记录还没有同步（退货报告同步后显示）；这里不会用 0 代替'
const NO_STOCK = '没有库存记录（库存同步后显示）'
const NO_DEMAND = '范围内近 7 天没有订购记录，无法估算可售天数'
const NO_RANK = '商品目录没有给出这个 ASIN 的销售排名（目录未同步，或新品、类目不排名）'
const NO_TRAFFIC = '所选日期范围内没有这个对象的销售与流量记录'

export interface SelectionResult {
  selection: AsinSelection
  truncated: boolean
}

export interface DayRange {
  from: string
  to: string
}

@Injectable()
export class AsinSelectionService {
  constructor(private readonly prisma: PrismaService) {}

  /** 父体选中时要查商品目录与父子关系；单个 ASIN 只需要它自己的商品行。 */
  familyOf(access: BrAccess, ref: AsinSelectRef, products: Family['products']): Promise<Family> {
    if (ref.kind === 'parent') return loadFamily(this.prisma, access.tenantId, access.scope, ref.asin)
    return Promise.resolve({ products: products.filter(product => product.asin === ref.asin), relationOnly: [], variationTheme: null })
  }

  /** 名下子体；超过上限时按范围内销售额从高到低保留。 */
  async membersOf(access: BrAccess, family: Family, parentAsin: string, range: DayRange): Promise<{ members: ChildAsin[]; truncated: boolean }> {
    const all = childrenOf(family.products, parentAsin, family.relationOnly)
    if (all.length <= ASIN_MEMBER_LIMIT) return { members: all, truncated: false }
    const { groups } = await loadAsinGroups(this.prisma, access.tenantId, access.scope, 'CHILD', range.from, range.to, undefined)
    const sales = new Map<string, number | null>()
    for (const group of preferGroups(groups)) sales.set(group.asin, nullableSum([sales.get(group.asin) ?? null, group.orderedSales]))
    const { kept, truncated } = limitChildren(all, sales)
    return { members: kept, truncated }
  }

  async build(access: BrAccess, ref: AsinSelectRef, family: Family, range: DayRange): Promise<SelectionResult> {
    const isParent = ref.kind === 'parent'
    const own = family.products.find(product => product.asin === ref.asin)
    const found = isParent ? await this.membersOf(access, family, ref.asin, range) : { members: [{ asin: ref.asin } as ChildAsin], truncated: false }
    const asins = found.members.map(member => member.asin)
    const days = eachDay(range.from, range.to)
    const [loaded, summary, returns, ranks] = await Promise.all([
      loadFamilyDaily(this.prisma, access.tenantId, access.scope, asins, range.from, range.to),
      loadSummaryDays(this.prisma, access.tenantId, access.scope, asins, range.from, range.to),
      loadReturnsByDay(this.prisma, access.tenantId, access.scope, asins, range.from, range.to),
      isParent ? Promise.resolve(null) : loadRanksByDay(this.prisma, access.tenantId, access.scope, ref.asin, range.from, range.to),
    ])
    const rows = preferredByAsin(loaded.rows)
    const daily = new Map(
      pointsOf(rows, days).map(point => [point.date, { sales: point.orderedSales, units: point.unitsOrdered, sessions: point.sessions, pageViews: point.pageViews, buyBox: point.buyBoxPct }]),
    )
    const figures = figuresOf(rows)
    const ratios = { conversion: figures.unitSessionPct, price: figures.avgPrice, buyBox: figures.buyBoxPct }
    const { points, totals } = assemblePoints({ days, daily, adsByDay: summary.ads, returnsByDay: returns, stock: summary.stock, rankByDay: ranks, ratios })
    const gaps: Partial<Record<AsinMetricKey, string>> = {}
    if (rows.length === 0) gaps.sales = NO_TRAFFIC
    if (summary.ads === null) gaps.adsSales = gaps.organicSales = ASIN_NO_ADS_NOTE
    if (returns === null) gaps.returnRate = RETURNS_NOT_SYNCED
    if (totals.daysOfSupply === null) gaps.daysOfSupply = [...summary.stock.values()].some(day => day.available !== null) ? NO_DEMAND : NO_STOCK
    if (totals.salesRank === null) gaps.salesRank = isParent ? ASIN_RANK_PARENT_NOTE : NO_RANK
    const selection: AsinSelection = {
      key: asinSelectKey(ref),
      kind: ref.kind,
      asin: ref.asin,
      title: own?.title ?? null,
      productId: isParent ? (own?.id ?? null) : (family.products[0]?.id ?? null),
      memberCount: isParent ? asins.length : family.products.length > 0 || rows.length > 0 ? 1 : 0,
      points,
      totals,
      gaps,
    }
    return { selection, truncated: loaded.truncated || summary.truncated || found.truncated }
  }
}

/** 逐个 ASIN 做来源取舍（同一店铺同一天两个来源都有只用数据中心）。 */
export function preferredMap(rows: ReadonlyArray<BrRow & { asin: string }>): Map<string, BrRow[]> {
  const byAsin = new Map<string, Array<BrRow & { asin: string }>>()
  for (const row of rows) byAsin.set(row.asin, [...(byAsin.get(row.asin) ?? []), row])
  return new Map([...byAsin].map(([asin, group]) => [asin, preferredRows(group)]))
}

export const preferredByAsin = (rows: ReadonlyArray<BrRow & { asin: string }>): BrRow[] => [...preferredMap(rows).values()].flat()
