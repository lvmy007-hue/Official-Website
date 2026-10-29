import { Injectable } from '@nestjs/common'
import {
  FEE_AUDIT_CONVERT,
  FEE_AUDIT_EVIDENCE_KIND,
  FEE_AUDIT_KIND_LABEL,
  FEE_AUDIT_OPPORTUNITY_RULE,
  claimWindowOf,
  feeAuditOpportunityKey,
  resolveWindows,
  type FeeAuditConvertResult,
  type FeeAuditKind,
  type OpportunityEvidence,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { SettingsService } from '../settings'
import { FEE_AUDIT_ID_PATTERN } from './fee-audit-common'

const OPEN = ['PENDING', 'CASE_CREATED']
const CLOSED_TEXT: Readonly<Record<string, string>> = { IGNORED: '已被忽略', EXPIRED: '已过期', RESOLVED: '差异已消除' }

// 一键转为赔付机会（07 章 7.6）：把一个“疑似多收”的核查对象转成赔付中心的“费用多收”机会，之后在赔付中心立案跟进。
// 同一个核查对象（类别 + SKU 或入仓计划）只对应一个机会，不管在哪个核查日转：已经转过就返回已有的（不重复建）；
// 已有机会被忽略、已过期或差异已消除时不重建，提示到赔付中心处理。金额是核查的累计差额，是疑似多收，不是亚马逊认可的结论。
@Injectable()
export class FeeAuditConvertService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly settings: SettingsService,
    private readonly audit: AuditWriter,
  ) {}

  async convert(req: RequestWithContext, id: string, now = new Date()): Promise<FeeAuditConvertResult> {
    // 权限先于其它检查：无权限的人先拿 403
    const { context, scope } = await this.context.authorizeScoped(req, FEE_AUDIT_CONVERT, {})
    if (!FEE_AUDIT_ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '核查结果不存在')
    const tenantId = context.tenantId
    const row = await this.prisma.feeAudit.findFirst({ where: { id, tenantId, ...storeWhere(scope) } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '核查结果不存在')
    const kind = row.feeKind as FeeAuditKind
    const dedupKey = feeAuditOpportunityKey(kind, row.subjectKey)
    const where = { tenantId_sellerAccountId_ruleCode_dedupKey: { tenantId, sellerAccountId: row.sellerAccountId, ruleCode: FEE_AUDIT_OPPORTUNITY_RULE, dedupKey } }
    const existing = await this.prisma.reimbursementOpportunity.findUnique({ where, select: { id: true, status: true } })
    if (existing) return this.reuse(row.id, existing)
    const overcharge = Number(row.overchargeAmount.toString())
    if (row.occurrences <= 0 || overcharge <= 0) throw appError('DATA_CONDITION_FAILED', '这个核查对象没有疑似多收，不需要转为赔付机会', { details: { status: row.status } })
    const windows = resolveWindows((await this.settings.get(tenantId, 'reimbursement.windows')).value)[FEE_AUDIT_OPPORTUNITY_RULE]
    const window = claimWindowOf(row.firstSeenAt ?? row.snapshotDate, now, windows.waitDays, windows.windowDays)
    if (window.state === 'EXPIRED') throw appError('DATA_CONDITION_FAILED', `最早一次多收已超过申请期限（${window.deadline}），不能再转为赔付机会`, { details: { deadline: window.deadline } })
    const label = `${FEE_AUDIT_KIND_LABEL[kind]}核查：${row.sku ?? row.shipmentRef ?? row.subjectKey}`
    const evidence: OpportunityEvidence[] = [{ kind: FEE_AUDIT_EVIDENCE_KIND, id: row.id, label }, ...(row.sku ? [{ kind: 'SKU' as const, id: row.sku, label: row.sku }] : [])]
    try {
      const created = await this.prisma.$transaction(async tx => {
        const opportunity = await tx.reimbursementOpportunity.create({
          data: {
            tenantId,
            sellerAccountId: row.sellerAccountId,
            ruleCode: FEE_AUDIT_OPPORTUNITY_RULE,
            dedupKey,
            evidenceRefsJson: evidence as unknown as Prisma.InputJsonValue,
            estimatedAmount: overcharge,
            currency: row.currency,
            deadlineAt: new Date(`${window.deadline}T00:00:00.000Z`),
            status: 'PENDING',
            sku: row.sku,
            qty: null,
          },
          select: { id: true },
        })
        await tx.feeAudit.update({ where: { id: row.id }, data: { status: 'APPEALED', opportunityId: opportunity.id } })
        await this.audit.record(
          req,
          {
            action: 'FEE_AUDIT_CONVERTED',
            resourceType: 'FeeAudit',
            resourceId: row.id,
            after: { opportunityId: opportunity.id, overchargeAmount: overcharge, currency: row.currency, feeKind: kind },
          },
          { client: tx },
        )
        return opportunity
      })
      return { id: row.id, status: 'APPEALED', opportunityId: created.id, created: true }
    } catch (error) {
      // 并发的另一个请求刚建了同一个机会（企业 + 店铺 + 规则 + 去重键唯一）：按已有的返回
      if ((error as { code?: string }).code !== 'P2002') throw error
      const raced = await this.prisma.reimbursementOpportunity.findUnique({ where, select: { id: true, status: true } })
      if (!raced) throw error
      return this.reuse(row.id, raced)
    }
  }

  private async reuse(auditId: string, existing: { id: string; status: string }): Promise<FeeAuditConvertResult> {
    if (!OPEN.includes(existing.status)) {
      throw appError('DATA_CONDITION_FAILED', `这个核查对象对应的赔付机会${CLOSED_TEXT[existing.status] ?? '已处理'}，请到赔付中心查看`, {
        details: { opportunityId: existing.id, status: existing.status },
      })
    }
    await this.prisma.feeAudit.update({ where: { id: auditId }, data: { status: 'APPEALED', opportunityId: existing.id } })
    return { id: auditId, status: 'APPEALED', opportunityId: existing.id, created: false }
  }
}
