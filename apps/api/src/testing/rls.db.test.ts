import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Client } from 'pg'
import { insertRow, seedTenant } from './db-fixtures'
import { APPEND_ONLY_TABLES, CHILD_TABLES, IGNORED_TABLES, READ_ONLY_TABLES, SPECIAL_TABLES, SYSTEM_ONLY_TABLES, listTenantTables, seedTenantRows } from './tenant-seed'
import { startTestDatabase, type TestDatabase } from './test-database'

// 行级安全（P1-16，12.8 第 2 条）：第二道防线在数据库里。
// 与应用代码无关：直接以租户连接账号（nova_app）访问每一张表，验证租户甲永远碰不到租户乙的行。
// 新增的表只要带 tenantId，就会被自动纳入下面的全部检查；没带 tenantId 的表必须在本文件登记归类，否则“策略覆盖检查”失败。

// 表的归类（子表、系统专用、专门策略、只增不改）登记在 tenant-seed.ts，与越权测试套件共用。

type Outcome = { rows?: any[]; rowCount?: number | null; error?: string }

describe('行级安全（真实数据库，租户连接账号）', () => {
  let db: TestDatabase
  let admin: Client
  let app: Client
  let system: Client
  let tenantTables: string[]
  const A = 'tenant-rls-a'
  const B = 'tenant-rls-b'

  // 以租户连接账号执行一条语句：每次都在独立事务里，设置（或不设置）租户变量后执行，最后回滚，互不影响。
  async function asApp(tenantId: string | null, sql: string, params: unknown[] = []): Promise<Outcome> {
    await app.query('BEGIN')
    try {
      if (tenantId !== null) await app.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      const result = await app.query(sql, params)
      return { rows: result.rows, rowCount: result.rowCount }
    } catch (error) {
      return { error: (error as { code?: string }).code ?? String(error) }
    } finally {
      await app.query('ROLLBACK')
    }
  }

  const count = async (tenantId: string | null, table: string, where = 'TRUE') => {
    const outcome = await asApp(tenantId, `SELECT count(*)::int AS n FROM "${table}" WHERE ${where}`)
    return outcome.error ?? (outcome.rows?.[0].n as number)
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('rls')
    db.migrate('rls')
    admin = await db.connect('rls')
    app = new Client({ connectionString: db.urlFor('rls', 'app') })
    system = new Client({ connectionString: db.urlFor('rls', 'system') })
    await app.connect()
    await system.connect()

    tenantTables = await listTenantTables(admin)

    // 造数：两个租户、各自的用户与成员关系，再为每张租户表各造一行
    await admin.query(`SET session_replication_role = replica`)
    const tenantA = await seedTenant(admin, 'rls-a')
    const tenantB = await seedTenant(admin, 'rls-b')
    await admin.query(`UPDATE "Tenant" SET id = $1 WHERE id = $2`, [A, tenantA.tenantId])
    await admin.query(`UPDATE "Tenant" SET id = $1 WHERE id = $2`, [B, tenantB.tenantId])
    await admin.query(`UPDATE "LegalEntity" SET "tenantId" = $1 WHERE id = $2`, [A, tenantA.legalEntityId])
    await admin.query(`UPDATE "LegalEntity" SET "tenantId" = $1 WHERE id = $2`, [B, tenantB.legalEntityId])
    await admin.query(`UPDATE "SellerAccount" SET "tenantId" = $1 WHERE id = $2`, [A, tenantA.sellerAccountId])
    await admin.query(`UPDATE "SellerAccount" SET "tenantId" = $1 WHERE id = $2`, [B, tenantB.sellerAccountId])
    await insertRow(admin, 'Role', { id: 'role-global', tenantId: null, name: '预设角色', system: true })
    for (const [suffix, tenantId] of [
      ['rls-a', A],
      ['rls-b', B],
    ] as const) {
      await seedTenantRows(admin, tenantTables, tenantId, suffix)
      // 成员关系指向真实用户，用来验证“用户只对本企业成员可见”
      const user = await insertRow(admin, 'User', { id: `member-user-${suffix}`, email: `m-${suffix}@example.com` })
      await admin.query(`UPDATE "Membership" SET "userId" = $1 WHERE "tenantId" = $2`, [user.id, tenantId])
    }
    await admin.query(`SET session_replication_role = DEFAULT`)
  })

  afterAll(async () => {
    await app?.end()
    await system?.end()
    await admin?.end()
    await db?.stop()
  })

  describe('策略覆盖检查', () => {
    it('租户连接账号是普通账号：不是超级用户，不绕过行级安全，也不是任何表的所有者', async () => {
      const role = (await admin.query(`SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = 'nova_app'`)).rows[0]
      expect(role).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false })
      const owned = (await admin.query(`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public' AND tableowner = 'nova_app'`)).rows[0].n
      expect(owned).toBe(0)
    })

    it('系统连接账号可绕过行级安全；两个账号都不能在公共模式里建表', async () => {
      const role = (await admin.query(`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'nova_system'`)).rows[0]
      expect(role).toEqual({ rolsuper: false, rolbypassrls: true })
      expect((await admin.query(`SELECT has_schema_privilege('nova_app', 'public', 'CREATE') AS a, has_schema_privilege('nova_system', 'public', 'CREATE') AS s`)).rows[0]).toEqual({
        a: false,
        s: false,
      })
    })

    it('每一张表都已归类：带 tenantId 的启用行级安全并有策略；其余在本文件登记。新增表漏掉策略会在这里失败', async () => {
      const tables = (
        await admin.query(
          `SELECT c.relname AS name, c.relrowsecurity AS rls,
                  (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS policies,
                  (SELECT count(*)::int FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname AND (coalesce(p.qual, '') || coalesce(p.with_check, '')) LIKE '%nova_current_tenant%') AS tenant_policies
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition ORDER BY c.relname`,
        )
      ).rows.filter(row => !IGNORED_TABLES.has(row.name))

      const problems: string[] = []
      for (const table of tables) {
        if (tenantTables.includes(table.name)) {
          if (!table.rls || table.tenant_policies < 1) problems.push(`${table.name}：带 tenantId 但没有启用行级安全或缺少按租户的策略`)
        } else if (SYSTEM_ONLY_TABLES.includes(table.name)) {
          // 系统专用：租户连接无权限（下一条断言），无需策略
        } else if (SPECIAL_TABLES.includes(table.name) || table.name in CHILD_TABLES) {
          if (!table.rls || table.policies < 1) problems.push(`${table.name}：已登记为受保护的表，但没有启用行级安全或没有策略`)
        } else {
          problems.push(`${table.name}：没有 tenantId 列，也没有在行级安全登记中归类（子表、系统专用或专门策略三选一）`)
        }
      }
      expect(problems).toEqual([])
    })

    it('系统专用的表：租户连接没有任何权限', async () => {
      for (const table of SYSTEM_ONLY_TABLES) {
        const privilege = (await admin.query(`SELECT has_table_privilege('nova_app', $1, 'SELECT, INSERT, UPDATE, DELETE') AS any_privilege`, [`public."${table}"`])).rows[0]
        const detail = (await admin.query(`SELECT bool_or(has_table_privilege('nova_app', $1, p)) AS granted FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p`, [`public."${table}"`]))
          .rows[0]
        expect({ table, granted: detail.granted, privilege: privilege.any_privilege }).toEqual({ table, granted: false, privilege: false })
        expect(await asApp(A, `SELECT 1 FROM "${table}" LIMIT 1`)).toEqual({ error: '42501' })
      }
    })

    it('只增不改的表：租户连接只能读取与写入，不能修改或删除', async () => {
      for (const table of APPEND_ONLY_TABLES) {
        expect(await asApp(A, `UPDATE "${table}" SET "tenantId" = "tenantId"`)).toEqual({ error: '42501' })
        expect(await asApp(A, `DELETE FROM "${table}"`)).toEqual({ error: '42501' })
      }
    })

    it('租户只读的表：租户连接只能读取，不能新增、修改或删除', async () => {
      for (const table of READ_ONLY_TABLES) {
        expect(await count(A, table)).toBeGreaterThan(0)
        expect(await asApp(A, `UPDATE "${table}" SET "tenantId" = "tenantId"`)).toEqual({ error: '42501' })
        expect(await asApp(A, `DELETE FROM "${table}"`)).toEqual({ error: '42501' })
        expect((await asApp(A, `INSERT INTO "${table}" SELECT * FROM "${table}" LIMIT 1`)).error).toBe('42501')
      }
    })

    it('企业生命周期状态只能由平台修改：租户连接改动会被拒绝，改名等普通字段不受影响', async () => {
      expect((await asApp(A, `UPDATE "Tenant" SET "lifecycleStatus" = 'SUSPENDED' WHERE id = $1`, [A])).error).toBe('42501')
      expect((await asApp(A, `UPDATE "Tenant" SET "closedAt" = now() WHERE id = $1`, [A])).error).toBe('42501')
      expect((await asApp(A, `UPDATE "Tenant" SET name = 'ok' WHERE id = $1`, [A])).rowCount).toBe(1)
    })
  })

  describe('每张租户表：甲方连接看不到、改不了、删不了、写不进乙方的行', () => {
    it('造数覆盖了全部租户表（每个租户每张表都有行）', async () => {
      expect(tenantTables.length).toBeGreaterThanOrEqual(30)
      for (const table of tenantTables) {
        for (const tenantId of [A, B]) {
          const n = (await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [tenantId])).rows[0].n
          expect({ table, tenantId, hasRows: n > 0 }).toEqual({ table, tenantId, hasRows: true })
        }
      }
    })

    it('读取：只返回本租户的行；没有设置租户或设置成不存在的租户，一行都看不到', async () => {
      const tables = tenantTables.filter(name => name !== 'Role')
      for (const table of tables) {
        const mine = (await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" = $1`, [A])).rows[0].n
        expect({ table, visible: await count(A, table) }).toEqual({ table, visible: mine })
        expect({ table, other: await count(A, table, `"tenantId" = '${B}'`) }).toEqual({ table, other: 0 })
        expect({ table, none: await count(null, table) }).toEqual({ table, none: 0 })
        expect({ table, unknown: await count('no-such-tenant', table) }).toEqual({ table, unknown: 0 })
        expect({ table, empty: await count('', table) }).toEqual({ table, empty: 0 })
      }
    })

    it('修改与删除乙方的行：影响 0 行（追加型表直接无权限）', async () => {
      for (const table of tenantTables.filter(name => !APPEND_ONLY_TABLES.includes(name) && !READ_ONLY_TABLES.includes(name) && name !== 'Role')) {
        const updated = await asApp(A, `UPDATE "${table}" SET "tenantId" = "tenantId" WHERE "tenantId" = $1`, [B])
        expect({ table, updated: updated.error ?? updated.rowCount }).toEqual({ table, updated: 0 })
        const deleted = await asApp(A, `DELETE FROM "${table}" WHERE "tenantId" = $1`, [B])
        expect({ table, deleted: deleted.error ?? deleted.rowCount }).toEqual({ table, deleted: 0 })
      }
    })

    it('把乙方的租户编号写进新行（或把自己的行改成乙方）：被策略拒绝', async () => {
      for (const table of tenantTables.filter(name => name !== 'Role')) {
        const inserted = await asApp(
          A,
          `INSERT INTO "${table}" SELECT (jsonb_populate_record(null::"${table}", to_jsonb(r) || jsonb_build_object('id', 'forged-' || r.id, 'tenantId', $1::text))).* FROM "${table}" r WHERE r."tenantId" = $2 LIMIT 1`,
          [B, A],
        )
        expect({ table, inserted: inserted.error }).toEqual({ table, inserted: '42501' })
        if (APPEND_ONLY_TABLES.includes(table) || READ_ONLY_TABLES.includes(table)) continue
        const moved = await asApp(A, `UPDATE "${table}" SET "tenantId" = $1 WHERE "tenantId" = $2`, [B, A])
        expect({ table, moved: moved.error }).toEqual({ table, moved: '42501' })
      }
    })

    it('系统连接（可绕过行级安全）没有设置租户也能看到全部租户的行', async () => {
      for (const table of tenantTables) {
        const total = (await admin.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" IN ($1, $2)`, [A, B])).rows[0].n
        const seen = (await system.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "tenantId" IN ($1, $2)`, [A, B])).rows[0].n
        expect({ table, seen }).toEqual({ table, seen: total })
      }
    })
  })

  describe('子表：通过上级对象归属租户', () => {
    for (const [table, { parent, foreignKey }] of Object.entries(CHILD_TABLES)) {
      it(`${table}（上级 ${parent}）：只看到本租户上级对象下的行；不能挂到乙方的上级对象下`, async () => {
        const rowsOf = async (tenantId: string | null) => {
          const outcome = await asApp(tenantId, `SELECT id FROM "${table}" ORDER BY id`)
          return outcome.error ?? outcome.rows?.map(row => row.id)
        }
        const visibleA = (await rowsOf(A)) as string[]
        expect(visibleA).toContain(`${table}-rls-a`)
        expect(visibleA).not.toContain(`${table}-rls-b`)
        // 没有租户时看不到任何租户的行（平台预设角色的字段权限属于全局数据，所有人可读）
        const noTenant = (await rowsOf(null)) as string[]
        expect(noTenant.filter(id => id.startsWith(`${table}-rls-`))).toEqual([])
        const parentB = (await admin.query(`SELECT id FROM "${parent}" WHERE "tenantId" = $1 LIMIT 1`, [B])).rows[0].id
        const forged = await asApp(
          A,
          `INSERT INTO "${table}" SELECT (jsonb_populate_record(null::"${table}", to_jsonb(r) || jsonb_build_object('id', 'forged-' || r.id, $1::text, $2::text))).* FROM "${table}" r WHERE r.id = $3`,
          [foreignKey, parentB, `${table}-rls-a`],
        )
        expect(forged.error).toBe('42501')
        const updated = await asApp(A, `UPDATE "${table}" SET id = id WHERE id = $1`, [`${table}-rls-b`])
        expect(updated.error ?? updated.rowCount).toBe(0)
        const deleted = await asApp(A, `DELETE FROM "${table}" WHERE id = $1`, [`${table}-rls-b`])
        expect(deleted.error ?? deleted.rowCount).toBe(0)
      })
    }
  })

  describe('有专门策略的表', () => {
    it('Role：看到自己租户的角色与平台预设角色，看不到乙方的；不能新增预设角色、不能改预设角色或乙方的角色', async () => {
      const ids = ((await asApp(A, `SELECT id FROM "Role" ORDER BY id`)).rows ?? []).map(row => row.id)
      expect(ids).toContain('Role-rls-a')
      expect(ids).toContain('role-global')
      expect(ids).not.toContain('Role-rls-b')
      // 没有租户时只能看到平台预设角色（tenantId 为空的行）
      const withoutTenant = ((await asApp(null, `SELECT id, "tenantId" FROM "Role"`)).rows ?? []) as Array<{ id: string; tenantId: string | null }>
      expect(withoutTenant.length).toBeGreaterThan(0)
      expect(withoutTenant.every(role => role.tenantId === null)).toBe(true)

      const forgedGlobal = await asApp(
        A,
        `INSERT INTO "Role" SELECT (jsonb_populate_record(null::"Role", to_jsonb(r) || '{"id":"forged-global","tenantId":null}'::jsonb)).* FROM "Role" r WHERE r.id = 'Role-rls-a'`,
      )
      expect(forgedGlobal.error).toBe('42501')
      expect((await asApp(A, `UPDATE "Role" SET name = 'hacked' WHERE id = 'role-global'`)).rowCount).toBe(0)
      expect((await asApp(A, `UPDATE "Role" SET name = 'hacked' WHERE id = 'Role-rls-b'`)).rowCount).toBe(0)
      expect((await asApp(A, `DELETE FROM "Role" WHERE id IN ('role-global', 'Role-rls-b')`)).rowCount).toBe(0)
      expect((await asApp(A, `UPDATE "Role" SET name = 'mine' WHERE id = 'Role-rls-a'`)).rowCount).toBe(1)
    })

    it('Tenant：只能读取与修改自己这一行；不能新增、不能删除', async () => {
      expect((await asApp(A, `SELECT id FROM "Tenant"`)).rows?.map(row => row.id)).toEqual([A])
      expect((await asApp(null, `SELECT id FROM "Tenant"`)).rows).toEqual([])
      expect((await asApp(A, `UPDATE "Tenant" SET name = 'x' WHERE id = $1`, [B])).rowCount).toBe(0)
      expect((await asApp(A, `UPDATE "Tenant" SET name = 'x' WHERE id = $1`, [A])).rowCount).toBe(1)
      expect(
        (await asApp(A, `INSERT INTO "Tenant" SELECT (jsonb_populate_record(null::"Tenant", to_jsonb(t) || '{"id":"t-new","slug":"t-new"}'::jsonb)).* FROM "Tenant" t WHERE t.id = $1`, [A])).error,
      ).toBe('42501')
      expect((await asApp(A, `DELETE FROM "Tenant" WHERE id = $1`, [A])).error).toBe('42501')
    })

    it('User：只能读取本企业成员的用户，且不能新增、修改、删除', async () => {
      const emails = ((await asApp(A, `SELECT email FROM "User" ORDER BY email`)).rows ?? []).map(row => row.email)
      expect(emails.length).toBeGreaterThan(0)
      for (const email of emails) expect(email).not.toContain('rls-b')
      expect((await asApp(null, `SELECT email FROM "User"`)).rows).toEqual([])
      expect((await asApp(A, `UPDATE "User" SET "displayName" = 'x'`)).error).toBe('42501')
      expect((await asApp(A, `DELETE FROM "User"`)).error).toBe('42501')
    })
  })
})
