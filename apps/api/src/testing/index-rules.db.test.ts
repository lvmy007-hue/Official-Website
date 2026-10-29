import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { applyMigrations } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 索引规范与分区规范的自动检查（freeze/models.md 0.2、0.3；14.5 第 7 类“数据库迁移检查”）。
// 新增表若违反规则，持续集成直接失败，不靠人工记得。

type Row = Record<string, any>

// 规则 1 的已知例外：这些表在阶段 0 之前就存在，其租户列索引不在第一位；由对应工作包迁移时修正，逐项登记，不得新增。
const TENANT_INDEX_EXCEPTIONS: Record<string, string> = {}

describe('数据库结构规则', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('rules')
    client = await db.connect('rules')
    await applyMigrations(client)
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })

  it('规则 1：带租户列的表，至少有一个以租户列开头的索引（主键、唯一键、普通索引均可）', async () => {
    const { rows } = await client.query<Row>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relispartition
        AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped)
        AND NOT EXISTS (
          SELECT 1 FROM pg_index i
          JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
          WHERE i.indrelid = c.oid AND a.attname = 'tenantId')
      ORDER BY c.relname`)
    const offenders = rows.map(r => r.table_name as string).filter(name => !(name in TENANT_INDEX_EXCEPTIONS))
    expect(offenders, `这些表没有以 tenantId 开头的索引：${offenders.join('、')}`).toEqual([])
  })

  it('规则 2：外键列都有索引支撑（任一索引的第一列等于外键的第一列）', async () => {
    const { rows } = await client.query<Row>(`
      SELECT c.conrelid::regclass::text AS table_name, a.attname AS column_name, c.conname
      FROM pg_constraint c
      JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND n.nspname = 'public' AND NOT t.relispartition AND c.conparentid = 0
        AND NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1])
      ORDER BY 1, 2`)
    const list = rows.map(r => `${r.table_name}.${r.column_name}`)
    expect(list, `这些外键列没有索引：${list.join('、')}`).toEqual(EXPECTED_UNINDEXED_FOREIGN_KEYS)
  })

  it('规则 3：分区表的主键与全部唯一索引都包含分区列', async () => {
    const { rows } = await client.query<Row>(`
      SELECT c.relname AS table_name, ic.relname AS index_name
      FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid
      JOIN pg_index i ON i.indrelid = p.partrelid AND i.indisunique
      JOIN pg_class ic ON ic.oid = i.indexrelid
      WHERE NOT (p.partattrs::int2[] <@ i.indkey::int2[])
      ORDER BY 1, 2`)
    expect(rows).toEqual([])
  })

  it('规则 4：分区表必须有默认分区与当月、未来 3 个月的分区', async () => {
    await client.query(`SELECT * FROM nova_ensure_all_partitions(3)`)
    const { rows } = await client.query<Row>(`
      SELECT c.relname AS table_name,
             count(*) FILTER (WHERE pg_get_expr(ch.relpartbound, ch.oid) = 'DEFAULT') AS defaults,
             count(*) FILTER (WHERE pg_get_expr(ch.relpartbound, ch.oid) <> 'DEFAULT') AS months
      FROM pg_partitioned_table p
      JOIN pg_class c ON c.oid = p.partrelid
      JOIN pg_inherits i ON i.inhparent = p.partrelid
      JOIN pg_class ch ON ch.oid = i.inhrelid
      GROUP BY c.relname ORDER BY 1`)
    expect(rows.length).toBeGreaterThanOrEqual(7)
    for (const row of rows) {
      expect(Number(row.defaults), `${row.table_name} 缺少默认分区`).toBe(1)
      expect(Number(row.months), `${row.table_name} 的月份分区不足 4 个`).toBeGreaterThanOrEqual(4)
    }
  })
})

// 规则 2 的已知清单：阶段 0 之前就存在、尚未建索引的外键列；由对应工作包迁移补齐后从这里删除，不得新增。
const EXPECTED_UNINDEXED_FOREIGN_KEYS: string[] = []
