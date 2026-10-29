import {
  ADS_RULE_ACTION_LABEL,
  ADS_RULE_METRIC_INFO,
  defaultAsOf,
  describeAction,
  describeRuleSpec,
  entityDetailPath,
  evaluateRule,
  evidenceKey,
  formatRuleValue,
  ruleDueOf,
  type AdsRuleHit,
  type AdsRuleSpec,
} from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { Prisma, PrismaClient } from '@prisma/client'
import { holdersOf, notifyUsers } from '../platform/notify'
import type { QueueRegistry } from '../runtime/queues'
import { canAutoExecute, executeRuleHit } from './execute'
import { latestDataDate, loadRuleSubjects } from './load'
import { localDay, specOfRule } from './spec'

// 自动规则的定时评估（P3-13，08 章 8.10）：每半小时检查一次，到期的“已启用”规则（按执行频率）评估一遍，命中的对象生成待办并留下执行记录。
// 建议模式命中只生成待办；自动执行模式（P3-17）命中活动或投放词时提交写入（execute.ts：需要动作开关与“自动规则执行”开关，条件不满足记为已跳过并写明原因），搜索词层级仍只生成待办。
// 规则：已有未处理待办的对象不重复生成；每个规则 24 小时内最多处理“每日执行次数上限”个对象，超出的（按花费从高到低取舍）记为跳过；
// 广告账户从没有日指标时不评估也不记录（不把“没有数据”当成“没有命中”）；单条规则出错不拖垮其它规则，也不更新它的评估时间（下一轮重试）。

export const ADS_RULE_SCAN_INTERVAL_MS = 30 * 60 * 1000
const RULE_LIMIT = 500
const DAY_MS = 86_400_000
const WORK_DUE_HOURS = 72
const SKIPPED_ROW_CAP = 50
const AUTO_TODO_NOTE = '自动执行模式在这里只生成待办（搜索词层级需要所属广告组），没有改变亚马逊账户'
const HISTORY_LIMIT = 5000

export interface TenantScan {
  /** 到期并真正评估了的规则数。 */
  rules: number
  /** 生成的待办（执行记录）数。 */
  suggested: number
  /** 自动执行提交了写入的对象数（等亚马逊确认）。 */
  queued: number
  /** 因超过每日上限记为跳过的行数。 */
  skipped: number
  /** 广告账户没有日指标而没评估的规则数。 */
  noData: number
  errors: string[]
}

type Logger = { warn(fields: Record<string, unknown>, message: string): void }

function evidenceText(spec: AdsRuleSpec, hit: AdsRuleHit): string {
  return spec.conditions
    .map(condition => `近 ${condition.windowDays} 天${ADS_RULE_METRIC_INFO[condition.metric].label} ${formatRuleValue(condition.metric, hit.metrics[evidenceKey(condition)] ?? null)}`)
    .join('；')
}

/** 待办负责人：规则的创建人（须仍在职且有规则权限），否则第一位有规则权限的在职成员；没有就没有负责人。 */
async function chooseOwner(db: PrismaClient, tenantId: string, createdBy: string): Promise<string | null> {
  const holders = await holdersOf(db, tenantId, 'ads.rule.write')
  return holders.includes(createdBy) ? createdBy : (holders[0] ?? null)
}

/** 已有未处理待办的对象（规则 + 对象 + 动作）：不重复提醒。 */
async function openKeys(db: PrismaClient, tenantId: string, ruleId: string, since: Date): Promise<Set<string>> {
  const runs = await db.adsAutomationRun.findMany({
    where: { tenantId, ruleId, outcome: 'SUGGESTED', workItemId: { not: null }, runAt: { gte: since } },
    select: { entityKey: true, actionType: true, workItemId: true },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: HISTORY_LIMIT,
  })
  const ids = [...new Set(runs.flatMap(run => (run.workItemId ? [run.workItemId] : [])))]
  if (ids.length === 0) return new Set()
  const open = await db.workItem.findMany({ where: { tenantId, id: { in: ids }, closedAt: null }, select: { id: true }, orderBy: { id: 'asc' }, take: HISTORY_LIMIT })
  const openIds = new Set(open.map(item => item.id))
  return new Set(runs.filter(run => run.workItemId && openIds.has(run.workItemId)).map(run => `${run.entityKey}|${run.actionType}`))
}

interface RuleRecord {
  id: string
  tenantId: string
  adsProfileId: string
  name: string
  mode: string
  frequency: string
  lastRunAt: Date | null
  version: number
  createdBy: string
  updatedAt: Date
  level: string
  scopeJson: unknown
  conditionJson: unknown
  actionJson: unknown
  guardrailJson: unknown
  adsProfile: { sellerAccountId: string | null }
}

type Queues = Pick<QueueRegistry, 'addSync'>

async function scanRule(db: PrismaClient, rule: RuleRecord, asOf: string, now: Date, result: TenantScan, queues?: Queues): Promise<void> {
  const spec = specOfRule(rule)
  if ((await latestDataDate(db, rule.tenantId, rule.adsProfileId)) === null) {
    result.noData += 1
    return
  }
  const { subjects } = await loadRuleSubjects(db, { tenantId: rule.tenantId, adsProfileId: rule.adsProfileId, level: spec.level, campaignIds: spec.campaignIds, asOf })
  const evaluation = evaluateRule(spec, subjects, asOf)
  const dayAgo = new Date(now.getTime() - DAY_MS)
  const [open, used, ownerId] = await Promise.all([
    openKeys(db, rule.tenantId, rule.id, new Date(now.getTime() - 30 * DAY_MS)),
    db.adsAutomationRun.count({ where: { tenantId: rule.tenantId, ruleId: rule.id, outcome: { in: ['SUGGESTED', 'QUEUED', 'APPLIED'] }, runAt: { gte: dayAgo } } }),
    chooseOwner(db, rule.tenantId, rule.createdBy),
  ])
  const fresh = evaluation.hits.filter(hit => !open.has(`${hit.key}|${hit.actionType}`))
  const room = Math.max(0, spec.guardrails.dailyLimit - used)
  const chosen = fresh.slice(0, room)
  const overflow = fresh.slice(room, room + SKIPPED_ROW_CAP)
  const summary = describeRuleSpec(spec)
  const pending = rule.mode === 'AUTO' ? `；${AUTO_TODO_NOTE}` : ''
  const autoExecute = rule.mode === 'AUTO' && queues !== undefined && canAutoExecute(spec.level)

  let suggested = 0
  let queued = 0
  for (const hit of chosen) {
    const label = `${hit.label}${hit.campaignLabel && hit.campaignLabel !== hit.label ? `（${hit.campaignLabel}）` : ''}`
    if (autoExecute) {
      const done = await executeRuleHit({ db, queues }, { id: rule.id, tenantId: rule.tenantId, adsProfileId: rule.adsProfileId, level: spec.level }, hit, now)
      if (done.status === 'QUEUED') queued += 1
      await db.adsAutomationRun.create({
        data: {
          tenantId: rule.tenantId,
          ruleId: rule.id,
          ruleVersion: rule.version,
          entityKey: hit.key,
          entityLabel: label.slice(0, 200),
          actionType: hit.actionType,
          beforeValue: hit.before,
          afterValue: hit.after,
          executed: false,
          outcome: done.status === 'QUEUED' ? 'QUEUED' : done.status === 'FAILED' ? 'FAILED' : 'SKIPPED',
          message: done.status === 'QUEUED' ? '已提交写入，等待亚马逊确认' : done.reason.slice(0, 500),
          writeRunId: done.status === 'SKIPPED' ? null : done.runId,
          evidenceJson: hit.metrics as Prisma.InputJsonValue,
          runAt: now,
        },
      })
      continue
    }
    await db.$transaction(async tx => {
      const work = ownerId
        ? await tx.workItem.create({
            data: {
              tenantId: rule.tenantId,
              sellerAccountId: rule.adsProfile.sellerAccountId,
              title: `自动规则“${rule.name}”建议：${ADS_RULE_ACTION_LABEL[hit.actionType]} ${hit.label}`.slice(0, 200),
              kind: 'ADVERTISING',
              source: 'SYSTEM',
              severity: 'INFO',
              priority: 'NORMAL',
              dueAt: new Date(now.getTime() + WORK_DUE_HOURS * 3_600_000),
              entityType: 'ADS_RULE',
              entityId: rule.id,
              entityLabel: label.slice(0, 200),
              suggestedAction: `${describeAction(spec.action)}${hit.before !== null ? `（${hit.before} → ${hit.after ?? ''}）` : ''}`.slice(0, 500),
              detail:
                `规则条件：${summary.conditions}。触发时：${evidenceText(spec, hit)}。护栏：${summary.guardrails}${hit.notes.length > 0 ? `。${hit.notes.join('；')}` : ''}${pending}。到广告后台确认并处理后关闭待办。`.slice(
                  0,
                  2000,
                ),
              ownerId,
              createdBy: ownerId,
            },
            select: { id: true },
          })
        : null
      await tx.adsAutomationRun.create({
        data: {
          tenantId: rule.tenantId,
          ruleId: rule.id,
          ruleVersion: rule.version,
          entityKey: hit.key,
          entityLabel: label.slice(0, 200),
          actionType: hit.actionType,
          beforeValue: hit.before,
          afterValue: hit.after,
          executed: false,
          outcome: work ? 'SUGGESTED' : 'SKIPPED',
          message: (work ? (rule.mode === 'AUTO' ? AUTO_TODO_NOTE : null) : '没有拥有“自动规则”权限的在职成员可指派待办，本次没有生成待办')?.slice(0, 500) ?? null,
          workItemId: work?.id ?? null,
          evidenceJson: hit.metrics as Prisma.InputJsonValue,
          runAt: now,
        },
      })
      if (work) suggested += 1
    })
  }
  if (overflow.length > 0) {
    await db.adsAutomationRun.createMany({
      data: overflow.map(hit => ({
        tenantId: rule.tenantId,
        ruleId: rule.id,
        ruleVersion: rule.version,
        entityKey: hit.key,
        entityLabel: hit.label.slice(0, 200),
        actionType: hit.actionType,
        beforeValue: hit.before,
        afterValue: hit.after,
        executed: false,
        outcome: 'SKIPPED',
        message: `超过每日执行次数上限（${spec.guardrails.dailyLimit}），本次未处理；按近 30 天花费从高到低取舍`,
        evidenceJson: hit.metrics as Prisma.InputJsonValue,
        runAt: now,
      })),
      skipDuplicates: true,
    })
    result.skipped += overflow.length
  }
  // 评估统计只在评估成功之后更新；updatedAt 保持不变（它表示“上次有人改规则”，不是“上次评估”）
  await db.adsAutomationRule.updateMany({
    where: { id: rule.id, tenantId: rule.tenantId },
    data: { lastRunAt: now, lastEvaluated: evaluation.evaluated, lastMatched: evaluation.matched, updatedAt: rule.updatedAt },
  })
  result.rules += 1
  result.suggested += suggested
  result.queued += queued
  if (queued > 0 && ownerId) {
    await notifyUsers(db, rule.tenantId, [ownerId], {
      kind: 'ADS_RULE',
      title: `自动规则“${rule.name}”已提交 ${queued} 项广告修改`.slice(0, 200),
      body: `${summary.conditions}；已按规则${describeAction(spec.action)}并提交写入，亚马逊确认后记为已执行，结果见规则详情的运行记录。`,
      link: entityDetailPath('ADS_RULE', rule.id) ?? undefined,
      dedupKey: `ads-rule-write:${rule.id}:${now.toISOString()}`,
    }).catch(() => 0)
  }
  if (suggested > 0 && ownerId) {
    await notifyUsers(db, rule.tenantId, [ownerId], {
      kind: 'ADS_RULE',
      title: `自动规则“${rule.name}”命中 ${suggested} 个对象`.slice(0, 200),
      body: `${summary.conditions}；建议${describeAction(spec.action)}。已生成待办，请到待办或规则详情处理。`,
      link: entityDetailPath('ADS_RULE', rule.id) ?? undefined,
      dedupKey: `ads-rule:${rule.id}:${now.toISOString()}`,
    }).catch(() => 0)
  }
}

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function scanTenantRules(db: PrismaClient, tenantId: string, now: Date = new Date(), queues?: Queues): Promise<TenantScan> {
  const result: TenantScan = { rules: 0, suggested: 0, queued: 0, skipped: 0, noData: 0, errors: [] }
  const tenant = await db.tenant.findFirst({ where: { id: tenantId }, select: { timezone: true } })
  const asOf = defaultAsOf(localDay(now, tenant?.timezone))
  const rules = await db.adsAutomationRule.findMany({
    where: { tenantId, status: 'ACTIVE' },
    include: { adsProfile: { select: { sellerAccountId: true } } },
    orderBy: [{ id: 'asc' }],
    take: RULE_LIMIT,
  })
  for (const rule of rules) {
    if (!ruleDueOf(rule.frequency as 'DAILY' | 'EVERY_3_DAYS' | 'WEEKLY', rule.lastRunAt, now)) continue
    try {
      await scanRule(db, rule, asOf, now, result, queues)
    } catch (error) {
      result.errors.push(`${rule.id}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
    }
  }
  return result
}

export interface ScanAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  /** 提供后自动执行模式才会提交写入；不提供时自动模式和建议模式一样只生成待办。 */
  queues?: Queues
  logger: Logger
  now?: () => Date
}

export async function scanAllTenants(deps: ScanAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let suggested = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => scanTenantRules(deps.db, tenant.id, deps.now?.() ?? new Date(), deps.queues))
      suggested += result.suggested
      if (result.errors.length > 0) deps.logger.warn({ event: 'ads_rule_scan_errors', errors: result.errors }, 'some ads rules failed')
    } catch (error) {
      deps.logger.warn({ event: 'ads_rule_scan_failed', error: error instanceof Error ? error.message : String(error) }, 'ads rule scan failed for a tenant')
    }
  }
  return { tenants: tenants.length, suggested }
}
