import { Injectable } from '@nestjs/common'
import { ALERT_EVIDENCE_LABELS, WORK_TABS, WorkItemListQuerySchema, workDueGroup, type WorkTab } from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma, WorkItem } from '@prisma/client'
import { ApiContext, appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'

const SORT = { field: 'createdAt', dir: 'desc' } as const
const OPEN = ['PENDING', 'IN_PROGRESS']
const CLOSED = ['DONE', 'CLOSED']
const WATCH_ID_LIMIT = 2000

type ItemRow = WorkItem

/** 待办列表与详情的数据范围：本人相关的，或（有 workitem.read 时）全部。 */
export function canSeeAllWork(context: Pick<ApiContext, 'permissions'>) {
  return hasPermission(context.permissions, 'workitem.read')
}

// 待办的读取（P1-28-3）：列表按页签与范围过滤，详情给业务用户看的内容（触发规则与证据、处理时间线、指派记录）。
@Injectable()
export class WorkQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  private async watchedIds(context: ApiContext) {
    const rows = await this.prisma.watch.findMany({ where: { tenantId: context.tenantId, userId: context.userId, entityType: 'WORK_ITEM' }, select: { entityId: true }, take: WATCH_ID_LIMIT })
    return rows.map(row => row.entityId)
  }

  private tabWhere(tab: WorkTab, context: ApiContext, all: boolean, watched: string[]): Prisma.WorkItemWhereInput {
    const me = context.userId
    const own: Prisma.WorkItemWhereInput = all ? {} : { ownerId: me }
    switch (tab) {
      case 'MINE':
        return { ...own, status: { in: OPEN } }
      case 'ASSIGNED':
        return {
          status: { in: OPEN },
          OR: [
            { createdBy: me, ownerId: { not: me } },
            { assignments: { some: { assignedBy: me, assigneeId: { not: me } } }, ownerId: { not: me } },
          ],
        }
      case 'WATCHING':
        return { id: { in: watched } }
      case 'DONE':
        return { ...own, status: { in: CLOSED }, NOT: { closeConclusion: 'IGNORED' } }
      default:
        return { ...own, closeConclusion: 'IGNORED' }
    }
  }

  async list(req: RequestWithContext, rawQuery: unknown) {
    const context = await this.context.resolve(req)
    const query = WorkItemListQuerySchema.parse(rawQuery)
    const all = query.scope === 'all'
    if (all && !canSeeAllWork(context)) throw appError('TENANT_ACCESS_DENIED', '当前账号没有查看全部待办的权限')
    const watched = query.tab === 'WATCHING' ? await this.watchedIds(context) : []
    const filters: Prisma.WorkItemWhereInput = {
      tenantId: context.tenantId,
      ...(query.source ? { source: query.source } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.dueBefore ? { dueAt: { lte: new Date(query.dueBefore) } } : {}),
    }
    const binding = bindingOf(context.tenantId, { userId: context.userId, tab: query.tab, scope: query.scope, source: query.source, severity: query.severity, dueBefore: query.dueBefore })
    const rows = await this.prisma.workItem.findMany({
      where: { AND: [filters, this.tabWhere(query.tab, context, all, watched), this.cursor.after(query.cursor, SORT, binding) as Prisma.WorkItemWhereInput] },
      orderBy: this.cursor.orderBy(SORT),
      take: query.limit + 1,
    })
    const page = this.cursor.page(rows, { pageSize: query.limit, sort: SORT, binding })
    const names = await memberNames(
      this.prisma,
      context.tenantId,
      page.items.flatMap(row => [row.ownerId, row.createdBy]),
    )
    const now = new Date()
    return {
      items: page.items.map(row => this.toItem(row, names, now)),
      pageInfo: page.pageInfo,
      counts: all ? null : await this.counts(context, await this.watchedIds(context)),
    }
  }

  private async counts(context: ApiContext, watched: string[]) {
    const entries = await Promise.all(
      WORK_TABS.map(async tab => [tab, await this.prisma.workItem.count({ where: { tenantId: context.tenantId, ...this.tabWhere(tab, context, false, watched) } })] as const),
    )
    return Object.fromEntries(entries) as Record<WorkTab, number>
  }

  toItem(row: ItemRow, names: ReadonlyMap<string, string>, now: Date) {
    const open = OPEN.includes(row.status)
    return {
      id: row.id,
      title: row.title,
      kind: row.kind,
      source: row.source,
      status: row.status,
      priority: row.priority,
      severity: row.severity,
      dueAt: row.dueAt,
      overdue: open && row.dueAt !== null && row.dueAt.getTime() < now.getTime(),
      remainingMinutes: open && row.dueAt ? Math.round((row.dueAt.getTime() - now.getTime()) / 60_000) : null,
      groupKey: open ? workDueGroup(row.dueAt, now) : 'NONE',
      slaBreachedAt: row.slaBreachedAt,
      escalatedAt: row.escalatedAt,
      entity: row.entityType ? { type: row.entityType, id: row.entityId, label: row.entityLabel } : null,
      impact:
        row.impactMin !== null || row.impactMax !== null
          ? { min: row.impactMin === null ? null : Number(row.impactMin.toString()), max: row.impactMax === null ? null : Number(row.impactMax.toString()), currency: row.currency }
          : null,
      suggestedAction: row.suggestedAction,
      owner: { id: row.ownerId, name: nameOrFormer(names, row.ownerId) },
      createdBy: { id: row.createdBy, name: nameOrFormer(names, row.createdBy) },
      createdAt: row.createdAt,
      ackAt: row.ackAt,
      deferredUntil: row.deferredUntil,
      closeConclusion: row.closeConclusion,
      ignoreReason: row.ignoreReason,
      version: row.version,
    }
  }

  /** 读取一条待办并确认当前成员能看到（本人相关，或有 workitem.read）；不能看到统一按“不存在”处理。 */
  async visibleItem(context: ApiContext, id: string): Promise<ItemRow> {
    const row = await this.prisma.workItem.findFirst({ where: { id, tenantId: context.tenantId } })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '待办不存在')
    if (canSeeAllWork(context) || row.ownerId === context.userId || row.createdBy === context.userId) return row
    const related = await Promise.all([
      this.prisma.assignment.count({ where: { tenantId: context.tenantId, workItemId: id, OR: [{ assigneeId: context.userId }, { assignedBy: context.userId }] } }),
      this.prisma.watch.count({ where: { tenantId: context.tenantId, userId: context.userId, entityType: 'WORK_ITEM', entityId: id } }),
    ])
    if (related[0] + related[1] === 0) throw appError('RESOURCE_NOT_FOUND', '待办不存在')
    return row
  }

  async detail(req: RequestWithContext, id: string) {
    const context = await this.context.resolve(req)
    const row = await this.visibleItem(context, id)
    const [events, assignments, watching, alert] = await Promise.all([
      this.prisma.entityEvent.findMany({ where: { tenantId: context.tenantId, entityType: 'WORK_ITEM', entityId: id }, orderBy: { occurredAt: 'asc' }, take: 200 }),
      this.prisma.assignment.findMany({ where: { tenantId: context.tenantId, workItemId: id }, orderBy: { assignedAt: 'asc' }, take: 50 }),
      this.prisma.watch.count({ where: { tenantId: context.tenantId, userId: context.userId, entityType: 'WORK_ITEM', entityId: id } }),
      row.sourceAlertId
        ? this.prisma.alertInstance.findFirst({
            where: { id: row.sourceAlertId, tenantId: context.tenantId },
            select: { evidenceJson: true, triggerCount: true, firstTriggeredAt: true, rule: { select: { name: true, domain: true } } },
          })
        : Promise.resolve(null),
    ])
    const names = await memberNames(this.prisma, context.tenantId, [
      row.ownerId,
      row.createdBy,
      row.closedBy,
      ...events.map(event => event.actorId),
      ...assignments.flatMap(item => [item.assigneeId, item.assignedBy]),
    ])
    const evidence =
      alert && alert.evidenceJson && typeof alert.evidenceJson === 'object' && !Array.isArray(alert.evidenceJson)
        ? Object.entries(alert.evidenceJson as Record<string, unknown>)
            .filter(([key, value]) => key in ALERT_EVIDENCE_LABELS && (typeof value === 'string' || typeof value === 'number'))
            .map(([key, value]) => ({ label: ALERT_EVIDENCE_LABELS[key], value: String(value) }))
        : []
    return {
      ...this.toItem(row, names, new Date()),
      detail: row.detail,
      closeNote: row.closeNote,
      closedAt: row.closedAt,
      closedBy: row.closedBy ? nameOrFormer(names, row.closedBy) : null,
      trigger: alert ? { ruleName: alert.rule.name, domain: alert.rule.domain, triggerCount: alert.triggerCount, firstTriggeredAt: alert.firstTriggeredAt, evidence } : null,
      watching: watching > 0,
      assignments: assignments.map(item => ({ assignee: nameOrFormer(names, item.assigneeId), assignedBy: nameOrFormer(names, item.assignedBy), assignedAt: item.assignedAt })),
      timeline: events.map(event => ({ id: event.id, at: event.occurredAt, title: event.title, actor: event.actorKind === 'USER' ? nameOrFormer(names, event.actorId) : '系统' })),
      can: {
        handle: hasPermission(context.permissions, 'workitem.handle') && (row.ownerId === context.userId || hasPermission(context.permissions, 'workitem.assign')),
        assign: hasPermission(context.permissions, 'workitem.assign'),
      },
    }
  }
}
