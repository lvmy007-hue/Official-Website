import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P5-12（G-10）：旧库存快照表在数据迁入当日快照之后删除。回滚只恢复空表结构。

const TARGET = '20261207010000_drop_inventory_snapshot'
const DIR = join(__dirname, '../../../../database/prisma/migrations', TARGET)

describe('删除旧库存快照表（P5-12）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  it('全部迁移之后旧表不存在，当日快照表仍在；回滚重建空表与行级安全，再次升级又删掉', async () => {
    await db.createDatabase('drop_inv_snap')
    db.migrate('drop_inv_snap')
    const client = await db.connect('drop_inv_snap')
    try {
      expect(await exists(client, 'InventorySnapshot')).toBe(false)
      expect(await exists(client, 'InventoryDailySnapshot')).toBe(true)

      await client.query(readFileSync(join(DIR, 'rollback.sql'), 'utf8'))
      expect(await exists(client, 'InventorySnapshot')).toBe(true)
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'InventorySnapshot'`)
      expect(columns.rows.map(row => row.column_name).sort()).toEqual([
        'available',
        'createdAt',
        'id',
        'inbound',
        'reserved',
        'sellerAccountId',
        'sku',
        'sourceRecordId',
        'sourceReportJobId',
        'sourceUpdatedAt',
        'syncedAt',
        'tenantId',
        'title',
      ])
      const policy = await client.query(`SELECT polname FROM pg_policy WHERE polrelid = '"InventorySnapshot"'::regclass`)
      expect(policy.rows.map(row => row.polname)).toEqual(['tenant_isolation'])
      expect((await client.query(`SELECT count(*)::int AS n FROM "InventorySnapshot"`)).rows[0].n).toBe(0)

      await client.query(readFileSync(join(DIR, 'migration.sql'), 'utf8'))
      expect(await exists(client, 'InventorySnapshot')).toBe(false)
      expect(await exists(client, 'InventoryDailySnapshot')).toBe(true)
    } finally {
      await client.end()
    }
  })
})

describe('删除前补迁（P5-12）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  it('删除前把还没迁过的旧行补进当日快照，已迁过的不重复也不覆盖；空表也能删', async () => {
    await db.createDatabase('drop_inv_catchup')
    const client = await db.connect('drop_inv_catchup')
    try {
      await applyMigrations(client, { before: TARGET })
      const ids = await seedTenant(client, 'catchup')
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
      await insertRow(client, 'InventorySnapshot', { id: 'late-1', ...base, sku: 'SKU-LATE', available: 7, inbound: 1, reserved: 0, sourceUpdatedAt: '2026-10-22T02:00:00Z' })
      await insertRow(client, 'InventorySnapshot', { id: 'dup-1', ...base, sku: 'SKU-DUP', available: 5, inbound: 0, reserved: 0, sourceUpdatedAt: '2026-10-22T03:00:00Z' })
      await insertRow(client, 'InventoryDailySnapshot', {
        id: 'legacy-dup-1',
        ...base,
        snapshotDate: '2026-10-22',
        sku: 'SKU-DUP',
        fnsku: '',
        asin: '',
        sellable: 99,
        source: 'API',
        sourceUpdatedAt: '2026-10-22T03:00:00Z',
      })

      await applyMigrations(client, { only: TARGET })
      expect(await exists(client, 'InventorySnapshot')).toBe(false)
      const rows = await client.query(`SELECT id, sku, sellable, "snapshotDate"::text AS day FROM "InventoryDailySnapshot" ORDER BY sku`)
      expect(rows.rows).toEqual([
        { id: 'legacy-dup-1', sku: 'SKU-DUP', sellable: 99, day: '2026-10-22' },
        { id: 'legacy-late-1', sku: 'SKU-LATE', sellable: 7, day: '2026-10-22' },
      ])
    } finally {
      await client.end()
    }
  })
})

async function exists(client: Client, table: string) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])
  return rows[0].found as boolean
}
