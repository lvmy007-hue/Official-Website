import { Injectable } from '@nestjs/common'
import { SUPPORT_READ, supportStatusLabel, type PolicyIssueSupportView, type SupportLinkView } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { CASE_SELECT, CONTACT_SELECT, caseRow, contactRow, supportSync } from './support-common'

const RECENT_CONTACTS = 5
const ISSUE_CASES = 5
/** 问题编号太短（或是按内容生成的编号）时，案件主题里的“包含”没有意义，不做主题匹配。 */
const MIN_SUBJECT_MATCH_LENGTH = 6

// 赔付案件详情里的“关联的亚马逊支持案件”（P2b-04）：赔付案件回填了亚马逊案件编号，就在这里显示同步下来的案件与最近几条沟通。
// 状态必须说清楚：没权限、没回填编号、支持接口没同步、同步了但没找到——不能混成“没有”。
@Injectable()
export class SupportLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async linkedView(
    who: { tenantId: string; permissions: readonly string[] },
    scope: ResolvedScope,
    reimbursement: { id: string; caseNo: string; sellerAccountId: string; amazonCaseId: string | null },
  ): Promise<SupportLinkView> {
    if (!hasPermission(who.permissions, SUPPORT_READ)) return { state: 'RESTRICTED', note: '需要“支持案件”读取权限才能查看关联的亚马逊支持案件' }
    const amazonCaseId = reimbursement.amazonCaseId?.trim()
    if (!amazonCaseId) return { state: 'NO_ID', note: '这个赔付案件还没有回填亚马逊案件编号；在卖家后台提交案件后，把案件编号回填到这里即可关联' }
    const row = await this.prisma.supportCase.findFirst({
      where: { tenantId: who.tenantId, sellerAccountId: reimbursement.sellerAccountId, caseId: amazonCaseId },
      select: CASE_SELECT,
    })
    if (!row) {
      // 以这个赔付案件所在店铺的同步状态为准（不是成员范围内最差的店铺）
      const { sync } = await supportSync(this.prisma, who.tenantId, { ...scope, unrestricted: false, sellerAccountIds: [reimbursement.sellerAccountId] })
      if (sync.rolePending) return { state: 'NOT_CONNECTED', note: '支持案件同步需要亚马逊批准“卖家支持”受限角色，当前未授权；案件编号已回填，仍可手工查看' }
      if (sync.status === 'NORMAL' || sync.status === 'DELAYED') return { state: 'NOT_FOUND', note: `支持案件 ${amazonCaseId} 暂未同步到；可能编号有误，或案件较新，下次同步后再看` }
      return { state: 'NOT_CONNECTED', note: sync.errorMessage ?? '支持案件尚未同步，暂时无法显示案件进展；案件编号已回填，仍可手工查看' }
    }
    const contacts = await this.prisma.supportContact.findMany({
      where: { tenantId: who.tenantId, supportCaseId: row.id },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: RECENT_CONTACTS,
      select: CONTACT_SELECT,
    })
    return { state: 'OK', case: caseRow(row, { id: reimbursement.id, caseNo: reimbursement.caseNo }), contacts: contacts.reverse().map(contactRow) }
  }

  /**
   * 账户健康里政策问题关联的支持案件（P5-02）：手工填写的案件编号精确匹配；案件主题里包含问题编号的也算关联（标注“主题匹配”）。
   * 状态说清楚：没有支持案件读取权限、没有关联到、支持接口没同步或未授权——不混成“没有”。
   */
  async policyIssueView(
    who: { tenantId: string; permissions: readonly string[] },
    scope: ResolvedScope,
    issue: { issueId: string; sellerAccountId: string; amazonCaseId: string | null },
  ): Promise<PolicyIssueSupportView> {
    if (!hasPermission(who.permissions, SUPPORT_READ)) return { state: 'RESTRICTED', note: '需要“支持案件”读取权限才能查看关联的亚马逊支持案件', cases: [] }
    const amazonCaseId = issue.amazonCaseId?.trim() || null
    const subjectMatch = !issue.issueId.startsWith('h:') && issue.issueId.length >= MIN_SUBJECT_MATCH_LENGTH
    const conditions = [...(amazonCaseId ? [{ caseId: amazonCaseId }] : []), ...(subjectMatch ? [{ subject: { contains: issue.issueId, mode: 'insensitive' as const } }] : [])]
    const rows =
      conditions.length === 0
        ? []
        : await this.prisma.supportCase.findMany({
            where: { tenantId: who.tenantId, sellerAccountId: issue.sellerAccountId, OR: conditions },
            select: { id: true, caseId: true, subject: true, status: true, amazonUpdatedAt: true },
            orderBy: [{ amazonUpdatedAt: 'desc' }, { id: 'asc' }],
            take: ISSUE_CASES,
          })
    if (rows.length > 0) {
      return {
        state: 'OK',
        note: null,
        cases: rows.map(row => ({
          id: row.id,
          caseId: row.caseId,
          subject: row.subject,
          statusLabel: supportStatusLabel(row.status),
          updatedAt: row.amazonUpdatedAt.toISOString(),
          via: amazonCaseId && row.caseId === amazonCaseId ? ('MANUAL' as const) : ('SUBJECT' as const),
        })),
      }
    }
    const { sync } = await supportSync(this.prisma, who.tenantId, { ...scope, unrestricted: false, sellerAccountIds: [issue.sellerAccountId] })
    if (sync.rolePending) return { state: 'NOT_CONNECTED', note: '支持案件同步需要亚马逊批准“卖家支持”受限角色，当前未授权；填写的案件编号会保留，仍可手工查看', cases: [] }
    if (sync.status === 'NORMAL' || sync.status === 'DELAYED')
      return {
        state: 'NONE',
        note: amazonCaseId ? `支持案件 ${amazonCaseId} 暂未同步到；可能编号有误，或案件较新，下次同步后再看` : '没有关联的支持案件；在卖家后台提交申诉后，把案件编号填到这个问题上即可关联',
        cases: [],
      }
    return { state: 'NOT_CONNECTED', note: sync.errorMessage ?? '支持案件尚未同步，暂时无法显示关联案件；填写的案件编号会保留', cases: [] }
  }
}
