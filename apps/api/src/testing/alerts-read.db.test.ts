import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALERT_BATCH_MAX } from '@nova/api-contracts'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 预警两套状态与规则模板（P6-15，真实数据库 + 完整应用）：AlertRead 迁移升级/回滚/再升级与约束；
// 已读按人独立（A 读了 B 仍未读）、范围外按不存在处理、重复标记幂等、未读数与列表/铃铛一致、批量标为已处理（逐条、跳过原因、上限、审计）、规则模板统计、预警删除级联。

type Member = { userId: string; token: string }
const TARGET = '20261217010000_alert_read'
const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

describe('AlertRead 迁移（P6-15）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alert_read_migrate')
    client = await db.connect('alert_read_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async () => (await client.query(`SELECT to_regclass('"AlertRead"') AS t`)).rows[0].t !== null

  it('升级建表、回滚删表、再升级闭环；同一人同一预警只有一条；用户编号不能为空；删预警级联删已读', async () => {
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(await exists()).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists()).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'alert-read-mig')
    await insertRow(client, 'AlertRule', { id: 'rule-r', tenantId: ids.tenantId, code: 'R', domain: 'ADS', name: 'R', conditionJson: '{}', scopeJson: '{}' })
    await insertRow(client, 'AlertInstance', { id: 'ai-r', tenantId: ids.tenantId, ruleId: 'rule-r', dedupKey: 'k', entityType: 'STORE', entityId: 's', evidenceJson: '{}', severity: 'WARNING' })
    const read = (over: Record<string, unknown>) => insertRow(client, 'AlertRead', { tenantId: ids.tenantId, alertId: 'ai-r', userId: 'u1', ...over })
    await read({ id: 'ar-1' })
    await expect(read({ id: 'ar-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(read({ id: 'ar-3', userId: '' })).rejects.toMatchObject({ code: '23514' })
    await read({ id: 'ar-4', userId: 'u2' })
    await client.query(`DELETE FROM "AlertInstance" WHERE "id" = 'ai-r'`)
    expect((await client.query(`SELECT 1 FROM "AlertRead"`)).rowCount).toBe(0)
  })
})

describe('预警已读与批量处理（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let store1: string
  let store2: string
  let owner: Member
  let reader: Member
  let scoped: Member
  let outsider: Member

  const call = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, body === undefined ? {} : { body })
  const ok = async (member: Member, method: string, path: string, body?: unknown) => {
    const res = await call(member, method, path, body)
    expect(res.status, `${method} ${path} → ${JSON.stringify(res.json)}`).toBeLessThan(300)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const alert = (id: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AlertInstance', {
      id,
      tenantId,
      ruleId: 'rule-ads',
      ruleVersionNo: 1,
      dedupKey: `dedup-${id}`,
      sellerAccountId: store1,
      entityType: 'AD_CAMPAIGN',
      entityId: `camp-${id}`,
      entityLabel: `活动 ${id}`,
      title: `活动 ${id} 花费高`,
      evidenceJson: '{}',
      severity: 'WARNING',
      status: 'NEW',
      triggerCount: 1,
      firstTriggeredAt: ago(30),
      lastTriggeredAt: ago(2),
      ...over,
    })
  const ids = (list: { items: Array<{ id: string }> }) => list.items.map(item => item.id).sort()
  const unread = (list: { unreadCount: number }) => list.unreadCount

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'alertread', db })
    const a = await h.createTenant('alr-a')
    tenantId = a.tenantId
    store1 = a.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-alr-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-ALR-2' })).id
    const b = await h.createTenant('alr-b')
    owner = await h.createMember(tenantId, 'alr-owner', ['*'])
    reader = await h.createMember(tenantId, 'alr-reader', ['alerts.read'])
    scoped = await h.createMember(tenantId, 'alr-scoped', ['alerts.read', 'alerts.handle'], { scopes: [{ sellerAccountId: store2 }] })
    outsider = await h.createMember(b.tenantId, 'alr-out', ['*'])
    const rule = (id: string, code: string, type: string, enabled: boolean) =>
      insertRow(h.client, 'AlertRule', {
        id,
        tenantId,
        code,
        domain: 'ADS',
        name: code,
        conditionJson: JSON.stringify({ type, params: {} }),
        severity: 'WARNING',
        cooldownMinutes: 1440,
        scopeJson: '{}',
        enabled,
        currentVersion: 1,
        version: 1,
      })
    await rule('rule-ads', 'ADS_HIGH_SPEND_LOW_RETURN', 'ads.high-spend-low-return', true)
    await rule('rule-cpc-1', 'ADS_CPC_SURGE', 'ads.cpc-surge', true)
    await rule('rule-cpc-2', 'CUSTOM_001', 'ads.cpc-surge', false)
    await alert('r-1')
    await alert('r-2')
    await alert('r-3')
    await alert('r-4', { triggerCount: 5 })
    await alert('r-store2', { sellerAccountId: store2 })
    await alert('r-done', { status: 'HANDLED', closeConclusion: 'HANDLED', resolvedAt: ago(20) })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('初始：所有人对所有待处理预警都是未读；列表带 read=false 与合并次数；铃铛未读数与列表一致', async () => {
    const list = await ok(reader, 'GET', '/alerts')
    expect(ids(list)).toEqual(['r-1', 'r-2', 'r-3', 'r-4', 'r-store2'])
    expect(list.items.every((item: { read: boolean }) => item.read === false)).toBe(true)
    expect(list.items.find((item: { id: string }) => item.id === 'r-4')).toMatchObject({ triggerCount: 5 })
    expect(unread(list)).toBe(5)
    expect((await ok(reader, 'GET', '/notifications/unread-count')).alerts).toBe(5)
    expect(unread(await ok(scoped, 'GET', '/alerts'))).toBe(1)
    expect((await ok(scoped, 'GET', '/notifications/unread-count')).alerts).toBe(1)
  })

  it('已读按人独立：A 读了不影响 B；readState 只看自己的；幂等；打开已读的不再增加记录', async () => {
    const first = await ok(owner, 'POST', '/alerts/read', { ids: ['r-1', 'r-2'] })
    expect(first).toEqual({ marked: 2, missing: [], unreadCount: 3 })
    expect(await ok(owner, 'POST', '/alerts/read', { ids: ['r-1', 'r-2'] })).toMatchObject({ marked: 0, unreadCount: 3 })
    expect((await rows(`SELECT 1 FROM "AlertRead" WHERE "tenantId" = $1`, [tenantId])).length).toBe(2)

    expect(ids(await ok(owner, 'GET', '/alerts?readState=unread'))).toEqual(['r-3', 'r-4', 'r-store2'])
    expect(ids(await ok(owner, 'GET', '/alerts?readState=read'))).toEqual(['r-1', 'r-2'])
    const readerList = await ok(reader, 'GET', '/alerts')
    expect(unread(readerList)).toBe(5)
    expect(ids(await ok(reader, 'GET', '/alerts?readState=unread'))).toHaveLength(5)
    expect(ids(await ok(reader, 'GET', '/alerts?readState=read'))).toEqual([])
    expect((await ok(owner, 'GET', '/notifications/unread-count')).alerts).toBe(3)
    expect((await ok(reader, 'GET', '/notifications/unread-count')).alerts).toBe(5)
    const mine = await ok(owner, 'GET', '/alerts')
    expect(mine.items.find((item: { id: string }) => item.id === 'r-1').read).toBe(true)
    expect(mine.items.find((item: { id: string }) => item.id === 'r-3').read).toBe(false)
  })

  it('范围外与跨企业的预警按不存在处理，不写已读记录；没有权限 403；已结束的预警不计未读数', async () => {
    const before = (await rows(`SELECT 1 FROM "AlertRead"`)).length
    expect(await ok(scoped, 'POST', '/alerts/read', { ids: ['r-3'] })).toMatchObject({ marked: 0, missing: ['r-3'] })
    expect(await ok(outsider, 'POST', '/alerts/read', { ids: ['r-3'] })).toMatchObject({ marked: 0, missing: ['r-3'] })
    expect((await rows(`SELECT 1 FROM "AlertRead"`)).length).toBe(before)
    const nobody = await h.createMember(tenantId, 'alr-nobody', [])
    expect((await call(nobody, 'POST', '/alerts/read', { ids: ['r-3'] })).status).toBe(403)
    expect(await ok(owner, 'POST', '/alerts/read', { ids: ['r-done'] })).toMatchObject({ marked: 1, unreadCount: 3 })
  })

  it('批量上限：超过 ALERT_BATCH_MAX 或空列表 422，且不写库', async () => {
    const before = (await rows(`SELECT 1 FROM "AlertRead"`)).length
    const tooMany = Array.from({ length: ALERT_BATCH_MAX + 1 }, (_, i) => `x-${i}`)
    expect((await call(owner, 'POST', '/alerts/read', { ids: tooMany })).status).toBe(422)
    expect((await call(owner, 'POST', '/alerts/handled', { ids: tooMany })).status).toBe(422)
    expect((await call(owner, 'POST', '/alerts/read', { ids: [] })).status).toBe(422)
    expect((await rows(`SELECT 1 FROM "AlertRead"`)).length).toBe(before)
    const exact = Array.from({ length: ALERT_BATCH_MAX }, (_, i) => `x-${i}`)
    expect((await ok(owner, 'POST', '/alerts/read', { ids: exact })).missing).toHaveLength(ALERT_BATCH_MAX)
  })

  it('批量标为已处理：逐条关闭；不存在、范围外、已被处理的记入 skipped；写审计；处理后不再计入未读；只有 alerts.read 403', async () => {
    expect((await call(reader, 'POST', '/alerts/handled', { ids: ['r-3'] })).status).toBe(403)
    const res = await ok(owner, 'POST', '/alerts/handled', { ids: ['r-3', 'r-4', 'r-done', 'ghost'], note: '批量核实' })
    expect(res.handled).toBe(2)
    expect(res.skipped.map((item: { id: string }) => item.id).sort()).toEqual(['ghost', 'r-done'])
    const state = await rows<{ id: string; status: string; closeConclusion: string; closeNote: string }>(
      `SELECT "id", "status", "closeConclusion", "closeNote" FROM "AlertInstance" WHERE "id" IN ('r-3','r-4') ORDER BY "id"`,
    )
    expect(state).toEqual([
      { id: 'r-3', status: 'HANDLED', closeConclusion: 'HANDLED', closeNote: '批量核实' },
      { id: 'r-4', status: 'HANDLED', closeConclusion: 'HANDLED', closeNote: '批量核实' },
    ])
    expect(res.unreadCount).toBe(1)
    // 审计逐条记录（沿用单条关闭的 ALERT_CLOSED，带每条预警的编号与处理前后状态）；被跳过的不产生审计
    const audits = await rows<{ resourceId: string }>(`SELECT "resourceId" FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'ALERT_CLOSED' AND "result" = 'SUCCEEDED' ORDER BY "resourceId"`, [
      tenantId,
    ])
    expect(audits.map(row => row.resourceId)).toEqual(['r-3', 'r-4'])
    // 范围收窄的成员只能处理自己店铺的：r-1 在 store1，当作不存在跳过
    const scopedRes = await ok(scoped, 'POST', '/alerts/handled', { ids: ['r-1', 'r-store2'] })
    expect(scopedRes.handled).toBe(1)
    expect(scopedRes.skipped.map((item: { id: string }) => item.id)).toEqual(['r-1'])
    expect(ids(await ok(owner, 'GET', '/alerts?handleState=handled'))).toEqual(['r-3', 'r-4', 'r-done', 'r-store2'])
  })

  it('规则模板：五组模板，按评估逻辑统计企业里已有的规则数（含自定义、含停用）；创建权限看 alerts.manage；跨企业各算各的', async () => {
    const data = await ok(reader, 'GET', '/alerts/templates')
    expect(data.can.create).toBe(false)
    expect(new Set(data.items.map((item: { group: string }) => item.group))).toEqual(new Set(['INVENTORY', 'ADS', 'SALES', 'TRAFFIC', 'STORE']))
    expect(data.items.find((item: { type: string }) => item.type === 'ads.cpc-surge')).toMatchObject({ ruleCount: 2, enabledCount: 1 })
    expect(data.items.find((item: { type: string }) => item.type === 'ads.high-spend-low-return')).toMatchObject({ ruleCount: 1, enabledCount: 1 })
    expect((await ok(owner, 'GET', '/alerts/templates')).can.create).toBe(true)
    const other = await ok(outsider, 'GET', '/alerts/templates')
    expect(other.items.every((item: { ruleCount: number }) => item.ruleCount === 0)).toBe(true)
  })

  it('删除预警会级联删除已读记录；其他企业的已读记录不受影响', async () => {
    await alert('r-del')
    await ok(owner, 'POST', '/alerts/read', { ids: ['r-del'] })
    expect((await rows(`SELECT 1 FROM "AlertRead" WHERE "alertId" = 'r-del'`)).length).toBe(1)
    await h.client.query(`DELETE FROM "AlertInstance" WHERE "id" = 'r-del'`)
    expect((await rows(`SELECT 1 FROM "AlertRead" WHERE "alertId" = 'r-del'`)).length).toBe(0)
    expect((await rows(`SELECT 1 FROM "AlertRead" WHERE "alertId" = 'r-1'`)).length).toBe(1)
  })
})
