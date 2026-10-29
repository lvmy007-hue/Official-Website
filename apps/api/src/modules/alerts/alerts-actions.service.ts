import { randomUUID } from 'node:crypto'
import { Injectable } from '@nestjs/common'
import {
  ALERTS_HANDLE,
  ALERT_CONCLUSION_LABEL,
  ALERT_STATUS_BY_CONCLUSION,
  ALERT_STATUS_LABEL,
  AlertAckBodySchema,
  AlertAssignBodySchema,
  AlertCloseBodySchema,
  AlertIgnoreBodySchema,
  WORK_DEFAULT_SLA_HOURS,
  entityDetailPath,
  type AlertActionResponse,
  type WorkSeverity,
} from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter } from '../../platform/write'
import { ContextService, storeWhere } from '../auth'
import { NotifyService } from '../notifications'
import { SettingsService } from '../settings'
import { ALERT_INCLUDE, OPEN_STATUSES, type AlertRow } from './alerts-common'

type Tx = Prisma.TransactionClient
const WORK_OPEN = ['PENDING', 'IN_PROGRESS']

// 预警的处理动作（09 章 9.1）：确认、忽略（必须原因）、分派、关闭（必须结论），都在同一个事务里：更新预警 + 同步关联待办 + 时间线事件 + 审计。
// 权限是 alerts.handle（预警中心是团队视图，不要求是待办负责人）；预警所属店铺必须在成员的数据范围内，否则按“不存在”处理。
// 并发保护靠状态条件更新（只有“新预警/处理中”能被处理，已被别人处理的返回 409）。
@Injectable()
export class AlertsActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
  ) {}

  private async load(req: RequestWithContext, id: string) {
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_HANDLE, {})
    const row = await this.prisma.alertInstance.findFirst({ where: { id, tenantId: context.tenantId, ...storeWhere(scope) }, include: ALERT_INCLUDE })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '预警不存在')
    return { context, row }
  }

  private assertOpen(row: AlertRow, what: string) {
    if (!OPEN_STATUSES.includes(row.status)) throw appError('CONFLICT', `这条预警已经是“${ALERT_STATUS_LABEL[row.status] ?? row.status}”，不能再${what}`)
  }

  private async assertActiveMember(tenantId: string, userId: string) {
    const member = await this.prisma.membership.findFirst({ where: { tenantId, userId, status: 'ACTIVE' }, select: { userId: true } })
    if (!member) throw appError('VALIDATION_FAILED', '分派对象不是企业的在职成员', { fieldErrors: { assigneeId: ['请选择企业内的在职成员'] } })
  }

  /** 预警与关联待办各记一条时间线事件（待办上的事件带 alert- 前缀的来源，预警详情不重复展示）。 */
  private async timeline(tx: Tx, tenantId: string, row: AlertRow, kind: string, title: string, actorId: string, detail?: Record<string, string | null>) {
    const base = { tenantId, occurredAt: new Date(), title, actorKind: 'USER', actorId, sourceRef: `alert-${kind}:${randomUUID()}`, detailJson: detail as Prisma.InputJsonValue | undefined }
    await tx.entityEvent.create({ data: { ...base, entityType: 'ALERT', entityId: row.id, kind: 'alert' } })
    if (row.workItemId) await tx.entityEvent.create({ data: { ...base, entityType: 'WORK_ITEM', entityId: row.workItemId, kind: 'workitem' } })
  }

  /** 把预警实例从“新预警/处理中”改成新状态；条件更新失败说明别人刚处理过。 */
  private async move(tx: Tx, tenantId: string, id: string, data: Prisma.AlertInstanceUpdateManyMutationInput) {
    const result = await tx.alertInstance.updateMany({ where: { id, tenantId, status: { in: OPEN_STATUSES } }, data })
    if (result.count === 0) throw appError('CONFLICT', '这条预警刚刚已被他人处理，请刷新后查看')
  }

  private async closeWork(tx: Tx, tenantId: string, row: AlertRow, data: { status: 'DONE' | 'CLOSED'; conclusion: string; note?: string; ignoreReason?: string; userId: string }) {
    if (!row.workItemId) return
    await tx.workItem.updateMany({
      where: { id: row.workItemId, tenantId, status: { in: WORK_OPEN } },
      data: {
        status: data.status,
        closeConclusion: data.conclusion,
        closeNote: data.note ?? null,
        ignoreReason: data.ignoreReason ?? null,
        closedAt: new Date(),
        closedBy: data.userId,
        version: { increment: 1 },
      },
    })
  }

  private response(id: string, status: string): AlertActionResponse {
    return { id, status, statusLabel: ALERT_STATUS_LABEL[status] ?? status }
  }

  async ack(req: RequestWithContext, id: string, rawBody: unknown): Promise<AlertActionResponse> {
    const { context, row } = await this.load(req, id)
    const body = AlertAckBodySchema.parse(rawBody ?? {})
    if (row.status !== 'NEW') throw appError('CONFLICT', '这条预警已经确认过或已结束')
    return this.prisma.$transaction(async tx => {
      await tx.alertInstance.updateMany({ where: { id, tenantId: context.tenantId, status: 'NEW' }, data: { status: 'ACKED' } }).then(result => {
        if (result.count === 0) throw appError('CONFLICT', '这条预警刚刚已被他人处理，请刷新后查看')
      })
      if (row.workItemId)
        await tx.workItem.updateMany({ where: { id: row.workItemId, tenantId: context.tenantId, status: 'PENDING' }, data: { status: 'IN_PROGRESS', ackAt: new Date(), version: { increment: 1 } } })
      await this.timeline(tx, context.tenantId, row, 'ack', body.note ? `确认，开始处理（${body.note}）` : '确认，开始处理', context.userId)
      await this.audit.record(
        req,
        { action: 'ALERT_ACKED', resourceType: 'AlertInstance', resourceId: id, before: { status: row.status }, after: { status: 'ACKED' }, detail: { note: body.note ?? null } },
        { client: tx },
      )
      return this.response(id, 'ACKED')
    })
  }

  async ignore(req: RequestWithContext, id: string, rawBody: unknown): Promise<AlertActionResponse> {
    const { context, row } = await this.load(req, id)
    const body = AlertIgnoreBodySchema.parse(rawBody)
    this.assertOpen(row, '忽略')
    return this.prisma.$transaction(async tx => {
      await this.move(tx, context.tenantId, id, { status: 'IGNORED', resolvedAt: new Date(), closeConclusion: 'IGNORED', closeNote: body.reason, closedBy: context.userId })
      await this.closeWork(tx, context.tenantId, row, { status: 'CLOSED', conclusion: 'IGNORED', ignoreReason: body.reason, userId: context.userId })
      await this.timeline(tx, context.tenantId, row, 'ignore', `忽略（${body.reason}）`, context.userId)
      await this.audit.record(
        req,
        { action: 'ALERT_IGNORED', resourceType: 'AlertInstance', resourceId: id, before: { status: row.status }, after: { status: 'IGNORED', closeConclusion: 'IGNORED' }, reason: body.reason },
        { client: tx },
      )
      return this.response(id, 'IGNORED')
    })
  }

  async close(req: RequestWithContext, id: string, rawBody: unknown): Promise<AlertActionResponse> {
    const { context, row } = await this.load(req, id)
    const body = AlertCloseBodySchema.parse(rawBody)
    this.assertOpen(row, '关闭')
    const status = ALERT_STATUS_BY_CONCLUSION[body.conclusion]
    return this.prisma.$transaction(async tx => {
      await this.move(tx, context.tenantId, id, { status, resolvedAt: new Date(), closeConclusion: body.conclusion, closeNote: body.note ?? null, closedBy: context.userId })
      await this.closeWork(tx, context.tenantId, row, { status: body.conclusion === 'HANDLED' ? 'DONE' : 'CLOSED', conclusion: body.conclusion, note: body.note, userId: context.userId })
      const text = ALERT_CONCLUSION_LABEL[body.conclusion]
      await this.timeline(tx, context.tenantId, row, 'close', `关闭：${text}${body.note ? `（${body.note}）` : ''}`, context.userId)
      await this.audit.record(
        req,
        {
          action: 'ALERT_CLOSED',
          resourceType: 'AlertInstance',
          resourceId: id,
          before: { status: row.status },
          after: { status, closeConclusion: body.conclusion },
          detail: { note: body.note ?? null },
        },
        { client: tx },
      )
      return this.response(id, status)
    })
  }

  async assign(req: RequestWithContext, id: string, rawBody: unknown): Promise<AlertActionResponse> {
    const { context, row } = await this.load(req, id)
    const body = AlertAssignBodySchema.parse(rawBody)
    this.assertOpen(row, '分派')
    await this.assertActiveMember(context.tenantId, body.assigneeId)
    const sla = (await this.settings.get(context.tenantId, 'work.sla.hours')).value as Record<WorkSeverity, number>
    return this.prisma.$transaction(async tx => {
      const work = row.workItemId ? await tx.workItem.findFirst({ where: { id: row.workItemId, tenantId: context.tenantId }, select: { id: true, ownerId: true, status: true } }) : null
      let workItemId = work?.id ?? null
      if (work && WORK_OPEN.includes(work.status)) {
        await tx.workItem.update({ where: { id: work.id }, data: { ownerId: body.assigneeId, status: 'PENDING', ackAt: null, version: { increment: 1 } } })
      } else {
        // 没有可分派的待办（生成预警时企业没有可指派的成员，或待办已被关闭）：新建一条
        const severity = row.severity === 'CRITICAL' || row.severity === 'INFO' ? row.severity : 'WARNING'
        const created = await tx.workItem.create({
          data: {
            tenantId: context.tenantId,
            sellerAccountId: row.sellerAccountId,
            title: row.title ?? row.rule.name,
            kind: row.rule.domain,
            source: 'ALERT',
            severity,
            priority: severity === 'CRITICAL' ? 'URGENT' : severity === 'WARNING' ? 'HIGH' : 'NORMAL',
            dueAt: new Date(Date.now() + (sla[severity] ?? WORK_DEFAULT_SLA_HOURS[severity]) * 3_600_000),
            sourceAlertId: id,
            ruleCode: row.rule.code,
            entityType: row.entityType,
            entityId: row.entityId,
            entityLabel: row.entityLabel,
            suggestedAction: row.suggestedAction,
            ...(row.impactMin !== null || row.impactMax !== null ? { impactMin: row.impactMin, impactMax: row.impactMax, currency: row.currency ?? 'USD' } : {}),
            ownerId: body.assigneeId,
            createdBy: context.userId,
          },
        })
        await tx.alertInstance.update({ where: { id }, data: { workItemId: created.id } })
        workItemId = created.id
      }
      await tx.assignment.upsert({
        where: { workItemId_assigneeId: { workItemId: workItemId as string, assigneeId: body.assigneeId } },
        create: { tenantId: context.tenantId, workItemId: workItemId as string, assigneeId: body.assigneeId, assignedBy: context.userId },
        update: { assignedBy: context.userId, assignedAt: new Date(), acceptedAt: null },
      })
      const names = await tx.membership.findFirst({ where: { tenantId: context.tenantId, userId: body.assigneeId }, select: { user: { select: { displayName: true, email: true } } } })
      const who = names?.user.displayName || names?.user.email || '成员'
      await this.timeline(tx, context.tenantId, { ...row, workItemId }, 'assign', body.note ? `分派给 ${who}（${body.note}）` : `分派给 ${who}`, context.userId, { assigneeId: body.assigneeId })
      await this.audit.record(
        req,
        {
          action: 'ALERT_ASSIGNED',
          resourceType: 'AlertInstance',
          resourceId: id,
          before: { ownerId: work?.ownerId ?? null },
          after: { ownerId: body.assigneeId },
          detail: { note: body.note ?? null },
        },
        { client: tx },
      )
      if (body.assigneeId !== context.userId)
        await this.notify.toUsers(
          context.tenantId,
          [body.assigneeId],
          {
            kind: 'WORK_ASSIGNED',
            title: '有一条预警分派给你',
            body: row.title ?? row.rule.name,
            link: entityDetailPath('ALERT', id) ?? undefined,
            severity: row.severity === 'CRITICAL' ? 'CRITICAL' : 'INFO',
          },
          tx,
        )
      return this.response(id, row.status)
    })
  }
}
