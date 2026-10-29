import { Injectable } from '@nestjs/common'
import {
  ALERTS_MANAGE,
  ALERT_RULE_CUSTOM_MAX,
  ALERT_RULE_CUSTOM_PREFIX,
  CUSTOM_METRIC_DOMAIN_OF,
  CUSTOM_METRIC_TYPE,
  AlertRuleCreateBodySchema,
  AlertRuleUpdateBodySchema,
  alertRuleDefOfType,
  checkAlertParams,
  type AlertRuleMutationResponse,
  type ConditionGroups,
  type AlertRuleScope,
} from '@nova/api-contracts'
import { Prisma } from '@prisma/client'
import { appError, RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { AuditWriter, updateWithVersion } from '../../platform/write'
import { ContextService } from '../auth'
import { checkConditionGroups, RULE_CATALOG } from './alert-rule-conditions'
import { snapshotOf } from './alert-rules-query.service'

const LABEL = '预警规则'
const CODE_SCAN_LIMIT = 200

const json = (value: unknown) => value as Prisma.InputJsonValue
const unique = (items: readonly string[] | undefined) => [...new Set(items ?? [])]

// 预警规则的改动（09 章 9.1 规则配置、规则版本）：只有 alerts.manage 能改；阈值按评估器类型登记的范围校验，范围里的主体、店铺、负责人、通知对象必须属于本企业；
// 每次真实改动生成新版本（版本快照存当时的全部设置），乐观锁防止两个人同时改。
@Injectable()
export class AlertRulesWriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly context: ContextService,
    private readonly audit: AuditWriter,
  ) {}

  /** 范围里引用的对象都必须是本企业的：主体、店铺存在；负责人与通知对象是在职成员。去重后返回。 */
  private async checkScope(tenantId: string, scope: AlertRuleScope): Promise<AlertRuleScope> {
    const errors: Record<string, string[]> = {}
    const entities = unique(scope.legalEntityIds)
    const stores = unique(scope.sellerAccountIds)
    const people = unique([...(scope.ownerId ? [scope.ownerId] : []), ...(scope.notifyUserIds ?? [])])
    const [entityRows, storeRows, memberRows] = await Promise.all([
      entities.length > 0 ? this.prisma.legalEntity.findMany({ where: { tenantId, id: { in: entities } }, select: { id: true }, take: 100 }) : [],
      stores.length > 0 ? this.prisma.sellerAccount.findMany({ where: { tenantId, id: { in: stores } }, select: { id: true }, take: 300 }) : [],
      people.length > 0 ? this.prisma.membership.findMany({ where: { tenantId, userId: { in: people }, status: 'ACTIVE' }, select: { userId: true }, take: 100 }) : [],
    ])
    if (entityRows.length !== entities.length) errors['scope.legalEntityIds'] = ['所选主体不属于本企业']
    if (storeRows.length !== stores.length) errors['scope.sellerAccountIds'] = ['所选店铺不属于本企业']
    const activeIds = new Set(memberRows.map(row => row.userId))
    if (scope.ownerId && !activeIds.has(scope.ownerId)) errors['scope.ownerId'] = ['默认负责人必须是企业的在职成员']
    if ((scope.notifyUserIds ?? []).some(id => !activeIds.has(id))) errors['scope.notifyUserIds'] = ['通知对象必须是企业的在职成员']
    if (Object.keys(errors).length > 0) throw appError('VALIDATION_FAILED', '规则的作用范围有误', { fieldErrors: errors })
    // 空列表等于“不填”，不存进去（评估时空列表与未设置含义一样，存了只会让规则页显示成“已设置”）
    const cleaned: AlertRuleScope = {}
    if (entities.length > 0) cleaned.legalEntityIds = entities
    if (stores.length > 0) cleaned.sellerAccountIds = stores
    const categories = unique(scope.categories)
    if (categories.length > 0) cleaned.categories = categories
    const skus = unique(scope.skus)
    if (skus.length > 0) cleaned.skus = skus
    if (scope.ownerId) cleaned.ownerId = scope.ownerId
    if ((scope.notifyUserIds ?? []).length > 0) cleaned.notifyUserIds = unique(scope.notifyUserIds)
    if (scope.quiet) cleaned.quiet = scope.quiet
    return cleaned
  }

  private checkParams(type: string, input: Record<string, unknown> | undefined, current: Record<string, unknown>) {
    const checked = checkAlertParams(type, input ?? {}, current)
    if (checked.ok) return checked.params
    const fieldErrors = Object.fromEntries(Object.entries(checked.errors).map(([key, messages]) => [`params.${key}`, messages]))
    throw appError('VALIDATION_FAILED', '规则阈值有误', { fieldErrors })
  }

  async update(req: RequestWithContext, id: string, rawBody: unknown): Promise<AlertRuleMutationResponse> {
    const context = await this.context.authorize(req, ALERTS_MANAGE)
    const body = AlertRuleUpdateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const rule = await this.prisma.alertRule.findFirst({ where: { id, tenantId } })
    if (!rule) throw appError('RESOURCE_NOT_FOUND', '预警规则不存在')
    const before = snapshotOf(rule)
    const customMetric = before.type === CUSTOM_METRIC_TYPE
    if (body.conditionGroups && !customMetric)
      throw appError('VALIDATION_FAILED', '只有自定义指标规则可以设置条件', { fieldErrors: { conditionGroups: ['这条规则用的是系统预置的评估逻辑，没有指标条件'] } })
    // 自定义指标规则没有可调阈值，阈值全在条件里
    const params = body.params && !customMetric ? this.checkParams(before.type, body.params, before.params) : before.params
    const scope = body.scope ? await this.checkScope(tenantId, body.scope) : before.scope
    const after = {
      type: before.type,
      params,
      severity: body.severity ?? rule.severity,
      cooldownMinutes: body.cooldownMinutes ?? rule.cooldownMinutes,
      enabled: body.enabled ?? rule.enabled,
      scope,
      conditionGroups: body.conditionGroups ? checkConditionGroups(body.conditionGroups) : before.conditionGroups,
      notifyFrequency: body.notifyFrequency ?? before.notifyFrequency,
      escalation: body.escalation ?? before.escalation,
    }
    if (customMetric && after.conditionGroups === null) throw appError('VALIDATION_FAILED', '自定义指标规则必须有条件', { fieldErrors: { conditionGroups: ['请设置至少一个条件'] } })
    if (JSON.stringify(sortKeys(after)) === JSON.stringify(sortKeys(before))) throw appError('VALIDATION_FAILED', '没有任何改动', { fieldErrors: { version: ['提交的设置与当前设置相同'] } })
    return this.prisma.$transaction(async tx => {
      const versionNo = rule.currentVersion + 1
      const row = await updateWithVersion(
        tx.alertRule,
        { id, tenantId },
        body.version,
        {
          conditionJson: json({ type: after.type, params: after.params }),
          severity: after.severity,
          cooldownMinutes: after.cooldownMinutes,
          enabled: after.enabled,
          scopeJson: json(after.scope),
          conditionGroups: after.conditionGroups ? json(after.conditionGroups) : Prisma.DbNull,
          notifyFrequency: after.notifyFrequency,
          escalation: after.escalation.length > 0 ? json(after.escalation) : Prisma.DbNull,
          currentVersion: versionNo,
        },
        { label: LABEL },
      )
      await tx.alertRuleVersion.create({ data: { tenantId, ruleId: id, versionNo, conditionJson: json(after), changedBy: context.userId, changeReason: body.changeReason } })
      await this.audit.record(req, { action: 'ALERT_RULE_UPDATED', resourceType: 'AlertRule', resourceId: id, before: json(before), after: json(after), reason: body.changeReason }, { client: tx })
      return { id, code: row.code, currentVersion: row.currentVersion, version: row.version }
    })
  }

  async create(req: RequestWithContext, rawBody: unknown): Promise<AlertRuleMutationResponse> {
    const context = await this.context.authorize(req, ALERTS_MANAGE)
    const body = AlertRuleCreateBodySchema.parse(rawBody)
    const tenantId = context.tenantId
    const customMetric = body.type === CUSTOM_METRIC_TYPE
    const preset = alertRuleDefOfType(body.type)
    if (!preset && !customMetric) throw appError('VALIDATION_FAILED', '不支持的规则类型', { fieldErrors: { type: ['请选择系统支持的规则类型'] } })
    if (body.conditionGroups && !customMetric)
      throw appError('VALIDATION_FAILED', '只有自定义指标规则可以设置条件', { fieldErrors: { conditionGroups: ['这条规则用的是系统预置的评估逻辑，没有指标条件'] } })
    if (customMetric && !body.conditionGroups) throw appError('VALIDATION_FAILED', '自定义指标规则必须有条件', { fieldErrors: { conditionGroups: ['请设置至少一个条件'] } })
    const conditionGroups: ConditionGroups | null = customMetric ? checkConditionGroups(body.conditionGroups) : null
    // 自定义指标规则不在预置目录里：业务域取第一个条件的指标所属域，严重度与冷却用通用默认值
    const def = preset ?? {
      type: CUSTOM_METRIC_TYPE,
      domain: CUSTOM_METRIC_DOMAIN_OF[RULE_CATALOG.get(conditionGroups?.groups[0]?.conditions[0]?.metric ?? '')?.domain ?? 'sales'] ?? 'SYSTEM',
      severity: 'WARNING' as const,
      cooldownMinutes: 60,
      params: {},
    }
    const params = customMetric ? {} : this.checkParams(def.type, body.params, { ...def.params })
    const scope = await this.checkScope(tenantId, body.scope ?? {})
    const existing = await this.prisma.alertRule.findMany({ where: { tenantId, code: { startsWith: ALERT_RULE_CUSTOM_PREFIX } }, select: { code: true }, take: CODE_SCAN_LIMIT })
    if (existing.length >= ALERT_RULE_CUSTOM_MAX) throw appError('VALIDATION_FAILED', `自定义规则最多 ${ALERT_RULE_CUSTOM_MAX} 条`, { fieldErrors: { type: ['已达自定义规则数量上限'] } })
    const next = Math.max(0, ...existing.map(row => Number(row.code.slice(ALERT_RULE_CUSTOM_PREFIX.length)) || 0)) + 1
    const code = `${ALERT_RULE_CUSTOM_PREFIX}${String(next).padStart(3, '0')}`
    const severity = body.severity ?? def.severity
    const cooldownMinutes = body.cooldownMinutes ?? def.cooldownMinutes
    const notifyFrequency = body.notifyFrequency ?? 'IMMEDIATE'
    const escalation = body.escalation ?? []
    const snapshot = { type: def.type, params, severity, cooldownMinutes, enabled: true, scope, conditionGroups, notifyFrequency, escalation }
    try {
      return await this.prisma.$transaction(async tx => {
        const row = await tx.alertRule.create({
          data: {
            tenantId,
            code,
            domain: def.domain,
            name: body.name,
            conditionJson: json({ type: def.type, params }),
            severity,
            cooldownMinutes,
            enabled: true,
            scopeJson: json(scope),
            conditionGroups: conditionGroups ? json(conditionGroups) : Prisma.DbNull,
            notifyFrequency,
            escalation: escalation.length > 0 ? json(escalation) : Prisma.DbNull,
          },
        })
        await tx.alertRuleVersion.create({
          data: { tenantId, ruleId: row.id, versionNo: row.currentVersion, conditionJson: json(snapshot), changedBy: context.userId, changeReason: body.changeReason ?? '新建自定义规则' },
        })
        await this.audit.record(
          req,
          { action: 'ALERT_RULE_CREATED', resourceType: 'AlertRule', resourceId: row.id, after: json({ code, name: body.name, ...snapshot }), reason: body.changeReason },
          { client: tx },
        )
        return { id: row.id, code, currentVersion: row.currentVersion, version: row.version }
      })
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') throw appError('CONFLICT', '规则编号刚被占用，请重试')
      throw error
    }
  }
}

/** 键排序后序列化，用来比较两份设置是否一样（阈值里键的顺序不影响含义）。 */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([key, item]) => [key, sortKeys(item)]),
    )
  return value
}
