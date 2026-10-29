import { DAYPARTING_GRID_SIZE, DAYPARTING_TARGET_LIMIT, daypartingDueOf, type AdsWriteOp, type DaypartingKind, type DaypartingLevel } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { Prisma, PrismaClient } from '@prisma/client'
import { submitAutoWrite, type AutoWriteResult } from '../ads-write/submit'
import type { QueueRegistry } from '../runtime/queues'

// 分时策略的调度执行（P3-17，08 章 8.9）：每 30 分钟对每个已启用的策略，按策略自己的时区取“此刻所在的小时格”，
// 对策略范围里的每个对象提交写入（来源 DAYPARTING，需要动作开关与“分时策略执行”开关），与当前值相同的不提交。
// 一个策略 × 对象 × 小时只记一行（DaypartingRun 的唯一键含小时起点），同一小时内再次扫描不重复提交；
// 启停策略：暂停（0）或启用（1）活动或广告组；竞价系数策略：广告组把默认竞价改为“基准竞价 × 系数”（保留两位小数）；
// 活动没有可以按系数改的竞价字段，活动级的竞价系数策略每小时只记为已跳过并写明原因。

export const DAYPARTING_SCAN_INTERVAL_MS = 30 * 60 * 1000
const STRATEGY_LIMIT = 500
const HOUR_MS = 3_600_000

type Queues = Pick<QueueRegistry, 'addSync'>
type Logger = { warn(fields: Record<string, unknown>, message: string): void }

export interface TenantDaypartingScan {
  strategies: number
  queued: number
  skipped: number
  failed: number
  errors: string[]
}

const gridOf = (json: unknown): number[] => (Array.isArray(json) && json.length === DAYPARTING_GRID_SIZE && json.every(value => typeof value === 'number') ? (json as number[]) : [])
const idsOf = (json: unknown): string[] => {
  const ids = json && typeof json === 'object' ? (json as { ids?: unknown }).ids : null
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string').slice(0, DAYPARTING_TARGET_LIMIT) : []
}

/** 此刻、这个对象应该写什么；写不了的给原因。 */
function opOf(kind: DaypartingKind, level: DaypartingLevel, entityId: string, value: number, baseBid: number | null): AdsWriteOp | string {
  if (kind === 'ON_OFF') return { kind: level === 'CAMPAIGN' ? 'CAMPAIGN_STATE' : 'AD_GROUP_STATE', entityId, state: value === 0 ? 'PAUSED' : 'ENABLED' }
  if (level === 'CAMPAIGN') return '活动没有可以按系数调整的竞价字段，活动级的竞价系数策略不会写亚马逊；请改用广告组级策略'
  if (baseBid === null) return '策略没有设置基准竞价，没有提交'
  return { kind: 'AD_GROUP_BID', entityId, amount: Math.round(baseBid * value * 100) / 100 }
}

const recordOf = (result: AutoWriteResult) =>
  result.status === 'QUEUED'
    ? { outcome: 'QUEUED', message: '已提交写入，等待亚马逊确认', writeRunId: result.runId }
    : result.status === 'FAILED'
      ? { outcome: 'FAILED', message: result.reason.slice(0, 500), writeRunId: result.runId }
      : { outcome: 'SKIPPED', message: result.reason.slice(0, 500), writeRunId: null }

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function runTenantDayparting(db: PrismaClient, tenantId: string, queues: Queues, now: Date = new Date()): Promise<TenantDaypartingScan> {
  const result: TenantDaypartingScan = { strategies: 0, queued: 0, skipped: 0, failed: 0, errors: [] }
  const runAt = new Date(Math.floor(now.getTime() / HOUR_MS) * HOUR_MS)
  const strategies = await db.daypartingStrategy.findMany({ where: { tenantId, status: 'ACTIVE' }, orderBy: { id: 'asc' }, take: STRATEGY_LIMIT })
  for (const strategy of strategies) {
    try {
      const kind = strategy.kind as DaypartingKind
      const level = strategy.targetLevel as DaypartingLevel
      const due = daypartingDueOf(kind, gridOf(strategy.hourlyMultipliersJson), strategy.timezone, now)
      if (due.value === null) continue
      result.strategies += 1
      const ids = idsOf(strategy.scopeJson)
      const done = await db.daypartingRun.findMany({ where: { tenantId, strategyId: strategy.id, runAt, entityId: { in: ids } }, select: { entityId: true }, take: ids.length })
      const recorded = new Set(done.map(row => row.entityId))
      for (const entityId of ids.filter(id => !recorded.has(id))) {
        const op = opOf(kind, level, entityId, due.value, strategy.baseBid === null ? null : Number(strategy.baseBid))
        const outcome =
          typeof op === 'string'
            ? ({ status: 'SKIPPED', reason: op } as const)
            : await submitAutoWrite({ db, queues }, { tenantId, source: 'DAYPARTING', op, requestId: `dayparting:${strategy.id}:${runAt.toISOString()}` })
        const record = recordOf(outcome)
        await db.daypartingRun.createMany({
          data: [{ tenantId, strategyId: strategy.id, entityId, hour: due.hour, appliedMultiplier: due.value, executed: false, runAt, ...record } satisfies Prisma.DaypartingRunCreateManyInput],
          skipDuplicates: true,
        })
        if (outcome.status === 'QUEUED') result.queued += 1
        else if (outcome.status === 'FAILED') result.failed += 1
        else result.skipped += 1
      }
    } catch (error) {
      result.errors.push(`${strategy.id}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
    }
  }
  return result
}

export interface DaypartingAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  queues: Queues
  logger: Logger
  now?: () => Date
}

export async function runAllTenantsDayparting(deps: DaypartingAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let queued = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => runTenantDayparting(deps.db, tenant.id, deps.queues, deps.now?.() ?? new Date()))
      queued += result.queued
      if (result.errors.length > 0) deps.logger.warn({ event: 'ads_dayparting_errors', errors: result.errors }, 'some dayparting strategies failed')
    } catch (error) {
      deps.logger.warn({ event: 'ads_dayparting_failed', error: error instanceof Error ? error.message : String(error) }, 'dayparting run failed for a tenant')
    }
  }
  return { tenants: tenants.length, queued }
}
