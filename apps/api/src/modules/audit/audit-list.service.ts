import { Injectable } from '@nestjs/common'
import {
  AUDIT_OPTIONS_LIMIT,
  AUDIT_OPTIONS_WINDOW_DAYS,
  AUDIT_READ,
  AuditListQuerySchema,
  auditActionLabel,
  auditFilterClauses,
  auditResourceLabel,
  type AuditListResponse,
  type AuditOptionsResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, FORMER_MEMBER_LABEL } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService } from '../auth'
import { AUDIT_LIST_SELECT, actorNamesOf, auditRowOf } from './audit-common'

const DAY_MS = 86_400_000
const EXPORT_PERMISSION = 'export.create'
const NO_EXPORT = '导出需要“发起导出”权限（export.create），请联系管理员在角色编辑器开通'

// 审计列表（09 章 9.11）：服务端搜索与筛选（操作人、动作、资源类型、资源编号、结果、来源、所属页面、请求编号、时间范围），游标分页，按发生时间倒序。
// 审计日志不分店铺，只要 audit.read；所有筛选都真实生效，不认识的参数返回 422。
@Injectable()
export class AuditListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AuditListResponse> {
    // 权限先于参数校验：无权限的人先拿 403，不该先看到 422 的校验细节
    const context = await this.context.authorize(req, AUDIT_READ)
    const query = AuditListQuerySchema.parse(rawQuery)
    const tenantId = context.tenantId
    const filters = { ...query, fromAt: query.fromAt ? new Date(query.fromAt) : undefined, toAt: query.toAt ? new Date(query.toAt) : undefined }
    const where = { AND: [{ tenantId }, ...auditFilterClauses(filters)] } as Prisma.AuditEventWhereInput
    const binding = bindingOf(tenantId, query)
    const rows = await this.prisma.auditEvent.findMany({
      where: { AND: [where, this.cursor.after(query.cursor, query.sort, binding) as Prisma.AuditEventWhereInput] },
      orderBy: this.cursor.orderBy(query.sort),
      take: query.pageSize + 1,
      select: AUDIT_LIST_SELECT,
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort: query.sort, binding })
    const names = await actorNamesOf(this.prisma, tenantId, page.items)
    const canExport = hasPermission(context.permissions, EXPORT_PERMISSION)
    return { items: page.items.map(row => auditRowOf(row, names)), pageInfo: page.pageInfo, canExport, exportBlockedReason: canExport ? null : NO_EXPORT }
  }

  /** 筛选项的取值：只列最近 90 天里真实出现过的动作、资源类型、所属页面与操作人，选了一定查得到。 */
  async options(req: RequestWithContext, now = new Date()): Promise<AuditOptionsResponse> {
    const context = await this.context.authorize(req, AUDIT_READ)
    const tenantId = context.tenantId
    const base: Prisma.AuditEventWhereInput = { tenantId, occurredAt: { gte: new Date(now.getTime() - AUDIT_OPTIONS_WINDOW_DAYS * DAY_MS) } }
    const take = AUDIT_OPTIONS_LIMIT + 1
    const [actions, types, pages, actors] = await Promise.all([
      this.prisma.auditEvent.groupBy({ by: ['action'], where: base, orderBy: { action: 'asc' }, take }),
      this.prisma.auditEvent.groupBy({ by: ['resourceType'], where: base, orderBy: { resourceType: 'asc' }, take }),
      this.prisma.auditEvent.groupBy({ by: ['page'], where: { ...base, page: { not: null } }, orderBy: { page: 'asc' }, take }),
      this.prisma.auditEvent.groupBy({ by: ['actorId'], where: { ...base, actorId: { not: null } }, orderBy: { actorId: 'asc' }, take }),
    ])
    const names = await memberNames(
      this.prisma,
      tenantId,
      actors.map(row => row.actorId),
    )
    const cut = <T>(items: T[]) => items.slice(0, AUDIT_OPTIONS_LIMIT)
    return {
      windowDays: AUDIT_OPTIONS_WINDOW_DAYS,
      actions: cut(actions).map(row => ({ value: row.action, label: auditActionLabel(row.action) })),
      resourceTypes: cut(types).map(row => ({ value: row.resourceType, label: auditResourceLabel(row.resourceType) })),
      pages: cut(pages).flatMap(row => (row.page ? [row.page] : [])),
      // 平台支持访问的记录没有成员编号，不会出现在这里；已离开的成员仍可按名字之外的编号筛选，显示“已离开的成员”
      actors: cut(actors).flatMap(row => (row.actorId ? [{ value: row.actorId, label: names.get(row.actorId) ?? FORMER_MEMBER_LABEL }] : [])),
      truncated: [actions, types, pages, actors].some(items => items.length > AUDIT_OPTIONS_LIMIT),
    }
  }
}
