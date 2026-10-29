import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { expectIndexedQuery, reviewQueryIndexes } from './explain'
import { startTestDatabase, type TestDatabase } from './test-database'

// 索引评审：现有的核心列表查询必须能走索引；评审工具本身也要能识别出没有索引的查询。
describe('索引评审工具与核心查询（真实数据库）', () => {
  let db: TestDatabase
  let client: Client

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('explain')
    await db.migrate('explain')
    client = await db.connect('explain')
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })

  it('订单按租户与下单时间范围查询走索引', async () => {
    const review = await expectIndexedQuery(client, `SELECT id FROM "Order" WHERE "tenantId" = $1 AND "purchaseDate" >= $2 AND "purchaseDate" < $3 ORDER BY "purchaseDate" DESC, id DESC LIMIT 50`, [
      't',
      '2026-01-01',
      '2026-02-01',
    ])
    expect(review.indexes.length).toBeGreaterThan(0)
  })

  it('审计事件按租户与发生时间范围查询走索引', async () => {
    await expectIndexedQuery(client, `SELECT id FROM "AuditEvent" WHERE "tenantId" = $1 AND "occurredAt" >= $2 ORDER BY "occurredAt" DESC, id DESC LIMIT 50`, ['t', '2026-01-01'])
  })

  it('同步任务按租户与创建时间查询走索引', async () => {
    await expectIndexedQuery(client, `SELECT id FROM "SyncJob" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 50`, ['t'])
  })

  it('没有索引的条件会被识别出来', async () => {
    const review = await reviewQueryIndexes(client, `SELECT id FROM "Order" WHERE "currency" = $1`, ['USD'])
    expect(review.seqScans.length).toBeGreaterThan(0)
    await expect(expectIndexedQuery(client, `SELECT id FROM "SyncJob" WHERE "failureCode" = $1`, ['x'])).rejects.toThrow(/no usable index/)
  })

  it('只接受查询语句，且评审后不留下会话设置', async () => {
    await expect(reviewQueryIndexes(client, `DELETE FROM "Order"`)).rejects.toThrow()
    const { rows } = await client.query<{ enable_seqscan: string }>('SHOW enable_seqscan')
    expect(rows[0].enable_seqscan).toBe('on')
  })
})
