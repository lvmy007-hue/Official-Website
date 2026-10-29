import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { reportTypesOfDomain } from '@nova/api-contracts'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 同步中心（P5-06，真实数据库 + 完整应用）：数据域与状态筛选（含报告任务按报告类型归域的 JSON 路径条件）、搜索、翻页、
// 数据范围、企业隔离、任务详情、人工重试的前置条件与写入、迁移的回滚与重放。

type Member = { userId: string; token: string }
type Row = Record<string, any>

const MIGRATION = join(__dirname, '../../../../database/prisma/migrations/20261202010000_sync_center')
const FINANCE_REPORT = reportTypesOfDomain('FINANCE')[0]!
const BASE = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000

describe('同步中心（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeB: string
  let admin: Member
  let scopedB: Member
  let reader: Member
  let other: Member

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Row
  }
  const ids = (data: Row) => (data.items as Row[]).map(item => item.id as string).sort()

  let seq = 0
  const job = (values: Row) => insertRow(h.client, 'SyncJob', { tenantId, requestId: `req-${++seq}`, createdAt: new Date(BASE - seq * 1000), ...values })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'sync_center' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    storeB = 'seller-b2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-B2', logicalRegion: 'NA', displayName: '店铺 B' })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-a', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher', sellerAccountId: a.sellerAccountId })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-b', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher', sellerAccountId: storeB })
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-ads', tenantId, provider: 'AMAZON_ADS_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    await insertRow(h.client, 'PlatformConnection', {
      id: 'conn-x',
      tenantId: b.tenantId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'cipher',
      sellerAccountId: b.sellerAccountId,
    })
    admin = await h.createMember(tenantId, 'admin', ['sync.read', 'sync.manage'])
    scopedB = await h.createMember(tenantId, 'scopedb', ['sync.read', 'sync.manage'], { scopes: [{ sellerAccountId: storeB }] })
    reader = await h.createMember(tenantId, 'reader', ['sync.read'])
    other = await h.createMember(b.tenantId, 'other', ['sync.read', 'sync.manage'])

    await job({
      id: 'j-failed',
      connectionId: 'conn-a',
      type: 'FBA_ORDERS',
      status: 'FAILED_PERMANENT',
      attempts: 5,
      failureCode: 'AUTH_EXPIRED',
      deadLettered: true,
      startedAt: new Date(BASE),
      finishedAt: new Date(BASE + 60_000),
    })
    await job({ id: 'j-done', connectionId: 'conn-a', type: 'FBA_ORDERS', status: 'SUCCEEDED', attempts: 1, resultJson: { imported: 5, markets: ['US'] }, finishedAt: new Date(BASE + 5_000) })
    await job({ id: 'j-queued', connectionId: 'conn-a', type: 'FBA_INVENTORY', status: 'PENDING', attempts: 0 })
    await job({ id: 'j-retry', connectionId: 'conn-a', type: 'FBA_INVENTORY', status: 'PENDING', attempts: 2, failureCode: 'THROTTLED' })
    await job({ id: 'j-health', connectionId: 'conn-a', type: 'FBA_REPORT_CREATE', status: 'PENDING', attempts: 1, context: { reportType: 'GET_V2_SELLER_PERFORMANCE_REPORT' } })
    await job({ id: 'j-brand', connectionId: 'conn-a', type: 'FBA_REPORT_POLL', status: 'PENDING', attempts: 1, context: { reportType: 'GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT' } })
    await job({ id: 'j-finance', connectionId: 'conn-a', type: 'FBA_REPORT_CREATE', status: 'PENDING', attempts: 1, context: { reportType: FINANCE_REPORT } })
    await job({ id: 'j-report', connectionId: 'conn-a', type: 'FBA_REPORT_CREATE', status: 'PENDING', attempts: 1, context: { reportType: 'GET_FBA_FULFILLMENT_CUSTOMER_RETURNS_DATA' } })
    await job({ id: 'j-unknown', connectionId: 'conn-a', type: 'SOMETHING_NEW', status: 'SUCCEEDED', attempts: 1, finishedAt: new Date(BASE) })
    await job({ id: 'j-running', connectionId: 'conn-b', type: 'FBA_ORDERS', status: 'RUNNING', attempts: 1, startedAt: new Date(BASE) })
    await job({ id: 'j-ads', connectionId: 'conn-ads', type: 'FBA_ADS', status: 'SUCCEEDED', attempts: 1, finishedAt: new Date(BASE) })
    await insertRow(h.client, 'SyncJob', {
      id: 'j-other',
      tenantId: b.tenantId,
      connectionId: 'conn-x',
      type: 'FBA_ORDERS',
      status: 'FAILED_PERMANENT',
      requestId: 'req-x',
      failureCode: 'AUTH_EXPIRED',
    })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('列表：本企业全部 11 个任务，别的企业的不出现；各状态条数与数据库一致', async () => {
    const list = await get(admin, '/sync/jobs?pageSize=100')
    expect(list.state).toBe('OK')
    expect(list.items).toHaveLength(11)
    expect(ids(list)).not.toContain('j-other')
    expect(list.counts).toEqual({ QUEUED: 1, RETRY_WAIT: 1, POLL_WAIT: 4, RUNNING: 1, SUCCEEDED: 3, FAILED: 1 })
    expect(list.items[0].id).toBe('j-failed') // 按创建时间倒序：最近创建的在前
  })

  it('数据域筛选：普通类型按类型，报告任务按报告类型归到账户健康、品牌分析、财务交易、业务报告；认不出的类型归系统任务', async () => {
    const domainIds = async (domain: string) => ids(await get(admin, `/sync/jobs?domain=${domain}&pageSize=100`))
    expect(await domainIds('ORDERS')).toEqual(['j-done', 'j-failed', 'j-running'])
    expect(await domainIds('INVENTORY')).toEqual(['j-queued', 'j-retry'])
    expect(await domainIds('ACCOUNT_HEALTH')).toEqual(['j-health'])
    expect(await domainIds('BRAND')).toEqual(['j-brand'])
    expect(await domainIds('FINANCE')).toEqual(['j-finance'])
    expect(await domainIds('REPORTS')).toEqual(['j-report'])
    expect(await domainIds('ADS_ENTITIES')).toEqual(['j-ads'])
    expect(await domainIds('SYSTEM')).toEqual(['j-unknown'])
    expect(await domainIds('ADS_STREAM')).toEqual([])
    const empty = await get(admin, '/sync/jobs?domain=ADS_STREAM')
    expect(empty).toMatchObject({ state: 'NO_DATA' })
    expect(empty.note).toContain('没有符合筛选条件')
  })

  it('状态筛选与搜索：每个状态各取出正确的任务；搜索匹配请求编号、任务编号、类型编号与类型中文名', async () => {
    const stateIds = async (state: string) => ids(await get(admin, `/sync/jobs?state=${state}&pageSize=100`))
    expect(await stateIds('QUEUED')).toEqual(['j-queued'])
    expect(await stateIds('RETRY_WAIT')).toEqual(['j-retry'])
    expect(await stateIds('POLL_WAIT')).toEqual(['j-brand', 'j-finance', 'j-health', 'j-report'])
    expect(await stateIds('RUNNING')).toEqual(['j-running'])
    expect(await stateIds('SUCCEEDED')).toEqual(['j-ads', 'j-done', 'j-unknown'])
    expect(await stateIds('FAILED')).toEqual(['j-failed'])
    expect(ids(await get(admin, '/sync/jobs?q=库存'))).toEqual(['j-queued', 'j-retry'])
    expect(ids(await get(admin, '/sync/jobs?q=FBA_ADS'))).toEqual(['j-ads'])
    expect(ids(await get(admin, '/sync/jobs?q=j-brand'))).toEqual(['j-brand'])
    const byRequest = await rows<{ requestId: string }>(`SELECT "requestId" FROM "SyncJob" WHERE id = 'j-done'`)
    expect(ids(await get(admin, `/sync/jobs?q=${byRequest[0]!.requestId}`))).toEqual(['j-done'])
    // 筛选后各状态条数不受状态筛选影响，但受数据域影响
    const filtered = await get(admin, '/sync/jobs?domain=ORDERS&state=FAILED')
    expect(filtered.counts).toEqual({ QUEUED: 0, RETRY_WAIT: 0, POLL_WAIT: 0, RUNNING: 1, SUCCEEDED: 1, FAILED: 1 })
  })

  it('翻页：逐页走完不重不漏；条件变化后旧游标失效', async () => {
    const seen: string[] = []
    let cursor: string | null = null
    let first: Row | undefined
    for (let page = 0; page < 10; page++) {
      const data: Row = await get(admin, `/sync/jobs?pageSize=4${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      first ??= data
      seen.push(...(data.items as Row[]).map(item => item.id as string))
      cursor = data.pageInfo.nextCursor
      if (!cursor) break
    }
    expect(seen).toHaveLength(11)
    expect(new Set(seen).size).toBe(11)
    const stale = await h.call(admin.token, 'GET', `/sync/jobs?pageSize=4&state=FAILED&cursor=${encodeURIComponent(first!.pageInfo.nextCursor)}`)
    expect(stale.status).toBe(400)
    expect(stale.json.error.code).toBe('CURSOR_INVALID')
  })

  it('数据域概况：19 个数据域齐全；有任务的写出近 24 小时的成败，没有任务的是“尚无记录”', async () => {
    const list = await get(admin, '/sync/jobs')
    expect(list.domains).toHaveLength(19)
    const of = (domain: string) => list.domains.find((item: Row) => item.domain === domain) as Row
    expect(of('ORDERS')).toMatchObject({ hasJobs: true, succeeded: 1, failed: 1, active: 1 })
    expect(of('ORDERS').lastFailureText).toMatch(/授权/)
    expect(of('ORDERS').lastSuccessAt).toBeTruthy()
    expect(of('ADS_STREAM')).toMatchObject({ availability: 'NOT_CONNECTED', hasJobs: false, succeeded: 0, lastSuccessAt: null })
    expect(of('AWD')).toMatchObject({ hasJobs: false })
  })

  it('数据范围：受限成员只能看到范围内店铺的任务；账户级连接（广告）与其他店铺的任务不可见，详情与重试都是 404', async () => {
    const list = await get(scopedB, '/sync/jobs?pageSize=100')
    expect(ids(list)).toEqual(['j-running'])
    expect(list.domains.find((item: Row) => item.domain === 'ORDERS')).toMatchObject({ active: 1, failed: 0 })
    expect((await h.call(scopedB.token, 'GET', '/sync/jobs/j-failed')).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', '/sync/jobs/j-ads')).status).toBe(404)
    expect((await h.call(scopedB.token, 'POST', '/sync/jobs/j-failed/retry')).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', '/sync/jobs/j-running')).status).toBe(200)
  })

  it('企业隔离：别的企业看不到本企业的任务；本企业看不到别的企业的任务', async () => {
    expect(ids(await get(other, '/sync/jobs?pageSize=100'))).toEqual(['j-other'])
    expect((await h.call(other.token, 'GET', '/sync/jobs/j-failed')).status).toBe(404)
    expect((await h.call(other.token, 'POST', '/sync/jobs/j-failed/retry')).status).toBe(404)
    expect((await h.call(admin.token, 'GET', '/sync/jobs/j-other')).status).toBe(404)
  })

  it('详情：参数、时间线、统计（只留数字）、死信、流程分步', async () => {
    await h.client.query(`UPDATE "SyncJob" SET "timelineJson" = $1::jsonb, "context" = $2::jsonb, "checkpointJson" = '{"p":1}'::jsonb WHERE id = 'j-failed'`, [
      JSON.stringify([
        { at: '2026-10-25T00:00:00.000Z', stage: 'STARTED', text: '第 5 次尝试' },
        { at: '2026-10-25T00:01:00.000Z', stage: 'FAILED', text: 'AUTH_EXPIRED' },
      ]),
      JSON.stringify({ marketplaceId: 'ATVPDKIKX0DER', secretToken: 'must-not-leak' }),
    ])
    await insertRow(h.client, 'WorkflowRun', { id: 'wf-1', tenantId, kind: 'order.sync', status: 'FAILED', errorCode: 'AUTH_EXPIRED', syncJobId: 'j-failed' })
    await insertRow(h.client, 'WorkflowStep', { id: 'ws-1', tenantId, runId: 'wf-1', seq: 1, name: 'fetch-orders', status: 'FAILED', errorCode: 'AUTH_EXPIRED', attempt: 2 })
    await insertRow(h.client, 'DeadLetterJob', {
      id: 'dl-1',
      tenantId,
      queue: 'sync-orders',
      jobName: 'sync',
      payloadRef: '{}',
      errorCode: 'AUTH_EXPIRED',
      errorDetail: 'x',
      attempts: 5,
      syncJobId: 'j-failed',
    })
    const data = await get(reader, '/sync/jobs/j-failed')
    expect(data.job).toMatchObject({ id: 'j-failed', state: 'FAILED', storeName: expect.any(String), canRetry: true })
    expect(data.queue).toBe('sync-orders')
    expect(data.hasCheckpoint).toBe(true)
    expect(data.timeline.map((item: Row) => item.label)).toEqual(['开始执行', '任务失败'])
    expect(data.params).toEqual(expect.arrayContaining([{ label: '站点', value: 'ATVPDKIKX0DER' }]))
    expect(JSON.stringify(data)).not.toContain('must-not-leak')
    expect(data.workflows).toMatchObject([{ kind: 'order.sync', steps: [{ seq: 1, name: 'fetch-orders', errorCode: 'AUTH_EXPIRED', attempt: 2 }] }])
    expect(data.deadLetter).toMatchObject({ id: 'dl-1', queue: 'sync-orders' })
    const done = await get(reader, '/sync/jobs/j-done')
    expect(done.stats).toEqual([{ key: 'imported', label: '导入行数', value: 5 }]) // 数组与文字没有进统计
    const noStats = await get(reader, '/sync/jobs/j-ads')
    expect(noStats.stats).toBeNull()
    expect(noStats.notes.join('')).toContain('没有记录写入统计')
    expect((await h.call(reader.token, 'GET', '/sync/jobs/nope')).status).toBe(404)
  })

  it('重试：只读成员 403；排队、运行、等待中的任务 409；失败的任务清零尝试次数、时间线记一笔、重新入队', async () => {
    expect((await h.call(reader.token, 'POST', '/sync/jobs/j-failed/retry')).status).toBe(403)
    for (const id of ['j-queued', 'j-retry', 'j-running', 'j-health']) {
      const res = await h.call(admin.token, 'POST', `/sync/jobs/${id}/retry`)
      expect(res.status, id).toBe(409)
      expect(res.json.error.code).toBe('SYNC_JOB_NOT_RETRYABLE')
    }
    h.queue.add.mockClear()
    const res = await h.call(admin.token, 'POST', '/sync/jobs/j-failed/retry')
    expect(res.status, JSON.stringify(res.json)).toBe(202)
    const [after] = await rows<Row>(`SELECT status, attempts, "failureCode", "deadLettered", "timelineJson" FROM "SyncJob" WHERE id = 'j-failed'`)
    expect(after).toMatchObject({ status: 'PENDING', attempts: 0, failureCode: null, deadLettered: false })
    expect((after!.timelineJson as Row[]).map(event => event.stage)).toEqual(['STARTED', 'FAILED', 'RETRY_REQUESTED'])
    expect(h.queue.add).toHaveBeenCalledTimes(1)
    const list = await get(admin, '/sync/jobs?q=j-failed')
    expect(list.items[0]).toMatchObject({ id: 'j-failed', state: 'QUEUED', canRetry: false }) // 重试后回到“排队中”
    expect((await h.call(admin.token, 'POST', '/sync/jobs/j-failed/retry')).status).toBe(409) // 同一个任务不能连点重试
  })

  it('已作废的任务不能重试：连接已断开与报告已取消', async () => {
    await job({ id: 'j-void', connectionId: 'conn-a', type: 'FBA_ORDERS', status: 'FAILED_PERMANENT', attempts: 1, failureCode: 'CONNECTION_DISCONNECTED' })
    const res = await h.call(admin.token, 'POST', '/sync/jobs/j-void/retry')
    expect(res.status).toBe(409)
    expect(res.json.error.message).toContain('连接已断开')
    const row = (await get(admin, '/sync/jobs/j-void')).job
    expect(row).toMatchObject({ canRetry: false })
    expect(row.retryBlockedReason).toContain('重新授权')
  })

  it('队列监控与限速状态：本企业的任务统计来自数据库；缓存与队列在测试里是替身，读不到数据时如实写“尚无记录”', async () => {
    // 订单队列里本企业的任务：j-running 运行中；j-failed 重试后排队中；j-done 十分钟前完成；j-void 五分钟前失败；j-unknown 等不在订单队列
    await h.client.query(`UPDATE "SyncJob" SET "finishedAt" = now() - interval '10 minutes' WHERE id = 'j-done'`)
    await h.client.query(`UPDATE "SyncJob" SET "finishedAt" = now() - interval '5 minutes' WHERE id = 'j-void'`)
    await h.client.query(`UPDATE "SyncJob" SET "finishedAt" = now() - interval '3 hours' WHERE id = 'j-unknown'`)
    h.queue.counts.mockResolvedValue({ 'sync-orders': { waiting: 2, active: 1, delayed: 0, failed: 0 } })
    const queues = await get(reader, '/sync/queues')
    expect(queues.state).toBe('OK')
    const orders = queues.queues.find((item: Row) => item.queue === 'sync-orders') as Row
    expect(orders).toMatchObject({ waiting: 2, active: 1, tenant: { waiting: 1, active: 1, completedLastHour: 1, failedLastHour: 1 }, tenantShare: 2 / 3 })
    const scoped = await get(scopedB, '/sync/queues')
    expect(scoped.queues.find((item: Row) => item.queue === 'sync-orders').tenant).toEqual({ waiting: 0, active: 1, completedLastHour: 0, failedLastHour: 0 })
    const none = await get(reader, '/sync/rate-limits')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    h.rateLimit.buckets.mockResolvedValueOnce({
      items: [
        { connectionId: 'conn-a', family: 'orders', tokens: 1, updatedAt: Date.now(), rate: 1, burst: 2, blockedUntil: 0, limitedAt: null },
        { connectionId: 'conn-x', family: 'orders', tokens: 1, updatedAt: Date.now(), rate: 1, burst: 2, blockedUntil: 0, limitedAt: null }, // 别的企业的连接编号，即使混进来也不显示
      ],
      truncated: false,
    })
    const limits = await get(reader, '/sync/rate-limits')
    expect(limits.items).toHaveLength(1)
    expect(limits.items[0]).toMatchObject({ connectionId: 'conn-a', family: 'orders', apiLabel: 'Amazon SP-API' })
    expect((await h.call(other.token, 'GET', '/sync/queues')).status).toBe(200)
  })

  it('回滚与重放：rollback.sql 删掉新增的列，migration.sql 能重新加上，任务行保留', async () => {
    const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "SyncJob"`))[0]!.n
    await h.client.query(readFileSync(join(MIGRATION, 'rollback.sql'), 'utf8'))
    const gone = await rows<{ n: number }>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'SyncJob' AND column_name IN ('resultJson', 'timelineJson')`)
    expect(gone[0]!.n).toBe(0)
    await h.client.query(readFileSync(join(MIGRATION, 'migration.sql'), 'utf8'))
    expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "SyncJob"`))[0]!.n).toBe(before)
    expect((await rows<Row>(`SELECT "resultJson", "timelineJson" FROM "SyncJob" LIMIT 1`))[0]).toEqual({ resultJson: null, timelineJson: null })
  })
})
