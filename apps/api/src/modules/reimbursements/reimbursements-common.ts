import {
  CASE_STATUS_LABEL,
  OPPORTUNITY_RULE_LABEL,
  OPPORTUNITY_STATUS_LABEL,
  isRuleConnected,
  type CaseRow,
  type CaseStatus,
  type OpportunityEvidence,
  type OpportunityRow,
  type OpportunityRule,
  type OpportunityStatus,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'

// 赔付中心的公共部分（P2b-03）：权限常量、行映射。

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
export const isUniqueViolation = (error: unknown): boolean => typeof error === 'object' && error !== null && (error as { code?: string }).code === 'P2002'
/** 机会列表与案件列表显示的数据新鲜度：识别依据来自这些来源，赔付到账来自官方赔付明细。 */
export const REIMBURSEMENT_FRESHNESS_KEYS = ['rpt.reimbursements', 'rpt.ledger-detail', 'rpt.customer-returns', 'rpt.removal-order', 'finance.transactions'] as const

const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const iso = (value: Date | null | undefined) => (value ? value.toISOString() : null)
const day = (value: Date | null | undefined) => (value ? value.toISOString().slice(0, 10) : null)

export const evidenceOf = (value: unknown): OpportunityEvidence[] => (Array.isArray(value) ? (value as OpportunityEvidence[]) : [])

export const OPPORTUNITY_SELECT = {
  id: true,
  ruleCode: true,
  sellerAccountId: true,
  sku: true,
  qty: true,
  status: true,
  estimatedAmount: true,
  currency: true,
  deadlineAt: true,
  detectedAt: true,
  evidenceRefsJson: true,
  note: true,
  version: true,
  sellerAccount: { select: { displayName: true } },
  cases: { select: { id: true, caseNo: true }, take: 1 },
} satisfies Prisma.ReimbursementOpportunitySelect
export type OpportunityRecord = Prisma.ReimbursementOpportunityGetPayload<{ select: typeof OPPORTUNITY_SELECT }>

export function opportunityRow(row: OpportunityRecord): OpportunityRow {
  const rule = row.ruleCode as OpportunityRule
  const status = row.status as OpportunityStatus
  const linked = row.cases[0] ?? null
  return {
    id: row.id,
    ruleCode: rule,
    ruleLabel: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode,
    connected: isRuleConnected(rule),
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    sku: row.sku,
    qty: row.qty,
    status,
    statusLabel: OPPORTUNITY_STATUS_LABEL[status] ?? row.status,
    estimatedAmount: num(row.estimatedAmount),
    currency: row.currency,
    deadlineAt: day(row.deadlineAt),
    detectedAt: row.detectedAt.toISOString(),
    evidence: evidenceOf(row.evidenceRefsJson),
    caseId: linked?.id ?? null,
    caseNo: linked?.caseNo ?? null,
    note: row.note,
    version: row.version,
  }
}

export const CASE_SELECT = {
  id: true,
  caseNo: true,
  ruleCode: true,
  status: true,
  sellerAccountId: true,
  sku: true,
  qty: true,
  expectedAmount: true,
  approvedAmount: true,
  receivedAmount: true,
  currency: true,
  ownerId: true,
  amazonCaseId: true,
  submittedAt: true,
  decidedAt: true,
  paidAt: true,
  deadlineAt: true,
  opportunityId: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  evidenceRefsJson: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.ReimbursementCaseSelect
export type CaseRecord = Prisma.ReimbursementCaseGetPayload<{ select: typeof CASE_SELECT }>

export async function ownerNamesOf(prisma: PrismaService, tenantId: string, rows: readonly Pick<CaseRecord, 'ownerId'>[]) {
  return memberNames(
    prisma,
    tenantId,
    rows.map(row => row.ownerId),
  )
}

export function caseRow(row: CaseRecord, names: ReadonlyMap<string, string>): CaseRow {
  const rule = row.ruleCode as OpportunityRule
  const status = row.status as CaseStatus
  return {
    id: row.id,
    caseNo: row.caseNo,
    ruleCode: rule,
    ruleLabel: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode,
    status,
    statusLabel: CASE_STATUS_LABEL[status] ?? row.status,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    sku: row.sku,
    qty: row.qty,
    expectedAmount: num(row.expectedAmount),
    approvedAmount: num(row.approvedAmount),
    receivedAmount: num(row.receivedAmount) ?? 0,
    currency: row.currency,
    ownerId: row.ownerId,
    ownerName: nameOrFormer(names, row.ownerId, '未指定'),
    amazonCaseId: row.amazonCaseId,
    submittedAt: iso(row.submittedAt),
    decidedAt: iso(row.decidedAt),
    paidAt: iso(row.paidAt),
    deadlineAt: day(row.deadlineAt),
    opportunityId: row.opportunityId,
    note: row.note,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** 案件编号：PC-日期-5 位随机码（大写字母与数字，去掉容易混淆的 0O1I），同一企业内唯一，冲突时由调用方重试。 */
export function newCaseNo(now = new Date()): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let code = ''
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)]
  return `PC-${now.toISOString().slice(0, 10).replaceAll('-', '')}-${code}`
}
