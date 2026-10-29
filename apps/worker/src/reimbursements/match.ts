import { MATCH_BASIS_LABEL, isPaidInFull, matchPayout, type MatchCandidate, type OpportunityRule } from '@nova/api-contracts'
import type { PrismaClient } from '@prisma/client'

// 官方赔付明细 → 我方案件的自动匹配（P2b-03，07 章 7.3）。
// 只匹配“还没归属”的赔付行，候选是已提交、处理中、已批准、部分批准的案件（同店铺、币种一致或案件还没币种）。匹配规则见契约 matchPayout：
// 案件编号一致 → 订单 + SKU 一致且唯一 → SKU + 原因吻合且唯一；有歧义宁可不匹配，留在“未归属赔付”。
// 匹配后重算案件实收（只由匹配累加，页面不允许手填）；实收达到批准金额（没有批准金额时只要有实收）转为已到账；赔付行带了亚马逊案件编号而案件还没填的，顺手回填。

export type MatchDb = Pick<PrismaClient, 'reimbursementRecord' | 'reimbursementCase' | 'entityEvent'>

const OPEN_STATUSES = ['SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'PARTIAL']
const BATCH = 5000

interface EvidenceRef {
  kind?: string
  id?: string
}

const orderRefsOf = (value: unknown): string[] =>
  Array.isArray(value) ? (value as EvidenceRef[]).filter(item => item?.kind === 'ORDER' && typeof item.id === 'string').map(item => item.id as string) : []

export interface MatchResult {
  matched: number
  paid: number
}

export async function matchPayouts(db: MatchDb, tenantId: string, now: Date): Promise<MatchResult> {
  const records = await db.reimbursementRecord.findMany({
    where: { tenantId, matchedCaseId: null },
    select: { id: true, sellerAccountId: true, sku: true, reason: true, approvedAt: true, amazonCaseId: true, originalOrderId: true, currency: true, amount: true },
    orderBy: { approvedAt: 'asc' },
    take: BATCH,
  })
  if (records.length === 0) return { matched: 0, paid: 0 }
  const cases = await db.reimbursementCase.findMany({
    where: { tenantId, status: { in: OPEN_STATUSES } },
    select: { id: true, sellerAccountId: true, ruleCode: true, sku: true, amazonCaseId: true, evidenceRefsJson: true, submittedAt: true, createdAt: true, currency: true },
    take: BATCH,
  })
  if (cases.length === 0) return { matched: 0, paid: 0 }
  const candidates: Array<MatchCandidate & { currency: string | null }> = cases.map(row => ({
    id: row.id,
    sellerAccountId: row.sellerAccountId,
    ruleCode: row.ruleCode as OpportunityRule,
    sku: row.sku,
    amazonCaseId: row.amazonCaseId,
    orderRefs: orderRefsOf(row.evidenceRefsJson),
    since: row.submittedAt ?? row.createdAt,
    currency: row.currency,
  }))
  const touched = new Map<string, { backfillCaseId: string | null }>()
  let matched = 0
  for (const record of records) {
    const pool = candidates.filter(item => !item.currency || item.currency === record.currency)
    const hit = matchPayout(
      { sellerAccountId: record.sellerAccountId, sku: record.sku, reason: record.reason, approvedAt: record.approvedAt, amazonCaseId: record.amazonCaseId, originalOrderId: record.originalOrderId },
      pool,
    )
    if (!hit) continue
    const claimed = await db.reimbursementRecord.updateMany({ where: { id: record.id, matchedCaseId: null }, data: { matchedCaseId: hit.caseId, matchBasis: hit.basis, matchedAt: now } })
    if (claimed.count === 0) continue
    matched += 1
    const state = touched.get(hit.caseId) ?? { backfillCaseId: null }
    if (record.amazonCaseId && !state.backfillCaseId) state.backfillCaseId = record.amazonCaseId
    touched.set(hit.caseId, state)
    await db.entityEvent.create({
      data: {
        tenantId,
        sellerAccountId: record.sellerAccountId,
        entityType: 'REIMBURSEMENT_CASE',
        entityId: hit.caseId,
        kind: 'reimbursement.payout',
        occurredAt: record.approvedAt,
        title: `官方赔付明细到账 ${record.amount.toString()} ${record.currency}（${MATCH_BASIS_LABEL[hit.basis] ?? hit.basis}）`,
        detailJson: { recordId: record.id, basis: hit.basis },
        actorKind: 'AMAZON',
        sourceRef: `record:${record.id}`,
      },
    })
  }
  let paid = 0
  for (const [caseId, state] of touched) if (await recompute(db, tenantId, caseId, state.backfillCaseId, now)) paid += 1
  return { matched, paid }
}

/** 重算一个案件的实收：返回这次是否转为已到账。 */
async function recompute(db: MatchDb, tenantId: string, caseId: string, backfill: string | null, now: Date): Promise<boolean> {
  const current = await db.reimbursementCase.findFirst({
    where: { id: caseId, tenantId },
    select: { id: true, status: true, approvedAmount: true, currency: true, amazonCaseId: true, decidedAt: true },
  })
  if (!current) return false
  const rows = await db.reimbursementRecord.findMany({ where: { tenantId, matchedCaseId: caseId }, select: { amount: true, currency: true, approvedAt: true }, take: 5000 })
  const received = Math.round(rows.reduce((sum, row) => sum + row.amount.toNumber(), 0) * 100) / 100
  const lastPaid = rows.filter(row => row.amount.toNumber() > 0).reduce<Date | null>((max, row) => (!max || row.approvedAt > max ? row.approvedAt : max), null)
  const approved = current.approvedAmount ? current.approvedAmount.toNumber() : null
  const becomesPaid = current.status !== 'PAID' && isPaidInFull(received, approved)
  await db.reimbursementCase.updateMany({
    where: { id: caseId, tenantId },
    data: {
      receivedAmount: received,
      currency: current.currency ?? rows[0]?.currency ?? null,
      ...(becomesPaid ? { status: 'PAID', paidAt: lastPaid ?? now } : lastPaid ? { paidAt: lastPaid } : {}),
      ...(!current.decidedAt && received > 0 ? { decidedAt: lastPaid ?? now } : {}),
      ...(backfill && !current.amazonCaseId ? { amazonCaseId: backfill.slice(0, 40) } : {}),
      version: { increment: 1 },
    },
  })
  return becomesPaid
}
