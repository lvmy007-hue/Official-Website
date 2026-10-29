import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from './test-database'

const REGRANT_SQL = readFileSync(join(__dirname, '../../../../database/ops/regrant.sql'), 'utf8')

const SNAPSHOT_SQL = `
  SELECT r.rolname AS role, c.relname AS "table", p.priv AS privilege
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN unnest(ARRAY['nova_app', 'nova_system']) AS r(rolname)
  CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) AS p(priv)
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND has_table_privilege(r.rolname, c.oid, p.priv)
  ORDER BY 1, 2, 3`

// P1-25 重新授权脚本（database/ops/regrant.sql）：迁移之前账号不存在的库（从单账号部署升级），用它补齐权限。
// 对照基准是“账号先创建、再执行全部迁移”得到的权限；脚本重放后必须与基准逐项一致，且不得扩大到系统专用表。
describe('重新授权脚本（真实数据库）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  it('撤销全部表权限后重放脚本：与迁移授权的结果逐项一致，并且可重复执行', async () => {
    await db.createDatabase('regrant_main')
    db.migrate('regrant_main')
    const admin = await db.connect('regrant_main')
    try {
      const baseline = (await admin.query(SNAPSHOT_SQL)).rows
      expect(baseline.length).toBeGreaterThan(100)

      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nova_app, nova_system')
      expect((await admin.query(SNAPSHOT_SQL)).rows).toHaveLength(0)

      await admin.query(REGRANT_SQL)
      expect((await admin.query(SNAPSHOT_SQL)).rows).toEqual(baseline)

      await admin.query(REGRANT_SQL)
      expect((await admin.query(SNAPSHOT_SQL)).rows).toEqual(baseline)
    } finally {
      await admin.end()
    }
  })

  it('不会把系统专用表开放给租户账号，数据密钥系统账号只增不删', async () => {
    await db.createDatabase('regrant_scope')
    db.migrate('regrant_scope')
    const admin = await db.connect('regrant_scope')
    try {
      await admin.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nova_app, nova_system')
      await admin.query(REGRANT_SQL)
      const rows = (await admin.query(SNAPSHOT_SQL)).rows as Array<{ role: string; table: string; privilege: string }>
      const has = (role: string, table: string, privilege: string) => rows.some(row => row.role === role && row.table === table && row.privilege === privilege)
      for (const table of ['Session', 'MfaFactor', 'DataEncryptionKey']) expect(has('nova_app', table, 'SELECT')).toBe(false)
      expect(has('nova_app', 'Order', 'SELECT')).toBe(true)
      expect(has('nova_app', 'AuditEvent', 'UPDATE')).toBe(false)
      expect(has('nova_system', 'Session', 'DELETE')).toBe(true)
      expect(has('nova_system', 'DataEncryptionKey', 'INSERT')).toBe(true)
      expect(has('nova_system', 'DataEncryptionKey', 'DELETE')).toBe(false)
    } finally {
      await admin.end()
    }
  })

  it('全新的库（还没有迁移）与账号不存在时什么也不做，不报错', async () => {
    await db.createDatabase('regrant_empty')
    const admin = await db.connect('regrant_empty')
    try {
      await expect(admin.query(REGRANT_SQL)).resolves.toBeDefined()
    } finally {
      await admin.end()
    }
  })
})
