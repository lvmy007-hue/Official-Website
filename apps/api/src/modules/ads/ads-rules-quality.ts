import { ADS_RULE_EFFECT_DAYS, ADS_RULE_QUALITY_DAYS, defaultAsOf, effectPairOf, summarizeEffect, type AdsRuleDay, type AdsRuleEffect, type AdsRuleQuality } from '@nova/api-contracts'
import type { PrismaService } from '../../platform/prisma.service'
import { localDate } from '../overview'
import { levelOf, specOf, type RuleRecord } from './ads-rules-common'
import { loadRuleSubjects } from './ads-rules-load'

// 规则质量（P3-13，08 章 8.10 的“规则质量统计”）：最近一次评估的命中率、近 30 天的执行记录、建议生成的待办被采纳的比例、已执行动作前后 7 天的效果。
// 全部来自本系统自己的记录，没有数据写“尚无记录”，不当 0；效果只在真的执行过动作之后才有（自动执行随 P3-17，之前永远是“尚未接入”）。

const DAY_MS = 86_400_000
const EFFECT_HISTORY_DAYS = ADS_RULE_QUALITY_DAYS + ADS_RULE_EFFECT_DAYS + 3
const OBJECT_COUNT_LIMIT = 5000
const WORK_ITEM_LIMIT = 2000
const EFFECT_RUN_LIMIT = 200

/** 已执行动作的前后对比：读这些对象的日指标，按动作当天（企业时区）切前后各 7 天。 */
async function loadEffect(prisma: PrismaService, tenantId: string, record: RuleRecord, now: Date, zone: string, since: Date): Promise<AdsRuleEffect> {
  const runs = await prisma.adsAutomationRun.findMany({
    where: { tenantId, ruleId: record.id, executed: true, runAt: { gte: since } },
    select: { entityKey: true, runAt: true },
    orderBy: [{ runAt: 'desc' }, { id: 'asc' }],
    take: EFFECT_RUN_LIMIT,
  })
  if (runs.length === 0) return summarizeEffect([], 0)
  const spec = specOf(record)
  const { subjects, incomplete } = await loadRuleSubjects(prisma, {
    tenantId,
    adsProfileId: record.adsProfileId,
    level: levelOf(record.level),
    campaignIds: spec.campaignIds,
    asOf: defaultAsOf(localDate(now, zone)),
    historyDays: EFFECT_HISTORY_DAYS,
  })
  const daysByKey = new Map<string, readonly AdsRuleDay[]>(subjects.map(subject => [subject.key, subject.daily]))
  const pairs = runs.flatMap(run => {
    const days = daysByKey.get(run.entityKey)
    const pair = days ? effectPairOf(days, localDate(run.runAt, zone)) : null
    return pair ? [pair] : []
  })
  const effect = summarizeEffect(pairs, runs.length)
  return incomplete && effect.state === 'OK' ? { ...effect, note: `${effect.note ?? ''}；对象或指标行太多，读取不完整，结果可能偏少` } : effect
}

export async function ruleQuality(prisma: PrismaService, tenantId: string, record: RuleRecord, now: Date, zone: string): Promise<AdsRuleQuality> {
  const since = new Date(now.getTime() - ADS_RULE_QUALITY_DAYS * DAY_MS)
  const runWhere = { tenantId, ruleId: record.id, runAt: { gte: since } }
  const [outcomes, objects, linked] = await Promise.all([
    prisma.adsAutomationRun.groupBy({ by: ['outcome'], where: runWhere, _count: { _all: true }, orderBy: { outcome: 'asc' } }),
    prisma.adsAutomationRun.groupBy({ by: ['entityKey'], where: runWhere, orderBy: { entityKey: 'asc' }, take: OBJECT_COUNT_LIMIT }),
    prisma.adsAutomationRun.findMany({ where: { ...runWhere, workItemId: { not: null } }, select: { workItemId: true }, orderBy: [{ runAt: 'desc' }, { id: 'asc' }], take: WORK_ITEM_LIMIT }),
  ])
  const countOf = (outcome: string) => outcomes.find(row => row.outcome === outcome)?._count._all ?? 0
  const workIds = [...new Set(linked.flatMap(row => (row.workItemId ? [row.workItemId] : [])))]
  const [openCount, closed] =
    workIds.length === 0
      ? [0, []]
      : await Promise.all([
          prisma.workItem.count({ where: { tenantId, id: { in: workIds }, closedAt: null } }),
          prisma.workItem.groupBy({ by: ['closeConclusion'], where: { tenantId, id: { in: workIds }, closedAt: { not: null } }, _count: { _all: true }, orderBy: { closeConclusion: 'asc' } }),
        ])
  const closedOf = (conclusion: string) => closed.find(row => row.closeConclusion === conclusion)?._count._all ?? 0
  const handled = closedOf('HANDLED')
  const notNeeded = closedOf('NOT_NEEDED')
  const falsePositive = closedOf('FALSE_POSITIVE')
  const closedTotal = handled + notNeeded + falsePositive

  const evaluated = record.lastEvaluated
  const hitRate = evaluated !== null && evaluated > 0 && record.lastMatched !== null ? record.lastMatched / evaluated : null
  const runs = outcomes.reduce((sum, row) => sum + row._count._all, 0)
  const notes: string[] = []
  if (!record.lastRunAt) notes.push('这条规则还没有被评估过：启用后按执行频率自动评估，也可以先试运行')
  else if (evaluated === 0) notes.push('最近一次评估时，范围内没有符合条件的对象可评估（对象还没有同步，或被范围与文本过滤排除了）')
  if (runs === 0 && record.lastRunAt) notes.push(`近 ${ADS_RULE_QUALITY_DAYS} 天没有命中记录`)
  if (workIds.length >= WORK_ITEM_LIMIT) notes.push(`生成的待办很多，采纳率只统计最近 ${WORK_ITEM_LIMIT} 个`)
  if (objects.length >= OBJECT_COUNT_LIMIT) notes.push(`命中的对象超过 ${OBJECT_COUNT_LIMIT} 个，对象数只统计到这里`)

  return {
    windowDays: ADS_RULE_QUALITY_DAYS,
    lastScan: { at: record.lastRunAt?.toISOString() ?? null, evaluated, matched: record.lastMatched, hitRate },
    recent: { runs, suggested: countOf('SUGGESTED'), applied: countOf('APPLIED'), skipped: countOf('SKIPPED'), failed: countOf('FAILED'), objects: objects.length },
    adoption: {
      state: workIds.length === 0 ? 'NO_DATA' : 'OK',
      open: openCount,
      handled,
      notNeeded,
      falsePositive,
      adoptionRate: closedTotal > 0 ? handled / closedTotal : null,
    },
    effect: await loadEffect(prisma, tenantId, record, now, zone, since),
    notes,
  }
}
