import {
  BRIDGE_NOT_CONNECTED,
  buildBridge,
  feeTotal,
  round6,
  type BridgeKey,
  type ProfitAmounts,
  type ProfitBridgeItem,
  type ProfitBridgeView,
  type ProfitItemState,
  type ProfitPerUnit,
} from '@nova/api-contracts'

// 利润日表汇总的纯函数（P2b-10）：把数据库汇总（每组的各列合计与行数）装成统一的“合计”，合并分组、算利润桥、利润率与单位经济。
// 金额符号沿用 P2b-09：费用、退款、促销、成本是正数的“花费”，销售额与赔付是正数的“收入”；null 永远表示“没有数据”，不是 0。

/** 数据库汇总里每一列的合计；Prisma 的小数、整数、null 都接受。 */
type Dec = { toString(): string } | null | undefined
export const SUM_COLUMNS = [
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
  'productCostOriginal',
  'firstMileCostOriginal',
] as const
export type SumColumn = (typeof SUM_COLUMNS)[number]
export type SumRecord = Partial<Record<SumColumn, Dec>>
/** 传给 Prisma `_sum` 的选择。 */
export const SUM_SELECT = Object.fromEntries(SUM_COLUMNS.map(column => [column, true])) as Record<SumColumn, true>

const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

/** 一个分组的合计：金额列 + 已能算出利润的行的利润合计 + 行数。 */
export interface Totals extends ProfitAmounts {
  rows: number
  /** 因缺成本算不出利润的行数。 */
  incompleteRows: number
  /** 已能算出利润的行的利润合计；一行都没有为 null。 */
  coveredProfit: number | null
  /** 整组净利润：有任何一行算不出就是 null。 */
  profit: number | null
  productCostOriginal: number | null
  firstMileCostOriginal: number | null
}

export function totalsOf(sum: SumRecord, rows: number, incompleteRows: number): Totals {
  const must = (value: Dec) => round6(num(value) ?? 0)
  const may = (value: Dec) => {
    const parsed = num(value)
    return parsed === null ? null : round6(parsed)
  }
  const covered = may(sum.profit)
  return {
    units: num(sum.units) ?? 0,
    costedUnits: num(sum.costedUnits) ?? 0,
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
    dutyCost: may(sum.dutyCost),
    reimbursement: must(sum.reimbursement),
    productCostOriginal: may(sum.productCostOriginal),
    firstMileCostOriginal: may(sum.firstMileCostOriginal),
    rows,
    incompleteRows,
    coveredProfit: covered,
    profit: incompleteRows > 0 || rows === 0 ? null : covered,
  }
}

const addNullable = (a: number | null, b: number | null) => (a === null && b === null ? null : round6((a ?? 0) + (b ?? 0)))

/** 合并两个分组（例如同一 ASIN 的两个 SKU）：可空列只要有一边有数就有数；利润只要有一边算不出就整体算不出。 */
export function mergeTotals(a: Totals, b: Totals): Totals {
  const incompleteRows = a.incompleteRows + b.incompleteRows
  const rows = a.rows + b.rows
  const coveredProfit = addNullable(a.coveredProfit, b.coveredProfit)
  return {
    units: a.units + b.units,
    costedUnits: a.costedUnits + b.costedUnits,
    revenue: round6(a.revenue + b.revenue),
    refunds: round6(a.refunds + b.refunds),
    feeCommission: round6(a.feeCommission + b.feeCommission),
    feeFulfillment: round6(a.feeFulfillment + b.feeFulfillment),
    feeStorage: round6(a.feeStorage + b.feeStorage),
    feeAged: round6(a.feeAged + b.feeAged),
    feeInbound: round6(a.feeInbound + b.feeInbound),
    feeOther: round6(a.feeOther + b.feeOther),
    promotion: round6(a.promotion + b.promotion),
    adsSpendAllocated: addNullable(a.adsSpendAllocated, b.adsSpendAllocated),
    adsUnallocated: addNullable(a.adsUnallocated, b.adsUnallocated),
    productCost: addNullable(a.productCost, b.productCost),
    firstMileCost: addNullable(a.firstMileCost, b.firstMileCost),
    otherCost: addNullable(a.otherCost, b.otherCost),
    dutyCost: addNullable(a.dutyCost ?? null, b.dutyCost ?? null),
    reimbursement: round6(a.reimbursement + b.reimbursement),
    productCostOriginal: addNullable(a.productCostOriginal, b.productCostOriginal),
    firstMileCostOriginal: addNullable(a.firstMileCostOriginal, b.firstMileCostOriginal),
    rows,
    incompleteRows,
    coveredProfit,
    profit: incompleteRows > 0 || rows === 0 ? null : coveredProfit,
  }
}

/** 利润率 = 净利润 ÷ 销售额；净利润算不出、销售额不为正时没有利润率。 */
export const marginOf = (profit: number | null, revenue: number | null): number | null => (profit === null || revenue === null || revenue <= 0 ? null : round6(profit / revenue))

/** 已计成本件数 ÷ 销售件数；没有销售件数为 null。 */
export const coverageOf = (costedUnits: number, units: number): number | null => (units > 0 ? round6(costedUnits / units) : null)

/** 单位经济（每件）：没有销量为 null；采购成本没算全时不给每件成本。 */
export function perUnitOf(totals: Totals, canCost: boolean): ProfitPerUnit | null {
  if (totals.units <= 0) return null
  const each = (value: number | null) => (value === null ? null : round6(value / totals.units))
  const complete = totals.costedUnits >= totals.units && totals.productCost !== null
  return {
    revenue: each(totals.revenue),
    fees: each(feeTotal(totals)),
    ...(canCost ? { productCost: complete ? each(totals.productCost) : null } : {}),
    profit: each(totals.profit),
  }
}

const COST_KEYS: readonly BridgeKey[] = ['PRODUCT_COST', 'FIRST_MILE', 'DUTY', 'OTHER_COST']
const NOTES: Partial<Record<BridgeKey, { notConnected?: string; noData?: string; ok?: string }>> = {
  FX_GAIN_LOSS: { notConnected: '汇兑损益尚未接入：需要采购付款日的汇率，目前没有对接' },
  ADS: { noData: '没有绑定广告账户，或范围内没有广告花费记录', ok: '广告花费：先按广告商品报表归属到 ASIN，剩余按销售额或销量分摊到商品，分不出去的留在店铺级行' },
  PRODUCT_COST: { noData: '没有生效的成本版本，采购成本未计入（商品成本生效后计入）' },
  FIRST_MILE: { noData: '没有头程成本：运单费用未分摊或成本版本未生效' },
  DUTY: { noData: '没有关税：生效的成本版本里没有填写单件关税（商品成本页可以录入）', ok: '关税：生效成本版本里的单件关税 × 件数，按存货计价逐日消耗批次，已含在净利润里' },
  OTHER_COST: { noData: '没有其他成本记录' },
}

/** 一个合计的利润桥视图；没有 field.cost 时三项成本为“无权限”。净利润是整体口径：有一行缺成本就整体不给。 */
export function bridgeViewOf(totals: Totals, canCost: boolean): ProfitBridgeView {
  const bridge = buildBridge([{ ...totals, profit: totals.profit }])
  const items: ProfitBridgeItem[] = bridge.items.map(item => {
    const notes = NOTES[item.key]
    if (item.key === 'NET_PROFIT') {
      const note =
        item.value === null
          ? totals.rows === 0
            ? '范围内没有利润日表数据'
            : `${totals.incompleteRows} 行因缺少成本算不出利润，净利润整体不给；已能计算的部分利润合计 ${totals.coveredProfit === null ? '尚无记录' : totals.coveredProfit.toFixed(2)}`
          : null
      return { ...item, state: item.state as ProfitItemState, note }
    }
    if (!canCost && COST_KEYS.includes(item.key)) return { ...item, value: null, contribution: null, state: 'RESTRICTED', note: '没有成本字段权限（field.cost）' }
    const state: ProfitItemState = BRIDGE_NOT_CONNECTED.includes(item.key) ? 'NOT_CONNECTED' : item.state
    return { ...item, state, note: state === 'NOT_CONNECTED' ? (notes?.notConnected ?? null) : state === 'NO_DATA' ? (notes?.noData ?? null) : (notes?.ok ?? null) }
  })
  return { items, netProfit: totals.profit, coveredProfit: totals.coveredProfit, incompleteRows: totals.incompleteRows, rows: totals.rows }
}
