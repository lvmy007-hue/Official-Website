import {
  PERIOD_SNAPSHOT_COST_LIMIT,
  PERIOD_SNAPSHOT_SKU_LIMIT,
  PERIOD_SNAPSHOT_VERSION,
  PROFIT_BASES,
  SNAP_SUM_COLUMNS,
  STORE_LEVEL_SKU,
  snapSkuOf,
  snapTotalsOf,
  type BasisSnapshot,
  type CostSnapVersion,
  type CostSnapshot,
  type FxSnapshot,
  type ProfitBasis,
  type ProfitSnapshot,
  type SnapSum,
  type SnapshotBundle,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { asDate, dateText } from '../overview'
import type { Db } from './periods-common'
import { profitRange, type PeriodTarget } from './periods-evidence'

// 期间快照的取数（P2b-13）：从利润日表、汇率表、成本版本表汇总出三份快照。全部只读；用数据库汇总（aggregate / groupBy），不把几十万行读回来。
// 关账锁定、重新开账的差异报告、关账前的预览都用这里同一套汇总，保证“审批时看到的”和“锁定时存的”是同一种算法。

const SUM_SELECT = Object.fromEntries(SNAP_SUM_COLUMNS.map(column => [column, true])) as Record<(typeof SNAP_SUM_COLUMNS)[number], true>
const asSum = (sum: Record<string, { toString(): string } | number | null | undefined>): SnapSum =>
  Object.fromEntries(Object.entries(sum).map(([key, value]) => [key, value === null || value === undefined ? null : Number(value.toString())])) as SnapSum

async function basisSnapshot(db: Db, target: PeriodTarget, basis: ProfitBasis): Promise<BasisSnapshot> {
  const where: Prisma.ProfitDailyWhereInput = { ...profitRange(target), basis }
  const skuWhere: Prisma.ProfitDailyWhereInput = { ...where, sku: { not: STORE_LEVEL_SKU } }
  const [total, missing, groups] = await Promise.all([
    db.profitDaily.aggregate({ where, _sum: SUM_SELECT, _count: { _all: true } }),
    db.profitDaily.count({ where: { ...where, profit: null } }),
    db.profitDaily.groupBy({
      by: ['sku'],
      where: skuWhere,
      _sum: SUM_SELECT,
      _max: { asin: true },
      orderBy: [{ _sum: { revenue: 'desc' } }, { sku: 'asc' }],
      take: PERIOD_SNAPSHOT_SKU_LIMIT + 1,
    }),
  ])
  const kept = groups.slice(0, PERIOD_SNAPSHOT_SKU_LIMIT)
  const gaps = kept.length
    ? await db.profitDaily.groupBy({
        by: ['sku'],
        where: { ...skuWhere, profit: null, sku: { in: kept.map(group => group.sku) } },
        _count: { _all: true },
        orderBy: { sku: 'asc' },
        take: PERIOD_SNAPSHOT_SKU_LIMIT,
      })
    : []
  const gapOf = new Map(gaps.map(group => [group.sku, group._count._all]))
  const skus = kept.map(group => snapSkuOf({ sku: group.sku, asin: group._max.asin }, asSum(group._sum), gapOf.get(group.sku) ?? 0))
  return { totals: snapTotalsOf(asSum(total._sum), total._count._all, missing), skus, skuCount: skus.length, truncated: groups.length > PERIOD_SNAPSHOT_SKU_LIMIT }
}

/** 利润日表快照：三种收入确认口径各一份合计与逐 SKU 汇总（按销售额从高到低，最多 3000 个）。 */
export async function loadProfitSnapshot(db: Db, target: PeriodTarget): Promise<ProfitSnapshot> {
  const [bases, versions] = await Promise.all([
    Promise.all(PROFIT_BASES.map(async basis => [basis, await basisSnapshot(db, target, basis)] as const)),
    db.profitDaily.groupBy({ by: ['metricVersion'], where: profitRange(target), orderBy: { metricVersion: 'asc' }, take: 20 }),
  ])
  return {
    version: PERIOD_SNAPSHOT_VERSION,
    metricVersions: versions.map(item => item.metricVersion),
    from: target.start,
    to: target.end,
    bases: Object.fromEntries(bases) as ProfitSnapshot['bases'],
  }
}

/** 汇率快照：期间内企业所有币种、所有来源的汇率行（含沿用与手工覆盖的标记）。 */
export async function loadFxSnapshot(db: Db, target: PeriodTarget): Promise<FxSnapshot> {
  const rows = await db.fxRate.findMany({
    where: { tenantId: target.tenantId, rateDate: { gte: asDate(target.start), lte: asDate(target.end) } },
    select: { quoteCurrency: true, rateDate: true, rate: true, source: true, isFallback: true, isManualOverride: true },
    orderBy: [{ quoteCurrency: 'asc' }, { rateDate: 'asc' }, { source: 'asc' }],
    take: 20_000,
  })
  const rates = rows.map(row => ({
    quote: row.quoteCurrency,
    date: dateText(row.rateDate),
    rate: Number(row.rate.toString()),
    source: row.source,
    fallback: row.isFallback,
    manual: row.isManualOverride,
  }))
  return { from: target.start, to: target.end, currencies: [...new Set(rates.map(rate => rate.quote))], rates }
}

interface VersionRow {
  sku: string
  versionNo: number
  effectiveFrom: string
}

/** 期间内生效过的成本版本：每个 SKU 按生效日排序，保留“下一个版本生效日晚于期间起始日”的那些（最后一个版本一直有效）。 */
export function versionsInEffect<T extends VersionRow>(rows: readonly T[], start: string): T[] {
  const bySku = new Map<string, T[]>()
  for (const row of rows) bySku.set(row.sku, [...(bySku.get(row.sku) ?? []), row])
  const kept: T[] = []
  for (const versions of bySku.values()) {
    const ordered = [...versions].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : a.versionNo - b.versionNo))
    ordered.forEach((row, index) => {
      const next = ordered[index + 1]
      if (!next || next.effectiveFrom > start) kept.push(row)
    })
  }
  return kept.sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.versionNo - b.versionNo))
}

/** 成本版本快照：期间内有销售的 SKU 在期间内生效过的、状态为生效中的成本版本。 */
export async function loadCostSnapshot(db: Db, target: PeriodTarget, skus: readonly string[]): Promise<CostSnapshot> {
  const rows = skus.length
    ? await db.costVersion.findMany({
        where: { tenantId: target.tenantId, status: 'ACTIVE', sku: { in: [...skus] }, effectiveFrom: { lte: asDate(target.end) } },
        select: { sku: true, versionNo: true, status: true, effectiveFrom: true, currency: true, unitProductCost: true, unitFirstMileCost: true, unitOtherCost: true },
        orderBy: [{ sku: 'asc' }, { versionNo: 'asc' }],
        take: PERIOD_SNAPSHOT_COST_LIMIT + 1,
      })
    : []
  const mapped = rows.slice(0, PERIOD_SNAPSHOT_COST_LIMIT).map((row): CostSnapVersion => ({
    sku: row.sku,
    versionNo: row.versionNo,
    status: row.status,
    effectiveFrom: dateText(row.effectiveFrom),
    currency: row.currency,
    productCost: row.unitProductCost === null ? null : Number(row.unitProductCost.toString()),
    firstMileCost: row.unitFirstMileCost === null ? null : Number(row.unitFirstMileCost.toString()),
    otherCost: row.unitOtherCost === null ? null : Number(row.unitOtherCost.toString()),
  }))
  const versions = versionsInEffect(mapped, target.start)
  return { asOf: target.end, skuCount: new Set(versions.map(version => version.sku)).size, truncated: rows.length > PERIOD_SNAPSHOT_COST_LIMIT, versions }
}

/** 三份快照一起取（关账锁定、重新开账的实时差异用）。成本版本只取利润快照里出现过的 SKU。 */
export async function loadBundle(db: Db, target: PeriodTarget): Promise<SnapshotBundle> {
  const [profit, fx] = await Promise.all([loadProfitSnapshot(db, target), loadFxSnapshot(db, target)])
  const skus = [...new Set(PROFIT_BASES.flatMap(basis => profit.bases[basis].skus.map(sku => sku.sku)))]
  return { profit, fx, costs: await loadCostSnapshot(db, target, skus) }
}
