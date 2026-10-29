import { Injectable } from '@nestjs/common'
import {
  ALERTS_MANAGE,
  ALERTS_READ,
  ALERT_RULE_DOMAIN_LABEL,
  ALERT_STATS_WINDOW_DAYS,
  ALERT_UNCONNECTED_TYPES,
  AlertRuleScopeSchema,
  alertRuleDefOfType,
  alertScopeSupportOf,
  describeConditions,
  isNotifyFrequency,
  readEscalation,
  type AlertNotifyFrequency,
  type AlertRuleDomain,
  type ConditionGroups,
  type AlertRuleScope,
  type AlertRuleSeverity,
  type AlertRuleStats,
  type AlertRuleVersionView,
  type AlertRuleView,
  type AlertRulesResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import type { AlertRule, AlertRuleVersion } from '@prisma/client'
import { RequestWithContext } from '../../platform/http'
import { memberNames, nameOrFormer } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { ContextService, storeWhere, type ResolvedScope } from '../auth'
import { RULE_CATALOG } from './alert-rule-conditions'
import { readCondition, readSnapshot } from './alert-rule-format'

const DAY = 86_400_000
const RULE_LIMIT = 500
const STATS_ROW_LIMIT = 19_999
const VERSION_SHOWN = 20
const CATEGORY_LIMIT = 200
const MEMBER_LIMIT = 200
const SYSTEM_AUTHOR = 'system'
const HANDLED_BY_PEOPLE = ['HANDLED', 'IGNORED']

const severityOf = (value: string | null): AlertRuleSeverity => (value === 'CRITICAL' || value === 'INFO' ? value : 'WARNING')
const domainOf = (value: string): AlertRuleDomain => (value in ALERT_RULE_DOMAIN_LABEL ? (value as AlertRuleDomain) : 'SYSTEM')

export function readScope(value: unknown): AlertRuleScope {
  const parsed = AlertRuleScopeSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

/** 规则当前的全部设置（版本快照存的就是它）。 */
export const snapshotOf = (rule: Pick<AlertRule, 'conditionJson' | 'severity' | 'cooldownMinutes' | 'enabled' | 'scopeJson' | 'conditionGroups' | 'notifyFrequency' | 'escalation'>) => ({
  ...readCondition(rule.conditionJson),
  severity: rule.severity,
  cooldownMinutes: rule.cooldownMinutes,
  enabled: rule.enabled,
  scope: readScope(rule.scopeJson),
  conditionGroups: readConditionGroups(rule.conditionGroups),
  notifyFrequency: isNotifyFrequency(rule.notifyFrequency) ? rule.notifyFrequency : ('IMMEDIATE' as AlertNotifyFrequency),
  escalation: readEscalation(rule.escalation),
})

/** 规则行里存的条件；格式不对按“没有条件”处理。 */
export function readConditionGroups(value: unknown): ConditionGroups | null {
  return value && typeof value === 'object' && !Array.isArray(value) && Array.isArray((value as ConditionGroups).groups) ? (value as ConditionGroups) : null
}

type StatRow = { ruleId: string; status: string; closeConclusion: string | null; firstTriggeredAt: Date; resolvedAt: Date | null }

/** 规则质量统计（09 章 9.1 规则质量统计）：命中次数、误报率、平均处理时长，口径写在 AlertRuleStats 的注释里。 */
export function statsOf(rows: readonly StatRow[], truncated: boolean): AlertRuleStats {
  const handled = rows.filter(row => HANDLED_BY_PEOPLE.includes(row.status))
  const falsePositive = handled.filter(row => row.closeConclusion === 'FALSE_POSITIVE').length
  const durations = handled.filter(row => row.resolvedAt).map(row => (row.resolvedAt as Date).getTime() - row.firstTriggeredAt.getTime())
  return {
    windowDays: ALERT_STATS_WINDOW_DAYS,
    hits: rows.length,
    open: rows.filter(row => row.status === 'NEW' || row.status === 'ACKED').length,
    handled: handled.length,
    falsePositive,
    falsePositiveRate: handled.length > 0 ? falsePositive / handled.length : null,
    avgHandleHours: durations.length > 0 ? Math.round((durations.reduce((sum, value) => sum + Math.max(0, value), 0) / durations.length / 3_600_000) * 10) / 10 : null,
    truncated,
  }
}

function versionView(row: AlertRuleVersion, names: ReadonlyMap<string, string>): AlertRuleVersionView {
  const snapshot = readSnapshot(row.conditionJson)
  return {
    versionNo: row.versionNo,
    changedByName: row.changedBy === SYSTEM_AUTHOR ? '系统' : nameOrFormer(names, row.changedBy),
    changeReason: row.changeReason,
    createdAt: row.createdAt.toISOString(),
    params: snapshot.params,
    severity: snapshot.severity ? severityOf(snapshot.severity) : null,
    cooldownMinutes: snapshot.cooldownMinutes,
    enabled: snapshot.enabled,
    scope: snapshot.scope ? readScope(snapshot.scope) : null,
  }
}

export function ruleView(rule: AlertRule, stats: AlertRuleStats, versions: readonly AlertRuleVersion[], names: ReadonlyMap<string, string>): AlertRuleView {
  const { type, params } = readCondition(rule.conditionJson)
  const def = alertRuleDefOfType(type)
  const conditionGroups = readConditionGroups(rule.conditionGroups)
  return {
    id: rule.id,
    code: rule.code,
    domain: domainOf(rule.domain),
    domainLabel: ALERT_RULE_DOMAIN_LABEL[domainOf(rule.domain)],
    name: rule.name,
    description: def?.description ?? '',
    type,
    custom: rule.code.startsWith('CUSTOM_'),
    enabled: rule.enabled,
    severity: severityOf(rule.severity),
    cooldownMinutes: rule.cooldownMinutes,
    params,
    defaultParams: { ...(def?.params ?? {}) },
    scope: readScope(rule.scopeJson),
    scopeSupport: alertScopeSupportOf(type),
    conditionGroups,
    conditionText: conditionGroups ? describeConditions(conditionGroups, RULE_CATALOG) : null,
    notifyFrequency: isNotifyFrequency(rule.notifyFrequency) ? rule.notifyFrequency : 'IMMEDIATE',
    escalation: readEscalation(rule.escalation),
    currentVersion: rule.currentVersion,
    version: rule.version,
    updatedAt: rule.updatedAt.toISOString(),
    stats,
    versions: versions.map(item => versionView(item, names)),
  }
}

// 规则页的读取（09 章 9.1 规则配置、规则版本、规则质量统计）。规则是企业级设置，列出全部；质量统计只算成员数据范围内的预警。
@Injectable()
export class AlertRulesQueryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
  ) {}

  async list(req: RequestWithContext): Promise<AlertRulesResponse> {
    const { context, scope } = await this.context.authorizeScoped(req, ALERTS_READ, {})
    const tenantId = context.tenantId
    const [rules, tenant, members, categories] = await Promise.all([
      this.prisma.alertRule.findMany({ where: { tenantId }, orderBy: [{ domain: 'asc' }, { code: 'asc' }], take: RULE_LIMIT }),
      this.prisma.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }),
      this.prisma.membership.findMany({
        where: { tenantId, status: 'ACTIVE' },
        select: { userId: true, user: { select: { displayName: true, email: true } } },
        orderBy: { userId: 'asc' },
        take: MEMBER_LIMIT,
      }),
      this.prisma.fbaProduct.findMany({
        where: { tenantId, categoryPath: { not: null } },
        select: { categoryPath: true },
        distinct: ['categoryPath'],
        orderBy: { categoryPath: 'asc' },
        take: CATEGORY_LIMIT,
      }),
    ])
    const { truncated, byRule } = await this.stats(tenantId, scope, rules)
    const versions = await this.versions(tenantId, rules)
    const names = await memberNames(
      this.prisma,
      tenantId,
      versions.map(item => item.changedBy),
    )
    return {
      state: rules.length > 0 ? 'OK' : 'NO_DATA',
      note: rules.length > 0 ? null : '尚无预警规则：后台任务在下一轮评估前会自动为企业补齐系统预置规则，请稍后刷新。',
      items: rules.map(rule =>
        ruleView(
          rule,
          byRule.get(rule.id) ?? statsOf([], truncated),
          versions.filter(item => item.ruleId === rule.id),
          names,
        ),
      ),
      timezone: tenant?.timezone ?? 'America/Los_Angeles',
      unconnected: ALERT_UNCONNECTED_TYPES,
      members: members.map(member => ({ id: member.userId, name: member.user.displayName || member.user.email })),
      categories: categories.map(row => row.categoryPath as string),
      can: { manage: hasPermission(context.permissions, ALERTS_MANAGE) },
    }
  }

  private async stats(tenantId: string, scope: ResolvedScope, rules: readonly AlertRule[]) {
    const since = new Date(Date.now() - ALERT_STATS_WINDOW_DAYS * DAY)
    const rows =
      rules.length === 0
        ? []
        : await this.prisma.alertInstance.findMany({
            where: { tenantId, ...storeWhere(scope), ruleId: { in: rules.map(rule => rule.id) }, firstTriggeredAt: { gte: since } },
            select: { ruleId: true, status: true, closeConclusion: true, firstTriggeredAt: true, resolvedAt: true },
            orderBy: { firstTriggeredAt: 'desc' },
            take: STATS_ROW_LIMIT,
          })
    const truncated = rows.length >= STATS_ROW_LIMIT
    const grouped = new Map<string, StatRow[]>()
    for (const row of rows) grouped.set(row.ruleId, [...(grouped.get(row.ruleId) ?? []), row])
    return { truncated, byRule: new Map([...grouped].map(([ruleId, list]) => [ruleId, statsOf(list, truncated)])) }
  }

  /** 每条规则最近的 20 个版本。 */
  private versions(tenantId: string, rules: readonly AlertRule[]) {
    if (rules.length === 0) return Promise.resolve([])
    return this.prisma.alertRuleVersion.findMany({
      where: { tenantId, OR: rules.map(rule => ({ ruleId: rule.id, versionNo: { gt: rule.currentVersion - VERSION_SHOWN } })) },
      orderBy: [{ ruleId: 'asc' }, { versionNo: 'desc' }],
      take: STATS_ROW_LIMIT,
    })
  }
}
