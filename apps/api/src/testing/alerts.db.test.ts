import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 本阶段预警规则（P2a-15，真实数据库）：预置规则补齐、库存五项、入仓差异、同步失败、授权失效从规则到预警实例、待办、通知的整条链路；
// 重复评估不重复建待办、命中消失自动恢复、关闭规则与改范围、两个企业互不可见。评估代码在后台任务进程里，这里按路径动态加载。

type Ids = Awaited<ReturnType<typeof seedTenant>>
type Evaluate = (deps: Record<string, unknown>) => Promise<{ tenants: number; created: number }>
const DAY = 86_400_000
const dayOffset = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const iso = (days: number) => new Date(Date.now() + days * DAY).toISOString()
const RULE_COUNT = 30

describe('本阶段预警规则（P2a-15，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let a: Ids
  let b: Ids
  let evaluateAll: Evaluate
  let provision: (db: unknown, tenantId: string) => Promise<string[]>
  let createEvaluators: () => unknown
  let seq = 0

  const logger = { info: () => undefined, warn: () => undefined }
  const run = () =>
    evaluateAll({
      systemDb: { tenant: { findMany: async () => [{ id: a.tenantId }, { id: b.tenantId }] } },
      db: scoped,
      registry: createEvaluators(),
      provision,
      now: () => new Date(), // 每次返回新对象：同一轮评估共用一次库存读取，下一轮重新读
      logger,
    })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  const instances = (tenantId: string) =>
    rows<{ code: string; entityId: string; status: string; triggerCount: number; severity: string; evidenceJson: Record<string, unknown>; workItemId: string | null }>(
      `SELECT r."code", i."entityId", i."status", i."triggerCount", i."severity", i."evidenceJson", i."workItemId" FROM "AlertInstance" i JOIN "AlertRule" r ON r."id" = i."ruleId" WHERE i."tenantId" = $1 ORDER BY r."code", i."entityId"`,
      [tenantId],
    )
  const open = async (tenantId: string) =>
    (await instances(tenantId))
      .filter(item => ['NEW', 'ACKED'].includes(item.status))
      .map(item => `${item.code}:${item.entityId}`)
      .sort()

  const store = async (ids: Ids) => {
    await admin.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE "id" = $1`, [ids.tenantId])
    await insertRow(admin, 'Role', { id: `role-${ids.tenantId}`, tenantId: ids.tenantId, name: '所有者', permissions: JSON.stringify(['*']), resourceScope: '{}', version: 1 })
    await insertRow(admin, 'Membership', { id: `ms-${ids.tenantId}`, tenantId: ids.tenantId, userId: ids.userId, roleId: `role-${ids.tenantId}` })
    await insertRow(admin, 'ReplenishmentPolicy', {
      id: `pol-${ids.tenantId}`,
      tenantId: ids.tenantId,
      level: 'TENANT',
      levelRef: 'ALL',
      versionNo: 1,
      leadTimeDays: 30,
      safetyDays: 14,
      coverageDays: 60,
      redundancyMultiplier: '1.50',
      inboundCounted: ['WORKING', 'SHIPPED'],
      agingFromDays: 271,
      effectiveFrom: '2026-01-01',
      changeReason: '测试',
      createdBy: ids.userId,
    })
  }
  /** 一条库存记录；规划报告给近 30 天销量 300 件（日销 10）。 */
  const item = async (ids: Ids, sku: string, sellable: number, planning: Record<string, unknown> = {}, record: Record<string, unknown> = {}) => {
    const row = await insertRow(admin, 'FbaInventoryRecord', {
      id: `fir-${ids.tenantId}-${sku}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      marketplaceId: 'ATVPDKIKX0DER',
      sellerSku: sku,
      asin: `B0${sku}`,
      fulfillableQuantity: sellable,
      ...record,
    })
    await insertRow(admin, 'InventoryPlanningSnapshot', {
      id: `ips-${++seq}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      snapshotDate: dayOffset(-1),
      sku,
      asin: `B0${sku}`,
      unitsShippedT7: 70,
      unitsShippedT30: 300,
      unitsShippedT60: 600,
      unitsShippedT90: 900,
      ...planning,
    })
    return row.id as string
  }

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alertsp2a')
    db.migrate('alertsp2a')
    admin = await db.connect('alertsp2a')
    a = await seedTenant(admin, 'al-a')
    b = await seedTenant(admin, 'al-b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('alertsp2a', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    evaluateAll = (await import(/* @vite-ignore */ String('../../../worker/src/platform/alert-evaluate'))).evaluateAllTenants
    provision = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/provision'))).ensureDefaultRules
    createEvaluators = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/register'))).createAlertEvaluators
    await store(a)
    await store(b)

    // 租户 A：每个场景一个 SKU
    await item(a, 'HI', 50) // 可售 50、日销 10：只够 5 天，短于补货提前期 30 天 → 断货风险
    await item(a, 'EX', 3000) // 300 天 → 冗余
    await item(a, 'LOW', 600, { lowInventoryLevelFeeApplied: 'Yes', lowInventoryLevelFee: 4.2, currency: 'USD' })
    await item(a, 'STR', 600)
    await admin.query(`UPDATE "FbaInventoryRecord" SET "strandedReason" = 'MISSING_LISTING' WHERE "id" = $1`, [`fir-${a.tenantId}-STR`])
    await insertRow(admin, 'InventoryDailySnapshot', {
      id: `ids-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      snapshotDate: dayOffset(-1),
      sku: 'STR',
      source: 'STRANDED',
      stranded: 5,
      strandedReason: 'MISSING_LISTING',
      sourceUpdatedAt: iso(-1),
    })
    // 库龄：快照在 82 天前，181-270 天的 40 件最迟在 8 天后满 271 天、271-365 天的 10 件最迟 13 天后满 366 天；单价取该档已有库存的预估费用 ÷ 数量
    await item(a, 'AGE', 600, { aisEst271To300: 10, aisEst301To330: 10, aisEst331To365: 0, aisEst365Plus: 50 })
    await insertRow(admin, 'InventoryAgeSnapshot', {
      id: `ias-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      snapshotDate: dayOffset(-82),
      sku: 'AGE',
      age0to90: 10,
      age91to180: 30,
      age181to270: 40,
      age271to365: 10,
      age365plus: 5,
      sourceUpdatedAt: iso(-82),
    })
    // 入仓差异、同步失败、授权失效
    await insertRow(admin, 'ReceivingDiscrepancy', {
      id: `rd-${++seq}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      shipmentRef: 'FBA15X',
      sku: 'HI',
      kind: 'SHORT',
      source: 'RECEIPT',
      qty: 3,
      firstSeenAt: iso(-5),
      lastSeenAt: iso(-1),
    })
    await insertRow(admin, 'PlatformConnection', {
      id: `pc-${a.tenantId}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      provider: 'AMAZON_SP_API',
      state: 'AUTHORIZED',
      encryptedRefreshToken: 'x',
      refreshTokenUpdatedAt: '2026-01-01T00:00:00Z',
      grantedScopes: '[]',
    })
    await insertRow(admin, 'DataFreshness', {
      id: `df-1`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      sourceKey: 'orders.api',
      lastAttemptAt: iso(0),
      status: 'FAILED',
      lastErrorCode: 'REPORT_FATAL',
    })
    await insertRow(admin, 'DataFreshness', {
      id: `df-2`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      sourceKey: 'inventory.api',
      lastAttemptAt: iso(0),
      status: 'UNAUTHORIZED',
      lastErrorCode: 'AUTH_EXPIRED',
    })
    // 租户 B：同样的“将断货”，评估后只属于 B
    await item(b, 'HI', 50)
  }, 180_000)

  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('第一轮：补齐全部预置规则（各带第 1 版记录；财务与售后四条见 alerts-finance.db.test.ts），每项预警各命中一个对象；每个企业只看到自己的', async () => {
    const result = await run()
    expect(result.tenants).toBe(2)
    for (const tenantId of [a.tenantId, b.tenantId]) {
      expect(await rows(`SELECT 1 FROM "AlertRule" WHERE "tenantId" = $1`, [tenantId])).toHaveLength(RULE_COUNT)
      expect(await rows(`SELECT 1 FROM "AlertRuleVersion" WHERE "tenantId" = $1 AND "versionNo" = 1 AND "changedBy" = 'system'`, [tenantId])).toHaveLength(RULE_COUNT)
    }
    expect(await open(a.tenantId)).toEqual(
      [
        `INV_AGING_TIER:fir-${a.tenantId}-AGE`,
        `INV_EXCESS:fir-${a.tenantId}-EX`,
        'INV_INBOUND_DISCREPANCY:FBA15X',
        `INV_LOW_LEVEL_FEE:fir-${a.tenantId}-LOW`,
        `INV_STOCKOUT_RISK:fir-${a.tenantId}-HI`,
        `INV_STRANDED:fir-${a.tenantId}-STR`,
        `SYS_AUTH_EXPIRING:${a.sellerAccountId}`,
        `SYS_SYNC_FAILED:${a.sellerAccountId}:orders.api`,
      ].sort(),
    )
    // 租户 B：只有自己的那一个断货风险（没有 A 的冗余、差异、同步失败）
    expect(await open(b.tenantId)).toEqual([`INV_STOCKOUT_RISK:fir-${b.tenantId}-HI`])
    expect(result.created).toBe(9)
  })

  it('每个预警都生成待办与站内通知，待办带实体、严重度与时限；影响金额只在有依据时写入', async () => {
    const list = await instances(a.tenantId)
    const stockout = list.find(item => item.code === 'INV_STOCKOUT_RISK')
    expect(stockout).toMatchObject({ severity: 'CRITICAL', status: 'NEW' })
    expect(stockout?.evidenceJson).toMatchObject({ sku: 'HI', risk: 'HIGH', sellable: 50, dailyDemand: 10, daysOfCover: 5, fastestLeadDays: 30 })
    const works = await rows<{
      title: string
      kind: string
      severity: string
      priority: string
      entityType: string
      entityId: string
      impactMin: string | null
      currency: string
      ownerId: string
      ruleCode: string
    }>(`SELECT "title", "kind", "severity", "priority", "entityType", "entityId", "impactMin", "currency", "ownerId", "ruleCode" FROM "WorkItem" WHERE "tenantId" = $1 ORDER BY "ruleCode"`, [
      a.tenantId,
    ])
    expect(works).toHaveLength(8)
    const byRule = Object.fromEntries(works.map(work => [work.ruleCode, work]))
    expect(byRule.INV_STOCKOUT_RISK).toMatchObject({ kind: 'INVENTORY', severity: 'CRITICAL', priority: 'URGENT', entityType: 'INVENTORY', ownerId: a.userId })
    expect(byRule.INV_STOCKOUT_RISK.title).toContain('HI 将断货')
    expect(byRule.INV_LOW_LEVEL_FEE).toMatchObject({ impactMin: '4.200000', currency: 'USD' })
    expect(byRule.INV_AGING_TIER.impactMin).toBe('180.000000') // 40 件 × (20 ÷ 10) + 10 件 × (50 ÷ 5)
    expect(byRule.INV_STRANDED.impactMin).toBeNull()
    expect(byRule.INV_INBOUND_DISCREPANCY).toMatchObject({ entityType: 'INBOUND_SHIPMENT', entityId: 'FBA15X' })
    expect(byRule.SYS_SYNC_FAILED).toMatchObject({ kind: 'SYSTEM', entityType: 'DATA_SOURCE' })
    expect(byRule.SYS_AUTH_EXPIRING).toMatchObject({ severity: 'CRITICAL', entityType: 'STORE', entityId: a.sellerAccountId })
    const notices = await rows<{ userId: string }>(`SELECT "userId" FROM "Notification" WHERE "tenantId" = $1 AND "kind" = 'ALERT_RULE'`, [a.tenantId])
    expect(notices).toHaveLength(8)
    expect(notices.every(notice => notice.userId === a.userId)).toBe(true)
  })

  it('第二轮数据没变：不新建预警与待办，只刷新命中次数；预置规则不重复建', async () => {
    const result = await run()
    expect(result.created).toBe(0)
    expect((await instances(a.tenantId)).every(item => item.triggerCount === 2)).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(8)
    expect(await rows(`SELECT 1 FROM "AlertRule" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(RULE_COUNT)
  })

  it('命中消失：补货后断货风险、差异消除、同步恢复、重新授权，对应预警自动恢复；已生成的待办留给人确认', async () => {
    await admin.query(`UPDATE "FbaInventoryRecord" SET "fulfillableQuantity" = 600 WHERE "id" = $1`, [`fir-${a.tenantId}-HI`])
    await admin.query(`UPDATE "ReceivingDiscrepancy" SET "resolvedAt" = now() WHERE "tenantId" = $1`, [a.tenantId])
    await admin.query(`UPDATE "DataFreshness" SET "status" = 'NORMAL', "lastErrorCode" = NULL, "lastSuccessAt" = now() WHERE "id" = 'df-1'`)
    // 失败之后重新授权（ISO 文字写入：列是不带时区的时间戳）
    await admin.query(`UPDATE "PlatformConnection" SET "refreshTokenUpdatedAt" = $2 WHERE "tenantId" = $1`, [a.tenantId, new Date(Date.now() + 60_000).toISOString()])
    await run()
    expect(await open(a.tenantId)).toEqual(
      [`INV_AGING_TIER:fir-${a.tenantId}-AGE`, `INV_EXCESS:fir-${a.tenantId}-EX`, `INV_LOW_LEVEL_FEE:fir-${a.tenantId}-LOW`, `INV_STRANDED:fir-${a.tenantId}-STR`].sort(),
    )
    const closed = (await instances(a.tenantId)).filter(item => item.status === 'AUTO_CLOSED').map(item => item.code)
    expect(closed.sort()).toEqual(['INV_INBOUND_DISCREPANCY', 'INV_STOCKOUT_RISK', 'SYS_AUTH_EXPIRING', 'SYS_SYNC_FAILED'])
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1 AND "status" = 'PENDING'`, [a.tenantId])).toHaveLength(8)
    // 租户 B 的断货风险不受 A 的补货影响
    expect(await open(b.tenantId)).toEqual([`INV_STOCKOUT_RISK:fir-${b.tenantId}-HI`])
  })

  it('关闭规则后不再评估新对象；规则范围改到别的店铺后，原来的命中消失并恢复；企业改过的规则不会被预置覆盖', async () => {
    await item(a, 'EX2', 4000)
    await admin.query(`UPDATE "AlertRule" SET "enabled" = false WHERE "tenantId" = $1 AND "code" = 'INV_EXCESS'`, [a.tenantId])
    await admin.query(`UPDATE "AlertRule" SET "scopeJson" = $2 WHERE "tenantId" = $1 AND "code" = 'INV_STRANDED'`, [a.tenantId, JSON.stringify({ sellerAccountIds: ['other-store'] })])
    await admin.query(`UPDATE "AlertRule" SET "conditionJson" = $2 WHERE "tenantId" = $1 AND "code" = 'INV_LOW_LEVEL_FEE'`, [
      a.tenantId,
      JSON.stringify({ type: 'inventory.low-level-fee', params: {} }),
    ])
    await run()
    const open2 = await open(a.tenantId)
    expect(open2).toContain(`INV_EXCESS:fir-${a.tenantId}-EX`) // 规则被关闭：不评估也不自动恢复
    expect(open2).not.toContain(`INV_EXCESS:fir-${a.tenantId}-EX2`)
    expect(open2).not.toContain(`INV_STRANDED:fir-${a.tenantId}-STR`)
    const rules = await rows<{ code: string; enabled: boolean; conditionJson: { params: Record<string, unknown> }; scopeJson: Record<string, unknown> }>(
      `SELECT "code", "enabled", "conditionJson", "scopeJson" FROM "AlertRule" WHERE "tenantId" = $1`,
      [a.tenantId],
    )
    const ruleOf = (code: string) => rules.find(rule => rule.code === code)
    // 企业改过的启停、范围、阈值，预置补齐不覆盖
    expect(ruleOf('INV_EXCESS')?.enabled).toBe(false)
    expect(ruleOf('INV_STRANDED')?.scopeJson).toEqual({ sellerAccountIds: ['other-store'] })
    expect(ruleOf('INV_LOW_LEVEL_FEE')?.conditionJson.params).toEqual({})
    expect(rules).toHaveLength(RULE_COUNT)
  })

  it('没有库存规则的企业：断货类预警不判定（原有的随之恢复）；后台账号不在租户上下文里读不到任何预警', async () => {
    await admin.query(`DELETE FROM "ReplenishmentPolicy" WHERE "tenantId" = $1`, [b.tenantId])
    await run()
    expect(await open(b.tenantId)).toEqual([])
    expect((await instances(b.tenantId)).map(item => item.status)).toEqual(['AUTO_CLOSED'])
    expect(await base.alertInstance.count()).toBe(0)
  })
})
