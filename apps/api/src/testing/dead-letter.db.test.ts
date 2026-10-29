import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { insertRow } from './db-fixtures'

// 失败任务（死信）接口的真实数据库行为（P1-20）：列表不泄露载荷、重放只成功一次、租户隔离。

describe('失败任务（死信）接口（真实数据库）', () => {
  let h: DbTestApp
  let a: Awaited<ReturnType<DbTestApp['createTenant']>>
  let b: Awaited<ReturnType<DbTestApp['createTenant']>>
  let tokenA: string
  let tokenB: string

  const letter = (tenantId: string, id: string) =>
    insertRow(h.client, 'DeadLetterJob', {
      id,
      tenantId,
      queue: 'reports',
      jobName: 'report-export',
      payloadRef: JSON.stringify({ tenantId, exportId: `exp-${id}` }),
      errorCode: 'HANDLER_NOT_REGISTERED',
      errorDetail: '没有注册处理器',
      attempts: 5,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'deadletter' })
    a = await h.createTenant('dla')
    b = await h.createTenant('dlb')
    tokenA = (await h.createMember(a.tenantId, 'dla', ['*'])).token
    tokenB = (await h.createMember(b.tenantId, 'dlb', ['*'])).token
    await letter(a.tenantId, 'dl-a-1')
    await letter(a.tenantId, 'dl-a-2')
    await letter(b.tenantId, 'dl-b-1')
  }, 120_000)
  afterAll(async () => {
    await h?.close()
  })

  it('列表只包含本租户的失败任务，且不返回任务载荷', async () => {
    const res = await h.call(tokenA, 'GET', '/sync/dead-letters')
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect(res.json.data.map((item: { id: string }) => item.id).sort()).toEqual(['dl-a-1', 'dl-a-2'])
    const text = JSON.stringify(res.json)
    expect(text).not.toContain('payloadRef')
    expect(text).not.toContain('exp-dl-a-1')
    expect(text).not.toContain('dl-b-1')
  })

  it('重放：按原队列与载荷入队，只成功一次，第二次返回 409；写入审计', async () => {
    const first = await h.call(tokenA, 'POST', '/sync/dead-letters/dl-a-1/replay')
    expect(first.status, JSON.stringify(first.json)).toBe(202)
    expect(first.json.data).toMatchObject({ id: 'dl-a-1' })
    expect(first.json.data.replayedAt).toBeTruthy()
    expect(h.queue.addRaw).toHaveBeenCalledTimes(1)
    expect(h.queue.addRaw.mock.calls[0].slice(0, 3)).toEqual(['reports', 'report-export', { tenantId: a.tenantId, exportId: 'exp-dl-a-1' }])

    const second = await h.call(tokenA, 'POST', '/sync/dead-letters/dl-a-1/replay')
    expect(second.status).toBe(409)
    expect(second.json.error.code).toBe('DEAD_LETTER_ALREADY_REPLAYED')
    expect(h.queue.addRaw).toHaveBeenCalledTimes(1)

    const audit = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'SYNC_DEAD_LETTER_REPLAYED'`, [a.tenantId])
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1)
  })

  it('默认列表不含已重放的记录；includeReplayed=true 才返回', async () => {
    const open = await h.call(tokenA, 'GET', '/sync/dead-letters')
    expect(open.json.data.map((item: { id: string }) => item.id)).toEqual(['dl-a-2'])
    const all = await h.call(tokenA, 'GET', '/sync/dead-letters?includeReplayed=true')
    expect(all.json.data).toHaveLength(2)
  })

  it('跨租户：对方的失败任务读不到、重放返回 404，且对方记录不变', async () => {
    const res = await h.call(tokenA, 'POST', '/sync/dead-letters/dl-b-1/replay')
    expect(res.status).toBe(404)
    const row = await h.client.query(`SELECT "replayedAt" FROM "DeadLetterJob" WHERE id = 'dl-b-1'`)
    expect(row.rows[0].replayedAt).toBeNull()
    const own = await h.call(tokenB, 'GET', '/sync/dead-letters')
    expect(own.json.data.map((item: { id: string }) => item.id)).toEqual(['dl-b-1'])
  })
})
