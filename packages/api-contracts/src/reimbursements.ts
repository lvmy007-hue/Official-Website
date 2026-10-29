import { z } from 'zod'
import type { InventoryFreshness } from './inventory.js'
import { cursorListQuery, type CursorPageInfo } from './query.js'
import type { ReimbursementWindows } from './reimbursement-windows.js'
import type { SupportLinkView } from './support.js'
import { OPPORTUNITY_RULES, OPPORTUNITY_STATUSES, type OpportunityEvidence, type OpportunityRule, type OpportunityStatus } from './receiving.js'

// 赔付中心（P2b-03，07 章 7.3）：赔付机会（7 类识别规则）、赔付案件（独立对象）、官方赔付明细匹配、证据包、回收率统计。
// 本文件只放常量、请求校验与响应类型；纯计算（状态流转、台账净额、到账匹配、回收率）在 reimbursements-math.ts。
// 亚马逊的卖家支持接口只能读取、不能创建案件：提交在卖家后台完成，之后把案件编号回填到系统。

export const REIMBURSEMENTS_READ = 'reimbursements.read'
export const REIMBURSEMENTS_WRITE = 'reimbursements.write'
/** 官方赔付明细报告（R-27）与它的新鲜度来源。 */
export const REIMBURSEMENT_REPORT_TYPE = 'GET_FBA_REIMBURSEMENTS_DATA'
export const REIMBURSEMENT_FRESHNESS_KEY = 'rpt.reimbursements'
/** 证据包导出任务的数据类型（导出中心 EXPORT_KINDS）。 */
export const EVIDENCE_EXPORT_KIND = 'reimbursement-evidence'

// ---- 机会规则 ----

/** 当前能产出机会的规则；费用多收由人在费用核查页一键转出（P2b-06），不是后台自动识别。 */
export const CONNECTED_RULES: readonly OpportunityRule[] = ['INBOUND_DISCREPANCY', 'LEDGER_LOST', 'LEDGER_DAMAGED', 'REFUND_NO_RETURN', 'RETURN_DISPOSITION', 'FEE_OVERCHARGE', 'REMOVAL_LOST']
export const isRuleConnected = (rule: OpportunityRule) => CONNECTED_RULES.includes(rule)

/** 每类机会的识别依据原文（页面“规则说明”与证据包都用它）。 */
export const RULE_BASIS: Readonly<Record<OpportunityRule, string>> = {
  INBOUND_DISCREPANCY: '货件关闭后，应发数量大于亚马逊接收数量，且过了等待期。',
  LEDGER_LOST: '库存台账出现“丢失”调整，过了等待期仍没有“找到”调整，也没有对应的官方赔付明细；按先后顺序先抵扣最早的丢失。',
  LEDGER_DAMAGED: '库存台账出现“损坏”调整，过了等待期仍没有对应的官方赔付明细。',
  REFUND_NO_RETURN: '订单已退款并过了等待期，而客户退货报告里没有这个订单的退货记录，也没有对应的官方赔付明细。部分退款与免退货退款也会命中，需要人工核实。',
  RETURN_DISPOSITION: '退货被处置为承运人损坏或仓库损坏，且没有对应的官方赔付明细。',
  FEE_OVERCHARGE: '费用核查发现疑似多收的配送费、佣金、仓储费或入仓配置费，由人在费用核查页确认后一键转出（不是后台自动识别）；金额是核查的累计差额，是疑似多收，不是亚马逊认可的结论。',
  REMOVAL_LOST: '移除订单已关闭，申请数量大于已发货、已弃置与已取消数量之和，且没有对应的官方赔付明细。',
}

// ---- 案件状态 ----

export const CASE_STATUSES = ['OPPORTUNITY', 'SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'PARTIAL', 'REJECTED', 'PAID'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]
export const CASE_STATUS_LABEL: Readonly<Record<CaseStatus, string>> = {
  OPPORTUNITY: '待提交',
  SUBMITTED: '已提交',
  IN_PROGRESS: '处理中',
  APPROVED: '已批准',
  PARTIAL: '部分批准',
  REJECTED: '已拒绝',
  PAID: '已到账',
}

/** 页签：赔付机会是机会列表，其余 5 个是案件列表的状态分组。 */
export const REIMBURSEMENT_TABS = ['opportunities', 'pending', 'processing', 'paid', 'rejected', 'all'] as const
export type ReimbursementTab = (typeof REIMBURSEMENT_TABS)[number]
export const REIMBURSEMENT_TAB_LABEL: Readonly<Record<ReimbursementTab, string>> = {
  opportunities: '赔付机会',
  pending: '待提交',
  processing: '处理中',
  paid: '已到账',
  rejected: '已拒绝',
  all: '全部案件',
}
export const CASE_TAB_STATUSES: Readonly<Record<Exclude<ReimbursementTab, 'opportunities'>, readonly CaseStatus[] | null>> = {
  pending: ['OPPORTUNITY'],
  processing: ['SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'PARTIAL'],
  paid: ['PAID'],
  rejected: ['REJECTED'],
  all: null,
}

export const CASE_NOTE_MAX = 500
export const AMAZON_CASE_ID_PATTERN = /^[A-Za-z0-9-]{1,40}$/
export const MATCH_BASIS_LABEL: Readonly<Record<string, string>> = { CASE_ID: '案件编号一致', ORDER_SKU: '订单与 SKU 一致', SKU_REASON: 'SKU 与赔付原因吻合' }

// ---- 请求 ----

const id = z.string().trim().min(1).max(64)
const amount = z.number().min(0, '金额不能小于 0').max(1_000_000_000, '金额过大')
/** 填写应收金额时的币种（机会或案件还没有币种——没有商品成本——时必填）。 */
const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, '币种用三位大写字母，如 USD')

export const OpportunityListQuerySchema = cursorListQuery({
  sortable: ['detectedAt'],
  defaultSort: { field: 'detectedAt', dir: 'desc' },
  filters: {
    rule: { type: 'enum', values: OPPORTUNITY_RULES },
    status: { type: 'enum', values: OPPORTUNITY_STATUSES },
  },
})
export type OpportunityListQuery = z.infer<typeof OpportunityListQuerySchema>

export const CaseListQuerySchema = cursorListQuery({
  sortable: ['createdAt'],
  defaultSort: { field: 'createdAt', dir: 'desc' },
  filters: {
    tab: { type: 'enum', values: ['pending', 'processing', 'paid', 'rejected', 'all'] },
    rule: { type: 'enum', values: OPPORTUNITY_RULES },
    status: { type: 'enum', values: CASE_STATUSES },
    ownerId: { type: 'text', max: 64 },
  },
})
export type CaseListQuery = z.infer<typeof CaseListQuerySchema>

export const CaseCreateBodySchema = z.object({
  opportunityId: id,
  ownerId: id.optional(),
  /** 不填时取机会的估算金额；机会没有估算金额（没有商品成本）时可以人工填写。 */
  expectedAmount: amount.nullable().optional(),
  currency: currency.optional(),
  note: z.string().trim().max(CASE_NOTE_MAX).optional(),
})
export type CaseCreateBody = z.infer<typeof CaseCreateBodySchema>

export const CaseUpdateBodySchema = z
  .object({
    version: z.number().int().min(1),
    status: z.enum(CASE_STATUSES).optional(),
    amazonCaseId: z.string().trim().regex(AMAZON_CASE_ID_PATTERN, '案件编号只能含字母、数字与短横线，最长 40 位').nullable().optional(),
    ownerId: id.optional(),
    expectedAmount: amount.nullable().optional(),
    approvedAmount: amount.nullable().optional(),
    currency: currency.optional(),
    note: z.string().trim().max(CASE_NOTE_MAX).nullable().optional(),
  })
  .refine(body => Object.keys(body).some(key => key !== 'version' && (body as Record<string, unknown>)[key] !== undefined), { message: '没有要修改的内容' })
export type CaseUpdateBody = z.infer<typeof CaseUpdateBodySchema>

export const OpportunityIgnoreBodySchema = z.object({ version: z.number().int().min(1), reason: z.string().trim().min(2, '请填写忽略原因').max(300) })
export const OpportunityRestoreBodySchema = z.object({ version: z.number().int().min(1) })

// ---- 响应 ----

export interface OpportunityRow {
  id: string
  ruleCode: OpportunityRule
  ruleLabel: string
  /** 该类规则目前是否真的在产出机会（费用多收尚未接入）。 */
  connected: boolean
  sellerAccountId: string
  storeName: string
  sku: string | null
  qty: number | null
  status: OpportunityStatus
  statusLabel: string
  /** 估算金额 = 数量 × 当前生效的单件商品成本；没有商品成本为 null（页面写“无商品成本，无法估算”，不写 0）。 */
  estimatedAmount: number | null
  currency: string | null
  deadlineAt: string | null
  detectedAt: string
  evidence: OpportunityEvidence[]
  /** 已生成的案件；没有为 null。 */
  caseId: string | null
  caseNo: string | null
  /** 忽略原因（状态为已忽略时）。 */
  note: string | null
  version: number
}

export interface OpportunityListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: OpportunityRow[]
  pageInfo: CursorPageInfo
  freshness: InventoryFreshness
}

export interface CaseRow {
  id: string
  caseNo: string
  ruleCode: OpportunityRule
  ruleLabel: string
  status: CaseStatus
  statusLabel: string
  sellerAccountId: string
  storeName: string
  sku: string | null
  qty: number | null
  /** 应收；没有为 null（页面写“尚未填写”，不写 0）。 */
  expectedAmount: number | null
  approvedAmount: number | null
  /** 实收：官方赔付明细匹配累加，没有匹配到任何一笔时为 0（此时页面写“尚无到账”）。 */
  receivedAmount: number
  currency: string | null
  ownerId: string
  ownerName: string
  amazonCaseId: string | null
  submittedAt: string | null
  decidedAt: string | null
  paidAt: string | null
  deadlineAt: string | null
  opportunityId: string | null
  note: string | null
  version: number
  createdAt: string
  updatedAt: string
}

export interface CaseListResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: CaseRow[]
  pageInfo: CursorPageInfo
  freshness: InventoryFreshness
}

export interface MatchedRecordRow {
  id: string
  reimbursementId: string
  sku: string
  reason: string
  quantity: number
  amount: number
  currency: string
  approvedAt: string
  matchBasis: string
  matchBasisLabel: string
}

export interface EvidenceAttachmentRow {
  id: string
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedBy: string
  uploadedAt: string
}

export interface EvidencePackRow {
  id: string
  generatedAt: string
  generatedBy: string
  lineCount: number
  exportJobId: string | null
  /** 导出任务状态（排队中、生成中、已完成、失败、已过期）；任务已不存在为 null。 */
  exportStatus: string | null
  exportStatusLabel: string | null
  downloadable: boolean
}

export interface CaseDetailResponse {
  case: CaseRow
  basis: string
  evidence: OpportunityEvidence[]
  attachments: EvidenceAttachmentRow[]
  records: MatchedRecordRow[]
  packs: EvidencePackRow[]
  /** 当前状态下可以改成的状态（已到账只由赔付明细匹配产生，不能手工改）。 */
  nextStatuses: CaseStatus[]
  canWrite: boolean
  /** 与亚马逊支持案件的关联（P2b-04）：按案件上回填的亚马逊案件编号对应到同步下来的支持案件；没有编号、没有权限、尚未同步都有各自的说明。 */
  supportCases: SupportLinkView
  freshness: InventoryFreshness
}

export interface CaseUpdateResult {
  id: string
  version: number
  status: CaseStatus
}

/** 证据包清单的一行（保存在 EvidencePack.contentManifestJson.lines，导出按它逐行输出）。 */
export interface EvidenceLine {
  /** 类别：案件、识别依据、证据、附件、官方赔付、时间线。 */
  section: string
  item: string
  detail: string
  /** 发生时间（ISO）；没有为 null。 */
  at: string | null
}
export const EVIDENCE_MANIFEST_VERSION = 1
export interface EvidenceManifest {
  version: number
  caseNo: string
  lines: EvidenceLine[]
}

export interface EvidencePackResult {
  packId: string
  lineCount: number
  exportJobId: string
}

export interface RuleStat {
  ruleCode: OpportunityRule
  ruleLabel: string
  connected: boolean
  basis: string
  /** 待处理的机会数。 */
  pendingOpportunities: number
  /** 已提交的案件数（状态在“已提交”之后）。 */
  submitted: number
  /** 已有结论的案件：已批准、部分批准、已到账算成功，已拒绝算失败。 */
  won: number
  rejected: number
  /** 成功率 = 成功 ÷ 有结论的案件；还没有有结论的案件为 null。 */
  successRate: number | null
}

export interface CurrencyRecovery {
  currency: string
  /** 已提交案件的应收合计（只算填了应收金额的案件）。 */
  expected: number
  received: number
  /** 回收率 = 实收 ÷ 应收；应收为 0 时为 null。 */
  recoveryRate: number | null
  caseCount: number
}

export interface ReimbursementStatsResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  caseCounts: Record<CaseStatus, number>
  pendingOpportunities: number
  recovery: CurrencyRecovery[]
  /** 平均到账时长（天）：已提交到第一笔赔付到账；没有已到账且有提交时间的案件为 null。 */
  avgPayDays: number | null
  paidSample: number
  rules: RuleStat[]
  /** 没有对应案件的官方赔付明细（未归属赔付）。 */
  unmatched: { count: number; byCurrency: Array<{ currency: string; amount: number }> }
  windows: ReimbursementWindows
  /** 时限是否还是系统默认值（企业没有保存过）。 */
  windowsDefault: boolean
  windowsVersion: number
  basis: string
  freshness: InventoryFreshness
}

export const STATS_BASIS =
  '回收率 = 实收 ÷ 应收，只统计已提交且填了应收金额的案件，按币种分别计算；实收只来自官方赔付明细（赔付报告）的自动匹配，不能手填。' +
  '成功率 = 已批准、部分批准、已到账的案件 ÷ 有结论的案件（再加已拒绝）。平均到账时长 = 案件提交到第一笔赔付明细的批准日。'
