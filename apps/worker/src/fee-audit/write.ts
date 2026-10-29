import { FEE_AUDIT_OPPORTUNITY_RULE, FEE_AUDIT_RETENTION_DAYS, FEE_BASELINE_RETENTION_DAYS, feeAuditOpportunityKey, feeAuditStatusOf, type FeeAuditKind } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { shiftDays, type AuditContext, type AuditResult } from './shared'

// 费用核查结果的写入（P2b-06）：一行 = 一个核查对象在一个核查日的结果，同一天重复核查按唯一键覆盖。
// 已经转为赔付机会（待处理或已生成案件）的对象保持“已转赔付机会”，不会被下一轮核查改回“疑似多收”。
// 本轮没有再产出的当日旧行（基准过期、订单被删等）在没有读取截断时清掉，避免页面上留着已经不成立的结果。

/** 已经存在的费用多收赔付机会：键为“店铺|去重键”，值为机会编号。 */
async function openOpportunities(ctx: AuditContext): Promise<Map<string, string>> {
  const rows = await ctx.db.reimbursementOpportunity.findMany({
    where: { tenantId: ctx.tenantId, ruleCode: FEE_AUDIT_OPPORTUNITY_RULE, status: { in: ['PENDING', 'CASE_CREATED'] } },
    select: { id: true, sellerAccountId: true, dedupKey: true },
    take: 20_000,
  })
  return new Map(rows.map(row => [`${row.sellerAccountId}|${row.dedupKey}`, row.id]))
}

export async function writeResults(ctx: AuditContext, results: readonly AuditResult[], startedAt: Date): Promise<{ written: number; removed: number }> {
  const { db, tenantId, today } = ctx
  const opportunities = await openOpportunities(ctx)
  let written = 0
  let removed = 0
  for (const result of results) {
    for (const subject of result.subjects) {
      const opportunityId = opportunities.get(`${subject.sellerAccountId}|${feeAuditOpportunityKey(result.kind, subject.subjectKey)}`) ?? null
      const data = {
        sku: subject.sku,
        asin: subject.asin,
        shipmentRef: subject.shipmentRef,
        currency: subject.currency,
        expectedAmount: subject.expected,
        actualAmount: subject.actual,
        diffAmount: Math.round((subject.actual - subject.expected) * 100) / 100,
        overchargeAmount: subject.overcharge,
        occurrences: subject.occurrences,
        checkedCount: subject.checkedCount,
        firstSeenAt: subject.firstSeenAt,
        lastSeenAt: subject.lastSeenAt,
        status: feeAuditStatusOf(subject.occurrences, opportunityId !== null),
        basisJson: subject.basis as unknown as Prisma.InputJsonValue,
        opportunityId,
      }
      await db.feeAudit.upsert({
        where: { sellerAccountId_feeKind_subjectKey_snapshotDate: { sellerAccountId: subject.sellerAccountId, feeKind: result.kind, subjectKey: subject.subjectKey, snapshotDate: today } },
        create: { ...data, tenantId, sellerAccountId: subject.sellerAccountId, feeKind: result.kind, subjectKey: subject.subjectKey, snapshotDate: today },
        update: data,
      })
      written += 1
    }
    if (!result.truncated) {
      const gone = await db.feeAudit.deleteMany({ where: { tenantId, feeKind: result.kind as FeeAuditKind, snapshotDate: today, updatedAt: { lt: startedAt } } })
      removed += gone.count
    }
  }
  return { written, removed }
}

/** 清理过期的核查结果与基准快照。 */
export async function pruneOld(ctx: AuditContext): Promise<{ audits: number; baselines: number }> {
  const audits = await ctx.db.feeAudit.deleteMany({ where: { tenantId: ctx.tenantId, snapshotDate: { lt: shiftDays(ctx.today, -FEE_AUDIT_RETENTION_DAYS) } } })
  const baselines = await ctx.db.feeBaseline.deleteMany({ where: { tenantId: ctx.tenantId, snapshotDate: { lt: shiftDays(ctx.today, -FEE_BASELINE_RETENTION_DAYS) } } })
  return { audits: audits.count, baselines: baselines.count }
}
