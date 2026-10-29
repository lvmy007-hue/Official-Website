import { feeTotal, round6, type ProfitCostDetail, type ProfitDimension, type ProfitGroupRow } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import { coverageOf, marginOf, mergeTotals, perUnitOf, type Totals } from './profit-aggregate'
import { MEMBER_SEP, memberKeyOf, type ProductMeta, type SkuGroup } from './profit-load'

// 按 SKU、ASIN、父体把利润日表的分组合并成列表行（P2b-10）。

export const UNKNOWN_ASIN = '(未知 ASIN)'
const OFFICIAL_NOTE = '本表暂不并排对照官方单品经济；官方与我方的逐 SKU 逐日核对（含成本、广告、时间口径的差异拆分）在“官方经济数据对账”页'

export interface GroupDraft {
  key: string
  dimension: ProfitDimension
  sellerAccountId: string | null
  sku: string | null
  asin: string | null
  parentAsin: string | null
  members: string[]
  totals: Totals
}

/** 每个 ASIN 的父体；没有父体信息或本身就是单体的，父体就是它自己。 */
export const parentMap = (products: readonly ProductMeta[]): Map<string, string> => {
  const map = new Map<string, string>()
  for (const product of products) if (!map.has(product.asin)) map.set(product.asin, product.parentAsin ?? product.asin)
  return map
}

export function mergeByDimension(groups: readonly SkuGroup[], dimension: ProfitDimension, parents: ReadonlyMap<string, string>): GroupDraft[] {
  const drafts = new Map<string, GroupDraft>()
  for (const group of groups) {
    const parentAsin = group.asin ? (parents.get(group.asin) ?? group.asin) : null
    const key = dimension === 'SKU' ? `${group.sellerAccountId}|${group.sku}` : dimension === 'ASIN' ? (group.asin ?? UNKNOWN_ASIN) : (parentAsin ?? UNKNOWN_ASIN)
    const found = drafts.get(key)
    if (found) {
      found.totals = mergeTotals(found.totals, group.totals)
      found.members.push(group.memberKey)
      found.asin ??= dimension === 'PARENT' ? null : group.asin
      continue
    }
    drafts.set(key, {
      key,
      dimension,
      sellerAccountId: dimension === 'SKU' ? group.sellerAccountId : null,
      sku: dimension === 'SKU' ? group.sku : null,
      asin: dimension === 'PARENT' ? null : group.asin,
      parentAsin: dimension === 'PARENT' ? (parentAsin ?? UNKNOWN_ASIN) : parentAsin,
      members: [group.memberKey],
      totals: group.totals,
    })
  }
  return [...drafts.values()]
}

/** 关键字：ASIN、SKU、父 ASIN 里包含即可（不分大小写）。 */
export const matchesKeyword = (draft: GroupDraft, keyword: string | undefined): boolean => {
  if (!keyword) return true
  const needle = keyword.toLowerCase()
  return [draft.sku, draft.asin, draft.parentAsin].some(value => value?.toLowerCase().includes(needle))
}

/** 成本折算明细：按 成本币种 × 汇率来源 分开列，原币金额、折算美元、平均汇率、沿用前值的行数都给；需要 field.cost。 */
export async function loadCostDetails(prisma: PrismaService, where: Prisma.ProfitDailyWhereInput, drafts: readonly GroupDraft[]): Promise<Map<string, ProfitCostDetail[]>> {
  const owner = new Map<string, string>()
  for (const draft of drafts) for (const member of draft.members) owner.set(member, draft.key)
  const skus = [...new Set([...owner.keys()].map(member => member.split(MEMBER_SEP)[1] as string))]
  const result = new Map<string, ProfitCostDetail[]>()
  if (skus.length === 0) return result
  const rows = await prisma.profitDaily.groupBy({
    by: ['sellerAccountId', 'sku', 'asin', 'costCurrency', 'fxSource', 'fxFallback'],
    where: { ...where, sku: { in: skus }, costCurrency: { not: null } },
    _sum: { productCostOriginal: true, productCost: true, firstMileCostOriginal: true, firstMileCost: true },
    _avg: { fxRate: true },
    _count: { _all: true },
    orderBy: [{ sellerAccountId: 'asc' }, { sku: 'asc' }, { asin: 'asc' }, { costCurrency: 'asc' }, { fxSource: 'asc' }, { fxFallback: 'asc' }],
    take: 20000,
  })
  const acc = new Map<string, { detail: ProfitCostDetail; rateSum: number; rateWeight: number }>()
  const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
  const add = (a: number | null, b: number | null) => (a === null && b === null ? null : round6((a ?? 0) + (b ?? 0)))
  for (const row of rows) {
    const draftKey = owner.get(memberKeyOf(row.sellerAccountId, row.sku, row.asin))
    if (!draftKey) continue
    const id = `${draftKey}\u0000${row.costCurrency}\u0000${row.fxSource ?? ''}`
    const entry = acc.get(id) ?? {
      detail: { currency: row.costCurrency, rate: null, source: row.fxSource, fallbackRows: 0, productOriginal: null, productConverted: null, firstMileOriginal: null, firstMileConverted: null },
      rateSum: 0,
      rateWeight: 0,
    }
    const d = entry.detail
    d.productOriginal = add(d.productOriginal, num(row._sum.productCostOriginal))
    d.productConverted = add(d.productConverted, num(row._sum.productCost))
    d.firstMileOriginal = add(d.firstMileOriginal, num(row._sum.firstMileCostOriginal))
    d.firstMileConverted = add(d.firstMileConverted, num(row._sum.firstMileCost))
    if (row.fxFallback) d.fallbackRows += row._count._all
    const rate = num(row._avg.fxRate)
    if (rate !== null) {
      entry.rateSum += rate * row._count._all
      entry.rateWeight += row._count._all
    }
    acc.set(id, entry)
    if (!result.has(draftKey)) result.set(draftKey, [])
  }
  for (const [id, entry] of acc) {
    const draftKey = id.split('\u0000')[0] as string
    entry.detail.rate = entry.rateWeight > 0 ? round6(entry.rateSum / entry.rateWeight) : null
    result.get(draftKey)?.push(entry.detail)
  }
  for (const list of result.values()) list.sort((a, b) => ((a.currency ?? '') < (b.currency ?? '') ? -1 : (a.currency ?? '') > (b.currency ?? '') ? 1 : 0))
  return result
}

export interface RowContext {
  storeNames: ReadonlyMap<string, string>
  /** 商品元数据：按 店铺|SKU、ASIN 两种键各一份。 */
  bySku: ReadonlyMap<string, ProductMeta>
  byAsin: ReadonlyMap<string, ProductMeta>
  costDetails: ReadonlyMap<string, ProfitCostDetail[]> | null
  canCost: boolean
}

export function productOf(draft: GroupDraft, context: Pick<RowContext, 'bySku' | 'byAsin'>): ProductMeta | null {
  if (draft.dimension === 'SKU' && draft.sellerAccountId && draft.sku) return context.bySku.get(`${draft.sellerAccountId}|${draft.sku}`) ?? null
  const asin = draft.dimension === 'PARENT' ? draft.parentAsin : draft.asin
  return asin ? (context.byAsin.get(asin) ?? null) : null
}

export function groupRow(draft: GroupDraft, context: RowContext): ProfitGroupRow {
  const { totals } = draft
  const product = productOf(draft, context)
  const row: ProfitGroupRow = {
    key: draft.key,
    dimension: draft.dimension,
    asin: draft.asin,
    sku: draft.sku,
    parentAsin: draft.dimension === 'PARENT' ? draft.parentAsin : (product?.parentAsin ?? null),
    title: product?.title ?? null,
    storeName: draft.sellerAccountId ? (context.storeNames.get(draft.sellerAccountId) ?? null) : null,
    productId: product?.id ?? null,
    units: totals.units,
    revenue: totals.revenue,
    refunds: totals.refunds,
    fees: feeTotal(totals),
    promotion: totals.promotion,
    reimbursement: totals.reimbursement,
    adsAllocated: totals.adsSpendAllocated,
    profit: totals.profit,
    margin: marginOf(totals.profit, totals.revenue),
    incompleteRows: totals.incompleteRows,
    rows: totals.rows,
    perUnit: perUnitOf(totals, context.canCost),
    official: { state: 'NOT_CONNECTED', note: OFFICIAL_NOTE },
  }
  if (context.canCost) {
    row.productCost = totals.productCost
    row.firstMileCost = totals.firstMileCost
    row.otherCost = totals.otherCost
    row.costCoverage = coverageOf(totals.costedUnits, totals.units)
    row.costDetail = context.costDetails?.get(draft.key) ?? []
  }
  return row
}
