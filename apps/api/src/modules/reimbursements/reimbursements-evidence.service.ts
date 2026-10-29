import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  CASE_STATUS_LABEL,
  EVIDENCE_EXPORT_KIND,
  EVIDENCE_MANIFEST_VERSION,
  OPPORTUNITY_RULE_LABEL,
  REIMBURSEMENTS_WRITE,
  RULE_BASIS,
  type CaseStatus,
  type EvidenceLine,
  type EvidenceManifest,
  type EvidencePackResult,
  type OpportunityRule,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { ExportsService } from '../exports'
import { AttachmentService } from '../procurement'
import { CASE_SELECT, ID_PATTERN, evidenceOf } from './reimbursements-common'
import { evidenceDetailLines } from './reimbursements-evidence-lines'

const MAX_LINES = 3000
const money = (value: { toString(): string } | null | undefined, currency: string | null) => (value === null || value === undefined ? '尚未填写' : `${value.toString()} ${currency ?? ''}`.trim())

// 赔付证据包（07 章 7.3）：把案件的识别依据、证据原始记录、附件清单、官方赔付匹配与处理时间线整理成一份清单，
// 清单当时就存下来（EvidencePack），导出文件按清单生成，走导出中心（保留 7 天），之后证据变化不影响已导出的包。
// 附件文件本身不打进导出文件（清单里列出文件名与上传人），需要提交给亚马逊时从案件页逐个下载。
@Injectable()
export class ReimbursementsEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly exportsService: ExportsService,
    private readonly attachments: AttachmentService,
  ) {}

  /** 案件在成员数据范围内才能操作它的附件：不在范围内与不存在一样返回 404。 */
  async assertCaseInScope(req: RequestWithContext, id: string, permission: string) {
    const { context, scope } = await this.context.authorizeScoped(req, permission, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const found = await this.prisma.reimbursementCase.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) }, select: { id: true } })
    if (!found) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
  }

  async generate(req: RequestWithContext, id: string): Promise<EvidencePackResult> {
    const { context, scope } = await this.context.authorizeScoped(req, REIMBURSEMENTS_WRITE, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const row = await this.prisma.reimbursementCase.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) }, select: CASE_SELECT })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '赔付案件不存在')
    const evidence = evidenceOf(row.evidenceRefsJson)
    const rule = row.ruleCode as OpportunityRule
    const status = row.status as CaseStatus
    const [files, records, events, details] = await Promise.all([
      this.attachments.list(context.tenantId, 'REIMBURSEMENT_CASE', id),
      this.prisma.reimbursementRecord.findMany({ where: { tenantId: context.tenantId, matchedCaseId: id }, orderBy: { approvedAt: 'asc' }, take: 500 }),
      this.prisma.entityEvent.findMany({ where: { tenantId: context.tenantId, entityType: 'REIMBURSEMENT_CASE', entityId: id }, orderBy: { occurredAt: 'asc' }, take: 500 }),
      evidenceDetailLines(this.prisma, context.tenantId, evidence),
    ])
    const lines: EvidenceLine[] = [
      { section: '案件', item: '案件编号', detail: row.caseNo, at: row.createdAt.toISOString() },
      { section: '案件', item: '机会类型', detail: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode, at: null },
      { section: '案件', item: '店铺 / SKU / 数量', detail: `${row.sellerAccount.displayName} / ${row.sku ?? '尚无记录'} / ${row.qty ?? '尚无记录'}`, at: null },
      { section: '案件', item: '应收金额', detail: money(row.expectedAmount, row.currency), at: null },
      { section: '案件', item: '案件状态', detail: CASE_STATUS_LABEL[status] ?? row.status, at: row.updatedAt.toISOString() },
      { section: '案件', item: '亚马逊案件编号', detail: row.amazonCaseId ?? '尚未回填', at: row.submittedAt?.toISOString() ?? null },
      { section: '识别依据', item: OPPORTUNITY_RULE_LABEL[rule] ?? row.ruleCode, detail: RULE_BASIS[rule] ?? '', at: null },
      ...evidence.map(item => ({ section: '证据引用', item: item.label, detail: `类型 ${item.kind}`, at: null })),
      ...details,
      ...files.map(file => ({
        section: '附件清单',
        item: file.fileName,
        detail: `${Math.max(1, Math.round(file.sizeBytes / 1024))} KB · 上传人 ${file.uploadedBy}（文件请在案件页下载）`,
        at: file.uploadedAt,
      })),
      ...records.map(record => ({
        section: '官方赔付明细',
        item: `赔付编号 ${record.reimbursementId} · ${record.reason || '无原因'}`,
        detail: `SKU ${record.sku}，数量 ${record.quantity}，金额 ${record.amount.toString()} ${record.currency}，匹配依据 ${record.matchBasis ?? '未匹配'}`,
        at: record.approvedAt.toISOString(),
      })),
      ...events.map(event => ({
        section: '处理时间线',
        item: event.title,
        detail: event.actorKind === 'USER' ? '人工操作' : event.actorKind === 'AMAZON' ? '来自官方赔付明细' : '系统',
        at: event.occurredAt.toISOString(),
      })),
    ].slice(0, MAX_LINES)
    const manifest: EvidenceManifest = { version: EVIDENCE_MANIFEST_VERSION, caseNo: row.caseNo, lines }
    const packId = randomUUID()
    await this.prisma.evidencePack.create({
      data: { id: packId, tenantId: context.tenantId, caseId: id, contentManifestJson: manifest as unknown as Prisma.InputJsonValue, lineCount: lines.length, generatedBy: context.userId },
    })
    try {
      const job = await this.exportsService.create(req, { kind: EVIDENCE_EXPORT_KIND, format: 'CSV', filters: { packId, storeIds: [row.sellerAccountId] }, filterSummary: `赔付证据包 ${row.caseNo}` })
      await this.prisma.$transaction(async tx => {
        await tx.evidencePack.updateMany({ where: { id: packId, tenantId: context.tenantId }, data: { exportJobId: job.id } })
        await this.audit.record(
          req,
          { action: 'REIMBURSEMENT_EVIDENCE_PACK_CREATED', resourceType: 'ReimbursementCase', resourceId: id, after: { packId, lineCount: lines.length, exportJobId: job.id } },
          { client: tx },
        )
      })
      return { packId, lineCount: lines.length, exportJobId: job.id }
    } catch (error) {
      // 导出任务没建成（没有导出权限、导出名额已满）：清单不留，避免出现下载不了的证据包
      await this.prisma.evidencePack.deleteMany({ where: { id: packId, tenantId: context.tenantId } })
      throw error
    }
  }
}
