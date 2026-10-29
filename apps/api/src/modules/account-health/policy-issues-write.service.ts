import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  ACCOUNT_HEALTH_ACTIONS,
  ACCOUNT_HEALTH_HANDLE,
  ACCOUNT_HEALTH_READ,
  POLICY_HANDLING_STATUS_LABEL,
  PolicyIssueUpdateBodySchema,
  entityDetailPath,
  type PolicyHandlingStatus,
  type PolicyIssueRow,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { NotifyService } from '../notifications'
import { ISSUE_SELECT, issueRow, type IssueRecord } from './account-health-common'

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const handlingText = (value: string) => POLICY_HANDLING_STATUS_LABEL[value as PolicyHandlingStatus] ?? value

/**
 * 处理政策合规问题：指定负责人、改处理状态、写备注、填写关联的亚马逊案件编号（09 章 9.2）。
 * 只改本系统里的处理信息，不调用亚马逊，也不会把问题标为“已解决”（解决状态只由报告决定）。
 * 版本号做乐观锁；一次修改在一个事务里写：问题 + 处理记录（时间线）+ 审计 + 通知新负责人。权限沿用预警处理（alerts.handle），同时要求能读账户健康。
 */
@Injectable()
export class PolicyIssuesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly notify: NotifyService,
  ) {}

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<PolicyIssueRow> {
    const { context, scope } = await this.context.authorizeScoped(req, ACCOUNT_HEALTH_HANDLE, {})
    this.context.require(context, ACCOUNT_HEALTH_READ)
    const body = PolicyIssueUpdateBodySchema.parse(rawBody)
    if (!ID_PATTERN.test(id)) throw appError('RESOURCE_NOT_FOUND', '政策问题不存在')
    const tenantId = context.tenantId
    const current = await this.prisma.policyIssue.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, select: { ...ISSUE_SELECT, sellerAccount: { select: { displayName: true } } } })
    if (!current) throw appError('RESOURCE_NOT_FOUND', '政策问题不存在')
    if (body.ownerUserId) {
      const member = await this.prisma.membership.findFirst({ where: { tenantId, userId: body.ownerUserId, status: 'ACTIVE' }, select: { userId: true } })
      if (!member) throw appError('VALIDATION_FAILED', '负责人不是企业的在职成员', { fieldErrors: { ownerUserId: ['请选择企业内的在职成员'] } })
    }
    const next = {
      ownerUserId: body.ownerUserId === undefined ? current.ownerUserId : body.ownerUserId,
      handlingStatus: body.handlingStatus ?? current.handlingStatus,
      handlingNote: body.handlingNote === undefined ? current.handlingNote : body.handlingNote || null,
      amazonCaseId: body.amazonCaseId === undefined ? current.amazonCaseId : body.amazonCaseId || null,
    }
    const changed = {
      owner: next.ownerUserId !== current.ownerUserId,
      status: next.handlingStatus !== current.handlingStatus,
      note: next.handlingNote !== current.handlingNote,
      caseId: next.amazonCaseId !== current.amazonCaseId,
    }
    const names = await memberNames(this.prisma, tenantId, [current.ownerUserId, next.ownerUserId])
    const row = (record: IssueRecord, ownerId: string | null) => issueRow(record, current.sellerAccount.displayName, ownerId ? (names.get(ownerId) ?? null) : null)
    // 什么都没变：不写库、不加版本号，直接返回当前内容
    if (!changed.owner && !changed.status && !changed.note && !changed.caseId) return row(current, current.ownerUserId)
    const parts = [
      changed.owner
        ? `负责人：${current.ownerUserId ? (names.get(current.ownerUserId) ?? '已离开的成员') : '（无）'} → ${next.ownerUserId ? (names.get(next.ownerUserId) ?? '成员') : '（无）'}`
        : null,
      changed.status ? `处理状态：${handlingText(current.handlingStatus)} → ${handlingText(next.handlingStatus)}` : null,
      changed.note ? (next.handlingNote ? '更新了处理备注' : '清空了处理备注') : null,
      changed.caseId ? `关联案件编号：${current.amazonCaseId ?? '（无）'} → ${next.amazonCaseId ?? '（无）'}` : null,
    ].filter((part): part is string => part !== null)
    const saved = await this.prisma.$transaction(async tx => {
      const record = await updateWithVersion(tx.policyIssue, { id, tenantId }, body.version, next, { label: '政策问题', select: ISSUE_SELECT })
      await tx.entityEvent.create({
        data: {
          tenantId,
          sellerAccountId: current.sellerAccountId,
          entityType: 'POLICY_ISSUE',
          entityId: id,
          kind: 'manual',
          occurredAt: new Date(),
          title: parts.join('；'),
          actorKind: 'USER',
          actorId: context.userId,
          sourceRef: `policy-issue:${randomUUID()}`,
          detailJson: { changed } as Prisma.InputJsonValue,
        },
      })
      await this.audit.record(
        req,
        {
          action: ACCOUNT_HEALTH_ACTIONS.issueUpdated,
          resourceType: 'PolicyIssue',
          resourceId: id,
          before: { ownerUserId: current.ownerUserId, handlingStatus: current.handlingStatus, amazonCaseId: current.amazonCaseId, version: current.version },
          after: { ownerUserId: next.ownerUserId, handlingStatus: next.handlingStatus, amazonCaseId: next.amazonCaseId, version: record.version },
        },
        { client: tx },
      )
      if (changed.owner && next.ownerUserId && next.ownerUserId !== context.userId)
        await this.notify.toUsers(
          tenantId,
          [next.ownerUserId],
          { kind: 'WORK_ASSIGNED', title: '有一条政策合规问题分配给你', body: current.title, link: entityDetailPath('POLICY_ISSUE', id) ?? undefined, severity: 'INFO' },
          tx,
        )
      return record
    })
    return row(saved as IssueRecord, next.ownerUserId)
  }
}
