import type { PrismaClient } from '@prisma/client'

// 注销流程用到的原始 SQL（P1-19）：表清单、批量删除、分页导出都按“表名 + 租户编号”拼装，Prisma 的模型接口无法表达“全部带租户编号的表”。
// 表名只来自数据库目录（pg_class），且逐个校验为安全标识符；租户编号永远走参数。
// 本文件只能使用系统连接（跨过行级安全），调用方必须已确认企业处于“注销中”。

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/
const quote = (name: string) => {
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`表名不合法：${name}`)
  return `"${name}"`
}

/** 全部带租户编号的业务表（分区表只取父表）。 */
export async function tenantTables(db: PrismaClient): Promise<string[]> {
  const rows = await db.$queryRawUnsafe<Array<{ name: string }>>(
    `SELECT c.relname AS name FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
      ORDER BY c.relname`,
  )
  return rows.map(row => row.name).filter(name => SAFE_IDENTIFIER.test(name))
}

export async function countRows(db: PrismaClient, table: string, tenantId: string): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT count(*) AS n FROM ${quote(table)} WHERE "tenantId" = $1`, tenantId)
  return Number(rows[0]?.n ?? 0)
}

/** 分页取出一批行（按 id 升序、id 大于游标）；每行是完整的 JSON 对象。 */
export async function pageRows(db: PrismaClient, table: string, tenantId: string, afterId: string | null, limit: number): Promise<Array<Record<string, unknown>>> {
  const rows = await db.$queryRawUnsafe<Array<{ j: Record<string, unknown> }>>(
    `SELECT to_jsonb(t) AS j FROM ${quote(table)} t WHERE t."tenantId" = $1 AND ($2::text IS NULL OR t."id" > $2) ORDER BY t."id" LIMIT ${Math.max(1, Math.floor(limit))}`,
    tenantId,
    afterId,
  )
  return rows.map(row => row.j)
}

/** 分批删除：每批最多 limit 行，返回本批删除的行数；直到返回 0 为止。 */
export async function deleteBatch(db: PrismaClient, table: string, tenantId: string, limit: number): Promise<number> {
  const t = quote(table)
  return db.$executeRawUnsafe(`DELETE FROM ${t} WHERE "id" IN (SELECT "id" FROM ${t} WHERE "tenantId" = $1 LIMIT ${Math.max(1, Math.floor(limit))})`, tenantId)
}

export const isForeignKeyViolation = (error: unknown) => /23503|foreign key constraint/i.test(error instanceof Error ? `${error.message} ${(error as { code?: string }).code ?? ''}` : String(error))
