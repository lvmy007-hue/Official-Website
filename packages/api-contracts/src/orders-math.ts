import {
  ORDER_RISK_LABEL,
  ORDER_SETTLEMENT_LABEL,
  type FinanceLineGroup,
  type OrderChargesResponse,
  type OrderMatchState,
  type OrderRefundState,
  type OrderRisk,
  type OrderRiskKind,
  type OrderSettlementState,
} from './orders.js'

// 订单页的纯计算（P2b-01）：结算状态、退款、财务明细分组、收入与财务交易的匹配、净收益、风险标记。
// 全部是纯函数，口径写在注释里；接口与测试共用。
// 口径假设（没有真实店铺数据核对，见 CR-039）：财务明细的分组靠路径关键字判断，不是官方分类；9 类费用分类器由 P2b-05 交付。

export const MONEY_TOLERANCE = 0.05
const round2 = (value: number) => Math.round(value * 100) / 100
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0)

// ---- 结算与退款 ----

const RELEASED_STATUSES = new Set(['RELEASED', 'DEFERRED_RELEASED'])

/** 订单的结算状态：没有交易 = 尚无财务交易；有任一笔“递延” = 递延；全部已释放 = 已释放；其余（接口给了没见过的状态）= 状态未知。 */
export function orderSettlementState(statuses: readonly (string | null)[]): OrderSettlementState {
  if (statuses.length === 0) return 'NONE'
  if (statuses.some(status => status === 'DEFERRED')) return 'DEFERRED'
  if (statuses.every(status => status !== null && RELEASED_STATUSES.has(status))) return 'RELEASED'
  return 'UNKNOWN'
}

export const settlementView = (statuses: readonly (string | null)[]) => {
  const state = orderSettlementState(statuses)
  return { state, label: ORDER_SETTLEMENT_LABEL[state] }
}

export const isRefundTransaction = (transactionType: string | null | undefined) => !!transactionType && /refund/i.test(transactionType)

export type TxFact = { externalTransactionId: string; transactionType: string | null; transactionStatus: string | null; amount: number }
export type LineFact = { sourceEventId: string | null; path: string; amount: number }

/** 明细属于哪笔交易：明细编号的前缀是“交易编号:”（财务同步器的写法）。 */
export const lineBelongsTo = (line: Pick<LineFact, 'sourceEventId'>, transactionId: string) => !!line.sourceEventId && line.sourceEventId.startsWith(`${transactionId}:`)

/**
 * 退款：没有任何财务交易 = 待财务交易（不能说“无退款”）；有交易但没有退款类交易 = 无退款。
 * 退款金额 = 退款类交易里“商品与税”类明细的负数之和（客户实际拿回的钱）；没有逐项明细时退回交易合计的负数。
 * 达到订单金额（容差 0.05）算全额，否则部分。
 */
export function refundOf(transactions: readonly TxFact[], lines: readonly LineFact[], orderAmount: number | null): { state: OrderRefundState; amount: number | null } {
  if (transactions.length === 0) return { state: 'PENDING_DATA', amount: null }
  const refunds = transactions.filter(tx => isRefundTransaction(tx.transactionType))
  if (refunds.length === 0) return { state: 'NONE', amount: null }
  const own = lines.filter(line => refunds.some(tx => lineBelongsTo(line, tx.externalTransactionId)) && classifyFinanceLine(line.path) !== 'FEE')
  const raw = own.length > 0 ? sum(own.map(line => line.amount)) : sum(refunds.map(tx => tx.amount))
  const amount = round2(Math.abs(raw))
  if (amount === 0) return { state: 'NONE', amount: null }
  const full = orderAmount !== null && orderAmount > 0 && amount >= orderAmount - MONEY_TOLERANCE
  return { state: full ? 'FULL' : 'PARTIAL', amount }
}

// ---- 财务明细分组 ----

const FEE_WORDS = /fee|commission|referral|chargeback|adjustment|reimburse|withheld|storage|fba/i
const TAX_WORDS = /tax/i
const REVENUE_WORDS = /principal|product[\s_-]?charge|shipping|gift[\s_-]?wrap|promotion|discount|sales|item[\s_-]?price|order[\s_-]?charge/i

/** 按路径关键字把财务明细分成：收入类（商品、运费、礼品包装、促销）、税、费用（其余都算费用，包括佣金与配送费）。启发式，不是官方分类。 */
export function classifyFinanceLine(path: string): FinanceLineGroup {
  if (FEE_WORDS.test(path)) return 'FEE'
  if (TAX_WORDS.test(path)) return 'TAX'
  if (REVENUE_WORDS.test(path)) return 'REVENUE'
  return 'FEE'
}

/** 路径转成易读名称：取最后两段，驼峰拆开。 */
export function financeLineLabel(path: string): string {
  const tail = path.split('/').filter(Boolean).slice(-2).join(' / ')
  return (tail || path).replace(/([a-z])([A-Z])/g, '$1 $2')
}

// ---- 订单自己的收入明细 ----

export const CHARGE_KIND_LABEL: Readonly<Record<string, string>> = { ITEM: '商品', SHIPPING: '运费', PROMOTION: '促销折扣', TAX: '税', FEE: '订单附加费', OTHER: '其他' }

export function chargesSummary(charges: ReadonlyArray<{ chargeKind: string; amount: number }>): NonNullable<OrderChargesResponse['revenue']> {
  const of = (kind: string) => round2(sum(charges.filter(charge => charge.chargeKind === kind).map(charge => charge.amount)))
  const item = of('ITEM')
  const shipping = of('SHIPPING')
  const promotion = of('PROMOTION')
  const tax = of('TAX')
  const other = round2(of('FEE') + of('OTHER'))
  const totalExTax = round2(item + shipping + promotion + other)
  return { item, shipping, promotion, tax, other, totalExTax, total: round2(totalExTax + tax) }
}

/** 订单接口的收入、税与财务交易里同类明细比对（退款类交易的明细不参与）。 */
export function financeMatch(input: { orderRevenue: number; orderTax: number; transactionCount: number; lines: readonly LineFact[] }): OrderChargesResponse['match'] {
  if (input.transactionCount === 0) return { state: 'NO_TRANSACTIONS', note: '这个订单还没有财务交易，亚马逊通常在发货后才生成；同步后再比对。', revenue: null, tax: null }
  if (input.lines.length === 0) return { state: 'NO_LINES', note: '已有财务交易但没有逐项明细，无法逐项比对。', revenue: null, tax: null }
  const finance = (group: FinanceLineGroup) => round2(sum(input.lines.filter(line => classifyFinanceLine(line.path) === group).map(line => line.amount)))
  const pair = (order: number, fin: number) => ({ order: round2(order), finance: fin, diff: round2(fin - order) })
  const revenue = pair(input.orderRevenue, finance('REVENUE'))
  const tax = pair(input.orderTax, finance('TAX'))
  const state: OrderMatchState = Math.abs(revenue.diff) <= MONEY_TOLERANCE && Math.abs(tax.diff) <= MONEY_TOLERANCE ? 'MATCHED' : 'DIFF'
  return {
    state,
    note: state === 'MATCHED' ? '订单接口的收入与税和财务交易一致。' : '订单接口与财务交易的收入或税对不上；明细分组按路径关键字判断，请以财务交易为准人工核对。',
    revenue,
    tax,
  }
}

/** 净收益（我方计算）：这个订单全部财务交易金额之和（收入 + 亚马逊费用 + 退款，已含亚马逊扣费）；没有交易还不能算。不含商品成本与广告。 */
export function netIncomeOf(transactions: readonly Pick<TxFact, 'amount'>[]): { state: 'OK' | 'PENDING'; value: number | null; note: string } {
  if (transactions.length === 0) return { state: 'PENDING', value: null, note: '财务交易还没同步，暂不能计算' }
  return { state: 'OK', value: round2(sum(transactions.map(tx => tx.amount))), note: '全部财务交易金额之和（已扣亚马逊费用与退款），未扣商品成本与广告' }
}

// ---- 风险标记 ----

export interface OrderRiskFacts {
  status: string
  amount: number | null
  /** 订单接口给出的逐项金额之和（含税）；没有逐项金额为 null。 */
  chargesTotal: number | null
  orderTax: number
  /** 财务交易里“税”类明细之和；没有逐项明细为 null。 */
  financeTax: number | null
  cancellation: { cancelledBy: string; reasonCode: string; cancelledAt: Date | null } | null
  refund: { state: OrderRefundState; amount: number | null }
  returns: ReadonlyArray<{ quantity: number; reason: string | null }>
  isReplacement: boolean
  replacedOrderId: string | null
  replacementReason: string | null
  replacedBy: readonly string[]
  /** 已释放交易的收款合计（正数部分），已取消订单仍有收款时报财务差异。 */
  positiveTransactionTotal: number
}

const CANCEL_BY: Record<string, string> = { BUYER: '买家', SELLER: '卖家', AMAZON: '亚马逊', UNKNOWN: '未知方' }
export const cancelledByLabel = (value: string) => CANCEL_BY[value] ?? value
const money = (value: number) => `$${Math.abs(value).toFixed(2)}`

export function orderRisks(facts: OrderRiskFacts): OrderRisk[] {
  const risks: OrderRisk[] = []
  const add = (kind: OrderRiskKind, level: OrderRisk['level'], reason: string) => risks.push({ kind, label: ORDER_RISK_LABEL[kind], level, reason })
  if (facts.cancellation) {
    const by = cancelledByLabel(facts.cancellation.cancelledBy)
    const code = facts.cancellation.reasonCode ? `，原因代码 ${facts.cancellation.reasonCode}` : ''
    add('CANCEL_REQUEST', facts.cancellation.cancelledAt ? 'MEDIUM' : 'HIGH', facts.cancellation.cancelledAt ? `订单已由${by}取消${code}` : `${by}提出了取消请求，订单尚未取消${code}`)
  }
  if (facts.refund.state === 'FULL' || facts.refund.state === 'PARTIAL') {
    add('REFUND', facts.refund.state === 'FULL' ? 'HIGH' : 'MEDIUM', `${facts.refund.state === 'FULL' ? '全额' : '部分'}退款 ${facts.refund.amount === null ? '' : money(facts.refund.amount)}`.trim())
  }
  if (facts.returns.length > 0) {
    const units = sum(facts.returns.map(item => item.quantity))
    const reason = facts.returns.find(item => item.reason)?.reason
    add('RETURN', 'MEDIUM', `有 ${facts.returns.length} 笔退货记录，共 ${units} 件${reason ? `，原因：${reason}` : ''}`)
  }
  if (facts.isReplacement) add('REPLACEMENT', 'MEDIUM', `这是订单 ${facts.replacedOrderId ?? '（原订单号未知）'} 的替换订单${facts.replacementReason ? `，原因：${facts.replacementReason}` : ''}`)
  if (facts.replacedBy.length > 0) add('REPLACEMENT', 'MEDIUM', `已为本订单发出替换订单：${facts.replacedBy.join('、')}`)
  if (facts.financeTax !== null && Math.abs(facts.orderTax - facts.financeTax) > MONEY_TOLERANCE) {
    add('TAX_ANOMALY', 'MEDIUM', `订单接口记录的税 ${money(facts.orderTax)}，财务交易里的税 ${money(facts.financeTax)}，相差 ${money(facts.financeTax - facts.orderTax)}`)
  }
  if (facts.amount !== null && facts.chargesTotal !== null && Math.abs(facts.amount - facts.chargesTotal) > MONEY_TOLERANCE) {
    add('FINANCE_DIFF', 'MEDIUM', `订单金额 ${money(facts.amount)} 与收入明细合计 ${money(facts.chargesTotal)} 不一致，相差 ${money(facts.amount - facts.chargesTotal)}`)
  }
  if (facts.status === 'Canceled' && facts.positiveTransactionTotal > MONEY_TOLERANCE) {
    add('FINANCE_DIFF', 'HIGH', `订单已取消，但财务交易里仍有收款 ${money(facts.positiveTransactionTotal)}`)
  }
  return risks
}
