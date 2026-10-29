import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Client } from 'pg'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// P2a-07 验收（M-P2a-07）：补货策略三级版本、批次与建议的约束、迁移保数据与回滚闭环、行级安全。
// 约束由数据库保证；这里直接用 SQL 验证，不经过应用层。

const TARGET = '20261023010000_replenishment_engine'
const NEW_TABLES = ['SubscribeSaveMetric', 'SubscribeSaveOffer', 'ReplenishmentBatch', 'ReplenishmentRecommendation', 'ReplenishmentAction', 'ReplenishmentOutcome', 'EconomicsSimulationRun'] as const
const NEW_COLUMNS = ['productionDays', 'domesticDays', 'receivingDays', 'serviceLevel', 'transportPreference', 'transportOptionsJson', 'casePackQty', 'moq', 'minOrderValue']

async function exists(client: Client, table: string) {
  const { rows } = await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])
  return rows[0].found as boolean
}
const policyColumns = async (client: Client) => {
  const { rows } = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'ReplenishmentPolicy' AND column_name = ANY($1)`, [NEW_COLUMNS])
  return rows.map(row => row.column_name as string).sort()
}

describe('补货引擎数据表（P2a-07）', () => {
  let db: TestDatabase
  beforeAll(async () => {
    db = await startTestDatabase()
  })
  afterAll(async () => {
    await db?.stop()
  })

  describe('迁移保数据与回滚', () => {
    let client: Client
    beforeAll(async () => {
      await db.createDatabase('rep_legacy')
      client = await db.connect('rep_legacy')
      await applyMigrations(client, { before: TARGET })
      const ids = await seedTenant(client, 'rep')
      await insertRow(client, 'ReplenishmentPolicy', {
        id: 'old-1',
        tenantId: ids.tenantId,
        level: 'TENANT',
        levelRef: 'ALL',
        versionNo: 1,
        leadTimeDays: 30,
        safetyDays: 14,
        coverageDays: 60,
        redundancyMultiplier: 1.5,
        inboundCounted: ['WORKING'],
        agingFromDays: 271,
        effectiveFrom: '2026-10-01',
        changeReason: '旧版',
        createdBy: 'u1',
      })
    })
    afterAll(async () => {
      await client?.end()
    })

    it('升级：旧版策略保留，新增的 9 列都是空（旧版没有这些参数，页面会提示补齐），不被填默认值', async () => {
      expect(await policyColumns(client)).toEqual([])
      await applyMigrations(client, { only: TARGET })
      expect(await policyColumns(client)).toEqual([...NEW_COLUMNS].sort())
      const row = (await client.query(`SELECT "leadTimeDays", "serviceLevel", "productionDays", "transportOptionsJson", "casePackQty", "minOrderValue" FROM "ReplenishmentPolicy" WHERE id = 'old-1'`))
        .rows[0]
      expect(row).toEqual({ leadTimeDays: 30, serviceLevel: null, productionDays: null, transportOptionsJson: null, casePackQty: null, minOrderValue: null })
      for (const table of NEW_TABLES) expect(await exists(client, table), `${table} 应存在`).toBe(true)
    })

    it('回滚：7 张新表与新增列都移除，旧版策略的原参数不变；再次升级闭环成功', async () => {
      await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
      for (const table of NEW_TABLES) expect(await exists(client, table), `${table} 应已删除`).toBe(false)
      expect(await policyColumns(client)).toEqual([])
      expect((await client.query(`SELECT "coverageDays" FROM "ReplenishmentPolicy" WHERE id = 'old-1'`)).rows[0].coverageDays).toBe(60)
      await applyMigrations(client, { only: TARGET })
      for (const table of NEW_TABLES) expect(await exists(client, table), `${table} 应再次存在`).toBe(true)
      expect(await policyColumns(client)).toEqual([...NEW_COLUMNS].sort())
    })
  })

  describe('约束与唯一键', () => {
    let client: Client
    let ids: Awaited<ReturnType<typeof seedTenant>>
    const base = () => ({ tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId })
    const policy = (extra: Record<string, unknown> = {}) => ({
      tenantId: ids.tenantId,
      level: 'SKU',
      levelRef: 'SKU-1',
      versionNo: 1,
      leadTimeDays: 30,
      safetyDays: 14,
      coverageDays: 60,
      redundancyMultiplier: 1.5,
      inboundCounted: ['WORKING'],
      agingFromDays: 271,
      effectiveFrom: '2026-10-22',
      changeReason: '测试',
      createdBy: 'u1',
      ...extra,
    })

    beforeAll(async () => {
      await db.createDatabase('rep_fresh')
      client = await db.connect('rep_fresh')
      await applyMigrations(client)
      ids = await seedTenant(client, 'fresh')
    })
    afterAll(async () => {
      await client?.end()
    })

    it('策略版本：同一对象同一版本号只能有一行；企业级对象必须是 ALL；新参数范围受限', async () => {
      await insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p1' }))
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p1-dup' }))).rejects.toMatchObject({ code: '23505' })
      await insertRow(
        client,
        'ReplenishmentPolicy',
        policy({
          id: 'p2',
          versionNo: 2,
          serviceLevel: 0.95,
          productionDays: 10,
          transportPreference: 'AUTO',
          transportOptionsJson: '[{"mode":"SEA","transitDays":30,"unitCost":0.5}]',
          casePackQty: 10,
          moq: 100,
          minOrderValue: 500,
        }),
      )
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p3', level: 'TENANT', levelRef: 'SKU-1' }))).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p4', versionNo: 3, serviceLevel: 1 }))).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p5', versionNo: 4, casePackQty: 0 }))).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p6', versionNo: 5, transportPreference: 'TRAIN' }))).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentPolicy', policy({ id: 'p7', versionNo: 6, transportOptionsJson: '{"mode":"SEA"}' }))).rejects.toMatchObject({ code: '23514' })
    })

    it('批次号唯一；批次状态、建议渠道与风险、动作与状态只接受约定取值', async () => {
      await insertRow(client, 'ReplenishmentBatch', { id: 'b1', tenantId: ids.tenantId, batchNo: 'RB-1', today: '2026-10-22', computedBy: 'u1' })
      await expect(insertRow(client, 'ReplenishmentBatch', { id: 'b1-dup', tenantId: ids.tenantId, batchNo: 'RB-1', today: '2026-10-22', computedBy: 'u1' })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'ReplenishmentBatch', { id: 'b2', tenantId: ids.tenantId, batchNo: 'RB-2', today: '2026-10-22', computedBy: 'u1', status: 'WHATEVER' })).rejects.toMatchObject({
        code: '23514',
      })
      const rec = { ...base(), batchId: 'b1', sku: 'SKU-1', recommendedQty: 440, purchaseQty: 440, dueDate: '2026-10-22', confidence: 0.9 }
      await insertRow(client, 'ReplenishmentRecommendation', { id: 'r1', ...rec })
      await expect(insertRow(client, 'ReplenishmentRecommendation', { id: 'r1-dup', ...rec })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'ReplenishmentRecommendation', { id: 'r2', ...rec, sku: 'SKU-2', channel: 'DRONE' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentRecommendation', { id: 'r3', ...rec, sku: 'SKU-3', riskLevel: 'SCARY' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentRecommendation', { id: 'r4', ...rec, sku: 'SKU-4', recommendedQty: -1 })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentRecommendation', { id: 'r5', ...rec, sku: 'SKU-5', confidence: 1.5 })).rejects.toMatchObject({ code: '23514' })
      const action = { tenantId: ids.tenantId, batchId: 'b1', recommendationId: 'r1', action: 'ADOPT', finalQty: 440, actorId: 'u1' }
      await insertRow(client, 'ReplenishmentAction', { id: 'a1', ...action })
      await expect(insertRow(client, 'ReplenishmentAction', { id: 'a2', ...action, action: 'DELETE' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentAction', { id: 'a3', ...action, status: 'LATER' })).rejects.toMatchObject({ code: '23514' })
      await expect(insertRow(client, 'ReplenishmentAction', { id: 'a4', ...action, finalQty: -5 })).rejects.toMatchObject({ code: '23514' })
      await insertRow(client, 'ReplenishmentAction', { id: 'a5', ...action, action: 'INBOUND_DRAFT', status: 'PENDING_TARGET', finalQty: null })
    })

    it('结果回看：同一条建议同一天只有一条评估；误差与多余库存可以为空（不是 0）；删除建议会级联删除动作与回看', async () => {
      const outcome = { tenantId: ids.tenantId, recommendationId: 'r1', evaluatedAt: '2026-10-30', windowStart: '2026-10-22', windowEnd: '2026-10-29', forecastQty: 80, actualQty: 0, stockoutDays: 0 }
      await insertRow(client, 'ReplenishmentOutcome', { id: 'o1', ...outcome, errorPct: null, excessUnits: null })
      await expect(insertRow(client, 'ReplenishmentOutcome', { id: 'o1-dup', ...outcome })).rejects.toMatchObject({ code: '23505' })
      const row = (await client.query(`SELECT "errorPct", "excessUnits" FROM "ReplenishmentOutcome" WHERE id = 'o1'`)).rows[0]
      expect(row).toEqual({ errorPct: null, excessUnits: null })
      await client.query(`DELETE FROM "ReplenishmentRecommendation" WHERE id = 'r1'`)
      expect((await client.query(`SELECT count(*)::int AS n FROM "ReplenishmentAction" WHERE "recommendationId" = 'r1'`)).rows[0].n).toBe(0)
      expect((await client.query(`SELECT count(*)::int AS n FROM "ReplenishmentOutcome" WHERE "recommendationId" = 'r1'`)).rows[0].n).toBe(0)
    })

    it('订阅省：指标与报价快照各自的唯一键生效；指标粒度只接受约定取值；没给的指标保持空', async () => {
      const metric = { ...base(), metricDate: '2026-10-21', granularity: 'DAY', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await insertRow(client, 'SubscribeSaveMetric', { id: 'm1', ...metric, shippedUnits: 12 })
      await expect(insertRow(client, 'SubscribeSaveMetric', { id: 'm1-dup', ...metric })).rejects.toMatchObject({ code: '23505' })
      await expect(insertRow(client, 'SubscribeSaveMetric', { id: 'm2', ...metric, granularity: 'HOUR' })).rejects.toMatchObject({ code: '23514' })
      expect((await client.query(`SELECT "activeSubscribers", revenue FROM "SubscribeSaveMetric" WHERE id = 'm1'`)).rows[0]).toEqual({ activeSubscribers: null, revenue: null })
      const offer = { ...base(), sku: 'SKU-1', snapshotDate: '2026-10-22', sourceUpdatedAt: '2026-10-22T08:00:00Z' }
      await insertRow(client, 'SubscribeSaveOffer', { id: 'f1', ...offer })
      await expect(insertRow(client, 'SubscribeSaveOffer', { id: 'f1-dup', ...offer })).rejects.toMatchObject({ code: '23505' })
      await insertRow(client, 'SubscribeSaveOffer', { id: 'f2', ...offer, snapshotDate: '2026-10-23' })
    })

    it('单品经济模拟：动作类型只接受约定取值', async () => {
      const run = { ...base(), startDate: '2026-10-22', endDate: '2026-11-21', createdBy: 'u1' }
      await insertRow(client, 'EconomicsSimulationRun', { id: 'e1', ...run, inputJson: '{"quantity":500}' })
      await expect(insertRow(client, 'EconomicsSimulationRun', { id: 'e2', ...run, actionType: 'MAGIC' })).rejects.toMatchObject({ code: '23514' })
    })

    it('新表都启用了按租户的行级安全', async () => {
      const { rows } = await client.query<{ relname: string; relrowsecurity: boolean }>(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [[...NEW_TABLES]])
      expect(rows.map(r => r.relname).sort()).toEqual([...NEW_TABLES].sort())
      expect(rows.every(r => r.relrowsecurity)).toBe(true)
    })
  })
})
