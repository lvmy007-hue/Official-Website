import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 广告预警（P3-18，真实数据库）：高花费低产出、断货商品仍在投放、超预算、单次点击成本突增从广告日汇总、被推广商品日报表、库存快照、活动管理接口数据
// 到预警实例与待办的整条链路；重复评估不重复建、业务数据变化后自动恢复、规则范围对没有绑定店铺的档案同样生效、两个企业互不可见。
// 评估代码在后台任务进程里，这里按路径动态加载。日期都按 UTC 日历日算（评估器没有企业时区）。

type Ids = Awaited<ReturnType<typeof seedTenant>>
type Evaluate = (deps: Record<string, unknown>) => Promise<{ tenants: number; created: number }>
const DAY = 86_400_000
const dayOffset = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10)
const NEW_CODES = ['ADS_HIGH_SPEND_LOW_RETURN', 'ADS_STOCKOUT_ADVERTISING', 'ADS_OUT_OF_BUDGET', 'ADS_CPC_SURGE']

describe('广告预警（P3-18，真实数据库）', () => {
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
      now: () => new Date(),
      logger,
    })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  const instances = (tenantId: string) =>
    rows<{ code: string; entityType: string; entityId: string; status: string; triggerCount: number; sellerAccountId: string | null; evidenceJson: Record<string, any> }>(
      `SELECT r."code", i."entityType", i."entityId", i."status", i."triggerCount", i."sellerAccountId", i."evidenceJson"
       FROM "AlertInstance" i JOIN "AlertRule" r ON r."id" = i."ruleId" WHERE i."tenantId" = $1 ORDER BY r."code", i."entityId"`,
      [tenantId],
    )
  const openOf = async (tenantId: string) => (await instances(tenantId)).filter(item => ['NEW', 'ACKED'].includes(item.status))
  const openCodes = async (tenantId: string) => [...new Set((await openOf(tenantId)).map(item => item.code))].sort()

  const owner = async (ids: Ids) => {
    await insertRow(admin, 'Role', { id: `role-${ids.tenantId}`, tenantId: ids.tenantId, name: '所有者', permissions: JSON.stringify(['*']), resourceScope: '{}', version: 1 })
    await insertRow(admin, 'Membership', { id: `ms-${ids.tenantId}`, tenantId: ids.tenantId, userId: ids.userId, roleId: `role-${ids.tenantId}` })
  }
  const profile = (ids: Ids, id: string, store: string | null) =>
    insertRow(admin, 'AdsProfile', { id, tenantId: ids.tenantId, profileId: `P-${id}`, sellerAccountId: store, bindingStatus: store ? 'MANUAL' : 'UNBOUND' })
  const account = (ids: Ids, profileId: string) =>
    insertRow(admin, 'AdsAccount', { id: `acct-${profileId}`, tenantId: ids.tenantId, adsProfileId: profileId, adsAccountId: `ACC-${profileId}`, name: profileId })
  const summary = (profileId: string, campaignId: string, days: number, values: Record<string, unknown>) =>
    insertRow(admin, 'AdsDailySummary', {
      id: `sm-${++seq}`,
      tenantId: a.tenantId,
      adsProfileId: profileId,
      adProduct: 'SPONSORED_PRODUCTS',
      campaignId,
      summaryDate: dayOffset(days),
      metricVersion: 'ads.v1',
      ...values,
    })
  const campaign = (ids: Ids, id: string, profileId: string, external: string, name: string, values: Record<string, unknown> = {}) =>
    insertRow(admin, 'AdsCampaign', {
      id,
      tenantId: ids.tenantId,
      adsProfileId: profileId,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const advertised = (profileId: string, asin: string, days: number, spend: number) =>
    insertRow(admin, 'AdsAdvertisedProductMetric', {
      id: `ad-${++seq}`,
      tenantId: a.tenantId,
      adsProfileId: profileId,
      adsAccountId: `ACC-${profileId}`,
      campaignId: 'c1',
      advertisedAsin: asin,
      reportDate: dayOffset(days),
      spend,
      sourceUpdatedAt: new Date().toISOString(),
    })
  const snapshot = (asin: string, sellable: number | null) =>
    insertRow(admin, 'InventoryDailySnapshot', {
      id: `sn-${asin}`,
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      snapshotDate: dayOffset(-1),
      sku: `SKU-${asin}`,
      asin,
      sellable,
      source: 'API',
      sourceUpdatedAt: new Date().toISOString(),
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('alertsp3x18')
    db.migrate('alertsp3x18')
    admin = await db.connect('alertsp3x18')
    a = await seedTenant(admin, 'ad-a')
    b = await seedTenant(admin, 'ad-b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('alertsp3x18', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    evaluateAll = (await import(/* @vite-ignore */ String('../../../worker/src/platform/alert-evaluate'))).evaluateAllTenants
    provision = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/provision'))).ensureDefaultRules
    createEvaluators = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/register'))).createAlertEvaluators
    await owner(a)
    await owner(b)

    await profile(a, 'ap-a', a.sellerAccountId)
    await profile(a, 'ap-free', null)
    await profile(b, 'ap-b', b.sellerAccountId)
    await account(a, 'ap-a')
    await account(a, 'ap-free')

    // 高花费低产出（默认：近 7 天到昨天、花费 ≥ 50、点击 ≥ 20、成本销售比 ≥ 100%）
    await summary('ap-a', 'c1', -1, { spend: 60, clicks: 40, sales: 0, orders: 0 }) // c1：两天合计花 130、没有销售额 → 无产出
    await summary('ap-a', 'c1', -2, { spend: 70, clicks: 40, sales: 0, orders: 0 })
    await summary('ap-a', 'c2', -1, { spend: 100, clicks: 50, sales: 400, orders: 8 }) // 成本销售比 25%，不报
    await summary('ap-a', 'c3', -1, { spend: 200, clicks: 90, sales: 100, orders: 4 }) // 成本销售比 200% → 报（没有活动记录）
    await summary('ap-a', 'c4', -1, { spend: 80, clicks: 40, sales: null, orders: 0 }) // 销售额没数据，不判断
    await summary('ap-a', 'c5', 0, { spend: 60, clicks: 25, sales: 0, orders: 0 }) // 今天的数据不在窗口里
    await summary('ap-a', '', -1, { spend: 500, clicks: 100, sales: 0, orders: 0 }) // 账户级行不是活动
    await summary('ap-a', 'c7', -1, { spend: 500, clicks: 100, sales: 0, orders: 0, currency: 'CAD' }) // 其他币种不看
    await summary('ap-free', 'cf1', -1, { spend: 90, clicks: 30, sales: 0, orders: 0 }) // 没有绑定店铺的档案：不限店铺的规则也看得到
    // 单次点击成本突增：最近 3 天 90 ÷ 60 = 1.5，基线（再往前 14 天）100 ÷ 100 = 1 → 刚好 1.5 倍；这些行销售额都很好，不触发低产出
    await summary('ap-a', 'c8', -1, { spend: 45, clicks: 30, sales: 250, orders: 3 })
    await summary('ap-a', 'c8', -2, { spend: 45, clicks: 30, sales: 250, orders: 3 })
    await summary('ap-a', 'c8', -5, { spend: 50, clicks: 50, sales: 300, orders: 4 })
    await summary('ap-a', 'c8', -10, { spend: 50, clicks: 50, sales: 300, orders: 4 })

    // 活动：cam-1（c1）与 cam-2 投放状态预算用完、已暂停的 cam-3 不算、正常的 cam-4 不算、c8 有记录；租户 B 自己一个预算用完的活动
    await campaign(a, 'cam-1', 'ap-a', 'c1', '品牌词活动', { budget: 30, budgetType: 'DAILY', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
    await campaign(a, 'cam-2', 'ap-a', 'c2', '清仓活动', { budget: 20, budgetType: 'DAILY', servingStatus: 'campaign_out_of_budget' })
    await campaign(a, 'cam-3', 'ap-a', 'c3x', '已暂停', { state: 'PAUSED', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
    await campaign(a, 'cam-4', 'ap-a', 'c4x', '正常活动', { servingStatus: 'CAMPAIGN_STATUS_ENABLED' })
    await campaign(a, 'cam-8', 'ap-a', 'c8', '自动活动')
    await campaign(b, 'cam-b', 'ap-b', 'cb1', '租户 B 活动', { servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })

    // 断货仍在投放（默认：近 3 天含今天、花费 ≥ 5、快照不早于 3 天）：B0AAA 没货且昨天今天都在花 → 报；B0BBB 有货；B0CCC 花费不到 5；
    // B0DDD 5 天前的花费不在回看期；B0FFF 所在档案没有绑定店铺，对不上库存
    await insertRow(admin, 'FbaProduct', { id: 'prod-AAA', tenantId: a.tenantId, sellerAccountId: a.sellerAccountId, sellerSku: 'SKU-B0AAA', asin: 'B0AAA', title: '断货商品' })
    await advertised('ap-a', 'B0AAA', -1, 12)
    await advertised('ap-a', 'B0AAA', 0, 6)
    await advertised('ap-a', 'B0BBB', -1, 8)
    await advertised('ap-a', 'B0CCC', -1, 3)
    await advertised('ap-a', 'B0DDD', -5, 10)
    await advertised('ap-free', 'B0FFF', -1, 9)
    for (const [asin, sellable] of [
      ['B0AAA', 0],
      ['B0BBB', 10],
      ['B0CCC', 0],
      ['B0DDD', 0],
      ['B0FFF', 0],
    ] as const)
      await snapshot(asin, sellable)
  }, 180_000)

  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('第一轮：四类预警各命中应命中的对象，不该命中的（正常、销售额没数据、今天的数据、账户级行、其他币种、有货、花费不到下限、太久远、没绑店铺、已暂停）都不命中；企业互不可见', async () => {
    const result = await run()
    expect(result.tenants).toBe(2)
    expect(await openCodes(a.tenantId)).toEqual([...NEW_CODES].sort())
    expect(await openCodes(b.tenantId)).toEqual(['ADS_OUT_OF_BUDGET'])
    expect(result.created).toBe(8)
    const list = await openOf(a.tenantId)
    const of = (code: string) => list.filter(item => item.code === code)

    const low = of('ADS_HIGH_SPEND_LOW_RETURN')
    const lowOf = (entityId: string) => low.find(item => item.entityId === entityId)
    expect(low.map(item => [item.entityType, item.entityId]).sort()).toEqual([
      ['ADS_CAMPAIGN', 'ap-a|SPONSORED_PRODUCTS|c3'],
      ['ADS_CAMPAIGN', 'ap-free|SPONSORED_PRODUCTS|cf1'],
      ['CAMPAIGN', 'cam-1'],
    ])
    expect(lowOf('cam-1')).toMatchObject({ sellerAccountId: a.sellerAccountId })
    expect(lowOf('cam-1')?.evidenceJson).toMatchObject({ kind: 'NO_SALES', campaignName: '品牌词活动', spend: 130, clicks: 80, sales: 0, currency: 'USD' })
    expect(lowOf('ap-a|SPONSORED_PRODUCTS|c3')?.evidenceJson).toMatchObject({ kind: 'HIGH_ACOS', spend: 200, sales: 100, acos: 2 })
    expect(lowOf('ap-free|SPONSORED_PRODUCTS|cf1')).toMatchObject({ sellerAccountId: null })

    const stockout = of('ADS_STOCKOUT_ADVERTISING')
    expect(stockout).toHaveLength(1)
    expect(stockout[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-AAA', sellerAccountId: a.sellerAccountId })
    expect(stockout[0].evidenceJson).toMatchObject({ asin: 'B0AAA', title: '断货商品', spend: 18, spendDays: 2, dailyWaste: 9, sellable: 0 })

    expect(
      of('ADS_OUT_OF_BUDGET')
        .map(item => item.entityId)
        .sort(),
    ).toEqual(['cam-1', 'cam-2'])
    expect(of('ADS_OUT_OF_BUDGET').find(item => item.entityId === 'cam-1')?.evidenceJson).toMatchObject({
      campaignName: '品牌词活动',
      servingStatus: 'CAMPAIGN_OUT_OF_BUDGET',
      budget: 30,
      budgetType: 'DAILY',
    })

    const cpc = of('ADS_CPC_SURGE')
    expect(cpc).toHaveLength(1)
    expect(cpc[0]).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'cam-8' })
    expect(cpc[0].evidenceJson).toMatchObject({ recentCpc: 1.5, baselineCpc: 1, ratio: 1.5, recentClicks: 60, baselineClicks: 100, extraSpend: 30 })
    expect((await openOf(b.tenantId)).map(item => item.entityId)).toEqual(['cam-b'])
  })

  it('每个预警都生成待办：断货与点击成本突增带影响金额，其余没有可靠依据的不写；预置规则每个企业都有', async () => {
    const works = await rows<{ ruleCode: string; kind: string; severity: string; entityType: string; entityId: string; impactMin: string | null; currency: string; ownerId: string }>(
      `SELECT "ruleCode", "kind", "severity", "entityType", "entityId", "impactMin", "currency", "ownerId" FROM "WorkItem" WHERE "tenantId" = $1 ORDER BY "ruleCode", "entityId"`,
      [a.tenantId],
    )
    expect(works).toHaveLength(7)
    expect(new Set(works.map(work => work.kind))).toEqual(new Set(['ADS']))
    expect(works.every(work => work.severity === 'WARNING' && work.ownerId === a.userId)).toBe(true)
    const byRule = (code: string) => works.filter(work => work.ruleCode === code)
    expect(byRule('ADS_STOCKOUT_ADVERTISING')[0]).toMatchObject({ impactMin: '9.000000', currency: 'USD' })
    expect(byRule('ADS_CPC_SURGE')[0]).toMatchObject({ impactMin: '30.000000', currency: 'USD' })
    expect([...byRule('ADS_HIGH_SPEND_LOW_RETURN'), ...byRule('ADS_OUT_OF_BUDGET')].every(work => work.impactMin === null)).toBe(true)
    for (const tenantId of [a.tenantId, b.tenantId]) {
      const codes = await rows<{ code: string }>(`SELECT "code" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = ANY($2)`, [tenantId, NEW_CODES])
      expect(codes).toHaveLength(NEW_CODES.length)
    }
  })

  it('第二轮数据没变：不新建预警与待办，只刷新命中次数', async () => {
    const result = await run()
    expect(result.created).toBe(0)
    expect((await instances(a.tenantId)).every(item => item.triggerCount === 2)).toBe(true)
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(7)
  })

  it('业务数据变化后自动恢复：预算恢复、补进库存、销售额回传；仍异常的不受影响；待办留给人确认；租户 B 不受影响', async () => {
    await admin.query(`UPDATE "AdsCampaign" SET "servingStatus" = 'CAMPAIGN_STATUS_ENABLED' WHERE "tenantId" = $1`, [a.tenantId])
    await admin.query(`UPDATE "InventoryDailySnapshot" SET "sellable" = 20 WHERE "tenantId" = $1 AND "asin" = 'B0AAA'`, [a.tenantId])
    await admin.query(`UPDATE "AdsDailySummary" SET "sales" = 1000, "orders" = 9 WHERE "tenantId" = $1 AND "campaignId" = 'c3'`, [a.tenantId])
    await run()
    expect(await openCodes(a.tenantId)).toEqual(['ADS_CPC_SURGE', 'ADS_HIGH_SPEND_LOW_RETURN'])
    expect(
      (await openOf(a.tenantId))
        .filter(item => item.code === 'ADS_HIGH_SPEND_LOW_RETURN')
        .map(item => item.entityId)
        .sort(),
    ).toEqual(['ap-free|SPONSORED_PRODUCTS|cf1', 'cam-1'])
    const closed = (await instances(a.tenantId)).filter(item => item.status === 'AUTO_CLOSED')
    expect(closed.map(item => item.code).sort()).toEqual(['ADS_HIGH_SPEND_LOW_RETURN', 'ADS_OUT_OF_BUDGET', 'ADS_OUT_OF_BUDGET', 'ADS_STOCKOUT_ADVERTISING'])
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1 AND "status" = 'PENDING'`, [a.tenantId])).toHaveLength(7)
    expect(await openCodes(b.tenantId)).toEqual(['ADS_OUT_OF_BUDGET'])
  })

  it('冷却期内再次命中不重复建待办；店铺范围对没有绑定店铺的档案同样生效；企业改过的规则不被预置覆盖；后台账号不在租户上下文里读不到预警', async () => {
    await admin.query(`UPDATE "AdsCampaign" SET "servingStatus" = 'CAMPAIGN_OUT_OF_BUDGET' WHERE "id" = 'cam-1'`)
    await run()
    expect((await openOf(a.tenantId)).filter(item => item.code === 'ADS_OUT_OF_BUDGET')).toEqual([])
    expect(await rows(`SELECT 1 FROM "WorkItem" WHERE "tenantId" = $1`, [a.tenantId])).toHaveLength(7)

    // 范围改成别的店铺：绑定了 ap-a 的活动与没绑定的 ap-free 都被排除
    await admin.query(`UPDATE "AlertRule" SET "scopeJson" = $2 WHERE "tenantId" = $1 AND "code" IN ('ADS_HIGH_SPEND_LOW_RETURN', 'ADS_CPC_SURGE')`, [
      a.tenantId,
      JSON.stringify({ sellerAccountIds: ['other-store'] }),
    ])
    await run()
    expect(await openCodes(a.tenantId)).toEqual([])
    const rule = await rows<{ scopeJson: Record<string, unknown> }>(`SELECT "scopeJson" FROM "AlertRule" WHERE "tenantId" = $1 AND "code" = 'ADS_CPC_SURGE'`, [a.tenantId])
    expect(rule[0].scopeJson).toEqual({ sellerAccountIds: ['other-store'] })
    expect(await base.alertInstance.count()).toBe(0)
  })
})
