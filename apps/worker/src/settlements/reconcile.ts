import {
  ACCOUNT_LEVEL_KEY,
  SETTLEMENT_EXCEPTION_LIMIT,
  SETTLEMENT_PERIOD_GRACE_MS,
  SETTLEMENT_TOLERANCE,
  blocksMatch,
  classifyException,
  compareBuckets,
  inPeriod,
  isOpeningBalanceLine,
  settlementStatusOf,
  totalsByCategory,
  type CategoryTotals,
  type ExceptionCategory,
  type ExceptionKind,
  type SettlementCategory,
  type SettlementCheck,
  type SettlementPendingReason,
  type SettlementStatus,
} from '@nova/api-contracts'

// 三方核对（P2b-07）的纯计算：结算报告明细、财务接口交易、我方订单。输入都是已经读出来的事实，输出是结算单的对账结果与异常清单；
// 不碰数据库，所以可以用手写数据逐项验证。读取与写入在 load.ts、write.ts。
// 比较口径：报告里除“保留金”外的明细，与接口里归在这张结算单的交易，按订单号汇总（没有订单号的合并成账户级一组）逐组比较。
// 保留金是余额类科目，财务接口里没有对应交易，所以不参与比较；订单只核对“报告里的订单号我方订单里有没有”，不比较订单金额（订单金额含税费优惠，与结算口径不同，没有可靠的换算）。

export interface LineFact {
  category: SettlementCategory
  amount: number
  amazonOrderId: string | null
  transactionType: string
  amountDescription: string
}
export interface TxFact {
  amazonOrderId: string | null
  amount: number
  currency: string
  postedAt: Date
}
export interface SettlementFact {
  currency: string
  periodStart: Date | null
  periodEnd: Date | null
  /** 汇总行的打款总额；报告没给为 null。 */
  headerTotal: number | null
}
export interface ReconcileInput {
  settlement: SettlementFact
  lines: readonly LineFact[]
  /** 财务接口里归在这张结算单的交易（各币种）。 */
  transactions: readonly TxFact[]
  /** 报告里出现的订单号里，我方订单表里有的那些。 */
  foundOrders: ReadonlySet<string>
  coverage: { apiStart: Date | null; ordersStart: Date | null }
  /** 这些订单号在接口里没归到本结算单（归到别的结算单或还没归属）的交易合计（同币种）。只会被问到有差异的订单。 */
  unattributedFor: (orderIds: string[]) => Promise<ReadonlyMap<string, number>>
}

export interface ExceptionDraft {
  kind: ExceptionKind
  category: ExceptionCategory
  refKey: string
  amazonOrderId: string | null
  reportAmount: number
  apiAmount: number
  amount: number
  note: string | null
}

export interface ReconcileOutcome {
  status: SettlementStatus
  pendingReason: SettlementPendingReason | null
  officialAmount: number
  systemAmount: number
  diffAmount: number
  summary: CategoryTotals
  openingBalance: number | null
  txnCount: number
  report: { lineCount: number; comparedTotal: number; headerTotal: number | null; selfDiff: number | null; orderCount: number }
  api: { transactionCount: number; total: number; orderCount: number; otherCurrencyCount: number }
  orders: { reportOrders: number; found: number; missing: number }
  checks: SettlementCheck[]
  /** 全部异常（按金额绝对值从大到小）。 */
  exceptions: ExceptionDraft[]
  /** 保存的异常；超过上限只保存前面的。 */
  saved: ExceptionDraft[]
  blocking: number
}

const money = (value: number) => Math.round(value * 100) / 100
const keyOf = (orderId: string | null) => orderId ?? ACCOUNT_LEVEL_KEY
const add = (map: Map<string, number>, key: string, amount: number) => map.set(key, (map.get(key) ?? 0) + amount)
const rounded = (map: Map<string, number>) => new Map([...map].map(([key, value]) => [key, money(value)]))

export async function buildReconciliation(input: ReconcileInput): Promise<ReconcileOutcome> {
  const { settlement, lines, transactions } = input
  const { currency, periodStart, periodEnd } = settlement
  const hasReport = lines.length > 0
  const hasTransactions = transactions.length > 0

  const compared = lines.filter(line => line.category !== 'RESERVE')
  const reportBuckets = new Map<string, number>()
  for (const line of compared) add(reportBuckets, keyOf(line.amazonOrderId), line.amount)
  const sameCurrency = transactions.filter(tx => tx.currency === currency)
  const apiBuckets = new Map<string, number>()
  for (const tx of sameCurrency) add(apiBuckets, keyOf(tx.amazonOrderId), tx.amount)

  const comparedTotal = money(compared.reduce((sum, line) => sum + line.amount, 0))
  const apiTotal = money(sameCurrency.reduce((sum, tx) => sum + tx.amount, 0))
  const linesTotal = money(lines.reduce((sum, line) => sum + line.amount, 0))
  const selfDiff = hasReport && settlement.headerTotal !== null ? money(settlement.headerTotal - linesTotal) : null
  const diffAmount = money(comparedTotal - apiTotal)

  const exceptions: ExceptionDraft[] = []
  const reportOrders = [...new Set(compared.flatMap(line => (line.amazonOrderId ? [line.amazonOrderId] : [])))]
  const missing = reportOrders.filter(order => !input.foundOrders.has(order))
  const reportRounded = rounded(reportBuckets)
  const apiRounded = rounded(apiBuckets)

  if (selfDiff !== null && Math.abs(selfDiff) > SETTLEMENT_TOLERANCE) {
    exceptions.push({
      kind: 'SELF_CHECK',
      category: 'UNEXPLAINED',
      refKey: 'self-check',
      amazonOrderId: null,
      reportAmount: linesTotal,
      apiAmount: 0,
      amount: selfDiff,
      note: `汇总行的打款总额 ${settlement.headerTotal}，明细合计 ${linesTotal}，相差 ${selfDiff}`,
    })
  }

  let diffs: ReturnType<typeof compareBuckets> = []
  if (hasReport && hasTransactions) {
    diffs = compareBuckets(reportRounded, apiRounded)
    const unattributed = diffs.length > 0 ? await input.unattributedFor(diffs.flatMap(item => (item.key === ACCOUNT_LEVEL_KEY ? [] : [item.key]))) : new Map<string, number>()
    for (const item of diffs) {
      const mine = sameCurrency.filter(tx => keyOf(tx.amazonOrderId) === item.key)
      const outside = money(mine.filter(tx => !inPeriod(tx.postedAt, periodStart, periodEnd, SETTLEMENT_PERIOD_GRACE_MS)).reduce((sum, tx) => sum + tx.amount, 0))
      const other = money(unattributed.get(item.key) ?? 0)
      const category = classifyException({
        kind: item.kind,
        reportAmount: item.reportAmount,
        apiAmount: item.apiAmount,
        diff: item.diff,
        apiOutsidePeriod: outside,
        apiUnattributed: other,
        periodStart,
        apiCoverageStart: input.coverage.apiStart,
        ordersCoverageStart: input.coverage.ordersStart,
      })
      const notes: Record<ExceptionCategory, string | null> = {
        TIMING: `接口交易里有 ${outside} 的入账时间在结算周期之外`,
        ATTRIBUTION: `同一订单还有 ${other} 的接口交易没有归到这张结算单`,
        SCOPE: item.kind === 'REPORT_ONLY' ? '财务接口同步的最早交易晚于结算周期开始，早期交易没有同步到' : null,
        UNEXPLAINED: null,
      }
      exceptions.push({
        kind: item.kind,
        category,
        refKey: item.key === ACCOUNT_LEVEL_KEY ? ACCOUNT_LEVEL_KEY : `order:${item.key}`,
        amazonOrderId: item.key === ACCOUNT_LEVEL_KEY ? null : item.key,
        reportAmount: item.reportAmount,
        apiAmount: item.apiAmount,
        amount: item.diff,
        note: notes[category],
      })
    }
  }

  if (hasReport) {
    for (const order of missing) {
      const category = classifyException({
        kind: 'ORDER_MISSING',
        reportAmount: reportRounded.get(order) ?? 0,
        apiAmount: apiRounded.get(order) ?? 0,
        diff: reportRounded.get(order) ?? 0,
        apiOutsidePeriod: 0,
        apiUnattributed: 0,
        periodStart,
        apiCoverageStart: input.coverage.apiStart,
        ordersCoverageStart: input.coverage.ordersStart,
      })
      exceptions.push({
        kind: 'ORDER_MISSING',
        category,
        refKey: `missing:${order}`,
        amazonOrderId: order,
        reportAmount: reportRounded.get(order) ?? 0,
        apiAmount: apiRounded.get(order) ?? 0,
        amount: reportRounded.get(order) ?? 0,
        note: category === 'SCOPE' ? '我方订单同步的最早订单晚于结算周期开始，或订单尚未同步' : '我方订单表里没有这个订单号',
      })
    }
  }

  exceptions.sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || (a.refKey < b.refKey ? -1 : 1))
  const blocking = exceptions.filter(item => blocksMatch(item.kind, item.category)).length
  const { status, pendingReason } = settlementStatusOf({ hasReport, hasTransactions, diff: diffAmount, blockingExceptions: blocking })

  const money2 = (value: number | null) => (value === null ? '没有' : String(value))
  const checks: SettlementCheck[] = [
    !hasReport
      ? { key: 'REPORT_SELF', label: '结算报告自检', state: 'SKIPPED', detail: '结算报告尚未到达' }
      : selfDiff === null
        ? { key: 'REPORT_SELF', label: '结算报告自检', state: 'SKIPPED', detail: '报告没有汇总行的打款总额，无法自检' }
        : {
            key: 'REPORT_SELF',
            label: '结算报告自检',
            state: Math.abs(selfDiff) <= SETTLEMENT_TOLERANCE ? 'PASS' : 'FAIL',
            detail: `汇总行打款总额 ${money2(settlement.headerTotal)}，明细合计 ${linesTotal}，相差 ${selfDiff}`,
          },
    !hasReport || !hasTransactions
      ? { key: 'REPORT_VS_API', label: '结算报告与财务交易', state: 'SKIPPED', detail: !hasReport ? '结算报告尚未到达' : '这张结算单还没有关联的财务接口交易' }
      : {
          key: 'REPORT_VS_API',
          label: '结算报告与财务交易',
          state: Math.abs(diffAmount) <= SETTLEMENT_TOLERANCE && diffs.length === 0 ? 'PASS' : 'FAIL',
          detail: `报告合计 ${comparedTotal}，接口合计 ${apiTotal}，相差 ${diffAmount}；${diffs.length} 组订单对不上`,
        },
    !hasReport
      ? { key: 'ORDERS', label: '结算报告与我方订单', state: 'SKIPPED', detail: '结算报告尚未到达' }
      : {
          key: 'ORDERS',
          label: '结算报告与我方订单',
          state: missing.length === 0 ? 'PASS' : 'FAIL',
          detail: `报告里有 ${reportOrders.length} 个订单，我方订单里找到 ${reportOrders.length - missing.length} 个`,
        },
  ]

  return {
    status,
    pendingReason,
    officialAmount: comparedTotal,
    systemAmount: apiTotal,
    diffAmount,
    summary: totalsByCategory(lines),
    openingBalance: (() => {
      const line = lines.find(item => isOpeningBalanceLine(item))
      return line ? money(line.amount) : null
    })(),
    txnCount: lines.length,
    report: { lineCount: lines.length, comparedTotal, headerTotal: settlement.headerTotal, selfDiff, orderCount: reportOrders.length },
    api: {
      transactionCount: transactions.length,
      total: apiTotal,
      orderCount: new Set(sameCurrency.flatMap(tx => (tx.amazonOrderId ? [tx.amazonOrderId] : []))).size,
      otherCurrencyCount: transactions.length - sameCurrency.length,
    },
    orders: { reportOrders: reportOrders.length, found: reportOrders.length - missing.length, missing: missing.length },
    checks,
    exceptions,
    saved: exceptions.slice(0, SETTLEMENT_EXCEPTION_LIMIT),
    blocking,
  }
}
