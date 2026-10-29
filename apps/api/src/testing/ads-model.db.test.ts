import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { ADS_METRIC_ENTITY_TYPES, ADS_NEGATIVE_LEVELS, ADS_TARGETING_TYPES, ADS_TARGET_KINDS } from '@nova/api-contracts'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 广告数据模型（P3-02，真实数据库）：
// 迁移升级保数据（回填对象编号、投放对象编号、档案范围编号，为 P3-01 的推荐与预测补账户行再加外键）、回滚、再次升级；
// 检查约束、唯一键、外键与级联；新分区表；每个新模型都能通过 Prisma 读写（模型与迁移没有漂移）；行级隔离。

const TARGET = '20261110010000_ads_data_model'
const DAY = '2026-10-10T00:00:00.000Z'
const ENTITY_TABLES = ['AdsPortfolio', 'AdsAdGroup', 'AdsAd', 'AdsTarget', 'AdsKeyword', 'AdsNegativeTarget', 'AdsCreative'] as const
const METRIC_TABLES = ['AdsPlacementMetric', 'AdsAdvertisedProductMetric', 'AdsConvertedProductDaily', 'AdsPerformanceHourly'] as const
const PARTITIONED = ['AdsAdvertisedProductMetric', 'AdsConvertedProductDaily', 'AdsPerformanceHourly'] as const
const NEW_TABLES = ['AdsAccount', ...ENTITY_TABLES, ...METRIC_TABLES] as const

describe('广告数据模型迁移（P3-02）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_model_migrate')
    client = await db.connect('ads_model_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean
  const columns = async (table: string) =>
    (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [table])).rows.map(row => row.column_name as string)
  const one = async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows[0] as T
  const count = async (table: string) => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}"`)).n
  const accountOf = (tenantId: string, adsProfileId: string, adsAccountId: string) => ({
    tenantId,
    adsProfileId,
    adsAccountId,
    type: 'BUDGET',
    entityType: 'CAMPAIGN',
    entityId: 'c1',
    payloadJson: '{}',
  })

  it('升级：回填档案范围编号、对象编号与投放对象编号，为推荐与预测补账户行；回滚还原；再次升级闭环成功', async () => {
    const ids = await seedTenant(client, 'adsm')
    const single = await insertRow(client, 'AdsProfile', { id: 'ap-single', tenantId: ids.tenantId, profileId: 'P-SINGLE', currencyCode: 'USD', timezone: 'America/Los_Angeles' })
    const double = await insertRow(client, 'AdsProfile', { id: 'ap-double', tenantId: ids.tenantId, profileId: 'P-DOUBLE' })
    const bare = await insertRow(client, 'AdsProfile', { id: 'ap-bare', tenantId: ids.tenantId, profileId: 'P-BARE' })
    const when = '2026-10-20T00:00:00.000Z'
    const rec = (id: string, profileId: string, account: string) =>
      insertRow(client, 'AdsRecommendation', { id, recommendationId: id, receivedAt: when, lastSeenAt: when, ...accountOf(ids.tenantId, profileId, account) })
    await rec('rec-1', single.id, 'acct-single')
    await rec('rec-2', single.id, 'acct-single')
    await rec('rec-3', double.id, 'acct-d1')
    await insertRow(client, 'AdsForecastRun', {
      id: 'fc-1',
      tenantId: ids.tenantId,
      adsProfileId: double.id,
      adsAccountId: 'acct-d2',
      campaignId: 'c1',
      requestedBudget: 5,
      forecastJson: '{}',
      requestedAt: when,
    })
    // 旧版日指标与词级指标
    await insertRow(client, 'AdsMetric', { id: 'm-1', tenantId: ids.tenantId, adsProfileId: single.id, reportDate: DAY, externalCampaignId: 'camp-1', cost: 2, purchases: 1 })
    await insertRow(client, 'AdsMetric', { id: 'm-2', tenantId: ids.tenantId, adsProfileId: single.id, reportDate: DAY, externalCampaignId: '' })
    await insertRow(client, 'AdsMetric', { id: 'm-3', tenantId: ids.tenantId, adsProfileId: single.id, reportDate: DAY, externalCampaignId: 'camp-3' })
    await client.query(`UPDATE "AdsMetric" SET "externalCampaignId" = NULL WHERE id = 'm-3'`)
    await insertRow(client, 'AdsTermMetric', { id: 't-1', tenantId: ids.tenantId, adsProfileId: single.id, reportDate: DAY, level: 'KEYWORD', rowKey: 'r1', keywordId: 'kw-1' })
    await insertRow(client, 'AdsTermMetric', { id: 't-2', tenantId: ids.tenantId, adsProfileId: single.id, reportDate: DAY, level: 'SEARCH_TERM', rowKey: 'r2' })
    expect(bare.id).toBe('ap-bare')

    for (const table of NEW_TABLES) expect(await exists(table), table).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of NEW_TABLES) {
      expect(await exists(table), table).toBe(true)
      expect((await one<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = $1`, [table])).relrowsecurity, table).toBe(true)
      expect((await client.query(`SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1 AND qual LIKE '%nova_current_tenant%'`, [table])).rowCount, table).toBe(1)
    }

    const profiles = Object.fromEntries((await client.query(`SELECT id, "legacyScopeId", "adsAccountId" FROM "AdsProfile"`)).rows.map(row => [row.id, row]))
    expect(profiles['ap-single']).toMatchObject({ legacyScopeId: 'P-SINGLE', adsAccountId: 'acct-single' }) // 只对应一个账户：写回档案
    expect(profiles['ap-double']).toMatchObject({ legacyScopeId: 'P-DOUBLE', adsAccountId: null }) // 对应两个账户：不猜，留空
    expect(profiles['ap-bare']).toMatchObject({ legacyScopeId: 'P-BARE', adsAccountId: null })
    const accounts = (await client.query(`SELECT "adsProfileId", "adsAccountId", status, currency, timezone FROM "AdsAccount" ORDER BY "adsAccountId"`)).rows
    expect(accounts.map(row => `${row.adsProfileId}:${row.adsAccountId}:${row.status}`)).toEqual(['ap-double:acct-d1:UNKNOWN', 'ap-double:acct-d2:UNKNOWN', 'ap-single:acct-single:UNKNOWN'])
    expect(accounts[2]).toMatchObject({ currency: 'USD', timezone: 'America/Los_Angeles' })

    const metrics = Object.fromEntries((await client.query(`SELECT id, "entityType", "entityId", "adsAccountId", units, "warningSignals" FROM "AdsMetric"`)).rows.map(row => [row.id, row]))
    expect(metrics['m-1']).toMatchObject({ entityType: 'CAMPAIGN', entityId: 'camp-1', adsAccountId: null, units: null, warningSignals: null })
    expect(metrics['m-2'].entityId).toBeNull() // 空串不当作对象编号
    expect(metrics['m-3'].entityId).toBeNull()
    const terms = Object.fromEntries((await client.query(`SELECT id, "targetId", "otherBucket", "matchedTargetExpression" FROM "AdsTermMetric"`)).rows.map(row => [row.id, row]))
    expect(terms['t-1']).toMatchObject({ targetId: 'kw-1', otherBucket: false, matchedTargetExpression: null })
    expect(terms['t-2'].targetId).toBeNull()

    // 推荐与预测已经有指向账户的外键：账户不存在被拒绝
    await expect(rec('rec-x', single.id, 'acct-missing')).rejects.toMatchObject({ code: '23503' })

    // 回滚：新表与新列全部消失，既有数据原样保留
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of NEW_TABLES) expect(await exists(table), table).toBe(false)
    expect(await columns('AdsProfile')).not.toContain('adsAccountId')
    expect(await columns('AdsProfile')).not.toContain('legacyScopeId')
    expect(await columns('AdsMetric')).not.toContain('entityType')
    expect(await columns('AdsTermMetric')).not.toContain('targetId')
    expect(await columns('AdsCampaign')).not.toContain('portfolioId')
    expect(await count('AdsMetric')).toBe(3)
    expect(await count('AdsTermMetric')).toBe(2)
    expect(await count('AdsRecommendation')).toBe(3)
    expect(await count('AdsForecastRun')).toBe(1)
    expect((await client.query(`SELECT 1 FROM pg_constraint WHERE conname IN ('AdsRecommendation_account_fkey', 'AdsMetric_account_fkey')`)).rowCount).toBe(0)

    // 再次升级
    await applyMigrations(client, { only: TARGET })
    expect(await count('AdsAccount')).toBe(3)
    expect((await one<{ entityId: string }>(`SELECT "entityId" FROM "AdsMetric" WHERE id = 'm-1'`)).entityId).toBe('camp-1')
  })
})

describe('广告数据模型（真实数据库，约束与读写）', () => {
  let db: TestDatabase
  let admin: Client
  let tenantA: Awaited<ReturnType<typeof seedTenant>>
  let tenantB: Awaited<ReturnType<typeof seedTenant>>
  let tenantDb: PrismaClient
  const ACCOUNT = 'amzn1.ads-account.g.model'
  const rows = async <T>(sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows as T[]
  const asTenant = <T>(tenantId: string, work: () => Promise<T>) => runWithTenant(tenantId, work)

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_model')
    db.migrate('ads_model')
    admin = await db.connect('ads_model')
    tenantA = await seedTenant(admin, 'adsm-a')
    tenantB = await seedTenant(admin, 'adsm-b')
    await insertRow(admin, 'AdsProfile', { id: 'ap-a', tenantId: tenantA.tenantId, profileId: 'PA' })
    await insertRow(admin, 'AdsProfile', { id: 'ap-b', tenantId: tenantB.tenantId, profileId: 'PB' })
    await insertRow(admin, 'AdsAccount', { id: 'aa-a', tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: ACCOUNT, name: 'A 账户' })
    const base = new PrismaClient({ datasourceUrl: db.urlFor('ads_model', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
  })
  afterAll(async () => {
    await admin?.end()
    await db?.stop()
  })

  const base = () => ({ tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: ACCOUNT })
  const entityRow = (table: (typeof ENTITY_TABLES)[number], id: string, over: Record<string, unknown> = {}) => {
    const keys: Record<(typeof ENTITY_TABLES)[number], Record<string, unknown>> = {
      AdsPortfolio: { portfolioId: id },
      AdsAdGroup: { adGroupId: id },
      AdsAd: { adId: id },
      AdsTarget: { targetId: id, kind: 'KEYWORD' },
      AdsKeyword: { keywordId: id },
      AdsNegativeTarget: { negativeId: id, level: 'CAMPAIGN' },
      AdsCreative: { creativeId: id },
    }
    return insertRow(admin, table, { id: `${table}-${id}`, ...base(), ...keys[table], ...over })
  }

  it('新表的默认值：账户状态、币种；组合已花费为 0；日指标的计数为 0、金额为空（不是 0）', async () => {
    expect(await rows(`SELECT status, currency, timezone FROM "AdsAccount" WHERE id = 'aa-a'`)).toEqual([{ status: 'ACTIVE', currency: 'USD', timezone: null }])
    expect(await entityRow('AdsPortfolio', 'p1')).toMatchObject({ spent: '0.000000', budgetCap: null, currency: 'USD' })
    const placement = await insertRow(admin, 'AdsPlacementMetric', { id: 'pl-1', ...base(), campaignId: 'c1', placement: 'TOP_OF_SEARCH', reportDate: DAY })
    expect(placement).toMatchObject({ impressions: 0, clicks: 0, orders: 0, spend: null, sales: null })
    const hourly = await insertRow(admin, 'AdsPerformanceHourly', { id: 'h-1', ...base(), entityType: 'CAMPAIGN', entityId: 'c1', hourStart: '2026-10-10T05:00:00.000Z' })
    expect(hourly).toMatchObject({ orders: 0, spend: null, extraJson: null })
  })

  it('唯一键：同企业同账户同编号只能有一行；另一个企业连同一个亚马逊账户编号互不影响', async () => {
    for (const table of ENTITY_TABLES) {
      await entityRow(table, 'u1')
      await expect(entityRow(table, 'u1', { id: `${table}-dup` }), table).rejects.toMatchObject({ code: '23505' })
    }
    await expect(insertRow(admin, 'AdsAccount', { id: 'aa-dup', ...base(), name: '重复' })).rejects.toMatchObject({ code: '23505' })
    await insertRow(admin, 'AdsAccount', { id: 'aa-b', tenantId: tenantB.tenantId, adsProfileId: 'ap-b', adsAccountId: ACCOUNT, name: 'B 账户' })
    await insertRow(admin, 'AdsPortfolio', { id: 'port-b', tenantId: tenantB.tenantId, adsProfileId: 'ap-b', adsAccountId: ACCOUNT, portfolioId: 'p1', name: 'B', status: 'ENABLED' })
    // 档案上的账户编号：同企业内唯一，不同企业可以相同，空值不互相冲突
    await admin.query(`UPDATE "AdsProfile" SET "adsAccountId" = $1 WHERE id IN ('ap-a', 'ap-b')`, [ACCOUNT])
    const second = { id: 'ap-a2', tenantId: tenantA.tenantId, profileId: 'PA2' }
    await insertRow(admin, 'AdsProfile', second)
    await insertRow(admin, 'AdsProfile', { id: 'ap-a3', tenantId: tenantA.tenantId, profileId: 'PA3' })
    await expect(admin.query(`UPDATE "AdsProfile" SET "adsAccountId" = $1 WHERE id = 'ap-a2'`, [ACCOUNT])).rejects.toMatchObject({ code: '23505' })
  })

  it('外键：账户不存在被拒绝；档案编号指向别的档案以外的不存在档案被拒绝', async () => {
    for (const table of ENTITY_TABLES) await expect(entityRow(table, 'orphan', { adsAccountId: 'nope' }), table).rejects.toMatchObject({ code: '23503' })
    await expect(entityRow('AdsAdGroup', 'orphan-p', { adsProfileId: 'no-such-profile' })).rejects.toMatchObject({ code: '23503' })
    await expect(insertRow(admin, 'AdsPlacementMetric', { id: 'pl-orphan', ...base(), adsAccountId: 'nope', campaignId: 'c1', placement: 'X', reportDate: DAY })).rejects.toMatchObject({
      code: '23503',
    })
    // 现有指标表的账户编号可以为空（旧数据），填了就必须存在
    await insertRow(admin, 'AdsMetric', { id: 'am-legacy', tenantId: tenantA.tenantId, adsProfileId: 'ap-a', reportDate: DAY, externalCampaignId: 'c1' })
    await expect(
      insertRow(admin, 'AdsMetric', { id: 'am-bad', tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: 'nope', reportDate: DAY, externalCampaignId: 'c2' }),
    ).rejects.toMatchObject({ code: '23503' })
    await expect(insertRow(admin, 'AdsCampaign', { id: 'cp-bad', tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: 'nope', externalCampaignId: 'x' })).rejects.toMatchObject({
      code: '23503',
    })
  })

  it('检查约束：投放类别、否定投放层级、投放方式、指标对象类型与非负数', async () => {
    await expect(entityRow('AdsTarget', 'k1', { kind: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
    for (const [index, kind] of ADS_TARGET_KINDS.entries()) await entityRow('AdsTarget', `kind-${index}`, { kind })
    await expect(entityRow('AdsNegativeTarget', 'n1', { level: 'ACCOUNT' })).rejects.toMatchObject({ code: '23514' })
    await expect(entityRow('AdsNegativeTarget', 'n2', { level: 'AD_GROUP', adGroupId: null })).rejects.toMatchObject({ code: '23514' }) // 广告组级必须有广告组编号
    for (const [index, level] of ADS_NEGATIVE_LEVELS.entries()) await entityRow('AdsNegativeTarget', `lv-${index}`, { level, adGroupId: 'g1' })
    for (const [index, targetingType] of ADS_TARGETING_TYPES.entries())
      await insertRow(admin, 'AdsCampaign', { id: `cp-${index}`, tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: ACCOUNT, externalCampaignId: `cp-${index}`, targetingType })
    await expect(insertRow(admin, 'AdsCampaign', { id: 'cp-x', tenantId: tenantA.tenantId, adsProfileId: 'ap-a', externalCampaignId: 'cp-x', targetingType: 'SEMI' })).rejects.toMatchObject({
      code: '23514',
    })

    for (const [index, entityType] of ADS_METRIC_ENTITY_TYPES.entries()) {
      await insertRow(admin, 'AdsMetric', { id: `met-${index}`, ...base(), entityType, entityId: `e-${index}`, reportDate: DAY, externalCampaignId: null })
      await insertRow(admin, 'AdsPerformanceHourly', { id: `hr-${index}`, ...base(), entityType, entityId: `e-${index}`, hourStart: '2026-10-10T06:00:00.000Z' })
    }
    await expect(insertRow(admin, 'AdsMetric', { id: 'met-x', ...base(), entityType: 'ACCOUNT', entityId: 'x', reportDate: DAY, externalCampaignId: null })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(admin, 'AdsPerformanceHourly', { id: 'hr-x', ...base(), entityType: 'ACCOUNT', entityId: 'x', hourStart: '2026-10-10T07:00:00.000Z' })).rejects.toMatchObject({
      code: '23514',
    })

    await expect(entityRow('AdsPortfolio', 'neg', { budgetCap: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(entityRow('AdsPortfolio', 'neg2', { spent: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(entityRow('AdsTarget', 'neg3', { bid: -0.1 })).rejects.toMatchObject({ code: '23514' })
    await expect(entityRow('AdsKeyword', 'neg4', { bid: -0.1 })).rejects.toMatchObject({ code: '23514' })
    await expect(entityRow('AdsAdGroup', 'neg5', { defaultBid: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(admin, 'AdsPlacementMetric', { id: 'pl-neg', ...base(), campaignId: 'c9', placement: 'X', reportDate: DAY, clicks: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(admin, 'AdsAdvertisedProductMetric', { id: 'ap-neg', ...base(), campaignId: 'c9', advertisedAsin: 'B0', reportDate: DAY, spend: -1 })).rejects.toMatchObject({
      code: '23514',
    })
    await expect(
      insertRow(admin, 'AdsConvertedProductDaily', { id: 'cv-neg', ...base(), campaignId: 'c9', advertisedAsin: 'B0', purchasedAsin: 'B1', reportDate: DAY, units: -1, sales: 1, isHalo: true }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertRow(admin, 'AdsPerformanceHourly', { id: 'hr-neg', ...base(), entityType: 'CAMPAIGN', entityId: 'neg', hourStart: '2026-10-10T08:00:00.000Z', orders: -1 }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('指标唯一键：现有日指标表按（企业、账户、对象、日、广告产品）去重，旧数据没有账户编号时不受影响；分区表的唯一键含分区列', async () => {
    const metric = (id: string, over: Record<string, unknown> = {}) =>
      insertRow(admin, 'AdsMetric', { id, ...base(), entityType: 'AD_GROUP', entityId: 'g-u', reportDate: DAY, adProduct: 'SPONSORED_PRODUCTS', externalCampaignId: null, ...over })
    await metric('mu-1')
    await expect(metric('mu-2')).rejects.toMatchObject({ code: '23505' })
    await metric('mu-3', { adProduct: 'SPONSORED_BRANDS' }) // 广告产品不同
    await metric('mu-4', { reportDate: '2026-10-11T00:00:00.000Z' }) // 日期不同
    await metric('mu-5', { adsAccountId: null, entityId: 'g-u' }) // 没有账户编号的旧行不进新唯一键
    await metric('mu-6', { adsAccountId: null, entityId: 'g-u' })

    const dupes = [
      ['AdsAdvertisedProductMetric', { campaignId: 'c1', advertisedAsin: 'B0A', reportDate: DAY }],
      ['AdsConvertedProductDaily', { campaignId: 'c1', advertisedAsin: 'B0A', purchasedAsin: 'B0B', reportDate: DAY, units: 1, sales: 2, isHalo: true }],
      ['AdsPlacementMetric', { campaignId: 'c1', placement: 'PRODUCT_PAGE', reportDate: DAY }],
      ['AdsPerformanceHourly', { entityType: 'CAMPAIGN', entityId: 'c-dupe', hourStart: '2026-10-10T09:00:00.000Z' }],
    ] as const
    for (const [table, values] of dupes) {
      await insertRow(admin, table, { id: `${table}-1`, ...base(), ...values })
      await expect(insertRow(admin, table, { id: `${table}-2`, ...base(), ...values }), table).rejects.toMatchObject({ code: '23505' })
    }
  })

  it('三张分区表确实是按月分区表，数据落进当月分区；其余新表是普通表', async () => {
    for (const table of PARTITIONED) {
      expect((await rows<{ relkind: string }>(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`"${table}"`]))[0].relkind, table).toBe('p')
    }
    for (const table of ['AdsAccount', ...ENTITY_TABLES, 'AdsPlacementMetric']) {
      expect((await rows<{ relkind: string }>(`SELECT relkind FROM pg_class WHERE oid = to_regclass($1)`, [`"${table}"`]))[0].relkind, table).toBe('r')
    }
    const part = await rows<{ part: string }>(`SELECT tableoid::regclass::text AS part FROM "AdsPerformanceHourly" WHERE id = 'hr-0'`)
    expect(part[0].part).toBe('"AdsPerformanceHourly_p202610"')
    const old = await rows<{ part: string }>(`SELECT tableoid::regclass::text AS part FROM "AdsAdvertisedProductMetric" WHERE id = 'AdsAdvertisedProductMetric-1'`)
    expect(old[0].part).toBe('"AdsAdvertisedProductMetric_p202610"')
  })

  it('删除广告账户：账户下全部实体、指标、推荐与预测一并删除，别的企业不受影响', async () => {
    const when = '2026-10-20T00:00:00.000Z'
    await insertRow(admin, 'AdsRecommendation', {
      id: 'rec-c',
      ...base(),
      recommendationId: 'rc',
      type: 'BUDGET',
      entityType: 'CAMPAIGN',
      entityId: 'c1',
      payloadJson: '{}',
      receivedAt: when,
      lastSeenAt: when,
    })
    await insertRow(admin, 'AdsForecastRun', { id: 'fc-c', ...base(), campaignId: 'c1', requestedBudget: 1, forecastJson: '{}', requestedAt: when })
    const tables = [...ENTITY_TABLES, ...METRIC_TABLES, 'AdsMetric', 'AdsCampaign', 'AdsRecommendation', 'AdsForecastRun']
    for (const table of tables) {
      const found = await rows(`SELECT 1 FROM "${table}" WHERE "tenantId" = $1 AND "adsAccountId" = $2`, [tenantA.tenantId, ACCOUNT])
      expect(found.length, `${table} 删除前应有数据`).toBeGreaterThan(0)
    }
    await admin.query(`DELETE FROM "AdsAccount" WHERE id = 'aa-a'`)
    for (const table of tables) expect((await rows(`SELECT 1 FROM "${table}" WHERE "tenantId" = $1 AND "adsAccountId" = $2`, [tenantA.tenantId, ACCOUNT])).length, `${table} 应已级联删除`).toBe(0)
    expect((await rows(`SELECT 1 FROM "AdsMetric" WHERE id = 'am-legacy'`)).length).toBe(1) // 没有账户编号的旧行不属于任何账户
    expect((await rows(`SELECT 1 FROM "AdsPortfolio" WHERE "tenantId" = $1`, [tenantB.tenantId])).length).toBe(1)
  })

  it('Prisma 读写每个新模型（模型与迁移没有漂移），行级隔离：别的企业读不到、也写不进', async () => {
    await admin.query(
      `INSERT INTO "AdsAccount" ("id","tenantId","adsProfileId","adsAccountId","name","sourceUpdatedAt","updatedAt") VALUES ('aa-p','${tenantA.tenantId}','ap-a','acct-prisma','P 账户',now(),now())`,
    )
    const scope = { tenantId: tenantA.tenantId, adsProfileId: 'ap-a', adsAccountId: 'acct-prisma' }
    const stamp = { sourceUpdatedAt: new Date(DAY) }
    const day = new Date(DAY)
    type Delegate = { create(args: { data: Record<string, unknown> }): Promise<{ id: string }>; count(): Promise<number> }
    const model = (name: string) => (tenantDb as unknown as Record<string, Delegate>)[name]
    const data: Record<string, Record<string, unknown>> = {
      adsPortfolio: { portfolioId: 'pp', name: '组合', status: 'ENABLED', budgetCap: 100, budgetPeriod: 'MONTHLY' },
      adsAdGroup: { adGroupId: 'pg', campaignId: 'c1', name: '组', state: 'ENABLED', defaultBid: 0.5 },
      adsAd: { adId: 'pa', adGroupId: 'pg', asin: 'B0P', sku: 'SKU-P', state: 'ENABLED' },
      adsTarget: { targetId: 'pt', adGroupId: 'pg', kind: 'PRODUCT', expression: 'asin="B0X"', state: 'ENABLED' },
      adsKeyword: { keywordId: 'pk', campaignId: 'c1', adGroupId: 'pg', text: 'steel bottle', matchType: 'EXACT', bid: 0.8, state: 'ENABLED' },
      adsNegativeTarget: { negativeId: 'pn', level: 'AD_GROUP', campaignId: 'c1', adGroupId: 'pg', expression: 'cheap', matchType: 'NEGATIVE_PHRASE' },
      adsCreative: { creativeId: 'pc', adId: 'pa', kind: 'IMAGE', assetsJson: { url: 'x' } },
      adsPlacementMetric: { campaignId: 'c1', placement: 'TOP_OF_SEARCH', reportDate: day, spend: 1.5, orders: 2 },
      adsAdvertisedProductMetric: { campaignId: 'c1', advertisedAsin: 'B0P', reportDate: day, spend: 2, units: 3 },
      adsConvertedProductDaily: { campaignId: 'c1', advertisedAsin: 'B0P', purchasedAsin: 'B0Q', reportDate: day, units: 1, sales: 9.9, isHalo: true },
      adsPerformanceHourly: { entityType: 'TARGET', entityId: 'pt', hourStart: new Date('2026-10-10T10:00:00Z'), extraJson: { viewableImpressions: 3 } },
    }
    for (const [name, values] of Object.entries(data)) {
      await asTenant(tenantA.tenantId, () => model(name).create({ data: { ...scope, ...stamp, ...values } }))
      expect(await asTenant(tenantA.tenantId, () => model(name).count()), `${name} 本企业可见`).toBeGreaterThan(0)
      expect(await asTenant(tenantB.tenantId, () => model(name).count()), `${name} 别的企业不可见`).toBe(name === 'adsPortfolio' ? 1 : 0)
    }
    // 企业 B 自己的组合只有 1 行（上面造的）；企业 B 不能往企业 A 的账户下写
    const leak = async () => asTenant(tenantB.tenantId, () => model('adsAdGroup').create({ data: { ...scope, ...stamp, adGroupId: 'leak', campaignId: 'c1', name: 'x', state: 'ENABLED' } }))
    await expect(leak()).rejects.toThrow(/其他租户/)
    expect((await rows(`SELECT 1 FROM "AdsAdGroup" WHERE "adGroupId" = 'leak'`)).length).toBe(0)
    const accountSeen = await asTenant(tenantB.tenantId, () => (tenantDb as unknown as { adsAccount: { count(): Promise<number> } }).adsAccount.count())
    expect(accountSeen).toBe(1) // 只看得到自己的账户（企业 B 的 aa-b）
  })
})
