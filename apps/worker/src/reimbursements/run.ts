import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { detectInbound } from './detect-inbound.js'
import { detectLedger } from './detect-ledger.js'
import { detectRefundNoReturn, detectReturnDisposition } from './detect-returns.js'
import { detectRemovalLost } from './detect-removal.js'
import { matchPayouts, type MatchResult } from './match.js'
import { expireOverdue, loadWindows } from './opportunity-write.js'
import { newContext, type ScanResult } from './scan.js'

// 赔付中心的定时扫描（P2b-03）：逐个企业，在企业的租户上下文里依次做 ① 官方赔付明细匹配案件（先于检测，让刚到账的缺口不再被当成机会）
// ② 6 类机会检测（第 6 类“费用多收”依赖费用对账，尚未接入，不扫描） ③ 过了申请期限的待处理机会转为已过期。
// 单类检测出错不拖垮其它类，单个企业出错不拖垮其它企业。

export const REIMBURSEMENT_SCAN_INTERVAL_MS = 3 * 60 * 60 * 1000

export interface TenantScan {
  rules: ScanResult[]
  expired: number
  match: MatchResult
  errors: string[]
}

type Logger = { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function scanTenant(db: PrismaClient, tenantId: string, now: Date = new Date()): Promise<TenantScan> {
  const errors: string[] = []
  const guard = async <T>(name: string, run: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await run()
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
      return fallback
    }
  }
  const windows = await loadWindows(db, tenantId)
  const ctx = newContext(db, tenantId, now, windows)
  const match = await guard('match', () => matchPayouts(db, tenantId, now), { matched: 0, paid: 0 })
  const rules: ScanResult[] = []
  for (const [name, run] of [
    ['inbound', async () => [await detectInbound(ctx)]],
    ['ledger', () => detectLedger(ctx)],
    ['refund-no-return', async () => [await detectRefundNoReturn(ctx)]],
    ['return-disposition', async () => [await detectReturnDisposition(ctx)]],
    ['removal', async () => [await detectRemovalLost(ctx)]],
  ] as const) {
    rules.push(...(await guard(name, run, [] as ScanResult[])))
  }
  const expired = await guard('expire', () => expireOverdue(db, tenantId, now), 0)
  return { rules, expired, match, errors }
}

export interface ScanAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  logger: Logger
  now?: () => Date
}

export async function scanAllTenants(deps: ScanAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let created = 0
  let matched = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => scanTenant(deps.db, tenant.id, deps.now?.() ?? new Date()))
      created += result.rules.reduce((sum, item) => sum + item.created, 0)
      matched += result.match.matched
      if (result.errors.length > 0) deps.logger.warn({ event: 'reimbursement_scan_errors', errors: result.errors }, 'some reimbursement scans failed')
    } catch (error) {
      deps.logger.warn({ event: 'reimbursement_scan_failed', error: error instanceof Error ? error.message : String(error) }, 'reimbursement scan failed for a tenant')
    }
  }
  return { tenants: tenants.length, created, matched }
}
