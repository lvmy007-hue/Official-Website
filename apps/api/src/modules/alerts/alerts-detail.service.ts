import { Injectable } from '@nestjs/common'
import {
  ALERTS_HANDLE,
  ALERTS_READ,
  ALERT_CONCLUSION_LABEL,
  ALERT_STATUS_LABEL,
  alertRuleDefOf,
  alertRuleDefOfType,
  type AlertDetailResponse,
  type AlertHistoryItem,
  type AlertRuleSeverity,
  type AlertTimelineItem,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { appError, RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere } from '../auth'
import { formatEvidence } from './alert-evidence'
import { describeParams, readCondition } from './alert-rule-format'
import { ALERT_INCLUDE, alertItem, loadLookups } from './alerts-common'

const HISTORY_LIMIT = 20
const EVENT_LIMIT = 200
const TREND_DAYS = 30
const TREND_ROW_LIMIT = 19_999
const ASSIGNEE_LIMIT = 200
const DAY = 86_400_000

const severityOf = (value: string): AlertRuleSeverity => (value === 'CRITICAL' || value === 'INFO' ? value : 'WARNING')

// 预警详情（09 章 9.1 预警详情）：证据、规则说明（含触发时的阈值）、历史触发记录、关联对象、处理时间线。评论与关注由协作模块按对象类型 ALERT 提供。
@Injectable()
export class AlertsDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async detail(req: RequestWithContext, id: string): Promise<AlertDetailResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_READ, {})
    const tenantId = context.tenantId
    const row = await this.prisma.alertInstance.findFirst({ where: { id, tenantId, ...storeWhere(scope) }, include: ALERT_INCLUDE })
    if (!row) throw appError('RESOURCE_NOT_FOUND', '预警不存在')
    const canHandle = hasPermission(context.permissions, ALERTS_HANDLE)
    const today = new Date()
    const since = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - (TREND_DAYS - 1) * DAY)
    const [rule, version, history, trendRows, alertEvents, lookups, assignees] = await Promise.all([
      this.prisma.alertRule.findFirst({ where: { id: row.ruleId, tenantId } }),
      this.prisma.alertRuleVersion.findFirst({ where: { tenantId, ruleId: row.ruleId, versionNo: row.ruleVersionNo } }),
      this.prisma.alertInstance.findMany({ where: { tenantId, ruleId: row.ruleId, dedupKey: row.dedupKey }, orderBy: { firstTriggeredAt: 'desc' }, take: HISTORY_LIMIT }),
      this.prisma.alertInstance.findMany({
        where: { tenantId, ruleId: row.ruleId, ...storeWhere(scope), firstTriggeredAt: { gte: since } },
        select: { firstTriggeredAt: true },
        take: TREND_ROW_LIMIT,
      }),
      this.prisma.entityEvent.findMany({ where: { tenantId, entityType: 'ALERT', entityId: id }, orderBy: { occurredAt: 'asc' }, take: EVENT_LIMIT }),
      loadLookups(this.prisma, tenantId, context.userId, [row]),
      canHandle ? this.prisma.membership.findMany({ where: { tenantId, status: 'ACTIVE' }, select: { userId: true, user: { select: { displayName: true, email: true } } }, take: ASSIGNEE_LIMIT }) : [],
    ])
    if (!rule) throw appError('RESOURCE_NOT_FOUND', '预警所属的规则不存在')
    const work = row.workItemId ? (lookups.work.get(row.workItemId) ?? null) : null
    // 待办上的事件（不含由预警动作同步写入的，那些已经在预警自己的时间线里）
    const workEvents = work
      ? await this.prisma.entityEvent.findMany({
          where: { tenantId, entityType: 'WORK_ITEM', entityId: work.id, NOT: { sourceRef: { startsWith: 'alert-' } } },
          orderBy: { occurredAt: 'asc' },
          take: EVENT_LIMIT,
        })
      : []
    const names = await memberNames(this.prisma, tenantId, [row.closedBy, ...alertEvents.map(event => event.actorId), ...workEvents.map(event => event.actorId)])
    const condition = readCondition(version?.conditionJson ?? rule.conditionJson)
    const type = readCondition(rule.conditionJson).type
    const def = alertRuleDefOf(rule.code) ?? alertRuleDefOfType(type)

    const timeline: AlertTimelineItem[] = [
      { id: `${row.id}:first`, at: row.firstTriggeredAt.toISOString(), title: `规则“${rule.name}”首次触发（规则版本 v${row.ruleVersionNo}）`, actor: '系统' },
      ...[...alertEvents, ...workEvents].map(event => ({
        id: event.id,
        at: event.occurredAt.toISOString(),
        title: event.title,
        actor: event.actorKind === 'USER' ? nameOrFormer(names, event.actorId) : '系统',
      })),
      ...(row.status === 'AUTO_CLOSED' && row.resolvedAt ? [{ id: `${row.id}:recovered`, at: row.resolvedAt.toISOString(), title: '命中条件消失，系统自动标记为已恢复', actor: '系统' }] : []),
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

    return {
      alert: alertItem(row, lookups),
      rule: {
        id: rule.id,
        code: rule.code,
        name: rule.name,
        description: def?.description ?? '',
        severity: severityOf(rule.severity),
        cooldownMinutes: rule.cooldownMinutes,
        enabled: rule.enabled,
        versionNo: row.ruleVersionNo,
        currentVersion: rule.currentVersion,
        thresholds: describeParams(type, condition.params),
      },
      evidence: formatEvidence(row.evidenceJson),
      history: history.map((item): AlertHistoryItem => ({
        id: item.id,
        current: item.id === row.id,
        status: item.status,
        statusLabel: ALERT_STATUS_LABEL[item.status] ?? item.status,
        severity: severityOf(item.severity),
        triggerCount: item.triggerCount,
        firstTriggeredAt: item.firstTriggeredAt.toISOString(),
        lastTriggeredAt: item.lastTriggeredAt.toISOString(),
        resolvedAt: item.resolvedAt?.toISOString() ?? null,
        conclusionLabel: item.closeConclusion ? (ALERT_CONCLUSION_LABEL[item.closeConclusion] ?? null) : null,
      })),
      ruleTrend: trendOf(
        trendRows.map(item => item.firstTriggeredAt),
        since,
      ),
      timeline,
      workItem: work ? { id: work.id, status: work.status, dueAt: work.dueAt?.toISOString() ?? null, path: `/app/my/work-items?item=${encodeURIComponent(work.id)}` } : null,
      closeInfo:
        row.resolvedAt !== null
          ? {
              conclusionLabel:
                row.status === 'AUTO_CLOSED' ? '命中条件消失，自动恢复' : row.closeConclusion ? (ALERT_CONCLUSION_LABEL[row.closeConclusion] ?? null) : (ALERT_STATUS_LABEL[row.status] ?? null),
              note: row.closeNote,
              closedByName: row.closedBy ? nameOrFormer(names, row.closedBy) : null,
              closedAt: row.resolvedAt.toISOString(),
            }
          : null,
      can: { handle: canHandle },
      assignees: assignees.map(member => ({ id: member.userId, name: member.user.displayName || member.user.email })),
    }
  }
}

/** 最近 30 个 UTC 日历日每天新增的预警条数（没有的日子是 0：这里数的是已有记录，不是缺数据）。 */
function trendOf(times: readonly Date[], since: Date): Array<{ date: string; count: number }> {
  const counts = new Map<string, number>()
  for (const time of times) {
    const key = time.toISOString().slice(0, 10)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return Array.from({ length: TREND_DAYS }, (_, index) => {
    const date = new Date(since.getTime() + index * DAY).toISOString().slice(0, 10)
    return { date, count: counts.get(date) ?? 0 }
  })
}
