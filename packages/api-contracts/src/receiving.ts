import { z } from 'zod'

// 货件接收与差异（P2a-13，06 章 6.12；07 章 7.3 第 1 类赔付机会）：口径常量、纯函数与响应类型。
// 常量与纯函数 worker（同步时判差异、产出机会）和 API（页面展示、统计）共用，保证两边同一套口径。

export const RECEIVING_KINDS = ['SHORT', 'OVER', 'NONCOMPLIANCE'] as const
export type ReceivingKind = (typeof RECEIVING_KINDS)[number]
export const RECEIVING_KIND_LABEL: Record<ReceivingKind, string> = { SHORT: '少收', OVER: '多收', NONCOMPLIANCE: '不合规' }

export const OPPORTUNITY_RULES = ['INBOUND_DISCREPANCY', 'LEDGER_LOST', 'LEDGER_DAMAGED', 'REFUND_NO_RETURN', 'RETURN_DISPOSITION', 'FEE_OVERCHARGE', 'REMOVAL_LOST'] as const
export type OpportunityRule = (typeof OPPORTUNITY_RULES)[number]
export const OPPORTUNITY_RULE_LABEL: Record<OpportunityRule, string> = {
  INBOUND_DISCREPANCY: '入仓差异',
  LEDGER_LOST: '仓内丢失',
  LEDGER_DAMAGED: '仓内损坏',
  REFUND_NO_RETURN: '退款未退货',
  RETURN_DISPOSITION: '退货处置异常',
  FEE_OVERCHARGE: '费用多收',
  REMOVAL_LOST: '移除丢失',
}

export const OPPORTUNITY_STATUSES = ['PENDING', 'CASE_CREATED', 'IGNORED', 'EXPIRED', 'RESOLVED'] as const
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number]
export const OPPORTUNITY_STATUS_LABEL: Record<OpportunityStatus, string> = {
  PENDING: '待处理',
  CASE_CREATED: '已生成案件',
  IGNORED: '已忽略',
  EXPIRED: '已过期',
  RESOLVED: '差异已消除',
}

/**
 * 入仓差异赔付的默认时限（天）。07 章写明“时限按亚马逊当期政策在设置中配置”，设置页在 P2b-03 落地，
 * 在那之前用这两个默认值：等待期从货件关闭起算（等亚马逊自己调查与自动赔付），申请期限同样从关闭起算。
 * 两个数字没有对照亚马逊当期政策核实，页面上写明“默认值”。
 */
export const INBOUND_CLAIM_WAIT_DAYS = 45
export const INBOUND_CLAIM_WINDOW_DAYS = 540

const DAY_MS = 86_400_000
const dayStart = (value: Date) => Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate())
const dayText = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export interface ClaimWindow {
  /** 等待期结束、可以申请的第一天（YYYY-MM-DD）。 */
  eligibleFrom: string
  /** 申请截止日（YYYY-MM-DD）。 */
  deadline: string
  state: 'WAITING' | 'OPEN' | 'EXPIRED'
}

/** 关闭日起算的等待期与申请期限；now 在等待期内为 WAITING，等待期后到截止日为 OPEN，之后为 EXPIRED。 */
export function claimWindowOf(closedAt: Date, now: Date, waitDays = INBOUND_CLAIM_WAIT_DAYS, windowDays = INBOUND_CLAIM_WINDOW_DAYS): ClaimWindow {
  const eligible = dayStart(closedAt) + waitDays * DAY_MS
  const deadline = dayStart(closedAt) + windowDays * DAY_MS
  const today = dayStart(now)
  return { eligibleFrom: dayText(eligible), deadline: dayText(deadline), state: today < eligible ? 'WAITING' : today > deadline ? 'EXPIRED' : 'OPEN' }
}

/** 一个 SKU 的接收差异：应发减已收，为正是少收，为负是多收，相等或没有接收数量返回 null。 */
export function discrepancyOf(shipped: number | null | undefined, received: number | null | undefined): { kind: 'SHORT' | 'OVER'; qty: number } | null {
  if (shipped === null || shipped === undefined || received === null || received === undefined) return null
  const diff = shipped - received
  if (diff === 0) return null
  return diff > 0 ? { kind: 'SHORT', qty: diff } : { kind: 'OVER', qty: -diff }
}

/** 接收时长（天）：开始接收到接收完成的自然日数，同一天为 0；顺序颠倒的脏数据返回 null。 */
export function receivingDaysOf(firstAt: Date | null | undefined, doneAt: Date | null | undefined): number | null {
  if (!firstAt || !doneAt) return null
  const days = Math.round((dayStart(doneAt) - dayStart(firstAt)) / DAY_MS)
  return days >= 0 ? days : null
}

export const RECEIVING_MIN_SAMPLES = 5
export const RECEIVING_WINDOW_DAYS = 365
export const RECEIVING_BASIS = `接收时长 = 开始接收到接收完成的自然日数，两个时间都是我方同步时第一次看到的时间（不是亚马逊发生的时间，误差约一个同步周期）；统计最近 ${RECEIVING_WINDOW_DAYS} 天内已关闭的货件，按目的运营中心分组；p50 为中位，p90 为九成货件不超过的天数，回写取 p90；样本少于 ${RECEIVING_MIN_SAMPLES} 个货件时只显示不建议回写`

// ---- 响应类型 ----

/** 货件的赔付状态：货件没关闭不判断；差异在等待期内为 WAITING；没有差异为 NONE；其余是机会的状态。 */
export type ClaimListState = 'NOT_JUDGED' | 'NONE' | 'WAITING' | OpportunityStatus

export interface ReceivingExtra {
  transportStatus: string | null
  /** 最早一条未消除的差异已经存在的天数；没有差异为 null。 */
  discrepancyDays: number | null
  claimState: ClaimListState
  /** 未消除的不合规问题数；不合规报告还没有同步成功过时为 null（页面写“尚未接入”，不写 0）。 */
  noncomplianceCount: number | null
}

export interface NoncomplianceItem {
  sku: string
  problemType: string | null
  qty: number | null
  amount: number | null
  currency: string | null
  firstSeenAt: string
  resolvedAt: string | null
}

/** 机会的证据引用：SHIPMENT 货件、SKU、LEDGER 台账行、ORDER 订单（亚马逊订单号）、RETURN 退货记录、REMOVAL 移除订单（店铺:订单号）、FEE_AUDIT 费用核查结果（P2b-06）。P2b-03 起 7 类机会共用。 */
export const EVIDENCE_KINDS = ['SHIPMENT', 'SKU', 'LEDGER', 'ORDER', 'RETURN', 'REMOVAL', 'FEE_AUDIT'] as const
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number]
export interface OpportunityEvidence {
  kind: EvidenceKind
  id: string
  label: string
}

export interface OpportunityItem {
  id: string
  ruleCode: OpportunityRule
  ruleLabel: string
  sku: string
  status: OpportunityStatus
  statusLabel: string
  qty: number | null
  /** 估算金额 = 少收数量 × 当前生效的单件商品成本；没有商品成本为 null（页面写“无商品成本，无法估算”，不写 0）。 */
  estimatedAmount: number | null
  currency: string | null
  deadlineAt: string | null
  detectedAt: string
  evidence: OpportunityEvidence[]
}

export interface ReceivingAuditRow {
  id: string
  at: string
  action: string
  actorName: string
  result: string
  reason: string | null
}

export interface ReceivingStatRow {
  /** 目的运营中心；全部运营中心合计为 null。 */
  destinationFc: string | null
  label: string
  sampleCount: number
  p50Days: number | null
  p90Days: number | null
  minDays: number | null
  maxDays: number | null
  /** 不能回写的原因；可以回写为 null。 */
  applyBlocked: string | null
}

export interface ReceivingStatsResponse {
  overall: ReceivingStatRow
  rows: ReceivingStatRow[]
  policyVersionNo: number | null
  /** 当前生效的企业级补货策略里的入仓接收天数；没有策略或没配置为 null。 */
  policyReceivingDays: number | null
  basis: string
}

export const ReceivingApplyBodySchema = z.object({
  /** 取哪个运营中心的 p90；null 表示全部运营中心合计。 */
  destinationFc: z.string().trim().min(1).max(32).nullable(),
  expectedVersionNo: z.number().int().min(1),
})
export type ReceivingApplyBody = z.infer<typeof ReceivingApplyBodySchema>
export interface ReceivingApplyResult {
  versionNo: number
  receivingDays: number
  previousDays: number | null
  scopeLabel: string
}
