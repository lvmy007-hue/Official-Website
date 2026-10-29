import { ADS_CHANGE_ENTITY_TYPES } from '@nova/api-contracts'
import { runWithTenant } from '@nova/tenancy'
import type { PrismaClient } from '@prisma/client'
import { emptyScan, scanProfileType, type ProfileScan } from './scan'

// 广告变更的定时识别（P3-14，08 章 8.11）：每半小时对每个企业的每个广告档案、每一类对象做一次快照对比（见 scan.ts）。
// 没同步到广告实体时什么都不会发生（没有对象可读）；单个档案或单类对象出错不拖垮其它，错误带回给调用方记日志，下一轮重试。

export const ADS_CHANGE_SCAN_INTERVAL_MS = 30 * 60 * 1000
const PROFILE_LIMIT = 2000

export interface TenantChangeScan extends ProfileScan {
  profiles: number
  errors: string[]
}

type Logger = { warn(fields: Record<string, unknown>, message: string): void }

/** 已经在企业的租户上下文里时调用（测试与手动触发也走这里）。 */
export async function scanTenantChanges(db: PrismaClient, tenantId: string, now: Date = new Date()): Promise<TenantChangeScan> {
  const total: TenantChangeScan = { ...emptyScan(), profiles: 0, errors: [] }
  const profiles = await db.adsProfile.findMany({ where: { tenantId }, select: { id: true }, orderBy: { id: 'asc' }, take: PROFILE_LIMIT })
  for (const profile of profiles) {
    total.profiles += 1
    for (const entityType of ADS_CHANGE_ENTITY_TYPES) {
      try {
        const part = await scanProfileType(db, { tenantId, adsProfileId: profile.id, entityType, now })
        for (const key of Object.keys(part) as Array<keyof ProfileScan>) total[key] += part[key]
      } catch (error) {
        total.errors.push(`${profile.id}/${entityType}: ${error instanceof Error ? error.message.slice(0, 200) : 'unknown'}`)
      }
    }
  }
  return total
}

export interface ScanAllDeps {
  systemDb: Pick<PrismaClient, 'tenant'>
  db: PrismaClient
  logger: Logger
  now?: () => Date
}

export async function scanAllTenants(deps: ScanAllDeps) {
  const tenants = await deps.systemDb.tenant.findMany({ where: { lifecycleStatus: { in: ['TRIAL', 'ACTIVE'] } }, select: { id: true }, take: 10_000 })
  let changes = 0
  for (const tenant of tenants) {
    try {
      const result = await runWithTenant(tenant.id, () => scanTenantChanges(deps.db, tenant.id, deps.now?.() ?? new Date()))
      changes += result.changes
      if (result.errors.length > 0) deps.logger.warn({ event: 'ads_change_scan_errors', errors: result.errors }, 'some ads change scans failed')
    } catch (error) {
      deps.logger.warn({ event: 'ads_change_scan_failed', error: error instanceof Error ? error.message : String(error) }, 'ads change scan failed for a tenant')
    }
  }
  return { tenants: tenants.length, changes }
}
