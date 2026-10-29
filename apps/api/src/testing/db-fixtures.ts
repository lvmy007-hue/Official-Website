import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Client } from 'pg'

// 数据库测试的公共工具：按顺序执行迁移文件、按表结构自动补齐必填列的造数。

export const MIGRATIONS_DIR = resolve(__dirname, '../../../../database/prisma/migrations')

export function migrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort()
}

/** 逐个执行迁移文件。before 指定时，执行到该迁移之前（不含）；only 指定时只执行该迁移。 */
export async function applyMigrations(client: Client, options: { before?: string; only?: string } = {}) {
  for (const name of migrationNames()) {
    if (options.only && name !== options.only) continue
    if (options.before && name >= options.before) break
    await client.query(readFileSync(join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'))
  }
}

type ColumnInfo = { column_name: string; data_type: string; udt_name: string }

const columnCache = new WeakMap<Client, Map<string, ColumnInfo[]>>()

async function requiredColumns(client: Client, table: string): Promise<ColumnInfo[]> {
  let perClient = columnCache.get(client)
  if (!perClient) {
    perClient = new Map()
    columnCache.set(client, perClient)
  }
  const cached = perClient.get(table)
  if (cached) return cached
  const { rows } = await client.query<ColumnInfo>(
    `SELECT column_name, data_type, udt_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER'
       AND column_name NOT IN (SELECT a.attname FROM pg_attribute a WHERE a.attrelid = $2::regclass AND a.attidentity <> '')`,
    [table, `"${table}"`],
  )
  perClient.set(table, rows)
  return rows
}

function dummyFor(column: ColumnInfo): unknown {
  switch (column.data_type) {
    case 'text':
    case 'character varying':
      return `${column.column_name}-x`
    case 'integer':
    case 'bigint':
    case 'smallint':
      return 0
    case 'numeric':
    case 'double precision':
      return 0
    case 'boolean':
      return false
    case 'jsonb':
    case 'json':
      return '{}'
    case 'date':
      return '2026-01-01'
    case 'timestamp without time zone':
    case 'timestamp with time zone':
      return '2026-01-01T00:00:00Z'
    default:
      throw new Error(`造数工具不认识列类型 ${column.data_type}（${column.column_name}）`)
  }
}

/** 插入一行。没有指定的必填列按类型补默认值；返回写入后的整行。 */
export async function insertRow(client: Client, table: string, values: Record<string, unknown> = {}): Promise<Record<string, any>> {
  const required = await requiredColumns(client, table)
  const row: Record<string, unknown> = { ...values }
  for (const column of required) if (!(column.column_name in row)) row[column.column_name] = dummyFor(column)
  const names = Object.keys(row)
  const placeholders = names.map((_, i) => `$${i + 1}`)
  const { rows } = await client.query(
    `INSERT INTO "${table}" (${names.map(n => `"${n}"`).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`,
    names.map(n => row[n]),
  )
  return rows[0]
}

/** 建立一套最小的租户基础数据（租户、法律主体、店铺、广告账户），返回各自编号。 */
export async function seedTenant(client: Client, suffix: string) {
  const tenant = await insertRow(client, 'Tenant', { id: `tenant-${suffix}`, slug: `tenant-${suffix}`, name: `租户${suffix}` })
  const user = await insertRow(client, 'User', { id: `user-${suffix}`, email: `u-${suffix}@example.com` })
  const legalEntity = await insertRow(client, 'LegalEntity', { id: `le-${suffix}`, tenantId: tenant.id })
  const seller = await insertRow(client, 'SellerAccount', { id: `seller-${suffix}`, tenantId: tenant.id, legalEntityId: legalEntity.id })
  return { tenantId: tenant.id as string, userId: user.id as string, legalEntityId: legalEntity.id as string, sellerAccountId: seller.id as string }
}
