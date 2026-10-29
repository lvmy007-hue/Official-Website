import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-05 验收（M-P2a-05）：库存类同步表的迁移保数据、约束与幂等键、回滚闭环。
// 同步器写库用的幂等键都由数据库唯一约束保证；这里直接用 SQL 验证，不经过应用层。

const TARGET = '20261022160000_inventory_sync'
const NEW_TABLES = [
  'InventoryDailySnapshot',
  'InventoryLedgerEntry',
  'InventoryLedgerSummary',
  'InventoryAgeSnapshot',
  'InventoryPlanningSnapshot',
  'StorageCapacitySnapshot',
  'StorageFeeRecord',
  'RemovalOrder',
  'RemovalShipment',
  'AmazonRestockRecommendation',
] as const

async function exists(client: Client, table: string) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])
  return rows[0].found as boolean
}

describe('库存类同步表（P2a-05）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移保数据与回滚', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>

    beforeAll(async () => {
      await db.createDatabase('inv_legacy')
      client = await db.connect('inv_legacy')
      await applyMigrations(client, { before: TARGET })
      ids = await seedTenant(client, 'inv')
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
      await insertRow(client, 'InventorySnapshot', { id: 'old-1', ...base, sku: 'SKU-1', available: 12, inbound: 3, reserved: 2, sourceUpdatedAt: '2026-10-20T23:30:00Z' })
      await insertRow(client, 'InventorySnapshot', { id: 'old-2', ...base, sku: 'SKU-2', available: 0, inbound: 0, reserved: 0, sourceUpdatedAt: '2026-10-21T01:00:00Z' })
      await insertRow(client, 'FbaInventoryRecord', { id: 'fir-1', ...base, sellerSku: 'SKU-1', asin: 'B000000001', fulfillableQuantity: 5, healthStatus: 'LOW_STOCK' })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级：旧快照迁入当日快照（来源 API，日期取来源更新时间的 UTC 日期），旧表保留；重复执行不产生重复行', async () => {
      await applyMigrations(client, { only: TARGET })
      const rows = await client.query(`SELECT id, sku, fnsku, asin, sellable, inbound, reserved, source, "snapshotDate"::text AS day FROM "InventoryDailySnapshot" ORDER BY sku`)
      expect(rows.rows).toEqual([
        { id: 'legacy-old-1', sku: 'SKU-1', fnsku: '', asin: '', sellable: 12, inbound: 3, reserved: 2, source: 'API', day: '2026-10-20' },
        { id: 'legacy-old-2', sku: 'SKU-2', fnsku: '', asin: '', sellable: 0, inbound: 0, reserved: 0, source: 'API', day: '2026-10-21' },
      ])
      expect(await client.query(`SELECT count(*)::int AS n FROM "InventorySnapshot"`).then(r => r.rows[0].n)).toBe(2)
      // 把迁移里的数据迁移段再跑一遍：幂等
      const sql = readFileSync(join(MIGRATIONS_DIR, TARGET, 'migration.sql'), 'utf8')
      const start = sql.indexOf('INSERT INTO "InventoryDailySnapshot"')
      const end = sql.indexOf(';', start)
      await client.query(sql.slice(start, end + 1))
      expect(await client.query(`SELECT count(*)::int AS n FROM "InventoryDailySnapshot"`).then(r => r.rows[0].n)).toBe(2)
    })

    it('升级：FbaInventoryRecord 去掉固定阈值判断列，新增来源列且旧数据来源为 API', async () => {
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaInventoryRecord' AND column_name IN ('healthStatus','source','realtimeSyncedAt')`)
      expect(columns.rows.map(r => r.column_name).sort()).toEqual(['realtimeSyncedAt', 'source'])
      expect((await client.query(`SELECT source FROM "FbaInventoryRecord" WHERE id = 'fir-1'`)).rows[0].source).toBe('API')
    })

    it('回滚：10 张新表删除，healthStatus 列按旧规则回填；再次升级闭环成功', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of NEW_TABLES) expect(await exists(client, table), `${table} 应已删除`).toBe(false)
      expect((await client.query(`SELECT "healthStatus" FROM "FbaInventoryRecord" WHERE id = 'fir-1'`)).rows[0].healthStatus).toBe('LOW_STOCK')
      await applyMigrations(client, { only: TARGET })
      for (const table of NEW_TABLES) expect(await exists(client, table), `${table} 应再次存在`).toBe(true)
      expect(await client.query(`SELECT count(*)::int AS n FROM "InventoryDailySnapshot"`).then(r => r.rows[0].n)).toBe(2)
    })
  })

  describe('幂等键与约束', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>
    const snapshot = (extra: Record<string, unknown> = {}) => ({
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      sku: 'SKU-1',
      fnsku: 'X001',
      snapshotDate: '2026-10-22',
      sourceUpdatedAt: '2026-10-22T08:00:00Z',
      ...extra,
    })

    beforeAll(async () => {
      await db.createDatabase('inv_fresh')
      client = await db.connect('inv_fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'fresh')
    })
    afterAll(async () => {
      await client?.end()
    })

    it('当日快照（分区表）：同一键同一来源重复写入被拒绝，不同来源各占一行；数量列可为空（没报的不是 0）', async () => {
      await insertRow(client, 'InventoryDailySnapshot', snapshot({ id: 's1', source: 'MYI_UNSUPPRESSED', sellable: 5 }))
      await expect(insertRow(client, 'InventoryDailySnapshot', snapshot({ id: 's1-dup', source: 'MYI_UNSUPPRESSED' }))).rejects.toMatchObject({ code: '23505' })
      await insertRow(client, 'InventoryDailySnapshot', snapshot({ id: 's2', source: 'RESERVED' }))
      const rows = await client.query(`SELECT source, sellable, reserved FROM "InventoryDailySnapshot" ORDER BY source`)
      expect(rows.rows).toEqual([
        { source: 'MYI_UNSUPPRESSED', sellable: 5, reserved: null },
        { source: 'RESERVED', sellable: null, reserved: null },
      ])
      const part = await client.query(`SELECT tableoid::regclass::text AS part FROM "InventoryDailySnapshot" WHERE id = 's1'`)
      expect(part.rows[0].part).toBe('"InventoryDailySnapshot_p202610"')
    })

    it('来源、费用类型、移除类型、台账粒度、容量来源只接受约定取值', async () => {
      await expect(insertRow(client, 'InventoryDailySnapshot', snapshot({ id: 's3', source: 'GUESS' }))).rejects.toMatchObject({ code: '23514' })
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
      await expect(insertRow(client, 'StorageFeeRecord', { ...base, chargeMonth: '2026-09-01', fnsku: 'X', feeKind: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'RemovalOrder', { ...base, orderId: 'R1', sku: 'S', requestDate: '2026-10-01', type: 'SELL' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'InventoryLedgerSummary', { ...base, date: '2026-10-01', fnsku: 'X', aggregation: 'HOURLY' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'StorageCapacitySnapshot', { ...base, snapshotDate: '2026-10-01', storageType: 'STANDARD', sourceKind: 'GUESS' })).rejects.toMatchObject({ code: '23514' })
    })

    it('台账明细按行哈希幂等；费用、移除订单、规划快照各自的唯一键生效', async () => {
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
      const ledger = { ...base, eventDate: '2026-10-20', fnsku: 'X001', quantity: 5, rowHash: 'h1' }
      await insertRow(client, 'InventoryLedgerEntry', ledger)
      await expect(insertRow(client, 'InventoryLedgerEntry', { ...ledger, id: 'l-dup' })).rejects.toMatchObject({ code: '23505' })
      await insertRow(client, 'InventoryLedgerEntry', { ...ledger, id: 'l-2', rowHash: 'h2' })
      const fee = { ...base, chargeMonth: '2026-09-01', fnsku: 'X001', fulfillmentCenter: 'ONT8', feeKind: 'STORAGE' }
      await insertRow(client, 'StorageFeeRecord', fee)
      await expect(insertRow(client, 'StorageFeeRecord', { ...fee, id: 'f-dup' })).rejects.toMatchObject({ code: '23505' })
      await insertRow(client, 'StorageFeeRecord', { ...fee, id: 'f-2', feeKind: 'UTILIZATION' })
      const removal = { ...base, orderId: 'R1', sku: 'S', fnsku: 'X001', disposition: 'Sellable', requestDate: '2026-10-01', type: 'RETURN' }
      await insertRow(client, 'RemovalOrder', removal)
      await expect(insertRow(client, 'RemovalOrder', { ...removal, id: 'r-dup' })).rejects.toMatchObject({ code: '23505' })
      const planning = { ...base, sku: 'SKU-1', fnsku: 'X001', snapshotDate: '2026-10-22', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await insertRow(client, 'InventoryPlanningSnapshot', planning)
      await expect(insertRow(client, 'InventoryPlanningSnapshot', { ...planning, id: 'p-dup' })).rejects.toMatchObject({ code: '23505' })
    })

    it('新表都启用了按租户的行级安全', async () => {
      const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])
      expect(rows.map(r => r.relname).sort()).toEqual([...NEW_TABLES].sort())
      expect(rows.every(r => r.relrowsecurity)).toBe(true)
    })
  })
})
