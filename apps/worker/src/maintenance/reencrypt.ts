import type { Keyring, SecretPurpose } from '@nova/crypto'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'

// 重加密（P1-24）：数据密钥轮换后，把还在用旧版本（或改造前旧格式）加密的密文迁到当前版本。
// 这是运维动作，不在日常任务里自动跑；跨租户处理全部数据，因此只用系统连接（已登记到租户隔离检查的白名单）。
// 安全性：
//   - 只改密文列，改之前先核对该行密文没有被别处同时改动（乐观比较），冲突的行下一轮会再处理；
//   - 解不开的行（密钥丢失、数据损坏）只记录行编号，不中断整体、不会无限重试；
//   - 日志里只有表名、数量与行编号，没有密文与明文。

export interface ReencryptSummary {
  target: string
  /** 检查过的行数（不含已经是当前版本的）。 */
  scanned: number
  migrated: number
  /** 解不开或写回冲突的行数。 */
  failed: number
  failedIds: string[]
}

export interface ReencryptDeps {
  systemPrisma: PrismaClient
  keyring: Keyring
  logger: Logger
  batchSize?: number
}

type Row = { key: Record<string, unknown>; label: string; ciphertext: string }

interface Target {
  name: string
  purpose: SecretPurpose
  /** 取一批“不是当前版本”的行；skip 为已确认无需或无法迁移的行数（它们仍在结果集前面）。 */
  fetch(prefix: string, skip: number, take: number): Promise<Row[]>
  /** 乐观写回：只有该行密文仍是 old 时才写；返回是否写成功。 */
  write(row: Row, next: { ciphertext: string; keyVersion: number }): Promise<boolean>
}

function targets(prisma: PrismaClient): Target[] {
  const db = prisma as unknown as Record<string, { findMany(args: unknown): Promise<any[]>; updateMany(args: unknown): Promise<{ count: number }> }>
  return [
    {
      name: 'PlatformConnection.encryptedRefreshToken',
      purpose: 'amazon-token',
      async fetch(prefix, skip, take) {
        const rows = await db.platformConnection.findMany({
          where: { encryptedRefreshToken: { not: null }, NOT: { encryptedRefreshToken: { startsWith: prefix } } },
          orderBy: { id: 'asc' },
          skip,
          take,
          select: { id: true, encryptedRefreshToken: true },
        })
        return rows.map(row => ({ key: { id: row.id }, label: row.id, ciphertext: row.encryptedRefreshToken as string }))
      },
      async write(row, next) {
        const result = await db.platformConnection.updateMany({
          where: { id: row.key.id, encryptedRefreshToken: row.ciphertext },
          data: { encryptedRefreshToken: next.ciphertext, refreshTokenUpdatedAt: new Date() },
        })
        return result.count === 1
      },
    },
    {
      name: 'Order.piiCiphertext',
      purpose: 'buyer-pii',
      async fetch(prefix, skip, take) {
        const rows = await db.order.findMany({
          where: { piiCiphertext: { not: null }, NOT: { piiCiphertext: { startsWith: prefix } } },
          orderBy: [{ purchaseDate: 'asc' }, { amazonOrderId: 'asc' }],
          skip,
          take,
          select: { sellerAccountId: true, amazonOrderId: true, purchaseDate: true, piiCiphertext: true },
        })
        return rows.map(row => ({
          key: { sellerAccountId: row.sellerAccountId, amazonOrderId: row.amazonOrderId, purchaseDate: row.purchaseDate },
          label: `${row.sellerAccountId}/${row.amazonOrderId}`,
          ciphertext: row.piiCiphertext as string,
        }))
      },
      async write(row, next) {
        const result = await db.order.updateMany({ where: { ...row.key, piiCiphertext: row.ciphertext }, data: { piiCiphertext: next.ciphertext } })
        return result.count === 1
      },
    },
    {
      // 退货买家备注（P6-14）：与订单买家信息同一用途的密钥，轮换时一起迁
      name: 'FbaReturnCase.customerCommentsCipher',
      purpose: 'buyer-pii',
      async fetch(prefix, skip, take) {
        const rows = await db.fbaReturnCase.findMany({
          where: { customerCommentsCipher: { not: null }, NOT: { customerCommentsCipher: { startsWith: prefix } } },
          orderBy: { id: 'asc' },
          skip,
          take,
          select: { id: true, customerCommentsCipher: true },
        })
        return rows.map(row => ({ key: { id: row.id }, label: row.id, ciphertext: row.customerCommentsCipher as string }))
      },
      async write(row, next) {
        const result = await db.fbaReturnCase.updateMany({ where: { id: row.key.id, customerCommentsCipher: row.ciphertext }, data: { customerCommentsCipher: next.ciphertext } })
        return result.count === 1
      },
    },
    {
      name: 'MfaFactor.secretCiphertext',
      purpose: 'mfa',
      async fetch(prefix, skip, take) {
        const rows = await db.mfaFactor.findMany({ where: { NOT: { secretCiphertext: { startsWith: prefix } } }, orderBy: { id: 'asc' }, skip, take, select: { id: true, secretCiphertext: true } })
        return rows.map(row => ({ key: { id: row.id }, label: row.id, ciphertext: row.secretCiphertext as string }))
      },
      async write(row, next) {
        const result = await db.mfaFactor.updateMany({ where: { id: row.key.id, secretCiphertext: row.ciphertext }, data: { secretCiphertext: next.ciphertext, keyVersion: next.keyVersion } })
        return result.count === 1
      },
    },
  ]
}

export async function reencryptAll(deps: ReencryptDeps): Promise<ReencryptSummary[]> {
  const batch = deps.batchSize ?? 200
  const summaries: ReencryptSummary[] = []
  for (const target of targets(deps.systemPrisma)) {
    const summary: ReencryptSummary = { target: target.name, scanned: 0, migrated: 0, failed: 0, failedIds: [] }
    const prefix = `nk2.${await deps.keyring.currentVersion(target.purpose)}.`
    // 留在结果集里的行（失败的、或迁移期间别处又轮换了版本而无需迁移的）要跳过，否则会反复取到它们
    let skip = 0
    for (;;) {
      const rows = await target.fetch(prefix, skip, batch)
      if (rows.length === 0) break
      for (const row of rows) {
        summary.scanned++
        try {
          const next = await deps.keyring.reencrypt(target.purpose, row.ciphertext)
          if (!next) {
            skip++
            continue
          }
          if (await target.write(row, next)) summary.migrated++
          else {
            skip++
            summary.failed++
            summary.failedIds.push(row.label)
          }
        } catch {
          skip++
          summary.failed++
          summary.failedIds.push(row.label)
        }
      }
      deps.logger.info({ event: 'reencrypt_progress', target: target.name, scanned: summary.scanned, migrated: summary.migrated, failed: summary.failed }, '重加密进度')
    }
    if (summary.failed > 0)
      deps.logger.warn({ event: 'reencrypt_failed_rows', target: target.name, ids: summary.failedIds.slice(0, 50), failed: summary.failed }, '部分行未能迁移，需人工核查（解密失败或写回冲突）')
    summaries.push(summary)
  }
  return summaries
}
