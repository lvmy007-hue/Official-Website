import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import type { Prisma, PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { loadRetentionPolicy } from '../platform/tenant-policy'
import type { RawSink } from './download'

// 原始报告文件留存（P1-23，importers.md S1）：下载的原始字节（解压之前）一边下载一边写进对象存储，
// 解析入库成功后在 RawReportFile 登记路径、大小与内容摘要；解析失败则丢弃，不留下半截或无法对应的文件。

export interface RawFileTarget {
  tenantId: string
  /** 数据域，如 reports、ads-reports。 */
  domain: string
  /** 文件名（会被净化并加上随机编号）。 */
  name: string
}

export interface RawFileRecord {
  /** 店铺编号；广告报告用 ads:<广告账户编号>；没有归属时用 - 。 */
  storeKey: string
  sellerAccountId?: string | null
  sourceKey: string
  reportType?: string | null
  reportId?: string | null
  rowCount?: number | null
  periodStart?: Date | null
  periodEnd?: Date | null
}

export interface RawFileHandle {
  /** 交给下载流水线的写入端。 */
  sink: RawSink
  /** 导入成功后调用：等文件落稳，登记到 RawReportFile（同店铺内容相同的只登记一次，多余的新文件被删除）。 */
  complete(record: RawFileRecord): Promise<void>
  /** 导入失败时调用：丢弃已写入的文件。可重复调用。 */
  discard(): Promise<void>
}

export type RawFileOpener = (target: RawFileTarget) => RawFileHandle | undefined

export interface RawFileOpenerDeps {
  storage: ObjectStorage
  /** 租户连接（任务在租户上下文内执行）。 */
  prisma: PrismaClient
  logger: Logger
  /** 保留天数（默认 400）。 */
  retentionDays?: number
  now?: () => Date
}

export const DEFAULT_RAW_FILE_RETENTION_DAYS = 400

export function rawFileRetentionDays(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env.RAW_FILE_RETENTION_DAYS)
  return Number.isInteger(value) && value >= 1 ? value : DEFAULT_RAW_FILE_RETENTION_DAYS
}

const isUniqueViolation = (error: unknown) => (error as { code?: string } | null)?.code === 'P2002'

export function createRawFileOpener(deps: RawFileOpenerDeps): RawFileOpener {
  const now = deps.now ?? (() => new Date())
  const retentionDays = deps.retentionDays ?? DEFAULT_RAW_FILE_RETENTION_DAYS
  return target => {
    const store = new TenantObjectStore(deps.storage, target.tenantId, now)
    const { key, writer } = store.openWriter({ domain: target.domain, name: target.name }, { contentType: 'application/octet-stream' })
    let removed = false
    const remove = async () => {
      if (removed) return
      removed = true
      await writer.abort().catch(() => undefined)
      await store.remove(key).catch(error => deps.logger.warn({ key, error: error instanceof Error ? error.message : String(error) }, 'raw file cleanup failed'))
    }
    return {
      sink: writer.stream,
      discard: remove,
      async complete(record) {
        const stored = await writer.done
        const storedAt = now()
        const data: Prisma.RawReportFileUncheckedCreateInput = {
          tenantId: target.tenantId,
          storeKey: record.storeKey,
          sellerAccountId: record.sellerAccountId ?? null,
          sourceKey: record.sourceKey,
          reportType: record.reportType ?? null,
          reportId: record.reportId ?? null,
          objectKey: stored.key,
          sizeBytes: BigInt(stored.sizeBytes),
          sha256: stored.sha256,
          rowCount: record.rowCount ?? null,
          periodStart: record.periodStart ?? null,
          periodEnd: record.periodEnd ?? null,
          storedAt,
          retentionUntil: new Date(storedAt.getTime() + retentionDays * 86_400_000),
        }
        const where = { tenantId_storeKey_sha256: { tenantId: target.tenantId, storeKey: record.storeKey, sha256: stored.sha256 } }
        try {
          if (await deps.prisma.rawReportFile.findUnique({ where })) {
            await remove()
            return
          } // 同样内容已登记：丢弃新文件
          // 保留天数：企业在设置里改过就用企业的，否则用部署默认（RAW_FILE_RETENTION_DAYS，默认 400 天）；只影响这次新保存的文件
          const days = (await loadRetentionPolicy(deps.prisma, target.tenantId))?.rawReportDays ?? retentionDays
          await deps.prisma.rawReportFile.create({ data: { ...data, retentionUntil: new Date(storedAt.getTime() + days * 86_400_000) } })
        } catch (error) {
          if (isUniqueViolation(error)) {
            await remove()
            return
          } // 并发的相同文件：别人先登记了
          await remove()
          throw error
        }
      },
    }
  }
}
