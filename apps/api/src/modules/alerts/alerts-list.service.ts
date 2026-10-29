import { Injectable } from '@nestjs/common'
import { ALERT_DOMAINS, ALERT_VIEWS, ALERT_VIEW_STATUSES, ALERTS_READ, AlertListQuerySchema, type AlertListResponse, type AlertRuleDomain, type AlertView } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { readAlertWhere, unreadAlertWhere } from '../../platform/alert-unread'
import { PrismaService } from '../../platform/prisma.service'
import { bindingOf, CursorService } from '../../platform/query'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { ALERT_INCLUDE, OPEN_STATUSES, alertItem, loadLookups } from './alerts-common'

const SORT_FIELD = 'lastTriggeredAt'
const RULE_LIMIT = 500

// 预警列表（09 章 9.1）：游标分页，按最近触发时间新到旧；受成员的店铺数据范围限制（没有店铺归属的企业级预警只有全范围成员看得到）。
// 页面没有全局范围栏，所以不接受范围参数（cursorListQuery 的 scope: false）。
@Injectable()
export class AlertsListService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly cursor: CursorService,
  ) {}

  async list(req: RequestWithContext, rawQuery: Record<string, string>): Promise<AlertListResponse> {
    // 先鉴权再解析参数：无权限的人看不到校验细节
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_READ, {})
    const query = AlertListQuerySchema.parse(rawQuery)
    const view: AlertView = query.handleState ?? query.view ?? 'open'
    const userId = context.userId
    const sort = { field: SORT_FIELD, dir: query.sort.dir } as const
    // 游标绑定要带上用户：已读筛选因人而异，别人的游标不能拿来用
    const binding = bindingOf(context.tenantId, { ...query, userId })
    const statuses = ALERT_VIEW_STATUSES[view]
    const search = query.q
    const base: Prisma.AlertInstanceWhereInput = {
      tenantId: context.tenantId,
      ...storeWhere(scope),
      ...(statuses ? { status: { in: [...statuses] } } : {}),
      ...(query.severity ? { severity: query.severity } : {}),
      ...(query.ruleId ? { ruleId: query.ruleId } : {}),
      ...(query.domain ? { rule: { domain: query.domain } } : {}),
      // 已读按人记录：未读 = 我没有已读记录，已读 = 我有
      ...(query.readState === 'unread' ? { reads: { none: { userId } } } : query.readState === 'read' ? readAlertWhere(userId) : {}),
      ...(search
        ? {
            OR: [
              { entityId: { contains: search, mode: 'insensitive' } },
              { entityLabel: { contains: search, mode: 'insensitive' } },
              { title: { contains: search, mode: 'insensitive' } },
              { rule: { name: { contains: search, mode: 'insensitive' } } },
            ],
          }
        : {}),
    }
    const rows = await this.prisma.alertInstance.findMany({
      where: { AND: [base, this.cursor.after(query.cursor, sort, binding) as Prisma.AlertInstanceWhereInput] },
      orderBy: this.cursor.orderBy(sort),
      take: query.pageSize + 1,
      include: ALERT_INCLUDE,
    })
    const page = this.cursor.page(rows, { pageSize: query.pageSize, sort, binding })
    const [lookups, counts, domainOpenCounts, unreadCount] = await Promise.all([
      loadLookups(this.prisma, context.tenantId, userId, page.items),
      this.counts(context.tenantId, scope),
      this.domainOpenCounts(context.tenantId, scope),
      this.prisma.alertInstance.count({ where: { tenantId: context.tenantId, ...storeWhere(scope), ...unreadAlertWhere(userId) } }),
    ])
    const items = page.items.map(row => alertItem(row, lookups))
    const hasAny = items.length > 0 || Boolean(query.cursor)
    const filtered = Boolean(query.domain || query.severity || query.ruleId || query.readState || search)
    return {
      state: hasAny ? 'OK' : 'NO_DATA',
      note: hasAny ? null : this.emptyNote(view, filtered, counts),
      items,
      pageInfo: page.pageInfo,
      counts,
      domainOpenCounts,
      unreadCount,
    }
  }

  private emptyNote(view: AlertView, filtered: boolean, counts: Record<AlertView, number>) {
    if (filtered) return '没有符合条件的预警；可以放宽筛选条件'
    if (counts.all === 0) return '尚无预警：系统每 15 分钟按预警规则评估一次，店铺授权并完成数据同步后才会出现预警；规则可以在“预警规则”里查看与调整'
    return view === 'open' ? '没有待处理的预警' : '这个视图下没有预警'
  }

  private async counts(tenantId: string, scope: ResolvedScope): Promise<Record<AlertView, number>> {
    const groups = await this.prisma.alertInstance.groupBy({ by: ['status'], where: { tenantId, ...storeWhere(scope) }, _count: { _all: true }, orderBy: { status: 'asc' } })
    const byStatus = new Map(groups.map(group => [group.status, group._count._all]))
    const sum = (statuses: readonly string[] | null) =>
      statuses ? statuses.reduce((total, status) => total + (byStatus.get(status) ?? 0), 0) : [...byStatus.values()].reduce((total, count) => total + count, 0)
    return Object.fromEntries(ALERT_VIEWS.map(view => [view, sum(ALERT_VIEW_STATUSES[view])])) as Record<AlertView, number>
  }

  private async domainOpenCounts(tenantId: string, scope: ResolvedScope): Promise<Record<AlertRuleDomain, number>> {
    const [groups, rules] = await Promise.all([
      this.prisma.alertInstance.groupBy({ by: ['ruleId'], where: { tenantId, ...storeWhere(scope), status: { in: OPEN_STATUSES } }, _count: { _all: true }, orderBy: { ruleId: 'asc' } }),
      this.prisma.alertRule.findMany({ where: { tenantId }, select: { id: true, domain: true }, take: RULE_LIMIT }),
    ])
    const domainOf = new Map(rules.map(rule => [rule.id, rule.domain]))
    const result = Object.fromEntries(ALERT_DOMAINS.map(domain => [domain, 0])) as Record<AlertRuleDomain, number>
    for (const group of groups) {
      const domain = domainOf.get(group.ruleId)
      if (domain && domain in result) result[domain as AlertRuleDomain] += group._count._all
    }
    return result
  }
}
