import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import type { PiiSealer } from '../crypto/secrets'
import { sealComment } from '../importers/returns/comment-vault'
import { loadRetentionPolicy } from '../platform/tenant-policy'

// 退货买家备注存量加密（P6-14）：升级前的备注是明文存在 customerComments 列里。
// 加密只能由应用层密钥环完成（SQL 做不了），所以由这个任务逐批读出、加密写入 customerCommentsCipher、清空明文列：
//   - 启动时与之后每小时随到期清理一起跑（幂等：已清空的不再处理）；也可以用 keys-cli 的 backfill-return-comments 手工跑；
//   - 保留期按“发货日（订单回填后才有，没有用退货日）+ 企业设置的保留天数”重新算，已经到期的不加密、直接清掉明文；
//   - 同一行已经有新导入的密文（重新同步过）时，保留较新的密文，只清明文；
//   - 解密不是它的事：它只加密。日志里只有数量与行编号，没有内容。
// 跨租户处理全部数据，因此只用系统连接（已登记到租户隔离检查的白名单）。全部清空后运行 database/ops/drop-return-comment-plaintext.sql 删除明文列。

export interface ReturnCommentBackfillSummary {
  scanned: number
  /** 加密写入的行数。 */
  encrypted: number
  /** 已到期或空白、直接清掉明文的行数。 */
  cleared: number
  /** 已有密文、只清明文的行数。 */
  keptNewer: number
  failed: number
  failedIds: string[]
}

export interface ReturnCommentBackfillDeps {
  systemPrisma: PrismaClient
  secrets: PiiSealer
  logger: Pick<Logger, 'info' | 'warn'>
  now?: Date
  batchSize?: number
  /** 最多处理多少批（定时调用时限制单次耗时，剩余的下一轮继续）；不传处理到清空为止。 */
  maxBatches?: number
}

export async function backfillReturnComments(deps: ReturnCommentBackfillDeps): Promise<ReturnCommentBackfillSummary> {
  const db = deps.systemPrisma
  const now = deps.now ?? new Date()
  const batch = deps.batchSize ?? 200
  const summary: ReturnCommentBackfillSummary = { scanned: 0, encrypted: 0, cleared: 0, keptNewer: 0, failed: 0, failedIds: [] }
  const retention = new Map<string, number | undefined>()
  const daysOf = async (tenantId: string) => {
    if (!retention.has(tenantId)) retention.set(tenantId, (await loadRetentionPolicy(db, tenantId))?.customerInfoDays)
    return retention.get(tenantId)
  }
  let after = ''
  for (let round = 0; round < (deps.maxBatches ?? Number.MAX_SAFE_INTEGER); round++) {
    const rows = await db.fbaReturnCase.findMany({
      where: { customerComments: { not: null }, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: 'asc' },
      take: batch,
      select: { id: true, tenantId: true, customerComments: true, returnDate: true, orderShippedAt: true },
    })
    if (rows.length === 0) break
    for (const row of rows) {
      after = row.id
      summary.scanned++
      try {
        const sealed = await sealComment(deps.secrets, row.customerComments ?? undefined, { returnDate: row.returnDate, shippedAt: row.orderShippedAt, retentionDays: await daysOf(row.tenantId), now })
        // 先试“还没有密文”的行：写密文并清明文；没写成（已经有较新的密文）就只清明文
        const written = sealed
          ? await db.fbaReturnCase.updateMany({ where: { id: row.id, customerComments: { not: null }, customerCommentsCipher: null }, data: { ...sealed, customerComments: null } })
          : { count: 0 }
        if (written.count === 1) {
          summary.encrypted++
          continue
        }
        await db.fbaReturnCase.updateMany({ where: { id: row.id }, data: { customerComments: null } })
        if (sealed) summary.keptNewer++
        else summary.cleared++
      } catch {
        summary.failed++
        summary.failedIds.push(row.id)
      }
    }
  }
  if (summary.scanned > 0) deps.logger.info({ event: 'return_comments_backfill', ...summary, failedIds: summary.failedIds.slice(0, 50) }, '退货买家备注存量加密')
  if (summary.failed > 0) deps.logger.warn({ event: 'return_comments_backfill_failed', failed: summary.failed }, '部分退货买家备注未能加密，下一轮会重试')
  return summary
}
