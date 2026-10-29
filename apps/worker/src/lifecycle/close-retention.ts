import type { PrismaClient } from '@prisma/client'
import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import { deleteBatch } from './close-sql'
import { parseCloseState } from './close-state'

export const CLOSE_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
/** 注销后审计记录保留天数（合规）：到期后删除；生命周期事件与删除证明长期保留。 */
export const CLOSED_AUDIT_RETENTION_DAYS = 730

/**
 * 清理注销产物（每天一次）：导出包超过保留期（30 天）删除文件；审计超过 730 天删除记录。
 * 只处理已注销的企业；每项清理成功后在 closeStateJson 里记录完成时间，不会重复处理。
 */
export async function purgeClosedTenantArtifacts(deps: { db: PrismaClient; storage: ObjectStorage; logger: { info(obj: object, msg?: string): void }; now?: () => Date }) {
  const now = (deps.now ?? (() => new Date()))()
  const closed = await deps.db.tenant.findMany({ where: { lifecycleStatus: 'CLOSED' }, select: { id: true, closedAt: true, closeStateJson: true } })
  let exportsPurged = 0
  let auditsPurged = 0
  for (const tenant of closed) {
    const state = parseCloseState(tenant.closeStateJson)
    let changed = false
    if (state.export && new Date(state.export.expiresAt) <= now) {
      await new TenantObjectStore(deps.storage, tenant.id).remove(state.export.key)
      state.purged = { ...state.purged, export: now.toISOString() }
      delete state.export
      exportsPurged += 1
      changed = true
    }
    if (tenant.closedAt && !state.purged?.audit && tenant.closedAt.getTime() + CLOSED_AUDIT_RETENTION_DAYS * 86_400_000 <= now.getTime()) {
      while ((await deleteBatch(deps.db, 'AuditEvent', tenant.id, 5000)) > 0);
      state.purged = { ...state.purged, audit: now.toISOString() }
      auditsPurged += 1
      changed = true
    }
    if (changed) await deps.db.tenant.update({ where: { id: tenant.id }, data: { closeStateJson: state as unknown as object } })
  }
  if (exportsPurged || auditsPurged) deps.logger.info({ exportsPurged, auditsPurged }, '已清理过期的注销产物')
  return { exportsPurged, auditsPurged }
}
