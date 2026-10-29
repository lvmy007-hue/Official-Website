import type { ObjectStorage } from '@nova/storage'
import type { PrismaClient } from '@prisma/client'

// 原始报告文件到期清理（P1-23）：登记表里 retentionUntil 已过的文件，先删对象存储里的文件，再删登记。
// 先删文件后删登记：删文件失败时登记保留，下次再试；绝不会出现“登记没了、文件还在”而无人清理的孤儿。
// 对全部租户一视同仁，用系统连接；日志只输出数量，不输出路径与租户。

export const RAW_FILE_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000
const BATCH_SIZE = 200
const MAX_BATCHES_PER_RUN = 50

export interface RawFilePurgeDeps {
  systemPrisma: Pick<PrismaClient, 'rawReportFile'>
  storage: Pick<ObjectStorage, 'delete'>
  logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void }
  now?: () => Date
}

export interface RawFilePurgeResult {
  deleted: number
  failed: number
}

export async function purgeExpiredRawFiles(deps: RawFilePurgeDeps): Promise<RawFilePurgeResult> {
  const now = (deps.now ?? (() => new Date()))()
  const result: RawFilePurgeResult = { deleted: 0, failed: 0 }
  const failedIds = new Set<string>()
  for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
    const rows = await deps.systemPrisma.rawReportFile.findMany({
      where: { retentionUntil: { lte: now }, ...(failedIds.size > 0 ? { id: { notIn: [...failedIds] } } : {}) },
      select: { id: true, objectKey: true },
      orderBy: { retentionUntil: 'asc' },
      take: BATCH_SIZE,
    })
    if (rows.length === 0) break
    for (const row of rows) {
      try {
        await deps.storage.delete(row.objectKey)
        await deps.systemPrisma.rawReportFile.delete({ where: { id: row.id } })
        result.deleted += 1
      } catch {
        failedIds.add(row.id)
        result.failed += 1
      }
    }
    if (rows.length < BATCH_SIZE) break
  }
  if (result.deleted > 0) deps.logger.info({ event: 'raw_files_purged', deleted: result.deleted }, 'expired raw report files deleted')
  if (result.failed > 0) deps.logger.warn({ event: 'raw_files_purge_failed', failed: result.failed }, 'some expired raw report files could not be deleted, will retry next run')
  return result
}
