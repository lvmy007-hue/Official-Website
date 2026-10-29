import { Injectable } from '@nestjs/common'
import { ACCOUNT_HEALTH_READ, type PolicyIssueDetail } from '@nova/api-contracts'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { SupportLinkService } from '../support'
import { ISSUE_SELECT, issueRow } from './account-health-common'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const TIMELINE_LIMIT = 50
const OWNER_LIMIT = 200

/** 政策合规问题详情：问题本身、处理记录时间线、关联的支持案件、可指定的负责人。看不到的店铺的问题按“不存在”处理。 */
@Injectable()
export class PolicyIssuesDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly support: SupportLinkService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<PolicyIssueDetail> {
    const { context, scope } = await this.context.authorizeScoped(req, ACCOUNT_HEALTH_READ, {})
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '政策问题不存在')
    const tenantId = context.tenantId
    const row = await this.prisma.policyIssue.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, select: { ...ISSUE_SELECT, sellerAccount: { select: { displayName: true } } } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '政策问题不存在')
    const [events, members, support] = await Promise.all([
      this.prisma.entityEvent.findMany({
        where: { tenantId, entityType: 'POLICY_ISSUE', entityId: id },
        select: { id: true, occurredAt: true, title: true, actorId: true },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: TIMELINE_LIMIT,
      }),
      this.prisma.membership.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { userId: true, user: { select: { displayName: true, email: true } } },
        orderBy: { userId: 'asc' },
        take: OWNER_LIMIT,
      }),
      this.support.policyIssueView(context, scope, { issueId: row.issueId, sellerAccountId: row.sellerAccountId, amazonCaseId: row.amazonCaseId }),
    ])
    const names = await memberNames(this.prisma, tenantId, [row.ownerUserId, ...events.map(event => event.actorId)])
    return {
      issue: { ...issueRow(row, row.sellerAccount.displayName, row.ownerUserId ? (names.get(row.ownerUserId) ?? null) : null), handlingNote: row.handlingNote },
      timeline: events.map(event => ({ id: event.id, at: event.occurredAt.toISOString(), title: event.title, actorName: event.actorId ? nameOrFormer(names, event.actorId) : null })),
      support,
      owners: members.map(member => ({ id: member.userId, name: member.user.displayName || member.user.email })),
    }
  }
}
