import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'

// 导出文件到期清理（P1-28-6）：已完成的导出到期后先删对象存储里的文件，再把任务标记为已过期（记录保留，文件指针清空）；
// 排队或生成中超过两小时仍无结论的任务（进程崩溃、队列丢失）标记为失败，不让用户一直看到“生成中”。
// 跨租户扫描，用系统连接；日志只输出数量，不输出路径与租户。

export const EXPORT_PURGE_INTERVAL_MS = 60 * 60 * 1000
export const EXPORT_STALE_AFTER_MS = 2 * 60 * 60 * 1000
const BATCH_SIZE = 200
const MAX_BATCHES_PER_RUN = 50

export interface ExportPurgeDeps {
  systemPrisma: Pick<PrismaClient, 'exportJob'>
  storage: Pick<ObjectStorage, 'delete'>
  logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
  now?: () => Date
}

export interface ExportPurgeResult {
  expired: number
  failedToDelete: number
  stale: number
}

export async function purgeExpiredExports(deps: ExportPurgeDeps): Promise<ExportPurgeResult> {
  const now = (deps.now ?? (() => new Date()))()
  const result: ExportPurgeResult = { expired: 0, failedToDelete: 0, stale: 0 }
  const stale = await deps.systemPrisma.exportJob.updateMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] }, createdAt: { lte: new Date(now.getTime() - EXPORT_STALE_AFTER_MS) } },
    data: { status: 'FAILED', errorCode: 'EXPORT_STALE', finishedAt: now },
  })
  result.stale = stale.count

  const skipped = new Set<string>()
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await deps.systemPrisma.exportJob.findMany({
      where: { status: 'DONE', expiresAt: { lte: now }, ...(skipped.size > 0 ? { id: { notIn: [...skipped] } } : {}) },
      select: { id: true, fileKey: true },
      orderBy: { expiresAt: 'asc' },
      take: BATCH_SIZE,
    })
    if (rows.length === 0) break
    for (const row of rows) {
      try {
        // 先删文件再改状态：删除失败时任务保持“已完成”，下次再试，不会出现“记录已过期、文件还在”的孤儿
        if (row.fileKey) await deps.storage.delete(row.fileKey)
        await deps.systemPrisma.exportJob.update({ where: { id: row.id }, data: { status: 'EXPIRED', fileKey: null } })
        result.expired += 1
      } catch {
        skipped.add(row.id)
        result.failedToDelete += 1
      }
    }
    if (rows.length < BATCH_SIZE) break
  }
  if (result.expired + result.stale > 0) deps.logger.info({ event: 'exports_purged', expired: result.expired, stale: result.stale }, 'expired export files deleted')
  if (result.failedToDelete > 0) deps.logger.warn({ event: 'exports_purge_failed', failed: result.failedToDelete }, 'some expired export files could not be deleted, will retry next run')
  return result
}
