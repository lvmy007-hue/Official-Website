import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { startTestDatabase, type TestDatabase } from './test-database'

// 验证测试数据库本身可用：启动、建库、执行全部现有迁移。
describe('测试数据库', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  it('能执行全部迁移，并创建核心表', async () => {
    await db.createDatabase('boot')
    db.migrate('boot')
    const client = await db.connect('boot')
    try {
      const { rows } = await client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('Order','OrderItem','AuditEvent','AdsMetric')`,
      )
      expect(rows.map(r => r.table_name).sort()).toEqual(['AdsMetric', 'AuditEvent', 'Order', 'OrderItem'])
      const version = await client.query<{ server_version: string }>('SHOW server_version')
      expect(version.rows[0].server_version.startsWith('16.')).toBe(true)
    } finally {
      await client.end()
    }
  })
})
