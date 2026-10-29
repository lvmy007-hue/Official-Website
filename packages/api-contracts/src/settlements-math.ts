import {
  SETTLEMENT_CATEGORIES,
  SETTLEMENT_TOLERANCE,
  type CategoryTotals,
  type ExceptionCategory,
  type ExceptionKind,
  type SettlementCategory,
  type SettlementPendingReason,
  type SettlementStatus,
} from './settlements.js'

// 结算交易的纯函数（P2b-07）：报告明细归类、结算报告里的时间、三方核对的金额比较、差异分类与对平判断。
// worker 的核对任务与 API 的展示共用，所以不依赖任何运行环境。

const money = (value: number) => Math.round(value * 100) / 100

/**
 * 结算报告明细归类（收入、费用、退款、赔付、调整、保留金）。按“交易类型 + 金额类型 + 金额说明”里的关键字判断，
 * 顺序有讲究：保留金与赔付先于退款与订单，费用在订单之后，认不出的归“调整及其他”（不会丢失，也不会冒充收入）。
 * 注意：关键字按亚马逊文档与常见报告整理，没有拿全部真实结算报告核对。
 */
export function classifySettlementLine(line: { transactionType?: string | null; amountType?: string | null; amountDescription?: string | null }): SettlementCategory {
  const type = (line.transactionType ?? '').toLowerCase()
  const kind = (line.amountType ?? '').toLowerCase()
  const text = (line.amountDescription ?? '').toLowerCase()
  const all = `${type} ${kind} ${text}`
  if (all.includes('reserve')) return 'RESERVE'
  if (/reimburs|safe-?t|warehouse[_ ]damage|warehouse[_ ]lost|missing_from_inbound|compensated_clawback|fba inventory/.test(all)) return 'REIMBURSEMENT'
  if (type.includes('refund') || /a-?to-?z|chargeback/.test(all)) return 'REFUND'
  if (type === 'order' || type.includes('order')) return kind.includes('fee') ? 'FEE' : 'INCOME'
  if (/fee|storage|advertis|subscription|commission|fba|cost of|removal|disposal/.test(all)) return 'FEE'
  return 'ADJUSTMENT'
}

/** 上期保留金余额那一行（期初余额）。 */
export const isOpeningBalanceLine = (line: { amountDescription?: string | null; transactionType?: string | null }) =>
  /previous reserve amount balance/i.test(`${line.amountDescription ?? ''} ${line.transactionType ?? ''}`)

const emptyTotals = (): CategoryTotals => ({ INCOME: 0, FEE: 0, REFUND: 0, REIMBURSEMENT: 0, ADJUSTMENT: 0, RESERVE: 0 })

/** 按类别合计（保留两位小数）。 */
export function totalsByCategory(lines: ReadonlyArray<{ category: SettlementCategory; amount: number }>): CategoryTotals {
  const totals = emptyTotals()
  for (const line of lines) totals[line.category] += line.amount
  for (const key of SETTLEMENT_CATEGORIES) totals[key] = money(totals[key])
  return totals
}

/**
 * 解析结算报告里的时间：`2026-09-30`、`2026-09-30 23:59:59 UTC`、`2026-09-30T23:59:59Z`、`2026-09-30 23:59:59`（按 UTC）。
 * 解析不了返回 null；不用当前时间兜底（日期进键，兜底会让同一条记录每次导入都变）。
 */
export function parseReportTime(value: string | null | undefined): Date | null {
  const raw = (value ?? '').trim()
  if (!raw) return null
  const day = /^(\d{4}-\d{2}-\d{2})$/.exec(raw)
  const full = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)\s*(UTC|GMT|Z)?$/i.exec(raw)
  const text = day ? `${day[1]}T00:00:00Z` : full ? `${full[1]}T${full[2]}Z` : raw
  const date = new Date(text)
  return Number.isNaN(date.getTime()) ? null : date
}

export interface BucketDiff {
  key: string
  reportAmount: number
  apiAmount: number
  /** 报告 − 接口。 */
  diff: number
  kind: Extract<ExceptionKind, 'AMOUNT_MISMATCH' | 'REPORT_ONLY' | 'API_ONLY'>
}

/**
 * 两边按“订单号（账户级合并成一组）”汇总后逐组比较：差额超过容差的才算异常。
 * 只有一边有这一组、另一边没有，按“报告有接口没有”或“接口有报告没有”；两边都有但金额不同是“金额不一致”。
 */
export function compareBuckets(report: ReadonlyMap<string, number>, api: ReadonlyMap<string, number>, tolerance: number = SETTLEMENT_TOLERANCE): BucketDiff[] {
  const out: BucketDiff[] = []
  for (const key of new Set([...report.keys(), ...api.keys()])) {
    const reportAmount = money(report.get(key) ?? 0)
    const apiAmount = money(api.get(key) ?? 0)
    const diff = money(reportAmount - apiAmount)
    if (Math.abs(diff) <= tolerance) continue
    const kind: BucketDiff['kind'] = !api.has(key) ? 'REPORT_ONLY' : !report.has(key) ? 'API_ONLY' : 'AMOUNT_MISMATCH'
    out.push({ key, reportAmount, apiAmount, diff, kind })
  }
  return out
}

export interface ExceptionContext {
  kind: ExceptionKind
  reportAmount: number
  apiAmount: number
  diff: number
  /** 这一组里归在本结算单、但入账时间落在结算周期之外的接口交易合计。 */
  apiOutsidePeriod: number
  /** 这一组里没归在本结算单（归到别的结算单或还没有归属）的接口交易合计。 */
  apiUnattributed: number
  periodStart: Date | null
  /** 这个店铺最早一笔接口交易、最早一个订单的时间；没有数据为 null。 */
  apiCoverageStart: Date | null
  ordersCoverageStart: Date | null
}

/** 差异归类：时间口径 → 归因口径 → 范围 → 未解释（越靠前越确定）。 */
export function classifyException(input: ExceptionContext, tolerance: number = SETTLEMENT_TOLERANCE): ExceptionCategory {
  const { kind } = input
  if (kind === 'ORDER_MISSING') {
    const covered = input.ordersCoverageStart !== null && (input.periodStart === null || input.ordersCoverageStart.getTime() <= input.periodStart.getTime())
    return covered ? 'UNEXPLAINED' : 'SCOPE'
  }
  if (kind === 'SELF_CHECK') return 'UNEXPLAINED'
  if (Math.abs(input.apiOutsidePeriod) > tolerance && Math.abs(input.reportAmount - (input.apiAmount - input.apiOutsidePeriod)) <= tolerance) return 'TIMING'
  if (Math.abs(input.apiUnattributed) > tolerance && Math.abs(input.diff - input.apiUnattributed) <= tolerance) return 'ATTRIBUTION'
  if (kind === 'REPORT_ONLY') {
    const covered = input.apiCoverageStart !== null && (input.periodStart === null || input.apiCoverageStart.getTime() <= input.periodStart.getTime())
    if (!covered) return 'SCOPE'
  }
  return 'UNEXPLAINED'
}

/** 这类异常是否挡住“已对平”：我方订单没同步到（范围）是我们的数据缺口，不是金额问题，只列出不挡。 */
export const blocksMatch = (kind: ExceptionKind, category: ExceptionCategory) => !(kind === 'ORDER_MISSING' && category === 'SCOPE')

export function settlementStatusOf(input: { hasReport: boolean; hasTransactions: boolean; diff: number; blockingExceptions: number; tolerance?: number }): {
  status: SettlementStatus
  pendingReason: SettlementPendingReason | null
} {
  if (!input.hasReport) return { status: 'PENDING', pendingReason: 'NO_REPORT' }
  if (!input.hasTransactions) return { status: 'PENDING', pendingReason: 'NO_TRANSACTIONS' }
  const matched = Math.abs(input.diff) <= (input.tolerance ?? SETTLEMENT_TOLERANCE) && input.blockingExceptions === 0
  return { status: matched ? 'MATCHED' : 'DISCREPANCY', pendingReason: null }
}

/** 入账时间是否在结算周期内（周期结束日按整天算，前后各放宽 grace 毫秒）；周期缺失视为在内。 */
export function inPeriod(at: Date, start: Date | null, end: Date | null, graceMs: number): boolean {
  if (start && at.getTime() < start.getTime() - graceMs) return false
  if (end && at.getTime() > end.getTime() + graceMs) return false
  return true
}
