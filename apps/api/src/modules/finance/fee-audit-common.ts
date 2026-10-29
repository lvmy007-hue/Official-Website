import { FEE_AUDIT_KINDS, FEE_AUDIT_KIND_LABEL, FEE_AUDIT_STATUSES, FEE_AUDIT_STATUS_LABEL, type FeeAuditBasis, type FeeAuditKind, type FeeAuditRow, type FeeAuditStatus } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'

// 费用核查页共用：选择列、行转换。

export const FEE_AUDIT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export const AUDIT_SELECT = {
  id: true,
  sellerAccountId: true,
  feeKind: true,
  subjectKey: true,
  sku: true,
  asin: true,
  shipmentRef: true,
  snapshotDate: true,
  currency: true,
  expectedAmount: true,
  actualAmount: true,
  diffAmount: true,
  overchargeAmount: true,
  occurrences: true,
  checkedCount: true,
  firstSeenAt: true,
  lastSeenAt: true,
  status: true,
  basisJson: true,
  opportunityId: true,
  sellerAccount: { select: { displayName: true } },
} satisfies Prisma.FeeAuditSelect
export type AuditRecord = Prisma.FeeAuditGetPayload<{ select: typeof AUDIT_SELECT }>

const num = (value: { toString(): string }) => Number(value.toString())
const EMPTY_BASIS: FeeAuditBasis = { summary: '', lines: [], dims: null, notes: [] }

/** 依据 JSON 是后台任务写的，读取时只认形状对的部分，不因为一行坏数据让整页失败。 */
export function basisOf(value: unknown): FeeAuditBasis {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return EMPTY_BASIS
  const raw = value as Partial<FeeAuditBasis>
  return {
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    lines: Array.isArray(raw.lines) ? raw.lines : [],
    dims: raw.dims && typeof raw.dims === 'object' ? raw.dims : null,
    notes: Array.isArray(raw.notes) ? raw.notes.filter((note): note is string => typeof note === 'string') : [],
  }
}

export function auditRow(row: AuditRecord): FeeAuditRow {
  const kind = (FEE_AUDIT_KINDS as readonly string[]).includes(row.feeKind) ? (row.feeKind as FeeAuditKind) : 'FULFILLMENT'
  const status = (FEE_AUDIT_STATUSES as readonly string[]).includes(row.status) ? (row.status as FeeAuditStatus) : 'NORMAL'
  return {
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    storeName: row.sellerAccount.displayName,
    feeKind: kind,
    feeKindLabel: FEE_AUDIT_KIND_LABEL[kind],
    subjectKey: row.subjectKey,
    sku: row.sku,
    asin: row.asin,
    shipmentRef: row.shipmentRef,
    snapshotDate: row.snapshotDate.toISOString().slice(0, 10),
    currency: row.currency,
    expectedAmount: num(row.expectedAmount),
    actualAmount: num(row.actualAmount),
    diffAmount: num(row.diffAmount),
    overchargeAmount: num(row.overchargeAmount),
    occurrences: row.occurrences,
    checkedCount: row.checkedCount,
    firstSeenAt: row.firstSeenAt?.toISOString() ?? null,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    status,
    statusLabel: FEE_AUDIT_STATUS_LABEL[status],
    basis: basisOf(row.basisJson),
    opportunityId: row.opportunityId,
  }
}
