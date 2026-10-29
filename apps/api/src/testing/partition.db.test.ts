import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P1-27 验收：分区与幂等。
// 一、迁移保数据（旧数据 → 分区表，行数一致、分区列正确、异常数据进默认分区、旧表已删）。
// 二、分区框架函数（续建幂等、默认分区数据迁入新分区、裁剪生效）。
// 三、幂等与约束（唯一键含分区列、外键级联）。
// 四、回滚脚本可用。

// 分区表清单：P127 是 M-P1-27 当时转换的 7 张表（迁移与回滚测试只看它们）；之后新增的分区表追加在后面（当前库的全部分区表）。
const PARTITIONED_P127 = ['Order', 'OrderItem', 'FbaFinancialTransaction', 'FbaFeeEvent', 'AdsMetric', 'AdsTermMetric', 'AuditEvent'] as const
const PARTITIONED = [
  ...PARTITIONED_P127,
  'OrderCharge',
  'AmazonNotificationEvent',
  'HourlySalesEvent',
  'HourlyTrafficEvent',
  'HourlyInventoryEvent',
  'InventoryDailySnapshot',
  'AdsAdvertisedProductMetric',
  'AdsConvertedProductDaily',
  'AdsPerformanceHourly',
  'SalesTrafficDaily',
  'SalesTrafficAsinDaily',
] as const
const TARGET = '20261021030000_partition_framework'

async function count(client: Client, table: string) {
  const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${table}"`)
  return rows[0].n as number
}

async function relkind(client: Client, table: string) {
  const { rows } = await client.query(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`"${table}"`])
  return rows[0]?.relkind as string | undefined
}

describe('分区框架（P1-27）', () => {
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
      await db.createDatabase('legacy')
      client = await db.connect('legacy')
      await applyMigrations(client, { before: TARGET })
      ids = await seedTenant(client, 'a')
      const profile = await insertRow(client, 'AdsProfile', { id: 'profile-a', tenantId: ids.tenantId })

      // 订单：三个月的正常数据 + 一条远早于分区范围的异常数据
      const purchase = ['2026-07-15T10:00:00Z', '2026-08-20T10:00:00Z', '2026-10-05T10:00:00Z', '2005-03-01T10:00:00Z']
      for (const [index, date] of purchase.entries()) {
        const order = await insertRow(client, 'Order', {
          id: `order-${index}`,
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          amazonOrderId: `111-000000${index}-0000000`,
          purchaseDate: date,
        })
        await insertRow(client, 'OrderItem', {
          id: `item-${index}`,
          tenantId: ids.tenantId,
          sellerAccountId: ids.sellerAccountId,
          orderId: order.id,
          amazonOrderId: order.amazonOrderId,
          orderItemId: `oi-${index}`,
        })
        await insertRow(client, 'FbaFeeEvent', { id: `fee-${index}`, tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, postedAt: date, sourceEventId: `fe-${index}` })
        await insertRow(client, 'FbaFinancialTransaction', { id: `txn-${index}`, tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, postedAt: date, externalTransactionId: `ft-${index}` })
        await insertRow(client, 'AdsMetric', { id: `adm-${index}`, tenantId: ids.tenantId, adsProfileId: profile.id, reportDate: date, externalCampaignId: `c-${index}` })
        await insertRow(client, 'AdsTermMetric', { id: `adt-${index}`, tenantId: ids.tenantId, adsProfileId: profile.id, reportDate: date, level: 'KEYWORD', rowKey: `r-${index}` })
        await insertRow(client, 'AuditEvent', { id: `aud-${index}`, tenantId: ids.tenantId, actorId: ids.userId, createdAt: date })
      }
    })
    afterAll(async () => {
      await client?.end()
    })

    it('执行迁移后：行数一致、全部为分区表、旧表已删除', async () => {
      await applyMigrations(client, { only: TARGET })
      for (const table of PARTITIONED_P127) {
        expect(await relkind(client, table), `${table} 应为分区表`).toBe('p')
        expect(await count(client, table), `${table} 行数`).toBe(4)
        expect(await relkind(client, `${table}_legacy`), `${table}_legacy 应已删除`).toBeUndefined()
      }
    })

    it('OrderItem 的分区列等于所属订单的下单时间，审计事件的发生时间回填为创建时间', async () => {
      const items = await client.query(`SELECT i."orderPurchaseDate" = o."purchaseDate" AS same FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId" AND o."purchaseDate" = i."orderPurchaseDate"`)
      expect(items.rows).toHaveLength(4)
      expect(items.rows.every(r => r.same)).toBe(true)
      const audits = await client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "occurredAt" <> "createdAt"`)
      expect(audits.rows[0].n).toBe(0)
    })

    it('正常数据落入对应月份分区，超范围的异常数据落入默认分区并可被监控发现', async () => {
      const inMonth = await client.query(`SELECT tableoid::regclass::text AS part FROM "Order" WHERE id = 'order-1'`)
      expect(inMonth.rows[0].part).toBe('"Order_p202608"')
      const ancient = await client.query(`SELECT tableoid::regclass::text AS part FROM "Order" WHERE id = 'order-3'`)
      expect(ancient.rows[0].part).toBe('"Order_default"')
      const watch = await client.query<{ parent_table: string; row_count: string }>(`SELECT * FROM nova_default_partition_rows() ORDER BY parent_table`)
      expect(watch.rows.map(r => r.parent_table)).toEqual([...PARTITIONED_P127].sort())
      expect(watch.rows.every(r => Number(r.row_count) === 1)).toBe(true)
    })

    it('回滚脚本：还原为普通表，数据原样保留', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of PARTITIONED_P127) {
        expect(await relkind(client, table), `${table} 应还原为普通表`).toBe('r')
        expect(await count(client, table), `${table} 行数`).toBe(4)
      }
      const items = await client.query(`SELECT count(*)::int AS n FROM "OrderItem" i JOIN "Order" o ON o.id = i."orderId"`)
      expect(items.rows[0].n).toBe(4)
      const columns = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN ('OrderItem','AuditEvent') AND column_name IN ('orderPurchaseDate','occurredAt')`)
      expect(columns.rows).toHaveLength(0)
    })

    it('回滚之后可以再次升级（回滚演练的闭环）', async () => {
      await applyMigrations(client, { only: TARGET })
      for (const table of PARTITIONED_P127) {
        expect(await relkind(client, table), `${table} 应再次变为分区表`).toBe('p')
        expect(await count(client, table), `${table} 行数`).toBe(4)
      }
    })
  })

  describe('框架函数、幂等与约束', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>

    beforeAll(async () => {
      await db.createDatabase('fresh')
      client = await db.connect('fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'b')
    })
    afterAll(async () => {
      await client?.end()
    })

    const order = (suffix: string, purchaseDate: string) => ({
      id: `o-${suffix}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId: `A-${suffix}`,
      purchaseDate,
    })

    it('新库自带当前月起往后 3 个月的分区；续建函数可重复执行，不重复创建', async () => {
      const first = await client.query<{ parent_table: string; created_count: number }>(`SELECT * FROM nova_ensure_all_partitions(3)`)
      expect(first.rows.map(r => r.parent_table).sort()).toEqual([...PARTITIONED].sort())
      const second = await client.query<{ created_count: number }>(`SELECT * FROM nova_ensure_all_partitions(3)`)
      expect(second.rows.every(r => r.created_count === 0)).toBe(true)
      // 再往后续建 6 个月，每张表应各新增 3 个
      const more = await client.query<{ created_count: number }>(`SELECT * FROM nova_ensure_all_partitions(6)`)
      expect(more.rows.every(r => r.created_count === 3)).toBe(true)
    })

    it('唯一键包含分区列：同一订单重复写入被拒绝，ON CONFLICT 幂等写入不产生重复', async () => {
      await insertRow(client, 'Order', order('1', '2026-10-05T00:00:00Z'))
      await expect(insertRow(client, 'Order', { ...order('1', '2026-10-05T00:00:00Z'), id: 'o-1-dup' })).rejects.toMatchObject({ code: '23505' })
      const upsert = await client.query(
        `INSERT INTO "Order" ("id","tenantId","sellerAccountId","amazonOrderId","marketplaceId","purchaseDate","status","currency","sourceUpdatedAt","sourceRecordId","updatedAt")
         VALUES ('o-1-again',$1,$2,'A-1','m','2026-10-05T00:00:00Z','Shipped','USD',now(),'r',now())
         ON CONFLICT ("sellerAccountId","amazonOrderId","purchaseDate") DO UPDATE SET "status" = EXCLUDED."status" RETURNING "id","status"`,
        [ids.tenantId, ids.sellerAccountId],
      )
      expect(upsert.rows[0]).toEqual({ id: 'o-1', status: 'Shipped' })
      const total = await client.query(`SELECT count(*)::int AS n FROM "Order" WHERE "amazonOrderId" = 'A-1'`)
      expect(total.rows[0].n).toBe(1)
    })

    it('订单明细：外键为（订单编号，下单时间），错位的下单时间被拒绝，删除订单级联删除明细', async () => {
      await insertRow(client, 'Order', order('2', '2026-10-06T00:00:00Z'))
      const item = { id: 'i-2', tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId, orderId: 'o-2', amazonOrderId: 'A-2', orderItemId: 'oi-2' }
      await expect(insertRow(client, 'OrderItem', { ...item, orderPurchaseDate: '2026-10-07T00:00:00Z' })).rejects.toMatchObject({ code: '23503' })
      await insertRow(client, 'OrderItem', { ...item, orderPurchaseDate: '2026-10-06T00:00:00Z' })
      await client.query(`DELETE FROM "Order" WHERE id = 'o-2'`)
      expect(await client.query(`SELECT 1 FROM "OrderItem" WHERE id = 'i-2'`).then(r => r.rowCount)).toBe(0)
    })

    it('按时间范围查询只扫描相关月份分区（分区裁剪）', async () => {
      const plan = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN SELECT * FROM "Order" WHERE "tenantId" = $1 AND "purchaseDate" >= '2026-10-01' AND "purchaseDate" < '2026-11-01'`, [
        ids.tenantId,
      ])
      const text = plan.rows.map(r => r['QUERY PLAN']).join('\n')
      expect(text).toContain('Order_p202610')
      expect(text).not.toMatch(/Order_p202609|Order_p202611|Order_default/)
    })

    it('默认分区里的数据在补建对应月份分区时自动迁入，数据不丢不重', async () => {
      await insertRow(client, 'Order', order('3', '2020-05-10T00:00:00Z'))
      const before = await client.query(`SELECT count(*)::int AS n FROM "Order"`)
      expect((await client.query(`SELECT tableoid::regclass::text AS part FROM "Order" WHERE id = 'o-3'`)).rows[0].part).toBe('"Order_default"')
      expect((await client.query(`SELECT nova_ensure_month_partition('"Order"'::regclass, '2020-05-01') AS created`)).rows[0].created).toBe(true)
      expect((await client.query(`SELECT tableoid::regclass::text AS part FROM "Order" WHERE id = 'o-3'`)).rows[0].part).toBe('"Order_p202005"')
      const after = await client.query(`SELECT count(*)::int AS n FROM "Order"`)
      expect(after.rows[0].n).toBe(before.rows[0].n)
      expect((await client.query(`SELECT nova_ensure_month_partition('"Order"'::regclass, '2020-05-20') AS created`)).rows[0].created).toBe(false)
    })

    it('续建函数拒绝非法参数', async () => {
      await expect(client.query(`SELECT nova_ensure_partitions('"Order"'::regclass, '2026-05-01', '2026-01-01')`)).rejects.toThrow(/不能早于/)
      await expect(client.query(`SELECT nova_ensure_partitions('"Order"'::regclass, '1900-01-01', '2026-01-01')`)).rejects.toThrow(/600/)
      await expect(client.query(`SELECT nova_partition_key('"Tenant"'::regclass)`)).rejects.toThrow(/不是单列范围分区表/)
    })
  })
})
