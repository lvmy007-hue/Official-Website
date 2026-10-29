import {
  PERIOD_DIFF_LIMIT,
  PERIOD_DIFF_TOLERANCE,
  type BasisDiff,
  type BasisSnapshot,
  type CostDiffRow,
  type CostSnapshot,
  type DiffAmount,
  type FxDiffRow,
  type FxSnapshot,
  type PeriodPreview,
  type PreviewBasis,
  type PreviewItem,
  type ProfitSnapshot,
  type SkuDiff,
  type SnapSku,
  type SnapTotals,
  type SnapshotDiff,
} from './periods.js'
import { PROFIT_BASES, PROFIT_BASIS_LABEL, type BridgeKey, type ProfitBasis } from './profit.js'
import { buildBridge, round6 } from './profit-math.js'

// 期间快照的纯函数（P2b-13）：把数据库汇总整理成快照里的合计与逐 SKU 汇总、由快照生成关账报表预览、比较两份快照生成差异报告。
// 金额符号沿用利润日表：费用、退款、促销、成本是正数的“花费”；null 永远表示“没有数据”，不是 0。

/** 快照要从利润日表汇总的列（传给数据库 `_sum`）。 */
export const SNAP_SUM_COLUMNS = [
  'units',
  'costedUnits',
  'revenue',
  'refunds',
  'feeCommission',
  'feeFulfillment',
  'feeStorage',
  'feeAged',
  'feeInbound',
  'feeOther',
  'promotion',
  'adsSpendAllocated',
  'adsUnallocated',
  'productCost',
  'firstMileCost',
  'otherCost',
  'dutyCost',
  'reimbursement',
  'profit',
] as const
export type SnapSum = Partial<Record<(typeof SNAP_SUM_COLUMNS)[number], number | null>>

const may = (value: number | null | undefined): number | null => (value === null || value === undefined ? null : round6(value))
const must = (value: number | null | undefined): number => round6(value ?? 0)

/** 一个口径的合计：可空列全为空才是 null；净利润在任何一行缺成本、或一行都没有时是 null。 */
export function snapTotalsOf(sum: SnapSum, rows: number, incompleteRows: number): SnapTotals {
  return {
    units: sum.units ?? 0,
    costedUnits: sum.costedUnits ?? 0,
    revenue: must(sum.revenue),
    refunds: must(sum.refunds),
    feeCommission: must(sum.feeCommission),
    feeFulfillment: must(sum.feeFulfillment),
    feeStorage: must(sum.feeStorage),
    feeAged: must(sum.feeAged),
    feeInbound: must(sum.feeInbound),
    feeOther: must(sum.feeOther),
    promotion: must(sum.promotion),
    adsSpendAllocated: may(sum.adsSpendAllocated),
    adsUnallocated: may(sum.adsUnallocated),
    productCost: may(sum.productCost),
    firstMileCost: may(sum.firstMileCost),
    otherCost: may(sum.otherCost),
    // 关税（P6-18）：没有数据时不带这个键，保持旧快照的形状
    ...(may(sum.dutyCost) === null ? {} : { dutyCost: may(sum.dutyCost) }),
    reimbursement: must(sum.reimbursement),
    rows,
    incompleteRows,
    profit: incompleteRows > 0 || rows === 0 ? null : may(sum.profit),
  }
}

/** 一个 SKU 的期间汇总；有一行缺成本这个 SKU 的利润就不给。 */
export function snapSkuOf(key: { sku: string; asin: string | null }, sum: SnapSum, incompleteRows: number): SnapSku {
  const ads = may(sum.adsSpendAllocated) === null && may(sum.adsUnallocated) === null ? null : round6((sum.adsSpendAllocated ?? 0) + (sum.adsUnallocated ?? 0))
  return {
    sku: key.sku,
    asin: key.asin,
    units: sum.units ?? 0,
    costedUnits: sum.costedUnits ?? 0,
    revenue: must(sum.revenue),
    refunds: must(sum.refunds),
    fees: round6(must(sum.feeCommission) + must(sum.feeFulfillment) + must(sum.feeStorage) + must(sum.feeAged) + must(sum.feeInbound) + must(sum.feeOther)),
    promotion: must(sum.promotion),
    ads,
    productCost: may(sum.productCost),
    firstMileCost: may(sum.firstMileCost),
    otherCost: may(sum.otherCost),
    reimbursement: must(sum.reimbursement),
    profit: incompleteRows > 0 ? null : may(sum.profit),
  }
}

// ---- 预览 ----

const COST_KEYS: readonly BridgeKey[] = ['PRODUCT_COST', 'FIRST_MILE', 'DUTY', 'OTHER_COST']

/** 一个口径的关账报表：利润桥各项加净利润；没有成本字段权限时三项成本不给数。 */
export function previewBasisOf(basis: ProfitBasis, totals: SnapTotals, canCost: boolean): PreviewBasis {
  const bridge = buildBridge([{ ...totals, profit: totals.profit }])
  const items = bridge.items
    .filter(item => item.key !== 'NET_PROFIT')
    .map((item): PreviewItem => {
      const restricted = !canCost && COST_KEYS.includes(item.key)
      return { key: item.key, label: item.label, direction: item.direction, value: restricted ? null : item.value, state: restricted ? 'RESTRICTED' : item.state }
    })
  return { basis, label: PROFIT_BASIS_LABEL[basis], units: totals.units, costedUnits: totals.costedUnits, rows: totals.rows, incompleteRows: totals.incompleteRows, netProfit: totals.profit, items }
}

/** 由一份利润快照生成预览（实时数据或已锁定的快照都走这里）。 */
export function previewOf(snapshot: ProfitSnapshot, canCost: boolean, source: PeriodPreview['source'], fx: PeriodPreview['fx'], costVersions: number | null): PeriodPreview {
  const bases = PROFIT_BASES.map(basis => previewBasisOf(basis, snapshot.bases[basis].totals, canCost))
  const empty = bases.every(basis => basis.rows === 0)
  return {
    state: empty ? 'NO_DATA' : 'OK',
    source,
    note: empty ? '这段期间的利润日表没有数据：订单与财务交易同步完成后会自动派生' : null,
    bases,
    fx,
    costVersions,
  }
}

// ---- 差异报告 ----

const changed = (a: number | null, b: number | null) => (a === null) !== (b === null) || (a !== null && b !== null && Math.abs(a - b) > PERIOD_DIFF_TOLERANCE)
const amountDiff = (key: string, label: string, before: number | null, after: number | null): DiffAmount => ({
  key,
  label,
  before,
  after,
  delta: before !== null && after !== null ? round6(after - before) : null,
})

const SKU_FIELDS = ['revenue', 'refunds', 'fees', 'promotion', 'ads', 'productCost', 'firstMileCost', 'otherCost', 'reimbursement', 'profit'] as const

function diffBasis(basis: ProfitBasis, before: BasisSnapshot, after: BasisSnapshot): BasisDiff {
  const bridgeOf = (snapshot: BasisSnapshot) => buildBridge([{ ...snapshot.totals, profit: snapshot.totals.profit }])
  const left = bridgeOf(before)
  const right = bridgeOf(after)
  const items = left.items
    .filter(item => item.key !== 'NET_PROFIT')
    .map(item => amountDiff(item.key, item.label, item.value, right.items.find(other => other.key === item.key)?.value ?? null))
    .filter(item => changed(item.before, item.after))
  const net = amountDiff('NET_PROFIT', '净利润', before.totals.profit, after.totals.profit)

  const was = new Map(before.skus.map(sku => [sku.sku, sku]))
  const now = new Map(after.skus.map(sku => [sku.sku, sku]))
  const rows: SkuDiff[] = []
  let skuChanged = 0
  let skuAdded = 0
  let skuRemoved = 0
  for (const sku of [...new Set([...was.keys(), ...now.keys()])]) {
    const x = was.get(sku)
    const y = now.get(sku)
    const kind = x && y ? 'CHANGED' : y ? 'ADDED' : 'REMOVED'
    if (kind === 'CHANGED' && !SKU_FIELDS.some(field => changed(x![field], y![field])) && x!.units === y!.units) continue
    if (kind === 'CHANGED') skuChanged += 1
    else if (kind === 'ADDED') skuAdded += 1
    else skuRemoved += 1
    const delta = (field: 'revenue' | 'profit') => Math.abs((y?.[field] ?? 0) - (x?.[field] ?? 0))
    rows.push({
      sku,
      kind,
      asin: y?.asin ?? x?.asin ?? null,
      units: { before: x?.units ?? null, after: y?.units ?? null },
      revenue: { before: x?.revenue ?? null, after: y?.revenue ?? null },
      profit: { before: x?.profit ?? null, after: y?.profit ?? null },
      magnitude: round6(Math.max(delta('revenue'), delta('profit'))),
    })
  }
  rows.sort((a, b) => b.magnitude - a.magnitude || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0))
  return { basis, label: PROFIT_BASIS_LABEL[basis], items, netProfit: net, skus: rows.slice(0, PERIOD_DIFF_LIMIT), skuChanged, skuAdded, skuRemoved, skuTruncated: before.truncated || after.truncated }
}

function diffFx(before: FxSnapshot, after: FxSnapshot): SnapshotDiff['fx'] {
  const keyOf = (row: { quote: string; date: string; source: string }) => `${row.quote}|${row.date}|${row.source}`
  const was = new Map(before.rates.map(row => [keyOf(row), row]))
  const now = new Map(after.rates.map(row => [keyOf(row), row]))
  const rows: FxDiffRow[] = []
  let changedCount = 0
  let added = 0
  let removed = 0
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const x = was.get(key)
    const y = now.get(key)
    if (x && y && Math.abs(x.rate - y.rate) <= 1e-8) continue
    if (x && y) changedCount += 1
    else if (y) added += 1
    else removed += 1
    const row = (y ?? x)!
    rows.push({ quote: row.quote, date: row.date, source: row.source, before: x?.rate ?? null, after: y?.rate ?? null })
  }
  return { rows: rows.slice(0, PERIOD_DIFF_LIMIT), changed: changedCount, added, removed }
}

function diffCosts(before: CostSnapshot, after: CostSnapshot): SnapshotDiff['costVersions'] {
  const keyOf = (row: { sku: string; versionNo: number }) => `${row.sku}|${row.versionNo}`
  const was = new Map(before.versions.map(row => [keyOf(row), row]))
  const now = new Map(after.versions.map(row => [keyOf(row), row]))
  const pick = (row: CostSnapshot['versions'][number]) => ({ status: row.status, productCost: row.productCost, firstMileCost: row.firstMileCost, otherCost: row.otherCost })
  const rows: CostDiffRow[] = []
  let changedCount = 0
  let added = 0
  let removed = 0
  for (const key of [...new Set([...was.keys(), ...now.keys()])].sort()) {
    const x = was.get(key)
    const y = now.get(key)
    if (x && y && x.status === y.status && !(['productCost', 'firstMileCost', 'otherCost'] as const).some(field => changed(x[field], y[field]))) continue
    const kind = x && y ? 'CHANGED' : y ? 'ADDED' : 'REMOVED'
    if (kind === 'CHANGED') changedCount += 1
    else if (kind === 'ADDED') added += 1
    else removed += 1
    const row = (y ?? x)!
    rows.push({ sku: row.sku, versionNo: row.versionNo, kind, before: x ? pick(x) : null, after: y ? pick(y) : null })
  }
  return { rows: rows.slice(0, PERIOD_DIFF_LIMIT), changed: changedCount, added, removed }
}

export interface SnapshotBundle {
  profit: ProfitSnapshot
  fx: FxSnapshot
  costs: CostSnapshot
}

/** 比较两份快照（之前 → 之后）：利润桥逐项与净利润、逐 SKU、汇率、成本版本；没有任何变化时 hasChanges 为 false。 */
export function diffSnapshots(before: SnapshotBundle, after: SnapshotBundle): SnapshotDiff {
  const bases = PROFIT_BASES.map(basis => diffBasis(basis, before.profit.bases[basis], after.profit.bases[basis]))
  const fx = diffFx(before.fx, after.fx)
  const costVersions = diffCosts(before.costs, after.costs)
  const hasChanges =
    bases.some(basis => basis.items.length > 0 || changed(basis.netProfit.before, basis.netProfit.after) || basis.skuChanged + basis.skuAdded + basis.skuRemoved > 0) ||
    fx.changed + fx.added + fx.removed > 0 ||
    costVersions.changed + costVersions.added + costVersions.removed > 0
  return { bases, fx, costVersions, hasChanges }
}
