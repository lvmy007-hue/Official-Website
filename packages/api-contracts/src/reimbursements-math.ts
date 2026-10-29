import { CASE_STATUSES, type CaseRow, type CaseStatus, type CurrencyRecovery, type RuleStat } from './reimbursements.js'
import { OPPORTUNITY_RULE_LABEL, OPPORTUNITY_RULES, type OpportunityRule } from './receiving.js'

// 赔付中心的纯函数（P2b-03）：案件状态流转、台账丢失净额、官方赔付明细与案件的匹配、回收率与成功率。API 与 worker 共用同一套口径。

const DAY_MS = 86_400_000
const round2 = (value: number) => Math.round(value * 100) / 100

// ---- 状态流转 ----

/**
 * 案件允许改成的状态。已到账只由官方赔付明细匹配产生（实收金额不能手填，所以不能手工标已到账）；
 * 已拒绝的案件可以重新提交（申诉）；已到账是终点。
 */
export function nextCaseStatuses(status: CaseStatus): CaseStatus[] {
  switch (status) {
    case 'OPPORTUNITY':
      return ['SUBMITTED']
    case 'SUBMITTED':
      return ['IN_PROGRESS', 'APPROVED', 'PARTIAL', 'REJECTED']
    case 'IN_PROGRESS':
      return ['APPROVED', 'PARTIAL', 'REJECTED']
    case 'REJECTED':
      return ['SUBMITTED']
    default:
      return []
  }
}

export interface CaseTransitionInput {
  status: CaseStatus
  expectedAmount: number | null
  approvedAmount: number | null
  amazonCaseId: string | null
}

/** 校验一次更新：返回第一条不通过的原因（中文），通过返回 null。patch 里没给的字段取当前值。 */
export function validateCaseUpdate(current: CaseTransitionInput, patch: { status?: CaseStatus; approvedAmount?: number | null; expectedAmount?: number | null }): string | null {
  const status = patch.status ?? current.status
  const approved = patch.approvedAmount === undefined ? current.approvedAmount : patch.approvedAmount
  const expected = patch.expectedAmount === undefined ? current.expectedAmount : patch.expectedAmount
  if (patch.status && patch.status !== current.status && !nextCaseStatuses(current.status).includes(patch.status)) {
    return patch.status === 'PAID' ? '已到账由官方赔付明细自动匹配产生，不能手工标记' : `案件现在是“${labelOf(current.status)}”，不能直接改成“${labelOf(patch.status)}”`
  }
  if (current.status === 'PAID' && (patch.approvedAmount !== undefined || patch.expectedAmount !== undefined)) return '案件已到账，金额不能再修改'
  if ((status === 'APPROVED' || status === 'PARTIAL') && (approved === null || approved <= 0)) return '批准或部分批准时必须填写亚马逊批准的金额（大于 0）'
  if (status === 'PARTIAL' && approved !== null && expected !== null && approved >= expected) return '部分批准的金额应小于应收金额；全额批准请选“已批准”'
  if (status === 'APPROVED' && approved !== null && expected !== null && approved > expected) return '批准金额不应大于应收金额，请先核对并更正应收金额'
  return null
}

const labelOf = (status: CaseStatus) => ({ OPPORTUNITY: '待提交', SUBMITTED: '已提交', IN_PROGRESS: '处理中', APPROVED: '已批准', PARTIAL: '部分批准', REJECTED: '已拒绝', PAID: '已到账' })[status]

/** 步骤条：待提交、已提交、处理中、已有结论（批准、部分批准、拒绝）、已到账。被拒绝时第 4 步标为失败。 */
export const CASE_STEPS = ['待提交', '已提交', '处理中', '已有结论', '已到账'] as const
export function caseStepOf(status: CaseStatus): { current: number; failed: boolean } {
  switch (status) {
    case 'OPPORTUNITY':
      return { current: 0, failed: false }
    case 'SUBMITTED':
      return { current: 1, failed: false }
    case 'IN_PROGRESS':
      return { current: 2, failed: false }
    case 'APPROVED':
    case 'PARTIAL':
      return { current: 3, failed: false }
    case 'REJECTED':
      return { current: 3, failed: true }
    default:
      return { current: 4, failed: false }
  }
}

// ---- 台账：丢失与损坏的净额 ----

export interface LedgerClaimEvent {
  id: string
  /** 事件日期（YYYY-MM-DD）。 */
  date: string
  /** 数量（正数，调用方取绝对值）。 */
  qty: number
}

/**
 * 同一个 SKU 的丢失（或损坏）事件，扣掉已经“被抵消”的数量后剩下的部分：按日期从早到晚依次抵扣
 * （先找到的、先赔付的先冲掉最早的那笔）。covered 是找到的数量与官方赔付的数量之和。返回仍然缺口的事件，数量是剩余量。
 */
export function netLedgerClaims(events: readonly LedgerClaimEvent[], covered: number): LedgerClaimEvent[] {
  let left = Math.max(0, covered)
  const out: LedgerClaimEvent[] = []
  for (const event of [...events].sort((a, b) => (a.date === b.date ? a.id.localeCompare(b.id) : a.date.localeCompare(b.date)))) {
    if (event.qty <= 0) continue
    const used = Math.min(left, event.qty)
    left -= used
    if (event.qty - used > 0) out.push({ ...event, qty: event.qty - used })
  }
  return out
}

// ---- 官方赔付明细与案件的匹配 ----

export interface PayoutRecord {
  sellerAccountId: string
  sku: string
  reason: string
  approvedAt: Date
  amazonCaseId: string | null
  originalOrderId: string | null
}

export interface MatchCandidate {
  id: string
  sellerAccountId: string
  ruleCode: OpportunityRule
  sku: string | null
  amazonCaseId: string | null
  /** 案件证据里的订单号（退款未退货、退货处置）。 */
  orderRefs: readonly string[]
  /** 提交时间，没提交过取创建时间。 */
  since: Date
}

const squash = (value: string) => value.toLowerCase().replace(/[\s_-]+/g, '')

/** 赔付原因（报告 reason 列，如 Lost_Warehouse、Damaged_Warehouse、CustomerReturn）与机会类型是否吻合：按关键字判断，是我们的推断。 */
export function reasonMatchesRule(reason: string, rule: OpportunityRule): boolean {
  const text = squash(reason)
  if (!text) return false
  switch (rule) {
    case 'INBOUND_DISCREPANCY':
      return text.includes('inbound') || text.includes('receiv')
    case 'LEDGER_LOST':
      return text.includes('lost')
    case 'LEDGER_DAMAGED':
      return text.includes('damag')
    case 'REFUND_NO_RETURN':
      return text.includes('return')
    case 'RETURN_DISPOSITION':
      return text.includes('return') || text.includes('damag')
    case 'FEE_OVERCHARGE':
      return text.includes('fee') || text.includes('correction')
    case 'REMOVAL_LOST':
      return text.includes('removal') || text.includes('lost')
  }
}

export type MatchBasis = 'CASE_ID' | 'ORDER_SKU' | 'SKU_REASON'

/**
 * 一笔赔付明细该归到哪个案件（同店铺内）：
 * 1. 赔付明细带了亚马逊案件编号，且与某个案件回填的编号一致；
 * 2. 赔付明细带了原订单号，与案件证据里的订单号、SKU 都一致，且只有一个候选；
 * 3. SKU 一致、赔付原因与机会类型吻合、批准日不早于案件提交（前一天容差），且只有一个候选。
 * 候选不唯一或没有候选返回 null：宁可留在“未归属赔付”也不猜。
 */
export function matchPayout(record: PayoutRecord, candidates: readonly MatchCandidate[]): { caseId: string; basis: MatchBasis } | null {
  const pool = candidates.filter(item => item.sellerAccountId === record.sellerAccountId)
  if (record.amazonCaseId) {
    const wanted = record.amazonCaseId.trim().toLowerCase()
    const byId = pool.filter(item => item.amazonCaseId && item.amazonCaseId.trim().toLowerCase() === wanted)
    if (byId.length === 1) return { caseId: byId[0].id, basis: 'CASE_ID' }
    if (byId.length > 1) return null
  }
  if (record.originalOrderId) {
    const order = record.originalOrderId
    const byOrder = pool.filter(item => item.orderRefs.includes(order) && item.sku === record.sku)
    if (byOrder.length === 1) return { caseId: byOrder[0].id, basis: 'ORDER_SKU' }
    if (byOrder.length > 1) return null
  }
  const floor = record.approvedAt.getTime() + DAY_MS
  const bySku = pool.filter(item => item.sku === record.sku && reasonMatchesRule(record.reason, item.ruleCode) && item.since.getTime() <= floor)
  return bySku.length === 1 ? { caseId: bySku[0].id, basis: 'SKU_REASON' } : null
}

/** 实收合计达到什么程度算“已到账”：有批准金额时实收要达到批准金额（差 0.01 以内算够），没有批准金额只要有实收。 */
export function isPaidInFull(received: number, approved: number | null): boolean {
  if (received <= 0) return false
  return approved === null || approved <= 0 ? true : received + 0.01 >= approved
}

// ---- 统计 ----

type StatCase = Pick<CaseRow, 'status' | 'ruleCode' | 'currency'> & { expectedAmount: number | null; receivedAmount: number; submittedAt: Date | null; firstPaidAt: Date | null }

export const emptyCaseCounts = (): Record<CaseStatus, number> => Object.fromEntries(CASE_STATUSES.map(status => [status, 0])) as Record<CaseStatus, number>

const SUBMITTED_SET: readonly CaseStatus[] = ['SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'PARTIAL', 'REJECTED', 'PAID']

/** 回收率按币种分别算：只算已提交且填了应收金额的案件。 */
export function recoveryByCurrency(cases: readonly StatCase[]): CurrencyRecovery[] {
  const map = new Map<string, CurrencyRecovery>()
  for (const item of cases) {
    if (!SUBMITTED_SET.includes(item.status) || item.expectedAmount === null || !item.currency) continue
    const row = map.get(item.currency) ?? { currency: item.currency, expected: 0, received: 0, recoveryRate: null, caseCount: 0 }
    row.expected = round2(row.expected + item.expectedAmount)
    row.received = round2(row.received + item.receivedAmount)
    row.caseCount += 1
    map.set(item.currency, row)
  }
  return [...map.values()]
    .map(row => ({ ...row, recoveryRate: row.expected > 0 ? Math.round((row.received / row.expected) * 10_000) / 10_000 : null }))
    .sort((a, b) => a.currency.localeCompare(b.currency))
}

/** 平均到账时长（天，保留 1 位）：已有提交时间与第一笔赔付日的案件。 */
export function averagePayDays(cases: readonly StatCase[]): { days: number | null; sample: number } {
  const spans = cases.flatMap(item => (item.submittedAt && item.firstPaidAt ? [Math.max(0, (item.firstPaidAt.getTime() - item.submittedAt.getTime()) / DAY_MS)] : []))
  if (spans.length === 0) return { days: null, sample: 0 }
  return { days: Math.round((spans.reduce((sum, value) => sum + value, 0) / spans.length) * 10) / 10, sample: spans.length }
}

/** 各类机会的案件成功率：已批准、部分批准、已到账算成功，已拒绝算失败，其余还没有结论。 */
export function ruleStats(
  cases: readonly StatCase[],
  pendingByRule: Readonly<Partial<Record<OpportunityRule, number>>>,
  connected: (rule: OpportunityRule) => boolean,
  basis: Readonly<Record<OpportunityRule, string>>,
): RuleStat[] {
  return OPPORTUNITY_RULES.map(rule => {
    const own = cases.filter(item => item.ruleCode === rule)
    const won = own.filter(item => item.status === 'APPROVED' || item.status === 'PARTIAL' || item.status === 'PAID').length
    const rejected = own.filter(item => item.status === 'REJECTED').length
    return {
      ruleCode: rule,
      ruleLabel: OPPORTUNITY_RULE_LABEL[rule],
      connected: connected(rule),
      basis: basis[rule],
      pendingOpportunities: pendingByRule[rule] ?? 0,
      submitted: own.filter(item => SUBMITTED_SET.includes(item.status)).length,
      won,
      rejected,
      successRate: won + rejected > 0 ? Math.round((won / (won + rejected)) * 10_000) / 10_000 : null,
    }
  })
}
