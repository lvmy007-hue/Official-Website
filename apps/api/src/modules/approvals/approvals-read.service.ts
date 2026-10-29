import { Injectable } from '@nestjs/common'
import {
  APPROVAL_REQUEST_STATUS_LABEL,
  APPROVAL_TYPE_LABEL,
  ApprovalListQuerySchema,
  approvalDetailPath,
  summaryItems,
  type ApprovalListResponse,
  type ApprovalRow,
  type ApprovalStatus,
  type ApprovalType,
} from '@nova/api-contracts'
import type { ApprovalRequest, Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { FORMER_MEMBER_LABEL, memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'

const SORT = { field: 'createdAt', dir: 'desc' } as const
const NOTE_EMPTY: Record<string, string> = {
  TODO: '没有需要你审批的单据',
  SENT: '你还没有发起过需要审批的单据',
  CC: '没有抄送给你的单据',
  DONE: '你还没有处理过审批',
}

export type ApprovalRecord = ApprovalRequest

export const typeOf = (value: string): ApprovalType => (value in APPROVAL_TYPE_LABEL ? (value as ApprovalType) : 'FINANCE_POLICY')
export const statusOf = (value: string): ApprovalStatus => (value in APPROVAL_REQUEST_STATUS_LABEL ? (value as ApprovalStatus) : 'PENDING')

/** 只与当前用户有关的单据：审批人、发起人、抄送人、处理人。 */
export const relatedTo = (userId: string): Prisma.ApprovalRequestWhereInput => ({
  OR: [{ approverIds: { has: userId } }, { requesterId: userId }, { ccIds: { has: userId } }, { decidedBy: userId }],
})

export async function rowsOf(prisma: PrismaService, tenantId: string, userId: string, records: readonly ApprovalRecord[]): Promise<ApprovalRow[]> {
  const names = await memberNames(
    prisma,
    tenantId,
    records.flatMap(row => [row.requesterId, row.decidedBy, ...row.approverIds, ...row.ccIds]),
  )
  const nameOf = (id: string) => names.get(id) ?? FORMER_MEMBER_LABEL
  return records.map(row => {
    const status = statusOf(row.status)
    const type = typeOf(row.type)
    const isRequester = row.requesterId === userId
    return {
      id: row.id,
      type,
      typeLabel: APPROVAL_TYPE_LABEL[type],
      title: row.title,
      objectType: row.objectType,
      objectId: row.objectId,
      status,
      statusLabel: APPROVAL_REQUEST_STATUS_LABEL[status],
      summary: summaryItems(row.summary),
      requesterId: row.requesterId,
      requesterName: nameOf(row.requesterId),
      approverNames: row.approverIds.map(nameOf),
      ccNames: row.ccIds.map(nameOf),
      decidedByName: row.decidedBy ? nameOf(row.decidedBy) : null,
      decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
      comment: row.comment,
      createdAt: row.createdAt.toISOString(),
      version: row.version,
      // 关账审批里发起检查的人不能审批，也没有撤回（重新检查会作废旧审批）；其他类型发起人可撤回
      canDecide: status === 'PENDING' && (row.approverIds.includes(userId) || (isRequester && type !== 'PERIOD_CLOSE')),
      isRequester,
      detailPath: approvalDetailPath(row.type, row.objectType, row.objectId),
    }
  })
}

// 审批收件箱列表（P6-27，freeze/api.md GET /approvals）：只含与当前用户有关的单据（审批人、发起人、抄送人、处理人），按企业隔离；
// 查看只需要登录并属于企业；处理时才沿用各单据原模块的审批权限（见 approvals-decision.service.ts）。游标分页，按创建时间倒序。
@Injectable()
export class ApprovalsReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: unknown): Promise<ApprovalListResponse> {
    const context = await this.context.resolve(req)
    const query = ApprovalListQuerySchema.parse(rawQuery)
    const { tenantId, userId } = context
    const boxWhere: Record<typeof query.box, Prisma.ApprovalRequestWhereInput> = {
      TODO: { approverIds: { has: userId } },
      SENT: { requesterId: userId },
      CC: { ccIds: { has: userId } },
      DONE: { decidedBy: userId },
    }
    const where: Prisma.ApprovalRequestWhereInput = { tenantId, ...boxWhere[query.box], status: query.state === 'PENDING' ? 'PENDING' : { not: 'PENDING' } }
    const binding = bindingOf(tenantId, { userId, box: query.box, state: query.state })
    const pending = (extra: Prisma.ApprovalRequestWhereInput) => this.prisma.approvalRequest.count({ where: { tenantId, status: 'PENDING', ...extra } })
    const [rows, todoPending, sentPending, ccPending] = await Promise.all([
      this.prisma.approvalRequest.findMany({
        where: { AND: [where, this.cursor.after(query.cursor, SORT, binding) as Prisma.ApprovalRequestWhereInput] },
        orderBy: this.cursor.orderBy(SORT),
        take: query.limit + 1,
      }),
      pending(boxWhere.TODO),
      pending(boxWhere.SENT),
      pending(boxWhere.CC),
    ])
    const page = this.cursor.page(rows, { pageSize: query.limit, sort: SORT, binding })
    const items = await rowsOf(this.prisma, tenantId, userId, page.items)
    return {
      state: items.length > 0 ? 'OK' : 'NO_DATA',
      note: items.length > 0 ? null : query.state === 'PENDING' ? NOTE_EMPTY[query.box] : '没有已处理的记录',
      box: query.box,
      filter: query.state,
      items,
      counts: { todoPending, sentPending, ccPending },
      pageInfo: page.pageInfo,
    }
  }
}
