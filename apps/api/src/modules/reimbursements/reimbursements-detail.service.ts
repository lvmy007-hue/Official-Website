import { Injectable } from '@nestjs/common'
import {
  EXPORT_STATUS_LABEL,
  MATCH_BASIS_LABEL,
  OPPORTUNITY_RULE_LABEL,
  REIMBURSEMENTS_READ,
  REIMBURSEMENTS_WRITE,
  RULE_BASIS,
  nextCaseStatuses,
  type CaseDetailResponse,
  type CaseStatus,
  type EvidencePackRow,
  type MatchedRecordRow,
  type OpportunityRule,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { sourceFreshness } from '../inventory'
import { AttachmentService } from '../procurement'
import { SupportLinkService } from '../support'
import { CASE_SELECT, ID_PATTERN, REIMBURSEMENT_FRESHNESS_KEYS, caseRow, evidenceOf, ownerNamesOf } from './reimbursements-common'

// 赔付案件详情（07 章 7.3）：案件、识别依据与证据引用、附件、已匹配的官方赔付明细、证据包记录。
// 时间线与评论由协作模块按对象（REIMBURSEMENT_CASE）提供，这里不重复。
@Injectable()
export class ReimbursementsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly attachments: AttachmentService,
    private readonly support: SupportLinkService,
  ) {}

  async detail(req: RequestWithContext, id: string, now = new Date()): Promise<CaseDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_READ, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const tenantId = context.tenantId
    const row = await this.prisma.reimbursementCase.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, select: CASE_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const [files, records, packs, freshness, names] = await Promise.all([
      this.attachments.list(tenantId, 'REIMBURSEMENT_CASE', id),
      this.prisma.reimbursementRecord.findMany({ where: { tenantId, matchedCaseId: id }, orderBy: { approvedAt: 'desc' }, take: 200 }),
      this.prisma.evidencePack.findMany({ where: { tenantId, caseId: id }, orderBy: { generatedAt: 'desc' }, take: 20 }),
      sourceFreshness(this.prisma, tenantId, scope, REIMBURSEMENT_FRESHNESS_KEYS),
      ownerNamesOf(this.prisma, tenantId, [row]),
    ])
    const jobs = await this.prisma.exportJob.findMany({
      where: { tenantId, id: { in: packs.flatMap(pack => (pack.exportJobId ? [pack.exportJobId] : [])) } },
      select: { id: true, status: true, expiresAt: true, fileKey: true, requestedBy: true },
      take: 20,
    })
    const jobById = new Map(jobs.map(job => [job.id, job]))
    const people = await memberNames(
      this.prisma,
      tenantId,
      packs.map(pack => pack.generatedBy),
    )
    const rule = row.ruleCode as OpportunityRule
    const matched: MatchedRecordRow[] = records.map(record => ({
      id: record.id,
      reimbursementId: record.reimbursementId,
      sku: record.sku,
      reason: record.reason,
      quantity: record.quantity,
      amount: Number(record.amount.toString()),
      currency: record.currency,
      approvedAt: record.approvedAt.toISOString(),
      matchBasis: record.matchBasis ?? '',
      matchBasisLabel: MATCH_BASIS_LABEL[record.matchBasis ?? ''] ?? '尚无记录',
    }))
    const packRows: EvidencePackRow[] = packs.map(pack => {
      const job = pack.exportJobId ? jobById.get(pack.exportJobId) : undefined
      const expired = job ? job.status === 'EXPIRED' || (job.status === 'DONE' && job.expiresAt <= now) : false
      const status = job ? (expired ? 'EXPIRED' : (job.status as keyof typeof EXPORT_STATUS_LABEL)) : null
      return {
        id: pack.id,
        generatedAt: pack.generatedAt.toISOString(),
        generatedBy: nameOrFormer(people, pack.generatedBy),
        lineCount: pack.lineCount,
        exportJobId: pack.exportJobId,
        exportStatus: status,
        exportStatusLabel: status ? (EXPORT_STATUS_LABEL[status] ?? status) : null,
        // 导出文件只有发起人自己能下载，在导出中心里取
        downloadable: Boolean(job && status === 'DONE' && job.fileKey && job.requestedBy === context.userId),
      }
    })
    return {
      case: caseRow(row, names),
      basis: RULE_BASIS[rule] ?? OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode,
      evidence: evidenceOf(row.evidenceRefsJson),
      attachments: files,
      records: matched,
      packs: packRows,
      nextStatuses: nextCaseStatuses(row.status as CaseStatus),
      canWrite: hasPermission(context.permissions, REIMBURSEMENTS_WRITE),
      supportCases: await this.support.linkedView(context, scope, row),
      freshness,
    }
  }
}
