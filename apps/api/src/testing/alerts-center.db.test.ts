import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 风险预警中心（P5-01，真实数据库 + 完整应用）：迁移升级与回滚；列表与详情的数据范围和跨企业隔离；确认、忽略、分派、关闭对预警、待办、时间线、通知、审计的联动；
// 并发与重复处理的冲突；规则改动的版本记录、乐观锁、范围校验；自定义规则；质量统计（误报率）。

type Member = { userId: string; token: string }
const TARGET = '20261129010000_alert_center'
const HOUR = 3_600_000
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString()

describe('预警中心迁移（P5-01）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alert_center_migrate')
    client = await db.connect('alert_center_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'AlertInstance'`)).rows.map(row => row.column_name as string)

  it('升级补九列与约束、回滚全部去掉、再次升级闭环；关闭结论取值由数据库约束', async () => {
    expect(await columns()).not.toContain('closeConclusion')
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toEqual(expect.arrayContaining(['closeConclusion', 'closeNote', 'closedBy', 'title', 'entityLabel', 'suggestedAction', 'impactMin', 'impactMax', 'currency']))
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await columns()).not.toContain('closeConclusion')
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'alert-mig')
    await insertRow(client, 'AlertRule', { id: 'rule-mig', tenantId: ids.tenantId, code: 'R', domain: 'ADS', name: 'R', conditionJson: '{}', scopeJson: '{}' })
    const instance = (over: Record<string, unknown>) =>
      insertRow(client, 'AlertInstance', {
        tenantId: ids.tenantId,
        ruleId: 'rule-mig',
        dedupKey: `k-${Math.random()}`,
        entityType: 'STORE',
        entityId: 's',
        evidenceJson: '{}',
        severity: 'WARNING',
        ...over,
      })
    expect(await instance({ id: 'ai-1', closeConclusion: 'FALSE_POSITIVE' })).toMatchObject({ closeConclusion: 'FALSE_POSITIVE', title: null, impactMin: null })
    await expect(instance({ id: 'ai-2', closeConclusion: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('预警中心（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let store1: string
  let store2: string
  let owner: Member
  let reader: Member
  let scoped: Member
  let outsider: Member
  let nobody: Member

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
      evidenceJson: JSON.stringify({ spend: 45.5, clicks: 80 }),
      severity: 'WARNING',
      status: 'NEW',
      firstTriggeredAt: ago(30),
      lastTriggeredAt: ago(2),
      ...over,
    })
  const work = (id: string, over: Record<string, unknown> = {}) =>
    insertRow(h.client, 'WorkItem', {
      id,
      tenantId,
      title: `待办 ${id}`,
      kind: 'ADS',
      source: 'ALERT',
      ownerId: owner.userId,
      createdBy: owner.userId,
      status: 'PENDING',
      severity: 'WARNING',
      ...over,
    })
  const state = async (id: string) =>
    (
      await rows<{ status: string; closeConclusion: string | null; closeNote: string | null; workItemId: string | null }>(
        `SELECT "status", "closeConclusion", "closeNote", "workItemId" FROM "AlertInstance" WHERE "id" = $1`,
        [id],
      )
    )[0]

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'alertcenter', db })
    const a = await h.createTenant('alc-a')
    tenantId = a.tenantId
    store1 = a.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-alc-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-ALC-2' })).id
    const b = await h.createTenant('alc-b')
    owner = await h.createMember(tenantId, 'alc-owner', ['*'])
    reader = await h.createMember(tenantId, 'alc-reader', ['alerts.read'])
    scoped = await h.createMember(tenantId, 'alc-scoped', ['alerts.read', 'alerts.handle'], { scopes: [{ sellerAccountId: store2 }] })
    nobody = await h.createMember(tenantId, 'alc-nobody', [])
    outsider = await h.createMember(b.tenantId, 'alc-out', ['*'])
    await insertRow(h.client, 'AlertRule', {
      id: 'rule-ads',
      tenantId,
      code: 'ADS_HIGH_SPEND_LOW_RETURN',
      domain: 'ADS',
      name: '高花费低产出',
      conditionJson: JSON.stringify({ type: 'ads.high-spend-low-return', params: { windowDays: 7, minSpend: 20, minClicks: 30, acosThreshold: 1 } }),
      severity: 'WARNING',
      cooldownMinutes: 1440,
      scopeJson: '{}',
      currentVersion: 1,
      version: 1,
    })
    await insertRow(h.client, 'AlertRuleVersion', {
      id: 'rv-1',
      tenantId,
      ruleId: 'rule-ads',
      versionNo: 1,
      conditionJson: '{"type":"ads.high-spend-low-return","params":{"windowDays":7}}',
      changedBy: 'system',
      changeReason: '系统预置规则',
    })
    await work('w-a1')
    await alert('a-ack', { workItemId: 'w-a1' })
    await alert('a-ignore')
    await alert('a-close-fp')
    await alert('a-close-ok')
    await alert('a-assign')
    await alert('a-store2', { sellerAccountId: store2 })
    await alert('a-old', { status: 'HANDLED', closeConclusion: 'HANDLED', resolvedAt: ago(20), dedupKey: 'old' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('列表：没有权限 403；有权限看到范围内的待处理预警；数据范围收窄后只看到自己店铺的；其他企业看不到', async () => {
    expect((await call(nobody, 'GET', '/alerts')).status).toBe(403)
    const list = await ok(reader, 'GET', '/alerts')
    expect(list.items.map((item: { id: string }) => item.id).sort()).toEqual(['a-ack', 'a-assign', 'a-close-fp', 'a-close-ok', 'a-ignore', 'a-store2'])
    expect(list.counts).toMatchObject({ open: 6, handled: 1, all: 7 })
    expect(list.items.find((item: { id: string }) => item.id === 'a-ack')).toMatchObject({ title: '活动 a-ack 花费高', domainLabel: '广告', owner: { id: owner.userId }, impact: null })
    const mine = await ok(scoped, 'GET', '/alerts')
    expect(mine.items.map((item: { id: string }) => item.id)).toEqual(['a-store2'])
    expect(mine.counts.all).toBe(1)
    const none = await ok(outsider, 'GET', '/alerts')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('详情：范围外与跨企业都是 404；范围内返回规则版本阈值与证据；已处理的预警带关闭信息', async () => {
    expect((await call(scoped, 'GET', '/alerts/a-ack')).status).toBe(404)
    expect((await call(outsider, 'GET', '/alerts/a-ack')).status).toBe(404)
    const detail = await ok(reader, 'GET', '/alerts/a-ack')
    expect(detail.rule).toMatchObject({ name: '高花费低产出', versionNo: 1 })
    expect(detail.rule.thresholds).toContainEqual({ label: '回看天数', value: '7 天' })
    expect(detail.evidence).toContainEqual({ label: '花费', value: 'USD 45.50' })
    expect(detail.history.length).toBeGreaterThan(0)
    expect(detail.can.handle).toBe(false)
    const old = await ok(reader, 'GET', '/alerts/a-old')
    expect(old.closeInfo).toMatchObject({ conclusionLabel: '已处理' })
  })

  it('确认：预警与待办同步变为处理中，预警与待办各记一条时间线，写入审计；重复确认 409', async () => {
    expect((await call(reader, 'POST', '/alerts/a-ack/ack', {})).status).toBe(403)
    const res = await ok(owner, 'POST', '/alerts/a-ack/ack', { note: '开始看' })
    expect(res).toMatchObject({ status: 'ACKED', statusLabel: '处理中' })
    expect((await state('a-ack')).status).toBe('ACKED')
    expect((await rows<{ status: string }>(`SELECT "status" FROM "WorkItem" WHERE "id" = 'w-a1'`))[0].status).toBe('IN_PROGRESS')
    const events = await rows<{ entityType: string }>(`SELECT "entityType" FROM "EntityEvent" WHERE "sourceRef" LIKE 'alert-ack:%' AND "tenantId" = $1`, [tenantId])
    expect(events.map(event => event.entityType).sort()).toEqual(['ALERT', 'WORK_ITEM'])
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'ALERT_ACKED' AND "resourceId" = 'a-ack' AND "result" = 'SUCCEEDED'`, [tenantId])).length).toBe(1)
    expect((await call(owner, 'POST', '/alerts/a-ack/ack', {})).status).toBe(409)
    const detail = await ok(owner, 'GET', '/alerts/a-ack')
    expect(detail.timeline.map((item: { title: string }) => item.title).join('|')).toContain('确认，开始处理')
  })

  it('范围外的预警不能处理（404）；忽略必须写原因，忽略后状态与结论落库，再处理 409', async () => {
    expect((await call(scoped, 'POST', '/alerts/a-ignore/ignore', { reason: '不该成功' })).status).toBe(404)
    expect((await call(owner, 'POST', '/alerts/a-ignore/ignore', { reason: '' })).status).toBe(422)
    const res = await ok(owner, 'POST', '/alerts/a-ignore/ignore', { reason: '促销期间的预期花费' })
    expect(res.status).toBe('IGNORED')
    expect(await state('a-ignore')).toMatchObject({ status: 'IGNORED', closeConclusion: 'IGNORED', closeNote: '促销期间的预期花费' })
    expect((await call(owner, 'POST', '/alerts/a-ignore/close', { conclusion: 'HANDLED' })).status).toBe(409)
    expect((await call(owner, 'POST', '/alerts/a-ignore/ignore', { reason: '再忽略一次' })).status).toBe(409)
  })

  it('关闭：必须选结论；误报与已处理的结论分别落库；规则的质量统计据此算误报率与平均处理时长', async () => {
    expect((await call(owner, 'POST', '/alerts/a-close-fp/close', {})).status).toBe(422)
    expect((await ok(owner, 'POST', '/alerts/a-close-fp/close', { conclusion: 'FALSE_POSITIVE', note: '数据延迟导致' })).status).toBe('IGNORED')
    expect((await ok(owner, 'POST', '/alerts/a-close-ok/close', { conclusion: 'HANDLED' })).status).toBe('HANDLED')
    expect(await state('a-close-fp')).toMatchObject({ closeConclusion: 'FALSE_POSITIVE', closeNote: '数据延迟导致' })
    expect(await state('a-close-ok')).toMatchObject({ closeConclusion: 'HANDLED' })
    const rules = await ok(reader, 'GET', '/alerts/rules')
    const stats = rules.items.find((item: { id: string }) => item.id === 'rule-ads').stats
    // 已被处理的有：a-ignore（忽略）、a-close-fp（误报）、a-close-ok（已处理）、a-old（历史已处理，无结论）
    expect(stats).toMatchObject({ handled: 4, falsePositive: 1, falsePositiveRate: 0.25 })
    expect(stats.avgHandleHours).toBeGreaterThan(0)
    expect(stats.hits).toBe(7)
    const scopedRules = await ok(scoped, 'GET', '/alerts/rules')
    expect(scopedRules.items[0].stats.hits).toBe(1)
  })

  it('分派：没有待办的预警建一条待办并回写，被分派人收到站内通知；非在职成员 422；其他企业的成员不能被分派', async () => {
    const res = await ok(owner, 'POST', '/alerts/a-assign/assign', { assigneeId: reader.userId, note: '请跟进' })
    expect(res.id).toBe('a-assign')
    const created = await state('a-assign')
    expect(created.workItemId).toBeTruthy()
    const item = (
      await rows<{ ownerId: string; source: string; sourceAlertId: string; dueAt: Date | null }>(`SELECT "ownerId", "source", "sourceAlertId", "dueAt" FROM "WorkItem" WHERE "id" = $1`, [
        created.workItemId,
      ])
    )[0]
    expect(item).toMatchObject({ ownerId: reader.userId, source: 'ALERT', sourceAlertId: 'a-assign' })
    expect(item.dueAt).not.toBeNull()
    expect((await rows(`SELECT 1 FROM "Notification" WHERE "tenantId" = $1 AND "userId" = $2`, [tenantId, reader.userId])).length).toBeGreaterThan(0)
    expect((await call(owner, 'POST', '/alerts/a-assign/assign', { assigneeId: outsider.userId })).status).toBe(422)
    const list = await ok(reader, 'GET', '/alerts?q=a-assign')
    expect(list.items[0].owner).toMatchObject({ id: reader.userId })
  })

  it('规则：改阈值生成新版本（快照存全部设置）、审计带原因；旧版本号冲突 409；没改动 422；范围里的店铺必须属于本企业', async () => {
    const before = (await ok(reader, 'GET', '/alerts/rules')).items.find((item: { id: string }) => item.id === 'rule-ads')
    expect((await call(reader, 'PATCH', '/alerts/rules/rule-ads', { version: before.version, changeReason: '越权', enabled: false })).status).toBe(403)
    const res = await ok(owner, 'PATCH', '/alerts/rules/rule-ads', {
      version: before.version,
      changeReason: '大促期间放宽',
      params: { minSpend: 80 },
      severity: 'CRITICAL',
      scope: { sellerAccountIds: [store1], quiet: { start: '22:00', end: '07:00' } },
    })
    expect(res).toMatchObject({ currentVersion: 2, version: before.version + 1 })
    const after = (await ok(reader, 'GET', '/alerts/rules')).items.find((item: { id: string }) => item.id === 'rule-ads')
    expect(after).toMatchObject({ severity: 'CRITICAL', currentVersion: 2, params: { minSpend: 80, windowDays: 7 }, scope: { sellerAccountIds: [store1], quiet: { start: '22:00', end: '07:00' } } })
    expect(after.versions.map((item: { versionNo: number }) => item.versionNo)).toEqual([2, 1])
    expect(after.versions[0]).toMatchObject({ changeReason: '大促期间放宽', severity: 'CRITICAL', params: { minSpend: 80 } })
    expect(after.versions[1]).toMatchObject({ changedByName: '系统', severity: null })
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'ALERT_RULE_UPDATED' AND "resourceId" = 'rule-ads' AND "result" = 'SUCCEEDED'`, [tenantId])).length).toBe(1)
    expect((await call(owner, 'PATCH', '/alerts/rules/rule-ads', { version: before.version, changeReason: '过期', enabled: false })).status).toBe(409)
    expect((await call(owner, 'PATCH', '/alerts/rules/rule-ads', { version: after.version, changeReason: '没改', enabled: true })).status).toBe(422)
    const foreign = await call(owner, 'PATCH', '/alerts/rules/rule-ads', { version: after.version, changeReason: '串店铺', scope: { sellerAccountIds: ['not-mine'] } })
    expect(foreign.status).toBe(422)
    expect((await call(outsider, 'PATCH', '/alerts/rules/rule-ads', { version: after.version, changeReason: '串企业', enabled: false })).status).toBe(404)
  })

  it('自定义规则：沿用评估器与默认阈值，编号递增，企业内互不可见；类型不支持 422', async () => {
    const created = await ok(owner, 'POST', '/alerts/rules', { type: 'ads.cpc-surge', name: '核心词点击成本突增', params: { ratio: 2 } })
    expect(created.code).toBe('CUSTOM_001')
    const second = await ok(owner, 'POST', '/alerts/rules', { type: 'ads.cpc-surge', name: '第二条' })
    expect(second.code).toBe('CUSTOM_002')
    const rules = await ok(reader, 'GET', '/alerts/rules')
    const custom = rules.items.find((item: { code: string }) => item.code === 'CUSTOM_001')
    expect(custom).toMatchObject({ custom: true, domain: 'ADS', params: { ratio: 2 }, currentVersion: 1 })
    expect(custom.params.recentDays).toBeDefined()
    expect(custom.versions[0].changeReason).toBe('新建自定义规则')
    expect((await ok(outsider, 'GET', '/alerts/rules')).items).toEqual([])
    expect((await call(owner, 'POST', '/alerts/rules', { type: 'made.up', name: '随便' })).status).toBe(422)
    expect((await call(owner, 'POST', '/alerts/rules', { type: 'ads.cpc-surge', name: '越界', params: { ratio: 99 } })).status).toBe(422)
  })
})
