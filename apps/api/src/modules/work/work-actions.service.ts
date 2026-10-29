import { Injectable } from '@nestjs/common'
import {
  ALERT_STATUS_BY_CONCLUSION,
  WORK_DEFER_MAX_DAYS,
  WorkItemAckBodySchema,
  WorkItemAssignBodySchema,
  WorkItemBatchBodySchema,
  WorkItemCloseBodySchema,
  WorkItemCreateBodySchema,
  WorkItemDeferBodySchema,
  WorkItemIgnoreBodySchema,
  ENTITY_TYPES,
  entityDetailPath,
  type WorkSeverity,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { ApiContext, appError, AppError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { NotifyService } from '../notifications'
import { SettingsService } from '../settings'
import { WorkQueryService } from './work-query.service'

type Tx = Prisma.TransactionClient
const OPEN = ['PENDING', 'IN_PROGRESS']
const LABEL = '待办'

// 待办的处理动作（P1-28-3）：每个动作 = 权限 + 状态检查 + 乐观锁更新 + 时间线事件 + 审计，同一个事务提交。
// 处理类动作只允许负责人本人，或有“指派待办”权限的成员（上级）操作。
@Injectable()
export class WorkActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
    private readonly notify: NotifyService,
    private readonly settings: SettingsService,
    private readonly query: WorkQueryService,
  ) {}

  private async activeMember(tenantId: string, userId: string) {
    const member = await this.prisma.membership.findFirst({ where: { tenantId, userId, status: 'ACTIVE' }, select: { userId: true } })
    if (!member) throw appError('VALIDATION_FAILED', '指派对象不是企业的在职成员', { fieldErrors: { assigneeId: ['请选择企业内的在职成员'] } })
  }

  /** 读取待办并确认当前成员有权处理它：负责人本人，或有 workitem.assign。 */
  private async handleable(context: ApiContext, id: string) {
    const row = await this.query.visibleItem(context, id)
    if (row.ownerId !== context.userId && !hasPermission(context.permissions, 'workitem.assign')) throw appError('TENANT_ACCESS_DENIED', '只有待办负责人或有指派权限的成员可以处理这条待办')
    return row
  }

  private open(row: { status: string }, what: string) {
    if (!OPEN.includes(row.status)) throw appError('CONFLICT', `这条待办已经${row.status === 'DONE' ? '完成' : '关闭'}，不能再${what}`)
  }

  private async timeline(tx: Tx, tenantId: string, id: string, version: number, kind: string, title: string, actorId: string, detail?: Record<string, string | number | null>) {
    await tx.entityEvent.create({
      data: {
        tenantId,
        entityType: 'WORK_ITEM',
        entityId: id,
        kind: 'workitem',
        occurredAt: new Date(),
        title,
        detailJson: detail as Prisma.InputJsonValue | undefined,
        actorKind: 'USER',
        actorId,
        sourceRef: `${kind}:${version}`,
      },
    })
  }

  /** 预警来源的待办被处理时，同步预警实例的状态。 */
  private async syncAlert(tx: Tx, tenantId: string, alertId: string | null, status: string, closed?: { conclusion: string; note?: string | null; userId: string }) {
    if (!alertId) return
    // 关闭结论、备注与处理人一并写到预警实例上（规则质量统计的误报率、处理时长用）
    const close = closed ? { closeConclusion: closed.conclusion, closeNote: closed.note ?? null, closedBy: closed.userId } : {}
    await tx.alertInstance.updateMany({ where: { id: alertId, tenantId }, data: { status, ...(status === 'ACKED' ? {} : { resolvedAt: new Date() }), ...close } })
  }

  async create(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.assign')
    const body = WorkItemCreateBodySchema.parse(rawBody)
    if (body.entityType && !ENTITY_TYPES.includes(body.entityType)) throw appError('VALIDATION_FAILED', '不支持的关联对象类型', { fieldErrors: { entityType: ['不支持的关联对象类型'] } })
    const ownerId = body.ownerId ?? context.userId
    if (ownerId !== context.userId) await this.activeMember(context.tenantId, ownerId)
    const sla = (await this.settings.get(context.tenantId, 'work.sla.hours')).value
    const dueAt = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + sla[body.severity as WorkSeverity] * 3_600_000)
    return this.prisma.$transaction(async tx => {
      const row = await tx.workItem.create({
        data: {
          tenantId: context.tenantId,
          title: body.title,
          kind: 'MANUAL',
          source: 'MANUAL',
          priority: body.priority,
          severity: body.severity,
          dueAt,
          detail: body.detail,
          entityType: body.entityType,
          entityId: body.entityId,
          entityLabel: body.entityLabel,
          suggestedAction: body.suggestedAction,
          ownerId,
          createdBy: context.userId,
        },
      })
      await tx.assignment.create({ data: { tenantId: context.tenantId, workItemId: row.id, assigneeId: ownerId, assignedBy: context.userId } })
      await this.timeline(tx, context.tenantId, row.id, row.version, 'created', '创建待办', context.userId)
      await this.audit.record(req, { action: 'WORK_ITEM_CREATED', resourceType: 'WorkItem', resourceId: row.id, after: { title: row.title, ownerId, severity: row.severity, dueAt } }, { client: tx })
      if (ownerId !== context.userId)
        await this.notify.toUsers(
          context.tenantId,
          [ownerId],
          {
            kind: 'WORK_ASSIGNED',
            title: '有一项新待办指派给你',
            body: row.title,
            link: entityDetailPath('WORK_ITEM', row.id) ?? undefined,
            severity: row.severity === 'CRITICAL' ? 'CRITICAL' : 'INFO',
          },
          tx,
        )
      return { id: row.id, version: row.version }
    })
  }

  async assign(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.assign')
    const body = WorkItemAssignBodySchema.parse(rawBody)
    const current = await this.query.visibleItem(context, id)
    this.open(current, '指派')
    await this.activeMember(context.tenantId, body.assigneeId)
    return this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.workItem, { id, tenantId: context.tenantId }, body.version, { ownerId: body.assigneeId, status: 'PENDING', ackAt: null }, { label: LABEL })
      await tx.assignment.upsert({
        where: { workItemId_assigneeId: { workItemId: id, assigneeId: body.assigneeId } },
        create: { tenantId: context.tenantId, workItemId: id, assigneeId: body.assigneeId, assignedBy: context.userId },
        update: { assignedBy: context.userId, assignedAt: new Date(), acceptedAt: null },
      })
      await this.timeline(tx, context.tenantId, id, row.version, 'assigned', body.note ? `转派待办（${body.note}）` : '转派待办', context.userId, { assigneeId: body.assigneeId })
      await this.audit.record(
        req,
        { action: 'WORK_ITEM_ASSIGNED', resourceType: 'WorkItem', resourceId: id, before: { ownerId: current.ownerId }, after: { ownerId: body.assigneeId }, detail: { note: body.note ?? null } },
        { client: tx },
      )
      if (body.assigneeId !== context.userId)
        await this.notify.toUsers(
          context.tenantId,
          [body.assigneeId],
          { kind: 'WORK_ASSIGNED', title: '有一项待办指派给你', body: row.title, link: entityDetailPath('WORK_ITEM', id) ?? undefined, severity: row.severity === 'CRITICAL' ? 'CRITICAL' : 'INFO' },
          tx,
        )
      return { id, version: row.version }
    })
  }

  async ack(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.handle')
    const { version } = WorkItemAckBodySchema.parse(rawBody)
    const current = await this.handleable(context, id)
    if (current.status !== 'PENDING') throw appError('CONFLICT', '这条待办已经确认过或已结束')
    return this.prisma.$transaction(async tx => {
      // 条件里不能带 status：更新成功后要按同一条件重新读取，带上旧状态会读不到刚更新的行（并发修改由版本号检测）
      const row = await updateWithVersion(tx.workItem, { id, tenantId: context.tenantId }, version, { status: 'IN_PROGRESS', ackAt: new Date() }, { label: LABEL })
      await this.timeline(tx, context.tenantId, id, row.version, 'ack', '确认，开始处理', context.userId)
      await this.syncAlert(tx, context.tenantId, current.sourceAlertId, 'ACKED')
      await this.audit.record(req, { action: 'WORK_ITEM_ACKED', resourceType: 'WorkItem', resourceId: id, before: { status: current.status }, after: { status: row.status } }, { client: tx })
      return { id, version: row.version, status: row.status }
    })
  }

  async ignore(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.handle')
    const body = WorkItemIgnoreBodySchema.parse(rawBody)
    const current = await this.handleable(context, id)
    this.open(current, '忽略')
    return this.prisma.$transaction(async tx => {
      const now = new Date()
      const row = await updateWithVersion(
        tx.workItem,
        { id, tenantId: context.tenantId },
        body.version,
        { status: 'CLOSED', closeConclusion: 'IGNORED', ignoreReason: body.reason, closedAt: now, closedBy: context.userId },
        { label: LABEL },
      )
      await this.timeline(tx, context.tenantId, id, row.version, 'ignored', `忽略（${body.reason}）`, context.userId)
      await this.syncAlert(tx, context.tenantId, current.sourceAlertId, ALERT_STATUS_BY_CONCLUSION.IGNORED, { conclusion: 'IGNORED', note: body.reason, userId: context.userId })
      await this.audit.record(
        req,
        { action: 'WORK_ITEM_IGNORED', resourceType: 'WorkItem', resourceId: id, before: { status: current.status }, after: { status: row.status, closeConclusion: 'IGNORED' }, reason: body.reason },
        { client: tx },
      )
      return { id, version: row.version, status: row.status }
    })
  }

  async close(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.handle')
    const body = WorkItemCloseBodySchema.parse(rawBody)
    const current = await this.handleable(context, id)
    this.open(current, '关闭')
    return this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(
        tx.workItem,
        { id, tenantId: context.tenantId },
        body.version,
        { status: body.conclusion === 'HANDLED' ? 'DONE' : 'CLOSED', closeConclusion: body.conclusion, closeNote: body.note, closedAt: new Date(), closedBy: context.userId },
        { label: LABEL },
      )
      const text = { HANDLED: '已处理', NOT_NEEDED: '无需处理', FALSE_POSITIVE: '误报' }[body.conclusion]
      await this.timeline(tx, context.tenantId, id, row.version, 'closed', `关闭：${text}${body.note ? `（${body.note}）` : ''}`, context.userId)
      await this.syncAlert(tx, context.tenantId, current.sourceAlertId, ALERT_STATUS_BY_CONCLUSION[body.conclusion], { conclusion: body.conclusion, note: body.note, userId: context.userId })
      await this.audit.record(
        req,
        {
          action: 'WORK_ITEM_CLOSED',
          resourceType: 'WorkItem',
          resourceId: id,
          before: { status: current.status },
          after: { status: row.status, closeConclusion: body.conclusion },
          detail: { note: body.note ?? null },
        },
        { client: tx },
      )
      return { id, version: row.version, status: row.status }
    })
  }

  async defer(req: RequestWithContext, id: string, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.handle')
    const body = WorkItemDeferBodySchema.parse(rawBody)
    const until = new Date(body.until)
    if (until.getTime() <= Date.now()) throw appError('VALIDATION_FAILED', '延期到的时间必须晚于现在', { fieldErrors: { until: ['必须晚于现在'] } })
    if (until.getTime() > Date.now() + WORK_DEFER_MAX_DAYS * 86_400_000)
      throw appError('VALIDATION_FAILED', `最长只能延期 ${WORK_DEFER_MAX_DAYS} 天`, { fieldErrors: { until: [`最长延期 ${WORK_DEFER_MAX_DAYS} 天`] } })
    const current = await this.handleable(context, id)
    this.open(current, '延期')
    return this.prisma.$transaction(async tx => {
      const row = await updateWithVersion(tx.workItem, { id, tenantId: context.tenantId }, body.version, { dueAt: until, deferredUntil: until, slaBreachedAt: null }, { label: LABEL })
      await this.timeline(tx, context.tenantId, id, row.version, 'deferred', `延期（${body.reason}）`, context.userId, { until: until.toISOString() })
      await this.audit.record(
        req,
        { action: 'WORK_ITEM_DEFERRED', resourceType: 'WorkItem', resourceId: id, before: { dueAt: current.dueAt }, after: { dueAt: until }, reason: body.reason },
        { client: tx },
      )
      return { id, version: row.version, dueAt: until }
    })
  }

  /** PATCH /work-items：批量指派、确认、忽略。逐条处理，成功与失败分别返回（某条冲突不影响其他条）。 */
  async batch(req: RequestWithContext, rawBody: unknown) {
    const context = await this.context.authorize(req, 'workitem.handle')
    const body = WorkItemBatchBodySchema.parse(rawBody)
    if (body.action === 'ASSIGN') this.context.require(context, 'workitem.assign')
    const results: Array<{ id: string; ok: boolean; code?: string; message?: string }> = []
    for (const item of body.items) {
      try {
        if (body.action === 'ASSIGN') await this.assign(req, item.id, { assigneeId: body.assigneeId, version: item.version })
        else if (body.action === 'ACK') await this.ack(req, item.id, { version: item.version })
        else await this.ignore(req, item.id, { reason: body.reason, version: item.version })
        results.push({ id: item.id, ok: true })
      } catch (error) {
        if (!(error instanceof AppError)) throw error
        results.push({ id: item.id, ok: false, code: error.code, message: (error.getResponse() as { message?: string }).message ?? '处理失败' })
      }
    }
    return { total: results.length, succeeded: results.filter(item => item.ok).length, results }
  }
}
