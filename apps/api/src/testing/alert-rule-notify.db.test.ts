import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 预警规则的条件、通知频率与多级升级（P6-16，真实数据库 + 完整应用 + worker 的评估框架）：
// 迁移升级与回滚、约束；自定义指标规则的创建、修改、版本快照与校验；试算；
// 按店铺判断的自定义指标评估；每小时/每日汇总、静默结束补发汇总、严重级别不进汇总；多级升级按时限推进、幂等、不对已确认的预警升级。

const TARGET = '20261218010000_alert_rule_notify'
const MINUTE = 60_000

describe('预警规则通知迁移（P6-16）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alert_notify_migrate')
    client = await db.connect('alert_notify_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'AlertRule'`)).rows.map(row => row.column_name as string)
  const tables = async () => (await client.query(`SELECT table_name FROM information_schema.tables WHERE table_name = 'AlertDigest'`)).rows.length

  it('升级补三列与汇总表，回滚全部去掉，再次升级闭环；取值由数据库约束', async () => {
    expect(await columns()).not.toContain('notifyFrequency')
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toEqual(expect.arrayContaining(['conditionGroups', 'notifyFrequency', 'escalation']))
    expect(await tables()).toBe(1)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await columns()).not.toContain('notifyFrequency')
    expect(await tables()).toBe(0)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'notify-mig')
    const rule = (over: Record<string, unknown>) =>
      insertRow(client, 'AlertRule', { id: `r-${Math.random()}`, tenantId: ids.tenantId, code: `C-${Math.random()}`, domain: 'ADS', name: 'R', conditionJson: '{}', scopeJson: '{}', ...over })
    expect((await rule({})).notifyFrequency).toBe('IMMEDIATE')
    await expect(rule({ notifyFrequency: 'WEEKLY' })).rejects.toThrow()
    await expect(rule({ escalation: JSON.stringify([{ afterMinutes: 5 }, { afterMinutes: 10 }, { afterMinutes: 20 }, { afterMinutes: 30 }]) })).rejects.toThrow()
    await expect(rule({ escalation: JSON.stringify({ afterMinutes: 5 }) })).rejects.toThrow()

    const base = await rule({ id: 'r-digest' })
    const digest = (over: Record<string, unknown>) =>
      insertRow(client, 'AlertDigest', { id: `dg-${Math.random()}`, tenantId: ids.tenantId, ruleId: base.id, kind: 'FREQUENCY', dedupKey: `d-${Math.random()}`, alertIds: '[]', itemCount: 1, ...over })
    expect(await digest({})).toMatchObject({ status: 'PENDING', itemCount: 1 })
    await expect(digest({ kind: 'OTHER' })).rejects.toThrow()
    await expect(digest({ status: 'WRONG' })).rejects.toThrow()
    await expect(digest({ status: 'SENT' })).rejects.toThrow()
    await expect(digest({ status: 'PENDING', sentAt: new Date().toISOString() })).rejects.toThrow()
    await expect(digest({ itemCount: -1 })).rejects.toThrow()
    await digest({ dedupKey: 'same' })
    await expect(digest({ dedupKey: 'same' })).rejects.toThrow()
  })
})

type Member = { userId: string; token: string }
type Hit = { entityType: string; entityId: string; sellerAccountId?: string; evidence: Record<string, unknown>; title: string }
type Result = { created: number; refreshed: number; skippedCooldown: number; errors: number }

describe('预警规则条件、汇总与升级（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let reader: Member
  let evaluateTenantRules: (deps: { db: unknown; registry: unknown; now: () => Date }, tenantId: string) => Promise<Result>
  let Registry: new () => { register(evaluator: unknown): { register(evaluator: unknown): unknown } }
  let customMetricEvaluator: unknown
  let flushDigests: (db: unknown, tenantId: string, now: Date, zone: string | null) => Promise<{ sent: number; items: number }>
  let runEscalations: (db: unknown, tenantId: string, now: Date) => Promise<{ escalated: number }>
  const hitsByRule = new Map<string, Hit[]>()
  const T0 = new Date('2026-10-27T12:10:00Z')
  const at = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE)

  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const inTenant = <T>(fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const run = (now: Date, extra?: unknown) => {
    const registry = new Registry().register({ type: 'test.hits', evaluate: async (context: { rule: { id: string } }) => hitsByRule.get(context.rule.id) ?? [] })
    if (extra) registry.register(extra)
    return inTenant(() => evaluateTenantRules({ db: tenantDb, registry, now: () => now }, tenantId))
  }
  const flush = (now: Date) => inTenant(() => flushDigests(tenantDb, tenantId, now, 'UTC'))
  const escalate = (now: Date) => inTenant(() => runEscalations(tenantDb, tenantId, now))
  const digests = (ruleId: string) =>
    rows<{ kind: string; status: string; itemCount: number; dedupKey: string }>(
      `SELECT "kind", "status", "itemCount", "dedupKey" FROM "AlertDigest" WHERE "tenantId" = $1 AND "ruleId" = $2 ORDER BY "createdAt"`,
      [tenantId, ruleId],
    )
  const alertNotices = async (ruleId: string) => {
    const instances = await rows<{ id: string }>(`SELECT "id" FROM "AlertInstance" WHERE "tenantId" = $1 AND "ruleId" = $2`, [tenantId, ruleId])
    return instances.length
  }
  const hit = (id: string): Hit => ({ entityType: 'AD_CAMPAIGN', entityId: id, sellerAccountId: storeA, evidence: {}, title: `活动 ${id} 异常` })
  const addRule = (id: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'AlertRule', {
      id,
      tenantId,
      code: id,
      domain: 'ADS',
      name: `规则 ${id}`,
      conditionJson: JSON.stringify({ type: 'test.hits', params: {} }),
      severity: 'WARNING',
      cooldownMinutes: 60,
      scopeJson: '{}',
      currentVersion: 1,
      version: 1,
      ...over,
    })
  const ruleNotices = (ruleId: string) =>
    rows<{ title: string; link: string | null; userId: string; severity: string; body: string }>(
      `SELECT n."title", n."link", n."userId", n."severity", n."body" FROM "Notification" n
       WHERE n."tenantId" = $1 AND n."kind" = 'ALERT_RULE'
       AND (n."dedupKey" LIKE $2 OR n."dedupKey" LIKE 'alert-digest:%' OR n."dedupKey" LIKE 'alert-escalation:%')
       AND n."title" LIKE $3 ORDER BY n."createdAt", n."id"`,
      [tenantId, `alert-rule:%`, `%${ruleId}%`],
    )
  const dateOffset = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10)
  const customBody = (over: Record<string, unknown> = {}) => ({
    type: 'CUSTOM_METRIC',
    name: '近三天销售额偏低',
    conditionGroups: { groups: [{ conditions: [{ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'sum', op: '<', threshold: 100 }] }] },
    notifyFrequency: 'HOURLY',
    escalation: [{ afterMinutes: 60 }, { afterMinutes: 240 }],
    ...over,
  })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'alert_notify' })
    const a = await h.createTenant('ann-a')
    tenantId = a.tenantId
    storeA = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" = $1`, [tenantId])
    storeB = (await insertRow(h.client, 'SellerAccount', { id: 'seller-ann-b', sellerId: 'SELLER-ANN-B', tenantId, legalEntityId: a.legalEntityId })).id
    owner = await h.createMember(tenantId, 'ann-owner', ['*'])
    reader = await h.createMember(tenantId, 'ann-reader', ['alerts.read'])
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('alert_notify', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const worker = (path: string) => import(/* @vite-ignore */ String(`../../../worker/src/${path}`))
    const evaluate = await worker('platform/alert-evaluate')
    evaluateTenantRules = evaluate.evaluateTenantRules
    Registry = evaluate.AlertEvaluatorRegistry
    customMetricEvaluator = (await worker('alerts/custom-metric-evaluator')).customMetricEvaluator
    const digest = await worker('platform/alert-digest')
    flushDigests = digest.flushDigests
    runEscalations = digest.runEscalations
    // 近 14 天的店铺日汇总：A 店每天销售额 10，B 店每天 50
    for (let day = 1; day <= 14; day += 1) {
      await insertRow(h.client, 'StoreDailySummary', { id: `sa-${day}`, tenantId, sellerAccountId: storeA, summaryDate: dateOffset(-day), salesAmount: 10, orders: 1, units: 1, metricVersion: 'v1' })
      await insertRow(h.client, 'StoreDailySummary', { id: `sb-${day}`, tenantId, sellerAccountId: storeB, summaryDate: dateOffset(-day), salesAmount: 50, orders: 5, units: 5, metricVersion: 'v1' })
    }
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  describe('自定义指标规则：创建、修改、校验', () => {
    let ruleId: string

    it('创建：条件、通知频率、升级都落库，版本快照留存，列表显示条件文字', async () => {
      const res = await h.call(owner.token, 'POST', '/alerts/rules', { body: customBody() })
      expect(res.status).toBe(201)
      ruleId = res.json.data.id
      const row = (await rows<Record<string, any>>(`SELECT * FROM "AlertRule" WHERE "id" = $1`, [ruleId]))[0]!
      expect(row).toMatchObject({ notifyFrequency: 'HOURLY', currentVersion: 1 })
      expect(row.conditionGroups.groups).toHaveLength(1)
      expect(row.escalation).toEqual([{ afterMinutes: 60 }, { afterMinutes: 240 }])
      const version = (await rows<{ conditionJson: any }>(`SELECT "conditionJson" FROM "AlertRuleVersion" WHERE "ruleId" = $1 AND "versionNo" = 1`, [ruleId]))[0]!
      expect(version.conditionJson).toMatchObject({ type: 'CUSTOM_METRIC', notifyFrequency: 'HOURLY', escalation: [{ afterMinutes: 60 }, { afterMinutes: 240 }] })
      expect(version.conditionJson.conditionGroups.groups[0].conditions[0]).toMatchObject({ metric: 'M-001', threshold: 100 })
      const listed = (await h.call(owner.token, 'GET', '/alerts/rules')).json.data.items.find((item: { id: string }) => item.id === ruleId)
      expect(listed).toMatchObject({ notifyFrequency: 'HOURLY', escalation: [{ afterMinutes: 60 }, { afterMinutes: 240 }] })
      expect(listed.conditionText).toContain('销售额')
    })

    it('校验：没有条件、未接入取数的指标、预置规则带条件、升级时限不递增，都是 422', async () => {
      const post = (body: Record<string, unknown>) => h.call(owner.token, 'POST', '/alerts/rules', { body })
      expect((await post({ type: 'CUSTOM_METRIC', name: '没有条件' })).status).toBe(422)
      expect((await post(customBody({ conditionGroups: { groups: [{ conditions: [{ metric: 'M-503', window: { kind: 'days', days: 3 }, agg: 'sum', op: '<', threshold: 1 }] }] } }))).status).toBe(422)
      expect((await post(customBody({ escalation: [{ afterMinutes: 60 }, { afterMinutes: 30 }] }))).status).toBe(422)
      expect((await post(customBody({ escalation: [{ afterMinutes: 1 }] }))).status).toBe(422)
      expect((await post(customBody({ notifyFrequency: 'WEEKLY' }))).status).toBe(422)
      const preset = await addRule('preset-rule', { code: 'ADS_CPC_SURGE' })
      const patched = await h.call(owner.token, 'PATCH', `/alerts/rules/${preset.id}`, { body: { version: 1, changeReason: '尝试加条件', conditionGroups: customBody().conditionGroups } })
      expect(patched.status).toBe(422)
    })

    it('修改：换阈值与频率生成新版本，快照带全部设置；什么都没变是 422；无权限是 403', async () => {
      const current = (await h.call(owner.token, 'GET', '/alerts/rules')).json.data.items.find((item: { id: string }) => item.id === ruleId)
      const groups = customBody({ conditionGroups: { groups: [{ conditions: [{ metric: 'M-001', window: { kind: 'days', days: 3 }, agg: 'sum', op: '<', threshold: 80 }] }] } }).conditionGroups
      const denied = await h.call(reader.token, 'PATCH', `/alerts/rules/${ruleId}`, { body: { version: current.version, changeReason: '调低阈值', conditionGroups: groups } })
      expect(denied.status).toBe(403)
      const ok = await h.call(owner.token, 'PATCH', `/alerts/rules/${ruleId}`, {
        body: { version: current.version, changeReason: '调低阈值', conditionGroups: groups, notifyFrequency: 'DAILY', escalation: [] },
      })
      expect(ok.status).toBe(200)
      const row = (await rows<Record<string, any>>(`SELECT * FROM "AlertRule" WHERE "id" = $1`, [ruleId]))[0]!
      expect(row).toMatchObject({ notifyFrequency: 'DAILY', currentVersion: 2 })
      expect(row.conditionGroups.groups[0].conditions[0].threshold).toBe(80)
      expect(row.escalation).toBeNull()
      const version = (await rows<{ conditionJson: any }>(`SELECT "conditionJson" FROM "AlertRuleVersion" WHERE "ruleId" = $1 AND "versionNo" = 2`, [ruleId]))[0]!
      expect(version.conditionJson).toMatchObject({ notifyFrequency: 'DAILY', escalation: [] })
      const fresh = (await h.call(owner.token, 'GET', '/alerts/rules')).json.data.items.find((item: { id: string }) => item.id === ruleId)
      const same = await h.call(owner.token, 'PATCH', `/alerts/rules/${ruleId}`, { body: { version: fresh.version, changeReason: '没有变化', notifyFrequency: 'DAILY' } })
      expect(same.status).toBe(422)
      // 改回 100，后面的评估用 100 作阈值
      const back = await h.call(owner.token, 'PATCH', `/alerts/rules/${ruleId}`, { body: { version: fresh.version, changeReason: '改回 100', conditionGroups: customBody().conditionGroups } })
      expect(back.status).toBe(200)
    })

    it('试算：最近 7 天每天各有几个店铺触发；条件里有未接入的指标会列出；无权限是 403', async () => {
      const preview = await h.call(owner.token, 'POST', '/alerts/rules/preview', { body: { conditionGroups: customBody().conditionGroups } })
      expect(preview.status).toBe(200)
      expect(preview.json.data).toMatchObject({ days: 7, evaluatedStores: 2, truncated: false, triggeredStores: 1, noDataStores: 0, unsupportedMetrics: [] })
      expect(preview.json.data.perDay).toHaveLength(7)
      expect(preview.json.data.perDay.every((day: { triggered: number }) => day.triggered === 1)).toBe(true)
      expect(preview.json.data.samples).toEqual([expect.objectContaining({ storeId: storeA, days: 7 })])
      expect((await h.call(reader.token, 'POST', '/alerts/rules/preview', { body: { conditionGroups: customBody().conditionGroups } })).status).toBe(403)
      expect((await h.call(owner.token, 'POST', '/alerts/rules/preview', { body: { conditionGroups: { groups: [] } } })).status).toBe(422)
    })

    it('试算的店铺数有上限：超过 100 个只判断前 100 个并标明截断', async () => {
      const b = await h.createTenant('ann-big')
      const big = await h.createMember(b.tenantId, 'ann-big-owner', ['*'])
      for (let i = 0; i < 101; i += 1) await insertRow(h.client, 'SellerAccount', { id: `big-${i}`, sellerId: `BIG-${i}`, tenantId: b.tenantId, legalEntityId: b.legalEntityId })
      const res = await h.call(big.token, 'POST', '/alerts/rules/preview', { body: { conditionGroups: customBody().conditionGroups } })
      expect(res.status).toBe(200)
      expect(res.json.data).toMatchObject({ evaluatedStores: 100, truncated: true })
    })

    it('评估：按店铺判断，只有合计低于阈值的店铺命中，且换成真实数据后恢复', async () => {
      const result = await run(new Date(`${dateOffset(0)}T12:00:00Z`), customMetricEvaluator)
      expect(result.errors).toBe(0)
      const alerts = await rows<{ entityType: string; entityId: string; ruleId: string }>(
        `SELECT "entityType", "entityId", "ruleId" FROM "AlertInstance" WHERE "tenantId" = $1 AND "ruleId" = $2 AND "status" IN ('NEW','ACKED')`,
        [tenantId, ruleId],
      )
      expect(alerts).toEqual([expect.objectContaining({ entityType: 'STORE', entityId: storeA })])
      // B 店的数据变少后也会命中
      await h.client.query(`UPDATE "StoreDailySummary" SET "salesAmount" = 5 WHERE "sellerAccountId" = $1`, [storeB])
      await run(new Date(`${dateOffset(0)}T13:30:00Z`), customMetricEvaluator)
      const both = await rows<{ entityId: string }>(`SELECT "entityId" FROM "AlertInstance" WHERE "tenantId" = $1 AND "ruleId" = $2 AND "status" IN ('NEW','ACKED') ORDER BY "entityId"`, [
        tenantId,
        ruleId,
      ])
      expect(both.map(row => row.entityId).sort()).toEqual([storeA, storeB].sort())
      await h.client.query(`UPDATE "StoreDailySummary" SET "salesAmount" = 50 WHERE "sellerAccountId" = $1`, [storeB])
      await h.client.query(`UPDATE "AlertRule" SET "enabled" = false WHERE "id" = $1`, [ruleId])
    })
  })

  describe('通知频率：汇总', () => {
    // 各场景互不牵连：开始前把前面场景遗留的待发送批次标成已发送
    beforeEach(async () => {
      hitsByRule.clear()
      await h.client.query(`UPDATE "AlertDigest" SET "status" = 'SENT', "sentAt" = now() WHERE "status" = 'PENDING'`)
    })
    it('每小时汇总：同一小时内多条预警只并入批次，下一小时发一条汇总并带筛选链接；重复扫描不重发', async () => {
      await addRule('hourly', { notifyFrequency: 'HOURLY', name: '每小时规则' })
      hitsByRule.set('hourly', [hit('h1'), hit('h2')])
      expect(await run(T0)).toMatchObject({ created: 2, errors: 0 })
      expect(await alertNotices('hourly')).toBe(2)
      expect(await digests('hourly')).toEqual([expect.objectContaining({ kind: 'FREQUENCY', status: 'PENDING', itemCount: 2 })])
      expect(await ruleNotices('每小时规则')).toHaveLength(0)
      expect(await flush(at(T0, 30))).toEqual({ sent: 0, items: 0 })
      expect(await flush(at(T0, 55))).toEqual({ sent: 1, items: 2 })
      const sent = await ruleNotices('每小时规则')
      expect(sent).toHaveLength(1)
      expect(sent[0]?.title).toContain('2')
      expect(sent[0]?.link).toContain('hourly')
      expect(sent[0]?.userId).toBe(owner.userId)
      expect(await flush(at(T0, 70))).toEqual({ sent: 0, items: 0 })
      expect((await digests('hourly'))[0]).toMatchObject({ status: 'SENT' })
    })

    it('每日汇总：当天内不发，企业时区次日才发', async () => {
      await addRule('daily', { notifyFrequency: 'DAILY', name: '每日规则' })
      hitsByRule.set('daily', [hit('d1')])
      await run(T0)
      expect(await flush(at(T0, 600))).toEqual({ sent: 0, items: 0 })
      expect(await flush(new Date('2026-10-28T00:30:00Z'))).toEqual({ sent: 1, items: 1 })
      expect(await ruleNotices('每日规则')).toHaveLength(1)
    })

    it('静默时段内命中不逐条发，也不丢：静默结束后补发一条汇总，随后另起新批次', async () => {
      await addRule('quiet', { name: '静默规则', scopeJson: JSON.stringify({ quiet: { start: '22:00', end: '07:00' } }) })
      hitsByRule.set('quiet', [hit('q1'), hit('q2')])
      const night = new Date('2026-10-27T23:00:00Z')
      await run(night)
      expect(await ruleNotices('静默规则')).toHaveLength(0)
      expect(await digests('quiet')).toEqual([expect.objectContaining({ kind: 'QUIET', status: 'PENDING', itemCount: 2 })])
      expect(await flush(new Date('2026-10-28T02:00:00Z'))).toEqual({ sent: 0, items: 0 })
      expect(await flush(new Date('2026-10-28T07:30:00Z'))).toEqual({ sent: 1, items: 2 })
      expect(await ruleNotices('静默规则')).toHaveLength(1)
      // 新的静默时段里再有新命中，另起一批
      hitsByRule.set('quiet', [hit('q1'), hit('q2'), hit('q3')])
      await run(new Date('2026-10-28T23:00:00Z'))
      const all = await digests('quiet')
      expect(all.filter(row => row.status === 'PENDING')).toEqual([expect.objectContaining({ kind: 'QUIET', itemCount: 3 })])
      // q1、q2 冷却期外再次触发的提醒与新的 q3 并入同一批
    })

    it('严重级别不受频率与静默限制：立即通知，不进批次', async () => {
      await addRule('critical', { name: '严重规则', severity: 'CRITICAL', notifyFrequency: 'DAILY', scopeJson: JSON.stringify({ quiet: { start: '22:00', end: '07:00' } }) })
      hitsByRule.set('critical', [hit('c1')])
      await run(new Date('2026-10-27T23:30:00Z'))
      expect(await digests('critical')).toHaveLength(0)
      const [row] = await rows<{ n: string }>(`SELECT count(*)::text AS n FROM "Notification" WHERE "tenantId" = $1 AND "title" LIKE '%c1%'`, [tenantId])
      expect(Number(row?.n)).toBeGreaterThanOrEqual(1)
    })

    it('汇总发送时批次里的预警都已处理：不发', async () => {
      await addRule('handled', { notifyFrequency: 'HOURLY', name: '已处理规则' })
      hitsByRule.set('handled', [hit('x1')])
      await run(T0)
      await h.client.query(`UPDATE "AlertInstance" SET "status" = 'HANDLED' WHERE "tenantId" = $1 AND "ruleId" = 'handled'`, [tenantId])
      expect(await flush(at(T0, 90))).toEqual({ sent: 0, items: 0 })
      expect(await ruleNotices('已处理规则')).toHaveLength(0)
    })
  })

  describe('多级升级', () => {
    const level = (ruleName: string) => ruleNotices(ruleName).then(list => list.filter(item => item.title.startsWith('预警未确认已升级')))

    it('未确认的预警按时限逐级升级：待办负责人、规则通知对象、预警管理员；每级只发一次；升级通知为严重级别', async () => {
      await addRule('esc', {
        name: '升级规则',
        escalation: JSON.stringify([{ afterMinutes: 60 }, { afterMinutes: 240 }, { afterMinutes: 600 }]),
        scopeJson: JSON.stringify({ notifyUserIds: [reader.userId] }),
      })
      hitsByRule.set('esc', [{ ...hit('e1'), title: '升级规则 e1' }])
      const t0 = new Date('2026-11-02T08:00:00Z')
      await run(t0)
      await h.client.query(`UPDATE "AlertInstance" SET "firstTriggeredAt" = $2 WHERE "tenantId" = $1 AND "ruleId" = 'esc'`, [tenantId, t0.toISOString()])
      expect(await escalate(at(t0, 30))).toEqual({ escalated: 0 })
      expect(await escalate(at(t0, 61))).toEqual({ escalated: 1 })
      expect(await escalate(at(t0, 62))).toEqual({ escalated: 0 })
      const first = await level('升级规则')
      expect(first).toHaveLength(1)
      expect(first[0]).toMatchObject({ userId: owner.userId, severity: 'CRITICAL' })
      expect(first[0]?.title).toContain('第 1 级')
      expect(await escalate(at(t0, 241))).toEqual({ escalated: 1 })
      const second = (await level('升级规则')).filter(item => item.title.includes('第 2 级'))
      expect(second.map(item => item.userId)).toContain(reader.userId)
      expect(await escalate(at(t0, 601))).toEqual({ escalated: 1 })
      expect((await level('升级规则')).filter(item => item.title.includes('第 3 级')).map(item => item.userId)).toContain(owner.userId)
      expect(await escalate(at(t0, 700))).toEqual({ escalated: 0 })
      expect((await digests('esc')).filter(row => row.kind === 'ESCALATION')).toHaveLength(3)
    })

    it('已确认的预警不再升级；规则停用后也不升级', async () => {
      await addRule('esc2', { name: '确认规则', escalation: JSON.stringify([{ afterMinutes: 60 }]) })
      hitsByRule.set('esc2', [{ ...hit('e2'), title: '确认规则 e2' }])
      const t0 = new Date('2026-11-03T08:00:00Z')
      await run(t0)
      await h.client.query(`UPDATE "AlertInstance" SET "firstTriggeredAt" = $2, "status" = 'ACKED' WHERE "tenantId" = $1 AND "ruleId" = 'esc2'`, [tenantId, t0.toISOString()])
      expect(await escalate(at(t0, 120))).toEqual({ escalated: 0 })
      await h.client.query(`UPDATE "AlertInstance" SET "status" = 'NEW' WHERE "tenantId" = $1 AND "ruleId" = 'esc2'`, [tenantId])
      await h.client.query(`UPDATE "AlertRule" SET "enabled" = false WHERE "id" = 'esc2'`)
      expect(await escalate(at(t0, 120))).toEqual({ escalated: 0 })
    })

    it('升级穿透个人免打扰', async () => {
      await insertRow(h.client, 'UserPreference', { tenantId, userId: owner.userId, notifyJson: JSON.stringify({ domains: {}, dnd: { enabled: true, start: '00:00', end: '23:59' } }) })
      await addRule('esc3', { name: '免打扰规则', escalation: JSON.stringify([{ afterMinutes: 60 }]) })
      hitsByRule.set('esc3', [{ ...hit('e3'), title: '免打扰规则 e3' }])
      const t0 = new Date('2026-11-04T08:00:00Z')
      await run(t0)
      await h.client.query(`UPDATE "AlertInstance" SET "firstTriggeredAt" = $2 WHERE "tenantId" = $1 AND "ruleId" = 'esc3'`, [tenantId, t0.toISOString()])
      expect(await escalate(at(t0, 90))).toEqual({ escalated: 1 })
      expect(await level('免打扰规则')).toEqual([expect.objectContaining({ severity: 'CRITICAL', userId: owner.userId })])
    })
  })
})
