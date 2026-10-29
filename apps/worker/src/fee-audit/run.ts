import { FEE_AUDIT_WINDOW_DAYS } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { auditPlacement } from './check-placement'
import { auditOrderLines } from './check-lines'
import { auditStorage } from './check-storage'
import { shiftDays, startOfDay, type AuditContext, type AuditResult } from './shared'
import { pruneOld, writeResults } from './write'

// 费用核查的定时任务（P2b-06）：逐个企业，在企业的租户上下文里依次做配送费、佣金、仓储费、入仓配置费四类核查并写入结果，再清理过期数据。
// 单类核查出错不拖垮其它类（出错的那一类本轮不动旧结果），单个企业出错不拖垮其它企业。核查结果是疑似多收，不是亚马逊认可的结论。

export const FEE_AUDIT_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface TenantAudit {
  results: Array<{ kind: AuditResult['kind']; subjects: number; suspected: number; truncated: boolean }>
  written: number
  removed: number
  errors: string[]
}

type Logger = { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function auditTenant(db: PrismaClient, tenantId: string, now: Date = new Date()): Promise<TenantAudit> {
  const today = startOfDay(now)
  // 清理“本轮没再产出的当日旧行”用真实时钟（行的更新时间是写入时的真实时刻），不用可注入的 now
  const startedAt = new Date()
  const ctx: AuditContext = { db, tenantId, now, today, since: shiftDays(today, -FEE_AUDIT_WINDOW_DAYS) }
  const errors: string[] = []
  const results: AuditResult[] = []
  for (const [name, run] of [
    ['fulfillment', () => auditOrderLines(ctx, 'FULFILLMENT')],
    ['commission', () => auditOrderLines(ctx, 'COMMISSION')],
    ['storage', () => auditStorage(ctx)],
    ['placement', () => auditPlacement(ctx)],
  ] as const) {
    try {
      results.push(await run())
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
    }
  }
  let written = 0
  let removed = 0
  try {
    const outcome = await writeResults(ctx, results, startedAt)
    written = outcome.written
    removed = outcome.removed
    await pruneOld(ctx)
  } catch (error) {
    errors.push(`write: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
  }
  return {
    results: results.map(result => ({ kind: result.kind, subjects: result.subjects.length, suspected: result.subjects.filter(item => item.occurrences > 0).length, truncated: result.truncated })),
    written,
    removed,
    errors,
  }
}

export interface AuditAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  logger: Logger
  now?: () => Date
}

export async function auditAllTenants(deps: AuditAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let written = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => auditTenant(deps.db, tenant.id, deps.now?.() ?? new Date()))
      written += result.written
      if (result.errors.length > 0) deps.logger.warn({ event: 'fee_audit_errors', errors: result.errors }, 'some fee audits failed')
    } catch (error) {
      deps.logger.warn({ event: 'fee_audit_failed', error: error instanceof Error ? error.message : String(error) }, 'fee audit failed for a tenant')
    }
  }
  return { tenants: tenants.length, written }
}
