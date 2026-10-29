import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P1-26 验收（数据库部分）：同步表带 4 个来源字段；新表与约束；导入幂等；迁移可回滚、可再次升级。

const TARGET = '20261022010000_orders_finance_v2'
const SYNC_TABLES = [
  'Order',
  'InventorySnapshot',
  'FbaProduct',
  'FbaInventoryRecord',
  'FbaInboundPlan',
  'FbaInboundShipment',
  'FbaFeeEvent',
  'FbaReturnCase',
  'AdsProfile',
  'AdsCampaign',
  'OrderItem',
  'FbaSettlement',
  'FbaFinancialTransaction',
  'AdsMetric',
  'AdsTermMetric',
  'OrderCharge',
  'OrderPackage',
  'OrderCancellation',
  'AccountBalanceSnapshot',
  'OrderStatusHistory',
]
const SOURCE_COLUMNS = ['sourceUpdatedAt', 'syncedAt', 'sourceReportJobId', 'sourceRecordId']
const NEW_TABLES = ['OrderCharge', 'OrderStatusHistory', 'OrderPackage', 'OrderCancellation', 'AccountBalanceSnapshot', 'ConnectorChannelState', 'ConnectorParityRun', 'ConnectorParityDiff']

async function columnsOf(client: Client, table: string) {
  const { rows } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])
  return rows.map(row => row.column_name as string)
}
async function relkind(client: Client, table: string) {
  const { rows } = await client.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`"${table}"`])
  return rows[0]?.relkind as string | undefined
}

describe('订单与财务接口升级（M-P1-26，真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移：保数据、可回滚、可再次升级', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('upgrade')
      client = await db.connect('upgrade')
      await applyMigrations(client, { before: TARGET })
      const ids = await seedTenant(client, 'u')
      const order = await insertRow(client, 'Order', {
        id: 'order-u',
        tenantId: ids.tenantId,
        sellerAccountId: ids.sellerAccountId,
        amazonOrderId: '111-0000001-0000001',
        purchaseDate: '2026-09-10T10:00:00Z',
        sourceUpdatedAt: '2026-09-11T00:00:00Z',
      })
      // 旧导入器给所有交易写的占位状态“POSTED”，不属于接口给出的三种状态，升级时清空
      await insertRow(client, 'FbaFinancialTransaction', {
        id: 'txn-u',
        tenantId: ids.tenantId,
        sellerAccountId: ids.sellerAccountId,
        postedAt: '2026-09-12T00:00:00Z',
        transactionStatus: 'POSTED',
        externalTransactionId: 'ft-u',
        sourceUpdatedAt: '2026-09-13T00:00:00Z',
      })
      expect(order.id).toBe('order-u')
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级后：同步表都带 4 个来源字段；既有记录的同步时间取来源更新时间；占位状态被清空', async () => {
      await applyMigrations(client, { only: TARGET })
      for (const table of SYNC_TABLES) {
        const columns = await columnsOf(client, table)
        for (const column of SOURCE_COLUMNS) expect(columns, `${table} 缺少 ${column}`).toContain(column)
      }
      const order = await client.query(`SELECT "syncedAt" = "sourceUpdatedAt" AS same FROM "Order" WHERE id = 'order-u'`)
      expect(order.rows[0].same).toBe(true)
      const txn = await client.query(`SELECT "transactionStatus", "reconciliationStatus" FROM "FbaFinancialTransaction" WHERE id = 'txn-u'`)
      expect(txn.rows[0]).toEqual({ transactionStatus: null, reconciliationStatus: 'UNRECONCILED' })
    })

    it('新增的订单收入费用明细是按月分区表；订单、财务、广告大表已补建过去 24 个月的分区', async () => {
      expect(await relkind(client, 'OrderCharge')).toBe('p')
      const oldest = new Date()
      oldest.setUTCMonth(oldest.getUTCMonth() - 23)
      const name = `Order_p${oldest.getUTCFullYear()}${String(oldest.getUTCMonth() + 1).padStart(2, '0')}`
      expect(await relkind(client, name), `${name} 应存在`).toBe('r')
    })

    it('回滚脚本：新表与新增列全部移除，订单数据原样保留', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of NEW_TABLES) expect(await relkind(client, table), `${table} 应已删除`).toBeUndefined()
      const orderColumns = await columnsOf(client, 'Order')
      for (const column of ['syncedAt', 'sourceReportJobId', 'fulfillmentStatus', 'refundStatus']) expect(orderColumns).not.toContain(column)
      expect(orderColumns).toContain('sourceRecordId')
      expect((await client.query(`SELECT count(*)::int AS n FROM "Order"`)).rows[0].n).toBe(1)
      expect((await client.query(`SELECT count(*) FROM pg_trigger WHERE tgname LIKE '%_touch_synced_at'`)).rows[0].count).toBe('0')
    })

    it('回滚之后可以再次升级（回滚演练的闭环）', async () => {
      await applyMigrations(client, { only: TARGET })
      expect(await relkind(client, 'OrderCharge')).toBe('p')
      expect(await columnsOf(client, 'Order')).toContain('syncedAt')
    })
  })

  describe('约束、触发器与幂等', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>
    const orderRow = (suffix: string, purchaseDate = '2026-10-05T10:00:00Z') => ({
      id: `o-${suffix}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId: `A-${suffix}`,
      purchaseDate,
    })

    beforeAll(async () => {
      await db.createDatabase('fresh')
      client = await db.connect('fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'f')
    })
    afterAll(async () => {
      await client?.end()
    })

    it('同步时间只在来源更新时间变化时刷新：重复同步没有变化的记录不会显得“刚同步过”', async () => {
      await insertRow(client, 'Order', { ...orderRow('sync'), syncedAt: '2026-01-01T00:00:00Z', sourceUpdatedAt: '2026-10-01T00:00:00Z' })
      await client.query(`UPDATE "Order" SET status = 'Shipped' WHERE id = 'o-sync'`)
      const unchanged = await client.query(`SELECT "syncedAt" = '2026-01-01T00:00:00' AS same FROM "Order" WHERE id = 'o-sync'`)
      expect(unchanged.rows[0].same).toBe(true)
      await client.query(`UPDATE "Order" SET "sourceUpdatedAt" = '2026-10-02T00:00:00Z' WHERE id = 'o-sync'`)
      const refreshed = await client.query(`SELECT "syncedAt" > '2026-06-01' AS fresh FROM "Order" WHERE id = 'o-sync'`)
      expect(refreshed.rows[0].fresh).toBe(true)
    })

    it('财务交易状态只允许接口给出的三种；对账状态只允许三种', async () => {
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, postedAt: '2026-10-05T00:00:00Z' }
      for (const status of ['DEFERRED', 'RELEASED', 'DEFERRED_RELEASED', null])
        await insertRow(client, 'FbaFinancialTransaction', { ...base, id: `t-${status}`, externalTransactionId: `ext-${status}`, transactionStatus: status })
      await expect(insertRow(client, 'FbaFinancialTransaction', { ...base, id: 't-bad', externalTransactionId: 'ext-bad', transactionStatus: 'POSTED' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'FbaFinancialTransaction', { ...base, id: 't-bad2', externalTransactionId: 'ext-bad2', reconciliationStatus: 'WHATEVER' })).rejects.toMatchObject({
        code: '23514',
      })
    })

    it('订单明细：类别受约束；唯一键即幂等键（重复写入被拒，冲突更新不产生重复）；删除订单时级联删除', async () => {
      await insertRow(client, 'Order', orderRow('c1'))
      const charge = {
        tenantId: ids.tenantId,
        sellerAccountId: ids.sellerAccountId,
        orderId: 'o-c1',
        purchaseDate: '2026-10-05T10:00:00Z',
        orderItemId: 'oi-1',
        amazonOrderId: 'A-c1',
        chargeKind: 'ITEM',
        componentKey: 'PRINCIPAL',
        amount: '19.99',
      }
      await insertRow(client, 'OrderCharge', { ...charge, id: 'ch-1' })
      await expect(insertRow(client, 'OrderCharge', { ...charge, id: 'ch-dup' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'OrderCharge', { ...charge, id: 'ch-bad', componentKey: 'X', chargeKind: 'MYSTERY' })).rejects.toMatchObject({ code: '23514' })
      await client.query(
        `INSERT INTO "OrderCharge" (id, "tenantId", "sellerAccountId", "orderId", "orderItemId", "amazonOrderId", "purchaseDate", "chargeKind", "componentKey", amount, "sourceUpdatedAt", "updatedAt")
         VALUES ('ch-new', $1, $2, 'o-c1', 'oi-1', 'A-c1', '2026-10-05T10:00:00Z', 'ITEM', 'PRINCIPAL', 25, now(), now())
         ON CONFLICT ("sellerAccountId", "orderItemId", "chargeKind", "componentKey", "purchaseDate") DO UPDATE SET amount = EXCLUDED.amount`,
        [ids.tenantId, ids.sellerAccountId],
      )
      expect((await client.query(`SELECT count(*)::int AS n, max(amount)::float AS amount FROM "OrderCharge" WHERE "orderId" = 'o-c1'`)).rows[0]).toEqual({ n: 1, amount: 25 })
      await client.query(`DELETE FROM "Order" WHERE id = 'o-c1'`)
      expect((await client.query(`SELECT count(*)::int AS n FROM "OrderCharge" WHERE "orderId" = 'o-c1'`)).rows[0].n).toBe(0)
    })

    it('取消、包裹、状态历史：取消执行方受约束，状态历史与包裹有各自的幂等键', async () => {
      await insertRow(client, 'Order', orderRow('c2'))
      const link = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, orderId: 'o-c2', orderPurchaseDate: '2026-10-05T10:00:00Z' }
      await insertRow(client, 'OrderCancellation', { ...link, id: 'cx-1', cancelledBy: 'BUYER' })
      await expect(insertRow(client, 'OrderCancellation', { ...link, id: 'cx-2', cancelledBy: 'SELLER' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'OrderCancellation', { ...link, id: 'cx-3', orderId: 'o-none', cancelledBy: 'NOBODY' })).rejects.toBeTruthy()
      await insertRow(client, 'OrderStatusHistory', { ...link, id: 'sh-1', status: 'SHIPPED', occurredAt: '2026-10-06T00:00:00Z', source: 'API', sourceUpdatedAt: '2026-10-06T00:00:00Z' })
      await expect(
        insertRow(client, 'OrderStatusHistory', { ...link, id: 'sh-2', status: 'SHIPPED', occurredAt: '2026-10-06T00:00:00Z', source: 'API', sourceUpdatedAt: '2026-10-06T00:00:00Z' }),
      ).rejects.toMatchObject({ code: '23505' })
      await expect(
        insertRow(client, 'OrderStatusHistory', { ...link, id: 'sh-3', status: 'DELIVERED', occurredAt: '2026-10-07T00:00:00Z', source: 'MAGIC', sourceUpdatedAt: '2026-10-07T00:00:00Z' }),
      ).rejects.toMatchObject({ code: '23514' })
      await insertRow(client, 'OrderPackage', { ...link, id: 'pk-1', packageId: 'p1', trackingNumber: 'TRK1' })
      await expect(insertRow(client, 'OrderPackage', { ...link, id: 'pk-2', packageId: 'p1', trackingNumber: 'TRK1' })).rejects.toMatchObject({ code: '23505' })
      await insertRow(client, 'OrderPackage', { ...link, id: 'pk-3', packageId: 'p1', trackingNumber: 'TRK2' })
    })

    it('账户余额快照：同一天同一余额类型可在不同账户类型下并存，同键重复被拒', async () => {
      const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, snapshotDate: '2026-10-05', balanceType: 'AVAILABLE', currency: 'USD', amount: '100' }
      await insertRow(client, 'AccountBalanceSnapshot', { ...base, id: 'b-1', accountType: 'PAYABLE' })
      await insertRow(client, 'AccountBalanceSnapshot', { ...base, id: 'b-2', accountType: 'RESERVE' })
      await expect(insertRow(client, 'AccountBalanceSnapshot', { ...base, id: 'b-3', accountType: 'PAYABLE' })).rejects.toMatchObject({ code: '23505' })
    })

    it('核对表：数据域、状态、差异类别都受约束；通道状态每个店铺每个数据域只有一行', async () => {
      const state = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
      await insertRow(client, 'ConnectorChannelState', { ...state, id: 'cs-1', domain: 'ORDERS' })
      await insertRow(client, 'ConnectorChannelState', { ...state, id: 'cs-2', domain: 'FINANCE' })
      await expect(insertRow(client, 'ConnectorChannelState', { ...state, id: 'cs-3', domain: 'ORDERS' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'ConnectorChannelState', { ...state, id: 'cs-4', domain: 'ADS' })).rejects.toMatchObject({ code: '23514' })
      const run = await insertRow(client, 'ConnectorParityRun', { ...state, id: 'run-1', domain: 'ORDERS', status: 'HAS_DIFFS' })
      await expect(insertRow(client, 'ConnectorParityRun', { ...state, id: 'run-2', domain: 'ORDERS', status: 'MAYBE' })).rejects.toMatchObject({ code: '23514' })
      for (const category of ['TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED'])
        await insertRow(client, 'ConnectorParityDiff', { tenantId: ids.tenantId, runId: run.id, category, id: `d-${category}` })
      await expect(insertRow(client, 'ConnectorParityDiff', { tenantId: ids.tenantId, runId: run.id, category: 'OTHER', id: 'd-bad' })).rejects.toMatchObject({ code: '23514' })
    })
  })
})
