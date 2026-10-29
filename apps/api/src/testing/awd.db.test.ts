import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-08 验收（M-P2a-08）：上游仓储（AWD）4 张表的迁移、回滚、幂等键、检查约束与行级安全。
// 同步器与写入流程依赖的唯一键、可空订单编号、状态取值都由数据库保证；这里直接用 SQL 验证，不经过应用层。

const TARGET = '20261023020000_awd'
const TABLES = ['AwdInventory', 'AwdInboundOrder', 'AwdInboundShipment', 'AwdShipmentItem'] as const

// insertRow 给文本列补的占位值是固定的，同表多行会撞主键：这里给每一行补一个唯一编号
let seq = 0
const put = (client: Client, table: string, values: Record<string, unknown>) => insertRow(client, table, { id: `awd-${++seq}`, ...values })

async function exists(client: Client, table: string) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])
  return rows[0].found as boolean
}

describe('上游仓储表（P2a-08）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移与回滚', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('awd_migrate')
      client = await db.connect('awd_migrate')
      await applyMigrations(client, { before: TARGET })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级建 4 张表且不动既有数据；回滚全部删除；再次升级闭环成功', async () => {
      const ids = await seedTenant(client, 'mig')
      for (const table of TABLES) expect(await exists(client, table), `${table} 升级前不应存在`).toBe(false)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(client, table), `${table} 应已创建`).toBe(true)
      expect((await client.query(`SELECT count(*)::int AS n FROM "SellerAccount" WHERE id = $1`, [ids.sellerAccountId])).rows[0].n).toBe(1)
      await put(client, 'AwdInboundOrder', { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, externalReferenceId: 'NOVA-1' })
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of TABLES) expect(await exists(client, table), `${table} 回滚后应已删除`).toBe(false)
      expect((await client.query(`SELECT count(*)::int AS n FROM "SellerAccount" WHERE id = $1`, [ids.sellerAccountId])).rows[0].n).toBe(1)
      await applyMigrations(client, { only: TARGET })
      for (const table of TABLES) expect(await exists(client, table), `${table} 应再次存在`).toBe(true)
    })
  })

  describe('幂等键与约束', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>
    let other: Awaited<ReturnType<typeof seedTenant>>
    const base = () => ({ tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId })

    beforeAll(async () => {
      await db.createDatabase('awd_fresh')
      client = await db.connect('awd_fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'awd')
      other = await seedTenant(client, 'awd-other')
    })
    afterAll(async () => {
      await client?.end()
    })

    it('库存快照：同店铺同 SKU 同日只有一行；各数量列可为空（没报的不是 0）；负数被拒绝', async () => {
      const snapshot = { ...base(), sku: 'SKU-1', snapshotDate: '2026-10-22', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await put(client, 'AwdInventory', { id: 'inv-1', ...snapshot, onhandQty: 5 })
      await expect(put(client, 'AwdInventory', { id: 'inv-dup', ...snapshot })).rejects.toMatchObject({ code: '23505' })
      await put(client, 'AwdInventory', { id: 'inv-next', ...snapshot, snapshotDate: '2026-10-23' })
      const row = (await client.query(`SELECT "onhandQty", "availableQty", "outboundToFbaInTransit" FROM "AwdInventory" WHERE id = 'inv-1'`)).rows[0]
      expect(row).toEqual({ onhandQty: 5, availableQty: null, outboundToFbaInTransit: null })
      await expect(put(client, 'AwdInventory', { id: 'inv-neg', ...snapshot, sku: 'SKU-2', availableQty: -1 })).rejects.toMatchObject({ code: '23514' })
    })

    it('入库订单：本地状态可以没有亚马逊订单编号，其余状态必须有；多个本地草稿不冲突，同一亚马逊订单编号不能重复', async () => {
      await put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-A' })
      await put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-B', status: 'CREATE_FAILED' })
      await put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-C', status: 'CANCELLED' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-D', status: 'DRAFT' })).rejects.toMatchObject({ code: '23514' })
      await put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-E', status: 'DRAFT', orderId: 'AWD-1' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-F', status: 'CONFIRMED', orderId: 'AWD-1' })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'NOVA-A' })).rejects.toMatchObject({ code: '23505' })
    })

    it('入库订单：状态、待处理动作只接受约定取值；数量不能为负；版本号从 1 起', async () => {
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'X1', status: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'X2', pendingAction: 'EXPLODE' })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'X3', expectedUnits: -1 })).rejects.toMatchObject({ code: '23514' })
      await expect(put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'X4', version: 0 })).rejects.toMatchObject({ code: '23514' })
      const row = await put(client, 'AwdInboundOrder', { ...base(), externalReferenceId: 'X5', pendingAction: 'CREATE' })
      expect(row).toMatchObject({ status: 'LOCAL_DRAFT', version: 1, orderId: null, expectedUnits: null })
    })

    it('入库货件与明细：货件编号按店铺唯一；状态取值受限；明细按货件与 SKU 唯一，数量可空不能为负', async () => {
      const shipment = { ...base(), shipmentId: 'SHIP-1', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await put(client, 'AwdInboundShipment', { ...shipment, status: 'IN_TRANSIT' })
      await expect(put(client, 'AwdInboundShipment', { ...shipment, status: 'CLOSED' })).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'AwdInboundShipment', { ...shipment, shipmentId: 'SHIP-2', status: 'LOST' })).rejects.toMatchObject({ code: '23514' })
      await put(client, 'AwdInboundShipment', { ...shipment, shipmentId: 'SHIP-3', status: 'UNKNOWN' })
      const item = { ...base(), shipmentId: 'SHIP-1', sku: 'SKU-1', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await put(client, 'AwdShipmentItem', item)
      await expect(put(client, 'AwdShipmentItem', item)).rejects.toMatchObject({ code: '23505' })
      await expect(put(client, 'AwdShipmentItem', { ...item, sku: 'SKU-2', receivedQty: -5 })).rejects.toMatchObject({ code: '23514' })
      expect((await client.query(`SELECT "expectedQty", "receivedQty", unit FROM "AwdShipmentItem" WHERE sku = 'SKU-1'`)).rows[0]).toEqual({ expectedQty: null, receivedQty: null, unit: null })
    })

    it('不同企业可以有相同的订单编号与货件编号（唯一键带企业编号）', async () => {
      const otherBase = { tenantId: other.tenantId, sellerAccountId: other.sellerAccountId }
      await put(client, 'AwdInboundOrder', { ...otherBase, externalReferenceId: 'NOVA-E', status: 'DRAFT', orderId: 'AWD-1' })
      await put(client, 'AwdInboundShipment', { ...otherBase, shipmentId: 'SHIP-1', status: 'CREATED', sourceUpdatedAt: '2026-10-22T08:00:00Z' })
    })

    it('行级安全：4 张表都启用，租户连接账号只能看到并写入自己企业的行', async () => {
      const policies = await client.query(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND qual LIKE '%nova_current_tenant%'`, [[...TABLES]])
      expect(policies.rows.map(row => row.tablename).sort()).toEqual([...TABLES].sort())
      const app = new Client({ connectionString: db.urlFor('awd_fresh', 'app') })
      await app.connect()
      try {
        await app.query('BEGIN')
        await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [other.tenantId])
        expect((await app.query(`SELECT count(*)::int AS n FROM "AwdInboundOrder"`)).rows[0].n).toBe(1)
        expect((await app.query(`SELECT count(*)::int AS n FROM "AwdInboundOrder" WHERE "tenantId" = $1`, [ids.tenantId])).rows[0].n).toBe(0)
        await app.query('SAVEPOINT attempt')
        await expect(
          app.query(
            `INSERT INTO "AwdInboundShipment" (id, "tenantId", "sellerAccountId", "shipmentId", status, "sourceUpdatedAt", "updatedAt") VALUES ('x', $1, $2, 'SHIP-X', 'CREATED', now(), now())`,
            [ids.tenantId, ids.sellerAccountId],
          ),
        ).rejects.toMatchObject({
          code: '42501',
        })
        await app.query('ROLLBACK')
        // 没有设置企业变量时什么都看不到
        await app.query('BEGIN')
        expect((await app.query(`SELECT count(*)::int AS n FROM "AwdInventory"`)).rows[0].n).toBe(0)
        await app.query('ROLLBACK')
      } finally {
        await app.end()
      }
    })
  })
})
