import {
  BRIDGE_COLUMN,
  BRIDGE_DEFS,
  BRIDGE_KEYS,
  BRIDGE_NOT_CONNECTED,
  DEFAULT_INVENTORY_COSTING,
  INVENTORY_COSTINGS,
  type BridgeDirection,
  type BridgeKey,
  type InventoryCosting,
  type ProfitAmounts,
} from './profit.js'

// 利润日表的纯函数（P2b-09）：费用明细归到利润桥项目、单行利润、一组行的利润桥。worker 的派生任务与（P2b-10 的）利润分析接口共用。
// 金额符号：费用、退款、促销、成本都用正数表示“花掉的钱”，收入类（销售额、赔付）也是正数。

export const round6 = (value: number) => Math.round(value * 1_000_000) / 1_000_000
const letters = (value: string | null | undefined) => (value ?? '').toLowerCase().replace(/[^a-z]/g, '')

/** 存货计价设置取值：不合法就按默认值，并告诉调用方（用来打标记）。 */
export function normalizeCosting(value: unknown): { costing: InventoryCosting; valid: boolean } {
  if (typeof value === 'string' && (INVENTORY_COSTINGS as readonly string[]).includes(value)) return { costing: value as InventoryCosting, valid: true }
  return { costing: DEFAULT_INVENTORY_COSTING, valid: value === undefined || value === null }
}

/** 一条费用明细归到的位置：利润桥的某个项目，REVENUE 是销售额（只在结算释放口径下取），EXCLUDED 是税（代收代缴，不是我们的收入与成本）。 */
export type LineTarget = Exclude<BridgeKey, 'ADS' | 'PRODUCT_COST' | 'FIRST_MILE' | 'DUTY' | 'OTHER_COST' | 'FX_GAIN_LOSS' | 'NET_PROFIT'> | 'EXCLUDED'

const TAX = /tax/
const PROMOTION = /promotion|discount|coupon/
const PRINCIPAL = /principal|principle|productcharge|itemprice|proceeds|ordercharge/

/**
 * 费用明细归类。入参是写入时已经分好的 9 类 + NON_FEE（见 fee-events.ts 的 classifyFeeLine）与子类型（路径最后一段）。
 * 关键字是按亚马逊文档与常见交易名整理的启发式，没有拿全部真实交易逐条核对；认不出的进“其他平台费用”，不会丢，也不会冒充销售额。
 */
export function bridgeTargetOfLine(line: { category: string; subtype: string | null | undefined }): LineTarget {
  const sub = letters(line.subtype)
  switch (line.category) {
    case 'NON_FEE':
      if (TAX.test(sub)) return 'EXCLUDED'
      if (PROMOTION.test(sub)) return 'PROMOTION'
      if (PRINCIPAL.test(sub)) return 'REVENUE'
      return 'OTHER_FEES' // 运费收入、礼品包装等：作为负的“其他平台费用”（收入）
    case 'REFUND':
      if (TAX.test(sub)) return 'EXCLUDED'
      if (/commission|referral|closing/.test(sub)) return 'COMMISSION' // 退还的佣金：负的佣金
      if (/fulfil|fba|pickandpack|weighthandling/.test(sub)) return 'FULFILLMENT'
      if (PROMOTION.test(sub)) return 'PROMOTION'
      return 'REFUNDS'
    case 'REIMBURSEMENT':
      return 'REIMBURSEMENT'
    case 'COMMISSION':
      return 'COMMISSION'
    case 'FULFILLMENT':
      return 'FULFILLMENT'
    case 'STORAGE':
      return 'STORAGE'
    case 'AGED_SURCHARGE':
      return 'AGED_SURCHARGE'
    case 'INBOUND_PLACEMENT':
      return 'INBOUND_PLACEMENT'
    default:
      return 'OTHER_FEES'
  }
}

/** 费用明细在表里的金额：费用为负、收入为正。转成利润桥里“花掉的钱”（取反）；销售额与赔付是收入，保持正。 */
export const lineValue = (target: LineTarget, amount: number): number => (target === 'REVENUE' || target === 'REIMBURSEMENT' ? amount : -amount)

export const emptyAmounts = (): ProfitAmounts => ({
  units: 0,
  costedUnits: 0,
  revenue: 0,
  refunds: 0,
  feeCommission: 0,
  feeFulfillment: 0,
  feeStorage: 0,
  feeAged: 0,
  feeInbound: 0,
  feeOther: 0,
  promotion: 0,
  adsSpendAllocated: null,
  adsUnallocated: null,
  productCost: null,
  firstMileCost: null,
  otherCost: null,
  dutyCost: null,
  reimbursement: 0,
})

const FEE_KEYS = ['feeCommission', 'feeFulfillment', 'feeStorage', 'feeAged', 'feeInbound', 'feeOther'] as const

/** 一行的平台费用合计。 */
export const feeTotal = (row: ProfitAmounts): number => round6(FEE_KEYS.reduce((sum, key) => sum + row[key], 0))

/**
 * 单行净利润。卖出了商品但采购成本没有完全覆盖时返回 null（不拿 0 当成本）；头程、其他成本缺失只打标记，利润里不含这一部分；
 * SKU 行的广告是分摊到该行的部分，店铺级行放没分摊出去的部分；广告没有数据（未接入）时两列都是 null，按“未扣”处理并由标记说明——所以店铺的总利润要把全部行加起来看。
 */
export function computeProfit(row: ProfitAmounts): number | null {
  if (row.units > 0 && (row.costedUnits < row.units || row.productCost === null)) return null
  const ads = (row.adsSpendAllocated ?? 0) + (row.adsUnallocated ?? 0)
  const cost = (row.productCost ?? 0) + (row.firstMileCost ?? 0) + (row.dutyCost ?? 0) + (row.otherCost ?? 0)
  return round6(row.revenue - row.refunds - feeTotal(row) - row.promotion - ads - cost + row.reimbursement)
}

export type BridgeState = 'OK' | 'NOT_CONNECTED' | 'NO_DATA'
export interface BridgeItem {
  key: BridgeKey
  label: string
  direction: BridgeDirection
  /** 该项目的合计（花费与收入都是正数）；没有数据来源时为 null。 */
  value: number | null
  state: BridgeState
  /** 对净利润的带符号贡献（收入为正，花费为负）；value 为空时为 null。 */
  contribution: number | null
}
export interface BridgeResult {
  items: BridgeItem[]
  /** 净利润：只要有一行的利润因缺成本算不出，就整体不给（null），不拿部分数字冒充。 */
  netProfit: number | null
  incompleteRows: number
  rows: number
}

/** 一组行（同一币种）的利润桥。 */
export function buildBridge(rows: ReadonlyArray<ProfitAmounts & { profit: number | null }>): BridgeResult {
  const sumOf = (pick: (row: ProfitAmounts) => number | null) => {
    let seen = false
    let total = 0
    for (const row of rows) {
      const value = pick(row)
      if (value === null) continue
      seen = true
      total += value
    }
    return seen ? round6(total) : null
  }
  const items: BridgeItem[] = BRIDGE_KEYS.map(key => {
    const def = BRIDGE_DEFS[key]
    if (key === 'NET_PROFIT') return { key, label: def.label, direction: def.direction, value: null, state: 'OK' as BridgeState, contribution: null }
    const value = BRIDGE_NOT_CONNECTED.includes(key)
      ? null
      : key === 'ADS'
        ? sumOf(row => (row.adsSpendAllocated === null && row.adsUnallocated === null ? null : (row.adsSpendAllocated ?? 0) + (row.adsUnallocated ?? 0)))
        : sumOf(row => (row[BRIDGE_COLUMN[key] as keyof ProfitAmounts] as number | null | undefined) ?? null)
    const state: BridgeState = BRIDGE_NOT_CONNECTED.includes(key) ? 'NOT_CONNECTED' : value === null ? 'NO_DATA' : 'OK'
    const contribution = value === null ? null : def.direction === 'INCOME' ? value : -value
    return { key, label: def.label, direction: def.direction, value, state, contribution }
  })
  const incompleteRows = rows.filter(row => row.profit === null).length
  const netProfit = incompleteRows > 0 || rows.length === 0 ? null : round6(rows.reduce((sum, row) => sum + (row.profit ?? 0), 0))
  const net = items.find(item => item.key === 'NET_PROFIT')!
  net.value = netProfit
  net.contribution = netProfit
  net.state = netProfit === null ? 'NO_DATA' : 'OK'
  return { items, netProfit, incompleteRows, rows: rows.length }
}
