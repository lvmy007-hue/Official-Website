import {
  WORK_DEFAULT_SLA_HOURS,
  entityDetailPath,
  isNotifyFrequency,
  readEscalation,
  type AlertEscalationLevel,
  type AlertNotifyFrequency,
  type ConditionGroups,
  type WorkSeverity,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { Prisma, PrismaClient } from '@prisma/client'
import { deferNotice, flushDigests, runEscalations } from './alert-digest'
import { chooseOwner, recipientsOf } from './alert-recipients'
import { expandRuleScope } from './alert-scope'
import { notifyUsers } from './notify'

// 预警评估框架（P1-28-5）：规则 → 命中 → 预警实例 → 待办 → 站内通知。
// 框架只负责“命中之后的一切”：去重、冷却、生成待办、通知、命中消失后自动恢复；
// “怎样算命中”由各业务工作包以评估器注册进来（规则的 conditionJson.type 对应评估器类型）；P2a-15 起库存、入仓差异、同步失败、授权失效
// 的评估器在 alerts/ 目录。没有评估器的规则不会被评估（页面不会出现凭空的预警）。
// - 同一规则同一对象在“新 / 已确认”状态下只有一条实例，重复命中并入这一条（次数加一，刷新最近命中时间与证据），不重复建待办与通知；
//   只有距上次命中已超过冷却期、上一条仍没处理时才重新提醒一次并清掉已读（见 mergeIntoOpen，P6-15）；
// - 实例被处理（恢复 / 忽略）后，冷却时间内（规则的 cooldownMinutes）再次命中不再新建，避免反复打扰；冷却期之外再命中新建一条；
// - 命中消失的开放实例自动标记为“已恢复”；已生成的待办留给负责人确认后关闭（不自动关闭）。

export const ALERT_EVALUATION_INTERVAL_MS = 15 * 60 * 1000
const MAX_HITS_PER_RULE = 500
const OPEN = ['NEW', 'ACKED']
const SEVERITIES = ['INFO', 'WARNING', 'CRITICAL']

export interface AlertHit {
  entityType: string
  entityId: string
  sellerAccountId?: string | null
  /** 证据（会展示在待办详情；不得含令牌、买家个人信息） */
  evidence: Record<string, unknown>
  /** 待办与通知的标题；缺省用规则名称 */
  title?: string
  entityLabel?: string
  suggestedAction?: string
  /** 影响金额区间（有可靠依据时才给；没有就不给，不写 0） */
  impact?: { min: number; max: number; currency?: string }
}

export interface AlertRuleView {
  id: string
  code: string
  domain: string
  name: string
  severity: string
  cooldownMinutes: number
  currentVersion: number
  condition: { type: string; params?: Record<string, unknown> }
  scope: Record<string, unknown>
  /** 自定义指标规则的条件（P6-16）；其余规则为 null */
  conditionGroups: ConditionGroups | null
  notifyFrequency: AlertNotifyFrequency
  escalation: AlertEscalationLevel[]
}

export interface AlertEvaluator {
  type: string
  /** 返回此刻“仍然成立”的全部命中（用于自动恢复，所以必须是完整集合，不能只返回新增）。 */
  evaluate(context: { db: PrismaClient; tenantId: string; rule: AlertRuleView; now: Date }): Promise<AlertHit[]>
}

export class AlertEvaluatorRegistry {
  private readonly items = new Map<string, AlertEvaluator>()
  register(evaluator: AlertEvaluator) {
    if (this.items.has(evaluator.type)) throw new Error(`预警评估器重复注册：${evaluator.type}`)
    this.items.set(evaluator.type, evaluator)
    return this
  }
  find(type: string) {
    return this.items.get(type)
  }
  get size() {
    return this.items.size
  }
}

export interface EvaluationResult {
  rules: number
  created: number
  refreshed: number
  resolved: number
  skippedCooldown: number
  errors: number
}

const severityOf = (value: string): 'INFO' | 'WARNING' | 'CRITICAL' => (SEVERITIES.includes(value) ? (value as 'INFO' | 'WARNING' | 'CRITICAL') : 'WARNING')

function toRuleView(row: {
  id: string
  code: string
  domain: string
  name: string
  severity: string
  cooldownMinutes: number
  currentVersion: number
  conditionJson: unknown
  scopeJson: unknown
  conditionGroups?: unknown
  notifyFrequency?: string
  escalation?: unknown
}): AlertRuleView | null {
  const condition = row.conditionJson as { type?: unknown; params?: unknown } | null
  if (!condition || typeof condition.type !== 'string') return null
  const params = condition.params && typeof condition.params === 'object' ? (condition.params as Record<string, unknown>) : undefined
  const scope = row.scopeJson && typeof row.scopeJson === 'object' && !Array.isArray(row.scopeJson) ? (row.scopeJson as Record<string, unknown>) : {}
  return {
    id: row.id,
    code: row.code,
    domain: row.domain,
    name: row.name,
    severity: row.severity,
    cooldownMinutes: row.cooldownMinutes,
    currentVersion: row.currentVersion,
    condition: { type: condition.type, params },
    scope,
    conditionGroups: row.conditionGroups && typeof row.conditionGroups === 'object' && !Array.isArray(row.conditionGroups) ? (row.conditionGroups as ConditionGroups) : null,
    notifyFrequency: isNotifyFrequency(row.notifyFrequency) ? row.notifyFrequency : 'IMMEDIATE',
    escalation: readEscalation(row.escalation),
  }
}

async function slaHours(db: PrismaClient, tenantId: string): Promise<Record<WorkSeverity, number>> {
  const row = await db.tenantSetting.findFirst({ where: { tenantId, sellerAccountId: null, key: 'work.sla.hours' } })
  const stored = row?.valueJson && typeof row.valueJson === 'object' ? (row.valueJson as Record<string, unknown>) : {}
  const pick = (key: WorkSeverity) => (typeof stored[key] === 'number' && stored[key] > 0 ? (stored[key] as number) : WORK_DEFAULT_SLA_HOURS[key])
  return { INFO: pick('INFO'), WARNING: pick('WARNING'), CRITICAL: pick('CRITICAL') }
}

/** 预警实例上的展示列（标题、对象名称、建议、影响金额区间），每次命中都刷新为评估器给的最新值。 */
function displayOf(rule: AlertRuleView, hit: AlertHit) {
  return {
    title: (hit.title ?? rule.name).slice(0, 200),
    entityLabel: hit.entityLabel?.slice(0, 200) ?? null,
    suggestedAction: hit.suggestedAction?.slice(0, 500) ?? null,
    impactMin: hit.impact ? Math.min(hit.impact.min, hit.impact.max) : null,
    impactMax: hit.impact ? Math.max(hit.impact.min, hit.impact.max) : null,
    currency: hit.impact ? (hit.impact.currency ?? 'USD') : null,
  }
}

interface RaiseContext {
  now: Date
  hours: Record<WorkSeverity, number>
  /** 企业时区，静默时段按它计时 */
  zone: string | null
}

async function raise(db: PrismaClient, tenantId: string, rule: AlertRuleView, hit: AlertHit, dedupKey: string, context: RaiseContext): Promise<boolean> {
  const { now, hours } = context
  const severity = severityOf(rule.severity)
  const ownerId = await chooseOwner(db, tenantId, rule.scope)
  const display = displayOf(rule, hit)
  const title = display.title
  let workItemId: string | null
  let alertId = ''
  try {
    workItemId = await db.$transaction(async tx => {
      const instance = await tx.alertInstance.create({
        data: {
          tenantId,
          sellerAccountId: hit.sellerAccountId ?? null,
          ruleId: rule.id,
          ruleVersionNo: rule.currentVersion,
          entityType: hit.entityType,
          entityId: hit.entityId,
          severity,
          status: 'NEW',
          // 用本轮评估时钟，不用数据库 now()。冷却、升级和静默补发都按这个时刻算。
          firstTriggeredAt: now,
          lastTriggeredAt: now,
          evidenceJson: hit.evidence as Prisma.InputJsonValue,
          dedupKey,
          ...display,
        },
      })
      alertId = instance.id
      if (!ownerId) return null
      const work = await tx.workItem.create({
        data: {
          tenantId,
          sellerAccountId: hit.sellerAccountId ?? null,
          title,
          kind: rule.domain,
          source: 'ALERT',
          severity,
          priority: severity === 'CRITICAL' ? 'URGENT' : severity === 'WARNING' ? 'HIGH' : 'NORMAL',
          dueAt: new Date(now.getTime() + hours[severity] * 3_600_000),
          sourceAlertId: instance.id,
          ruleCode: rule.code,
          entityType: hit.entityType,
          entityId: hit.entityId,
          entityLabel: hit.entityLabel?.slice(0, 200),
          suggestedAction: hit.suggestedAction?.slice(0, 500),
          ...(hit.impact ? { impactMin: Math.min(hit.impact.min, hit.impact.max), impactMax: Math.max(hit.impact.min, hit.impact.max), currency: hit.impact.currency ?? 'USD' } : {}),
          ownerId,
          createdBy: ownerId,
        },
      })
      await tx.alertInstance.update({ where: { id: instance.id }, data: { workItemId: work.id } })
      return work.id
    })
  } catch (error) {
    // 并发的另一个进程刚创建了同一条开放实例（部分唯一索引）：视为已存在
    if ((error as { code?: string }).code === 'P2002') return false
    throw error
  }
  // 预警与待办照常生成；站内通知按规则的通知频率与静默时段决定：频率不是“立即”或处在静默时段的，并入汇总批次稍后补发（P6-16）；严重级别不受限制，立即发
  const deferred = ownerId && workItemId ? await deferNotice(db, tenantId, rule, alertId, severity, now, context.zone).catch(() => false) : false
  if (ownerId && workItemId && !deferred) {
    await notifyUsers(db, tenantId, await recipientsOf(db, tenantId, rule.scope, ownerId), {
      kind: 'ALERT_RULE',
      // 个人通知偏好按业务域判断，预警规则自带业务域
      domain: rule.domain,
      title,
      body: hit.suggestedAction ?? `预警规则“${rule.name}”已触发，请处理`,
      link: entityDetailPath('WORK_ITEM', workItemId) ?? undefined,
      severity,
      dedupKey: `alert-rule:${dedupKey}:${now.toISOString().slice(0, 10)}`,
    }).catch(() => 0)
  }
  return true
}

interface OpenInstance {
  id: string
  lastTriggeredAt: Date
  triggerCount: number
  workItemId: string | null
}

/**
 * 并入上一条还没处理的预警（P6-15）：计数加一、刷新最近触发时间、证据与展示列；不重复建待办。
 * - 冷却期之内（距上次命中不足冷却分钟数，评估持续命中时就是这种情况）：安静地并入，不通知、不改已读；
 * - 冷却期之外（评估中断或规则停用后重新启用，距上次命中已超过冷却分钟数，上一条仍没处理）：并入之后清掉所有人的“已读”，
 *   让它重新出现在未读里，并提醒待办负责人一次（静默时段内、严重度以外的不提醒）；冷却分钟数为 0 的规则没有“冷却期”，一律按冷却期之内处理。
 * 重新提醒只是尽力而为：失败不影响并入，也不计入规则的错误数。
 */
async function mergeIntoOpen(db: PrismaClient, tenantId: string, rule: AlertRuleView, hit: AlertHit, open: OpenInstance, context: { now: Date; zone: string | null }) {
  const { now } = context
  const count = open.triggerCount + 1
  const afterCooldown = rule.cooldownMinutes > 0 && now.getTime() - open.lastTriggeredAt.getTime() >= rule.cooldownMinutes * 60_000
  await db.alertInstance.update({
    where: { id: open.id },
    data: { lastTriggeredAt: now, triggerCount: { increment: 1 }, evidenceJson: hit.evidence as Prisma.InputJsonValue, ...displayOf(rule, hit) },
  })
  if (!afterCooldown) return
  try {
    await db.alertRead.deleteMany({ where: { tenantId, alertId: open.id } })
    const work = open.workItemId ? await db.workItem.findFirst({ where: { id: open.workItemId, tenantId }, select: { id: true, ownerId: true } }) : null
    if (!work) return
    const severity = severityOf(rule.severity)
    // 静默时段或汇总频率的规则：并入汇总批次稍后补发，不逐条提醒（P6-16）
    if (await deferNotice(db, tenantId, rule, open.id, severity, now, context.zone)) return
    const title = displayOf(rule, hit).title
    await notifyUsers(db, tenantId, await recipientsOf(db, tenantId, rule.scope, work.ownerId), {
      kind: 'ALERT_RULE',
      domain: rule.domain,
      title,
      body: `预警“${rule.name}”再次触发（累计 ${count} 次），上一条还没有处理`,
      link: entityDetailPath('WORK_ITEM', work.id) ?? undefined,
      severity,
      dedupKey: `alert-rule-merge:${open.id}:${now.toISOString().slice(0, 10)}`,
    })
  } catch {
    // 重新提醒失败不影响并入
  }
}

/** 评估一个企业的全部启用规则（调用方负责进入该企业的租户上下文）。 */
export async function evaluateTenantRules(deps: { db: PrismaClient; registry: AlertEvaluatorRegistry; now?: () => Date }, tenantId: string): Promise<EvaluationResult> {
  const { db, registry } = deps
  const now = (deps.now ?? (() => new Date()))()
  const result: EvaluationResult = { rules: 0, created: 0, refreshed: 0, resolved: 0, skippedCooldown: 0, errors: 0 }
  if (registry.size === 0) return result
  const rows = await db.alertRule.findMany({ where: { tenantId, enabled: true }, take: 500 })
  const hours = await slaHours(db, tenantId)
  const zone = (await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }))?.timezone ?? null
  for (const row of rows) {
    const base = toRuleView(row)
    const evaluator = base ? registry.find(base.condition.type) : undefined
    if (!base || !evaluator) continue
    result.rules += 1
    try {
      // 规则范围里的主体、品类展开成店铺、SKU（展开失败只影响这一条规则，计入错误数）
      const rule: AlertRuleView = { ...base, scope: await expandRuleScope(db, tenantId, base.scope) }
      const hits = (await evaluator.evaluate({ db, tenantId, rule, now })).slice(0, MAX_HITS_PER_RULE)
      const seen = new Set<string>()
      for (const hit of hits) {
        const dedupKey = `${rule.id}:${hit.entityType}:${hit.entityId}`
        if (seen.has(dedupKey)) continue
        seen.add(dedupKey)
        const open = await db.alertInstance.findFirst({
          where: { tenantId, ruleId: rule.id, dedupKey, status: { in: OPEN } },
          select: { id: true, lastTriggeredAt: true, triggerCount: true, workItemId: true },
        })
        if (open) {
          await mergeIntoOpen(db, tenantId, rule, hit, open, { now, zone })
          result.refreshed += 1
          continue
        }
        const since = new Date(now.getTime() - rule.cooldownMinutes * 60_000)
        const recent = await db.alertInstance.findFirst({ where: { tenantId, ruleId: rule.id, dedupKey, status: { notIn: OPEN }, lastTriggeredAt: { gt: since } }, select: { id: true } })
        if (recent) {
          result.skippedCooldown += 1
          continue
        }
        if (await raise(db, tenantId, rule, hit, dedupKey, { now, hours, zone })) result.created += 1
        else result.refreshed += 1
      }
      const stale = await db.alertInstance.findMany({ where: { tenantId, ruleId: rule.id, status: { in: OPEN }, dedupKey: { notIn: [...seen] } }, select: { id: true }, take: 1000 })
      if (stale.length > 0) {
        await db.alertInstance.updateMany({ where: { tenantId, id: { in: stale.map(item => item.id) }, status: { in: OPEN } }, data: { status: 'AUTO_CLOSED', resolvedAt: now } })
        result.resolved += stale.length
      }
    } catch {
      result.errors += 1
    }
  }
  return result
}

export interface AlertScanDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  registry: AlertEvaluatorRegistry
  now?: () => Date
  /** 评估前为企业补齐预置规则（已在企业的租户上下文里调用）；失败只记日志，不影响已有规则的评估。 */
  provision?: (db: PrismaClient, tenantId: string) => Promise<unknown>
  logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
}

/**
 * 评估之后的通知跟进（P6-16）：发出到期的汇总批次（通知频率、静默结束补发），推进“未确认”预警的升级链。
 * 两件事互不影响，任何一个失败只记日志，不影响本轮评估结果与另一件事。
 */
async function followUpTenant(deps: AlertScanDeps, tenantId: string) {
  const now = (deps.now ?? (() => new Date()))()
  const zone = (await deps.db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } }))?.timezone ?? null
  await flushDigests(deps.db, tenantId, now, zone).catch(error =>
    deps.logger.warn({ event: 'alert_digest_failed', error: error instanceof Error ? error.message : String(error) }, 'alert digests could not be sent'),
  )
  await runEscalations(deps.db, tenantId, now).catch(error =>
    deps.logger.warn({ event: 'alert_escalation_failed', error: error instanceof Error ? error.message : String(error) }, 'alert escalations could not run'),
  )
}

/** 定时任务：逐个企业评估；没有注册评估器时不做任何数据库访问。 */
export async function evaluateAllTenants(deps: AlertScanDeps) {
  if (deps.registry.size === 0) return { tenants: 0, created: 0 }
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let created = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, async () => {
        if (deps.provision)
          await deps
            .provision(deps.db, tenant.id)
            .catch(error => deps.logger.warn({ event: 'alert_provision_failed', error: error instanceof Error ? error.message : String(error) }, 'default alert rules could not be provisioned'))
        const evaluated = await evaluateTenantRules({ db: deps.db, registry: deps.registry, now: deps.now }, tenant.id)
        await followUpTenant(deps, tenant.id)
        return evaluated
      })
      created += result.created
      if (result.errors > 0) deps.logger.warn({ event: 'alert_rule_errors', errors: result.errors }, 'some alert rules failed to evaluate')
    } catch (error) {
      deps.logger.warn({ event: 'alert_tenant_failed', error: error instanceof Error ? error.message : String(error) }, 'alert evaluation failed for a tenant')
    }
  }
  return { tenants: tenants.length, created }
}
