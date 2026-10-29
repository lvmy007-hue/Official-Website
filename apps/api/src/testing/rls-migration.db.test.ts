import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

const TARGET = '20261021080000_tenant_rls'

// 迁移 M-P1-16（租户行级安全）：已有数据原样保留、两个账号的权限边界、回滚可用且可再次升级。
describe('迁移 M-P1-16：行级安全的保数据与回滚（真实数据库）', () => {
  let db: TestDatabase
  let admin: Client

  const asApp = async (tenantId: string | null, sql: string) => {
    const app = new Client({ connectionString: db.urlFor('rls_migration', 'app') })
    await app.connect()
    try {
      await app.query('BEGIN')
      if (tenantId !== null) await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      const result = await app.query(sql)
      await app.query('ROLLBACK')
      return { rows: result.rows }
    } catch (error) {
      return { error: (error as { code?: string }).code ?? String(error) }
    } finally {
      await app.end()
    }
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('rls_migration')
    admin = await db.connect('rls_migration')
    await applyMigrations(admin, { before: TARGET })
    // 升级前：两个租户各有主体、店铺与一张订单
    for (const suffix of ['m1', 'm2']) {
      const seeded = await seedTenant(admin, suffix)
      await insertRow(admin, 'Order', {
        id: `order-${suffix}`,
        tenantId: seeded.tenantId,
        sellerAccountId: seeded.sellerAccountId,
        amazonOrderId: `111-${suffix}`,
        purchaseDate: '2026-03-01T00:00:00Z',
        marketplaceId: 'ATVPDKIKX0DER',
      })
    }
    await applyMigrations(admin, { only: TARGET })
  }, 120_000)

  afterAll(async () => {
    await admin?.end()
    await db?.stop()
  })

  it('升级后已有数据原样保留（行数与内容不变）', async () => {
    expect((await admin.query(`SELECT count(*)::int AS n FROM "Order"`)).rows[0].n).toBe(2)
    expect((await admin.query(`SELECT count(*)::int AS n FROM "LegalEntity"`)).rows[0].n).toBe(2)
    expect((await admin.query(`SELECT "amazonOrderId" FROM "Order" WHERE id = 'order-m1'`)).rows[0].amazonOrderId).toBe('111-m1')
  })

  it('升级后：租户连接只看到本租户的订单；没有设置租户时一行都看不到', async () => {
    expect((await asApp('tenant-m1', `SELECT id FROM "Order"`)).rows).toEqual([{ id: 'order-m1' }])
    expect((await asApp('tenant-m2', `SELECT id FROM "Order"`)).rows).toEqual([{ id: 'order-m2' }])
    expect((await asApp(null, `SELECT id FROM "Order"`)).rows).toEqual([])
  })

  it('分区维护函数：系统账号可以执行，租户账号没有权限', async () => {
    const system = new Client({ connectionString: db.urlFor('rls_migration', 'system') })
    await system.connect()
    try {
      await expect(system.query(`SELECT * FROM nova_default_partition_rows()`)).resolves.toBeTruthy()
    } finally {
      await system.end()
    }
    expect((await asApp('tenant-m1', `SELECT * FROM nova_default_partition_rows()`)).error).toBe('42501')
    expect((await asApp('tenant-m1', `SELECT * FROM nova_ensure_all_partitions(1)`)).error).toBe('42501')
  })

  it('回滚：策略与授权移除、数据全部保留；之后可再次升级并恢复隔离', async () => {
    await admin.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    const secured = (await admin.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relrowsecurity`)).rows[0].n
    expect(secured).toBe(0)
    expect((await admin.query(`SELECT count(*)::int AS n FROM "pg_policies" WHERE schemaname = 'public'`)).rows[0].n).toBe(0)
    expect((await admin.query(`SELECT count(*)::int AS n FROM "Order"`)).rows[0].n).toBe(2)
    // 租户账号被收回授权：连表都读不了
    expect((await asApp('tenant-m1', `SELECT id FROM "Order"`)).error).toBe('42501')

    await applyMigrations(admin, { only: TARGET })
    expect((await asApp('tenant-m1', `SELECT id FROM "Order"`)).rows).toEqual([{ id: 'order-m1' }])
    expect((await admin.query(`SELECT count(*)::int AS n FROM "Order"`)).rows[0].n).toBe(2)
  })
})
