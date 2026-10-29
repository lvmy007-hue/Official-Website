import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 审计中心（P5-09，真实数据库 + 完整应用）：
// 迁移升级、约束、回滚闭环；列表的各项服务端筛选、游标分页、跨企业隔离；详情的差异与脱敏；筛选项；个人信息明文查看视图与汇总；
// 写入时记录来源与所属页面；审计导出（不分店铺，只要审计读取权限与导出权限）。

const TARGET = '20261205010000_audit_center'
const MIN = 60_000
const NOW = Date.now()
const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString()

describe('审计中心迁移（P5-09）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('audit_migrate')
    client = await db.connect('audit_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'AuditEvent' AND column_name IN ('source', 'page')`)).rowCount

  it('升级加两列、来源约束与动作索引，旧记录原样保留（来源为空）；回滚去掉，再升级闭环', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-au', slug: 't-au', name: '租户' })
    await insertRow(client, 'AuditEvent', { id: 'old-1', tenantId: tenant.id, action: 'LOGIN', resourceType: 'Session', requestId: 'r0', result: 'SUCCEEDED', occurredAt: ago(10) })
    expect(await columns()).toBe(0)
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toBe(2)
    expect((await client.query(`SELECT "source", "page" FROM "AuditEvent" WHERE id = 'old-1'`)).rows[0]).toEqual({ source: null, page: null })
    const audit = (id: string, source: string | null) =>
      insertRow(client, 'AuditEvent', { id, tenantId: tenant.id, action: 'X', resourceType: 'Y', requestId: id, result: 'SUCCEEDED', source, occurredAt: ago(5) })
    for (const source of ['PAGE', 'API', 'SYSTEM', null]) await audit(`ok-${source}`, source)
    await expect(audit('bad', 'ROBOT')).rejects.toMatchObject({ code: '23514' })
    const index = await client.query(`SELECT 1 FROM pg_indexes WHERE tablename = 'AuditEvent' AND indexname = 'AuditEvent_tenantId_action_occurredAt_idx'`)
    expect(index.rowCount).toBe(1)

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await columns()).toBe(0)
    expect(((await client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "tenantId" = $1`, [tenant.id])).rows[0] as { n: number }).n).toBe(5)
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toBe(2)
  })
})

type Member = { userId: string; token: string }

describe('审计中心（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let a: { tenantId: string }
  let b: { tenantId: string }
  let reader: Member
  let noExport: Member
  let exporter: Member
  let denied: Member
  let bob: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path)
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const ids = async (query: string) => ((await ok(reader, `/audit?${query}`)).items as Array<{ id: string }>).map(item => item.id).sort()
  const event = (id: string, tenantId: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AuditEvent', { id, tenantId, action: 'ROLE_UPDATED', resourceType: 'Role', requestId: `req-${id}`, result: 'SUCCEEDED', source: 'PAGE', occurredAt: ago(60), ...over })
  const json = (value: unknown) => JSON.stringify(value)

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'audit', db })
    a = await h.createTenant('au-a')
    b = await h.createTenant('au-b')
    reader = await h.createMember(a.tenantId, 'au-reader', ['audit.read', 'export.create'])
    noExport = await h.createMember(a.tenantId, 'au-noexp', ['audit.read'])
    exporter = await h.createMember(a.tenantId, 'au-exporter', ['audit.read', 'export.create'], { scopes: [] })
    denied = await h.createMember(a.tenantId, 'au-denied', ['orders.read', 'export.create'])
    bob = await h.createMember(a.tenantId, 'au-bob', ['orders.read'])
    const amy = await h.createMember(a.tenantId, 'au-amy', ['orders.read'])

    await event('ae-page', a.tenantId, {
      actorId: bob.userId,
      resourceId: 'role-1',
      page: '/app/settings/roles',
      occurredAt: ago(600),
      ip: '203.0.113.7',
      beforeJson: json({ name: '旧名', status: 'A', contactEmail: 'old@example.com' }),
      afterJson: json({ name: '新名', status: 'A', contactEmail: 'new@example.com' }),
    })
    await event('ae-api', a.tenantId, {
      actorId: bob.userId,
      action: 'EXPORT_REQUESTED',
      resourceType: 'ExportJob',
      resourceId: 'exp-1',
      source: 'API',
      occurredAt: ago(500),
      detail: json({ kind: 'orders', accessMode: 'NORMAL' }),
    })
    await event('ae-sys', a.tenantId, { actorId: bob.userId, action: 'EXPORT_COMPLETED', resourceType: 'ExportJob', resourceId: 'exp-1', source: 'SYSTEM', occurredAt: ago(400) })
    await event('ae-legacy', a.tenantId, { actorId: null, action: 'LOGIN_FAILED', resourceType: 'Session', source: null, result: 'FAILED', occurredAt: ago(300) })
    await event('ae-denied', a.tenantId, { actorId: bob.userId, resourceId: 'role-1', result: 'DENIED', page: '/app/settings/roles', occurredAt: ago(200) })
    await event('ae-support', a.tenantId, { actorId: null, action: 'SUPPORT_ACCESS_REQUEST', resourceType: 'Tenant', source: 'API', occurredAt: ago(100), detail: json({ accessMode: 'SUPPORT' }) })
    const pii = (id: string, over: Record<string, unknown>) =>
      event(id, a.tenantId, { action: 'ORDER_BUYER_PII_VIEWED', resourceType: 'Order', page: '/app/orders', reason: '客户来电核对收货信息', ...over })
    await pii('ae-pii-1', { actorId: bob.userId, resourceId: 'order-1', occurredAt: ago(50), detail: json({ amazonOrderId: '111-0000001-0000001', outcome: 'OK', fields: ['buyerName', 'city'] }) })
    await pii('ae-pii-2', {
      actorId: bob.userId,
      resourceId: 'order-2',
      occurredAt: ago(40),
      detail: json({ amazonOrderId: '111-0000002-0000002', outcome: 'OK', fields: ['buyerName', 'buyerPhone', 'country'] }),
    })
    await pii('ae-pii-3', { actorId: amy.userId, resourceId: 'order-3', occurredAt: ago(30), detail: json({ amazonOrderId: '111-0000003-0000003', outcome: 'EXPIRED' }) })
    await pii('ae-pii-old', { actorId: bob.userId, resourceId: 'order-4', occurredAt: ago(3 * 1440), detail: json({ amazonOrderId: '111-0000004-0000004', outcome: 'OK', fields: ['buyerName'] }) })
    await pii('ae-pii-denied', { actorId: noExport.userId, resourceId: 'order-1', result: 'DENIED', occurredAt: ago(20), detail: json({ amazonOrderId: '111-0000001-0000001' }) })
    await event('be-1', b.tenantId, { actorId: null, resourceId: 'role-1', page: '/app/settings/roles', occurredAt: ago(10) })
    await event('be-pii', b.tenantId, { action: 'ORDER_BUYER_PII_VIEWED', resourceType: 'Order', resourceId: 'order-b', detail: json({ outcome: 'OK', fields: ['buyerName'] }), occurredAt: ago(10) })
  }, 240_000)
  afterAll(async () => {
    await h?.close()
  })

  it('权限：没有审计读取权限的人，所有接口都是 403', async () => {
    for (const path of ['/audit', '/audit/options', '/audit/pii-views', '/audit/ae-page']) expect((await get(denied, path)).status, path).toBe(403)
  })

  it('列表：只有本企业的记录，按时间从新到旧；行里写明操作人、来源、所属页面；没有导出权限时说明原因', async () => {
    const data = await ok(reader, '/audit?pageSize=100')
    expect(data.items.map((item: { id: string }) => item.id)).toEqual([
      'ae-pii-denied',
      'ae-pii-3',
      'ae-pii-2',
      'ae-pii-1',
      'ae-support',
      'ae-denied',
      'ae-legacy',
      'ae-sys',
      'ae-api',
      'ae-page',
      'ae-pii-old',
    ])
    const byId = Object.fromEntries(data.items.map((item: { id: string }) => [item.id, item]))
    expect(byId['ae-page']).toMatchObject({ actor: { id: bob.userId, kind: 'USER' }, source: 'PAGE', sourceLabel: '页面操作', page: '/app/settings/roles', accessMode: 'NORMAL' })
    expect(byId['ae-api']).toMatchObject({ source: 'API', sourceLabel: '接口调用', page: null })
    expect(byId['ae-sys']).toMatchObject({ actor: { name: '系统', kind: 'SYSTEM' }, source: 'SYSTEM' })
    expect(byId['ae-legacy']).toMatchObject({ actor: { name: '系统' }, source: 'SYSTEM', result: 'FAILED' })
    expect(byId['ae-support']).toMatchObject({ actor: { name: '平台人员', kind: 'SUPPORT' }, accessMode: 'SUPPORT' })
    expect(data).toMatchObject({ canExport: true, exportBlockedReason: null })
    const limited = await ok(noExport, '/audit?pageSize=1')
    expect(limited).toMatchObject({ canExport: false })
    expect(limited.exportBlockedReason).toContain('export.create')
  })

  it('筛选：操作人、动作、资源类型、资源编号、结果、来源、所属页面、请求编号、关键词、时间范围都在服务端生效', async () => {
    expect(await ids(`actorId=${bob.userId}&pageSize=100`)).toEqual(['ae-api', 'ae-denied', 'ae-page', 'ae-pii-1', 'ae-pii-2', 'ae-pii-old', 'ae-sys'])
    expect(await ids('action=EXPORT_REQUESTED')).toEqual(['ae-api'])
    expect(await ids('resourceType=ExportJob')).toEqual(['ae-api', 'ae-sys'])
    expect(await ids('resourceType=Role&resourceId=role-1')).toEqual(['ae-denied', 'ae-page'])
    expect(await ids('result=DENIED&pageSize=100')).toEqual(['ae-denied', 'ae-pii-denied'])
    expect(await ids('result=FAILED')).toEqual(['ae-legacy'])
    expect(await ids('source=SYSTEM')).toEqual(['ae-legacy', 'ae-sys'])
    expect(await ids('source=API')).toEqual(['ae-api', 'ae-support'])
    expect(await ids('source=PAGE&pageSize=100')).toHaveLength(7)
    expect(await ids('page=/app/orders')).toEqual(['ae-pii-1', 'ae-pii-2', 'ae-pii-3', 'ae-pii-denied', 'ae-pii-old'])
    expect(await ids('requestId=req-ae-api')).toEqual(['ae-api'])
    expect(await ids('q=exp-')).toEqual(['ae-api', 'ae-sys'])
    expect(await ids('q=role&pageSize=100')).toEqual(['ae-denied', 'ae-page'])
    expect(await ids(`fromAt=${encodeURIComponent(ago(450))}&toAt=${encodeURIComponent(ago(250))}`)).toEqual(['ae-legacy', 'ae-sys'])
    expect(await ids(`actorId=${bob.userId}&action=ROLE_UPDATED&result=SUCCEEDED`)).toEqual(['ae-page'])
    expect(await ids('actorId=nobody')).toEqual([])
  })

  it('游标分页：每页 3 条走完全部，不重不漏；游标换了筛选条件就不能用；非法参数 422', async () => {
    const seen: string[] = []
    let cursor = ''
    for (let guard = 0; guard < 10; guard += 1) {
      const data = await ok(reader, `/audit?pageSize=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...data.items.map((item: { id: string }) => item.id))
      if (!data.pageInfo.hasMore) break
      cursor = data.pageInfo.nextCursor
    }
    expect(seen).toHaveLength(11)
    expect(new Set(seen).size).toBe(11)
    const first = await ok(reader, '/audit?pageSize=3')
    expect((await get(reader, `/audit?pageSize=3&result=FAILED&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await get(reader, '/audit?pageSize=999')).status).toBe(422)
    expect((await get(reader, '/audit?nope=1')).status).toBe(422)
    expect((await get(reader, '/audit?result=BOGUS')).status).toBe(422)
  })

  it('详情：修改前后的差异（敏感字段只显示“已隐藏”）、请求上下文、关联资源最近记录；别的企业的记录是 404', async () => {
    const data = await ok(reader, '/audit/ae-page')
    expect(data.event).toMatchObject({ id: 'ae-page', ip: '203.0.113.7', stepUpVerified: false, actor: { id: bob.userId } })
    expect(data.hasSnapshot).toBe(true)
    expect(data.changes).toEqual(
      expect.arrayContaining([
        { field: 'name', before: '旧名', after: '新名' },
        { field: 'contactEmail', before: '[已隐藏]', after: '[已隐藏]' },
      ]),
    )
    expect(data.changes).toHaveLength(2)
    expect(JSON.stringify(data)).not.toContain('old@example.com')
    expect(data.resource).toMatchObject({ type: 'Role', id: 'role-1', recentTruncated: false })
    expect(data.resource.recent.map((item: { id: string }) => item.id)).toEqual(['ae-denied'])
    expect((await get(reader, '/audit/be-1')).status).toBe(404)
    const sys = await ok(reader, '/audit/ae-sys')
    expect(sys.event).toMatchObject({ actor: { name: '系统' }, initiator: { id: bob.userId, kind: 'USER' } })
    expect(sys.changes).toEqual([])
    expect(sys.hasSnapshot).toBe(false)
    expect(sys.resource.recent.map((item: { id: string }) => item.id)).toEqual(['ae-api'])
  })

  it('筛选项：只列真实出现过的动作、资源类型、页面与操作人，选了一定查得到；不含别的企业的取值', async () => {
    const data = await ok(reader, '/audit/options')
    const values = (items: Array<{ value: string }>) => items.map(item => item.value)
    expect(values(data.actions)).toEqual(expect.arrayContaining(['ROLE_UPDATED', 'EXPORT_REQUESTED', 'ORDER_BUYER_PII_VIEWED', 'LOGIN_FAILED']))
    expect(values(data.resourceTypes)).toEqual(expect.arrayContaining(['Role', 'ExportJob', 'Order', 'Session']))
    expect(data.pages).toEqual(['/app/orders', '/app/settings/roles'])
    expect(values(data.actors)).toEqual(expect.arrayContaining([bob.userId]))
    expect(data).toMatchObject({ windowDays: 90, truncated: false })
    for (const action of values(data.actions)) expect((await ids(`action=${action}`)).length, action).toBeGreaterThan(0)
  })

  it('个人信息明文查看：谁、何时、理由、哪个订单的哪些字段（只有字段名）、结果；汇总只数真正看到内容的次数', async () => {
    const data = await ok(reader, '/audit/pii-views?pageSize=100')
    const rows = data.items as Array<Record<string, any>>
    expect(rows.map(row => row.id)).toEqual(['ae-pii-denied', 'ae-pii-3', 'ae-pii-2', 'ae-pii-1', 'ae-pii-old'])
    const byId = Object.fromEntries(rows.map(row => [row.id, row]))
    expect(byId['ae-pii-1']).toMatchObject({
      actor: { id: bob.userId },
      reason: '客户来电核对收货信息',
      object: { type: 'Order', id: 'order-1', label: '111-0000001-0000001', path: '/app/orders/order-1' },
      fields: ['姓名', '城市'],
      outcome: 'OK',
      outcomeLabel: '已查看',
      accessMode: 'NORMAL',
    })
    expect(byId['ae-pii-2'].fields).toEqual(['姓名', '电话', '国家或地区'])
    expect(byId['ae-pii-3']).toMatchObject({ outcome: 'EXPIRED', fields: null })
    expect(byId['ae-pii-denied']).toMatchObject({ outcome: 'DENIED', outcomeLabel: '被拒绝' })
    expect(data.summary).toMatchObject({ last24h: 2, last7d: 3 })
    expect(data.summary.topViewers[0]).toMatchObject({ actorId: bob.userId, count: 3 })
    expect(data.alertRule).toBeNull()
    expect(JSON.stringify(data)).not.toContain('order-b')

    const byOrder = await ok(reader, '/audit/pii-views?q=111-0000002')
    expect(byOrder.items.map((row: { id: string }) => row.id)).toEqual(['ae-pii-2'])
    const byActor = await ok(reader, `/audit/pii-views?actorId=${bob.userId}&pageSize=100`)
    expect(byActor.items).toHaveLength(3)
    expect((await get(reader, '/audit/pii-views?pageSize=2')).json.data.pageInfo.hasMore).toBe(true)
  })

  it('大量查看预警规则补进企业后，视图显示当前阈值', async () => {
    await insertRow(h.client, 'AlertRule', {
      id: 'rule-pii',
      tenantId: a.tenantId,
      code: 'SYS_PII_BULK_VIEW',
      name: '大量查看买家信息明文',
      enabled: true,
      conditionJson: json({ type: 'audit.pii-bulk-view', params: { windowMinutes: 30, maxViews: 8 } }),
    })
    const data = await ok(reader, '/audit/pii-views')
    expect(data.alertRule).toEqual({ enabled: true, windowMinutes: 30, maxViews: 8 })
  })

  it('写入时记录来源与所属页面：带页面头是页面操作（页面路径规范化），不带或头不合法是接口调用；头里的参数与片段会被去掉', async () => {
    const send = (headers: Record<string, string>, filterSummary: string) =>
      h.call(reader.token, 'POST', '/exports', { body: { kind: 'audit-events', filters: { action: 'ROLE_UPDATED' }, filterSummary }, headers })
    // 导出创建是 202（已受理，后台生成）
    expect((await send({ 'x-nova-page': '/app/audit?view=pii#top' }, 'p1')).status).toBe(202)
    expect((await send({}, 'p2')).status).toBe(202)
    expect((await send({ 'x-nova-page': 'javascript:alert(1)' }, 'p3')).status).toBe(202)
    const rows = (
      await h.client.query(`SELECT "source", "page" FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'EXPORT_REQUESTED' AND "actorId" = $2 AND "result" = 'SUCCEEDED' ORDER BY "occurredAt"`, [
        a.tenantId,
        reader.userId,
      ])
    ).rows
    expect(rows).toEqual([
      { source: 'PAGE', page: '/app/audit' },
      { source: 'API', page: null },
      { source: 'API', page: null },
    ])
  })

  it('审计导出：不要求店铺授权（没有任何店铺范围也行），要审计读取与导出两项权限；筛选与页面一致地保存；不支持的筛选与错误时间 422', async () => {
    const filters = { action: 'ROLE_UPDATED', result: 'SUCCEEDED', fromAt: ago(700), toAt: ago(0) }
    const res = await h.call(exporter.token, 'POST', '/exports', { body: { kind: 'audit-events', filters, filterSummary: '动作=角色变更' } })
    expect(res.status, json(res.json)).toBe(202)
    const job = (await h.client.query(`SELECT * FROM "ExportJob" WHERE id = $1`, [res.json.data.id])).rows[0]
    expect(job).toMatchObject({ kind: 'audit-events', sourcePage: '/app/audit', requestedBy: exporter.userId, status: 'QUEUED' })
    expect(job.filterJson).toMatchObject({ action: 'ROLE_UPDATED', result: 'SUCCEEDED' })
    expect(job.fieldPolicySnapshot.scope).toMatchObject({ unrestricted: true })
    expect(job.fieldPolicySnapshot.columns).toContain('actorName')

    const send = (member: Member, body: Record<string, unknown>) => h.call(member.token, 'POST', '/exports', { body: { kind: 'audit-events', ...body } })
    expect((await send(denied, { filters: {} })).status).toBe(403)
    expect((await send(noExport, { filters: {} })).status).toBe(403)
    expect((await send(exporter, { filters: { storeIds: 's1' } })).status).toBe(422)
    expect((await send(exporter, { filters: { fromAt: 'yesterday' } })).status).toBe(422)
  })
})
