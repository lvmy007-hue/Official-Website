import { Injectable } from '@nestjs/common'
import { APPROVAL_APPROVER_LIMIT, type ApprovalStatus, type ApprovalSummaryItem, type ApprovalType } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { NotifyService, type NotifyClient } from '../notifications'

/** 登记与回写用的客户端：事务客户端或普通客户端都可以。 */
export type ApprovalDb = Pick<Prisma.TransactionClient, 'approvalRequest'> & NotifyClient

export interface ApprovalRegistration {
  tenantId: string
  type: ApprovalType
  /** 对象类型；同一类型下细分用冒号，例如 `MetricVersion:BUSINESS_RULES`。 */
  objectType: string
  objectId: string
  title: string
  summary: readonly ApprovalSummaryItem[]
  requesterId: string
  /** 有这项权限的在职成员（不含发起人）登记为审批人。 */
  approverPermission: string
  ccIds?: readonly string[]
}

export interface ApprovalResolution {
  tenantId: string
  type: ApprovalType
  objectType: string
  objectId: string
  outcome: Exclude<ApprovalStatus, 'PENDING'>
  userId: string
  comment?: string | null
  now?: Date
}

// 审批记录的登记与回写（P6-27）：各模块在“提交审批”的同一个事务里登记，在“审批、驳回、撤回”的同一个事务里回写。
// 各模块自己的状态仍是事实来源；这里只做统一入口。登记与回写都必须传入调用方的事务客户端，保证两边同时成功或同时失败。
@Injectable()
export class ApprovalsRegistryService {
  constructor(private readonly notify: NotifyService) {}

  /** 登记一条待处理的审批；同一对象同一类型已有待处理的，更新其内容与审批人（例如关账检查重新做了一遍）。 */
  async register(db: ApprovalDb, input: ApprovalRegistration): Promise<{ id: string }> {
    const holders = await this.notify.holdersOf(input.tenantId, input.approverPermission, db)
    const approverIds = holders.filter(id => id !== input.requesterId).slice(0, APPROVAL_APPROVER_LIMIT)
    const ccIds = [...new Set(input.ccIds ?? [])].filter(id => id !== input.requesterId && !approverIds.includes(id)).slice(0, APPROVAL_APPROVER_LIMIT)
    const summary = input.summary as unknown as Prisma.InputJsonValue
    const title = input.title.slice(0, 200)
    const where = { tenantId: input.tenantId, type: input.type, objectType: input.objectType, objectId: input.objectId, status: 'PENDING' }
    const pending = await db.approvalRequest.findFirst({ where, select: { id: true } })
    if (pending) {
      await db.approvalRequest.update({ where: { id: pending.id }, data: { title, summary, requesterId: input.requesterId, approverIds, ccIds, version: { increment: 1 } } })
      return { id: pending.id }
    }
    const row = await db.approvalRequest.create({
      data: { tenantId: input.tenantId, type: input.type, objectType: input.objectType, objectId: input.objectId, title, summary, requesterId: input.requesterId, approverIds, ccIds },
      select: { id: true },
    })
    return row
  }

  /** 回写：把该对象待处理的审批置为通过、驳回或撤回；没有登记（接入前提交的旧单据）时什么也不做。返回改了几条。 */
  async resolve(db: ApprovalDb, input: ApprovalResolution): Promise<number> {
    const result = await db.approvalRequest.updateMany({
      where: { tenantId: input.tenantId, type: input.type, objectType: input.objectType, objectId: input.objectId, status: 'PENDING' },
      data: { status: input.outcome, decidedBy: input.userId, decidedAt: input.now ?? new Date(), comment: input.comment ? input.comment.slice(0, 500) : null, version: { increment: 1 } },
    })
    return result.count
  }
}
