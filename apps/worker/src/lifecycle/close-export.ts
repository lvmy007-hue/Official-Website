import { once } from 'node:events'
import { createGzip } from 'node:zlib'
import type { PrismaClient } from '@prisma/client'
import { TenantObjectStore, type ObjectStorage } from '@nova/storage'
import { countRows, pageRows, tenantTables } from './close-sql'

export const EXPORT_PAGE_SIZE = 2000
export const EXPORT_RETENTION_DAYS = 30

/** 不进入导出包的表：幂等记录、再次验证记录等运行时数据，对企业没有保留价值。 */
const EXPORT_SKIP_TABLES = new Set(['IdempotencyRecord', 'StepUpVerification', 'OAuthState', 'WorkflowRun', 'DeadLetterJob'])
/** 不导出的列：密文、令牌、密钥、口令哈希、买家个人信息——导出包交给企业，不能带出这些。 */
const SENSITIVE_COLUMN = /(cipher|encrypt|token|secret|password|hash|pii|keyversion|mfa)/i

export const stripSensitive = (row: Record<string, unknown>) => Object.fromEntries(Object.entries(row).filter(([key]) => !SENSITIVE_COLUMN.test(key)))

export interface ExportResult {
  key: string
  bytes: number
  sha256: string
  rows: number
  expiresAt: string
  tables: Record<string, number>
}

/**
 * 导出企业数据：每个业务表一段，整体是 NDJSON 并 gzip 压缩，边读边写（内存只占一页）。
 * 第一行是清单（企业、生成时间、各表行数）；其后每行 {"t":"表名","r":{…}}；成员信息单独成表（只含邮箱、姓名、角色、状态）。
 * 对象存储里的原始报告文件不在导出包内（体积大且可由亚马逊重新获取），清单里如实说明。
 */
export async function exportTenant(deps: { db: PrismaClient; storage: ObjectStorage; now?: () => Date }, tenantId: string): Promise<ExportResult> {
  const now = (deps.now ?? (() => new Date()))()
  const store = new TenantObjectStore(deps.storage, tenantId, () => now)
  const tables = (await tenantTables(deps.db)).filter(name => !EXPORT_SKIP_TABLES.has(name))
  const counts: Record<string, number> = {}
  for (const table of tables) counts[table] = await countRows(deps.db, table, tenantId)
  const members = await deps.db.membership.findMany({ where: { tenantId }, select: { userId: true, roleId: true, status: true, user: { select: { email: true, displayName: true } } } })
  counts._Members = members.length

  const { key, writer } = store.openWriter({ domain: 'exports', name: `tenant-close-${tenantId}.ndjson.gz`, date: now }, { contentType: 'application/gzip' })
  const gzip = createGzip()
  gzip.pipe(writer.stream)
  const write = async (value: unknown) => {
    if (!gzip.write(`${JSON.stringify(value)}\n`)) await once(gzip, 'drain')
  }
  try {
    await write({ manifest: { tenantId, generatedAt: now.toISOString(), format: 'ndjson+gzip', tables: counts, excluded: ['原始报告文件（对象存储）', '密文、令牌、密钥与买家个人信息'] } })
    let rows = 0
    for (const table of tables) {
      let after: string | null = null
      for (;;) {
        const page = await pageRows(deps.db, table, tenantId, after, EXPORT_PAGE_SIZE)
        if (!page.length) break
        for (const row of page) await write({ t: table, r: stripSensitive(row) })
        rows += page.length
        after = String(page[page.length - 1].id)
        if (page.length < EXPORT_PAGE_SIZE) break
      }
    }
    for (const member of members)
      await write({ t: '_Members', r: { userId: member.userId, email: member.user.email, displayName: member.user.displayName, roleId: member.roleId, status: member.status } })
    rows += members.length
    gzip.end()
    const stored = await writer.done
    return { key, bytes: stored.sizeBytes, sha256: stored.sha256, rows, expiresAt: new Date(now.getTime() + EXPORT_RETENTION_DAYS * 86_400_000).toISOString(), tables: counts }
  } catch (error) {
    gzip.destroy()
    await writer.abort()
    throw error
  }
}
