import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告实体落库同步（P5-12A，真实数据库 + 完整应用 + worker 的同步器）：拉取（假的亚马逊响应）→ 落库 → 页面接口返回；
// 账户发现、增量与幂等、归档的保护、部分失败、超预算预警由同步下来的投放状态触发、任务分发的失败分类、跨企业隔离与数据范围。
// 响应字段是按统一接口命名约定写的假设（CR-104）：这里验证的是“给定这样的响应，落成这样的数据”，不是亚马逊真实响应。

type Member = { userId: string; token: string }
type Row = Record<string, any>
type Item = Record<string, unknown>
type Ctx = { prisma: PrismaClient; logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } }
type Profile = { id: string; tenantId: string; adsAccountId: string; displayName: string | null; currencyCode: string }

const budget = (value: number) => [{ recurrenceTimePeriod: 'DAILY', budgetValue: { monetaryBudgetValue: { monetaryBudget: { value, currencyCode: 'USD' } } } }]
const campaign = (id: string, name: string, serving: string, value: number, extra: Item = {}): Item => ({
  campaignId: id,
  name,
  state: 'ENABLED',
  adProduct: 'SPONSORED_PRODUCTS',
  budgets: budget(value),
  servingStatus: serving,
  ...extra,
})
const PORTFOLIOS = [{ portfolioId: 'PF1', name: '旺季组合', state: 'ENABLED', budget: { amount: 900, policy: 'MONTHLY', currencyCode: 'USD' } }]
const DATA: Record<string, Item[]> = {
  campaigns: [
    campaign('C1', '春季推广(新)', 'CAMPAIGN_STATUS_ENABLED', 50, { portfolioId: 'PF1', targetingType: 'MANUAL' }),
    campaign('C2', '超预算活动', 'CAMPAIGN_OUT_OF_BUDGET', 30),
    { campaignId: 'C3', name: '没有广告产品' },
  ],
  adGroups: [
    { adGroupId: 'G1', campaignId: 'C1', name: '核心词组', state: 'ENABLED', defaultBid: 1.2 },
    { adGroupId: 'G2', campaignId: 'C2', name: '第二组', state: 'ENABLED', defaultBid: 0.9 },
  ],
  ads: [{ adId: 'AD1', adGroupId: 'G1', asin: 'B0AAA', sku: 'SKU-1', state: 'ENABLED' }],
  targets: [
    { targetId: 'K1', adGroupId: 'G1', campaignId: 'C1', keywordText: 'yoga mat', matchType: 'EXACT', bid: 0.8, state: 'ENABLED' },
    { targetId: 'T1', adGroupId: 'G1', asin: 'B0BBB', bid: 0.5, state: 'ENABLED' },
    { targetId: 'K2', adGroupId: 'G2', keywordText: 'cheap mat', matchType: 'BROAD', bid: 0.4, state: 'ENABLED' },
    { targetId: 'N1', adGroupId: 'G1', negative: true, keywordText: 'free', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' },
    { targetId: 'N2', campaignId: 'C1', negative: true, keywordText: 'cheap', matchType: 'NEGATIVE_PHRASE', state: 'ENABLED' },
  ],
}
/** 假的统一接口：按资源名返回条目（campaigns 分两页，验证翻页）；记录每个请求用的账户编号。 */
const fakeApi = (data: Record<string, Item[]>, incomplete: string[] = []) => ({
  queryAll: async function* (resource: string) {
    for (const item of data[resource] ?? []) yield item as never
    return { complete: !incomplete.includes(resource), pages: 1 }
  },
})

describe('广告实体落库同步（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let other: Member
  let discover: (db: PrismaClient, client: unknown, tenantId: string, now?: Date) => Promise<Row>
  let sync: (ctx: Ctx, input: { profile: Profile; api: unknown; loadPortfolios: () => Promise<Item[]>; now?: Date }) => Promise<Row>
  let processEntities: (deps: Ctx, client: unknown, row: { tenantId: string }, payload: Row) => Promise<Row>
  let evaluateAll: (deps: Record<string, unknown>) => Promise<{ tenants: number; created: number }>
  let provision: unknown
  let createEvaluators: () => unknown
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const ctx: Ctx = { prisma: undefined as unknown as PrismaClient, logger }
  const inTenant = <T>(id: string, work: () => Promise<T>) => runWithTenant(id, work)
  const rows = async <T = Row>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, status = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, `${path} ${JSON.stringify(res.json)}`).toBe(status)
    return res.json.data as Row
  }
  const profileA: Profile = { id: 'ap-a', tenantId: '', adsAccountId: 'ACC-A', displayName: null, currencyCode: 'USD' }
  const runSync = (api: unknown, portfolios: () => Promise<Item[]> = async () => PORTFOLIOS) =>
    inTenant(tenantId, () => sync(ctx, { profile: { ...profileA, tenantId }, api, loadPortfolios: portfolios, now: new Date() }))
  const alertRun = () =>
    evaluateAll({
      systemDb: { tenant: { findMany: async () => [{ id: tenantId }, { id: otherTenantId }] } },
      db: tenantDb,
      registry: createEvaluators(),
      provision,
      now: () => new Date(),
      logger: { info: () => undefined, warn: () => undefined },
    })
  const budgetAlerts = (tenant: string) =>
    rows<{ entityId: string; status: string }>(
      `SELECT i."entityId", i."status" FROM "AlertInstance" i JOIN "AlertRule" r ON r."id" = i."ruleId" WHERE i."tenantId" = $1 AND r."code" = 'ADS_OUT_OF_BUDGET' ORDER BY i."entityId"`,
      [tenant],
    )
  const idOf = async (table: string, column: string, value: string) => (await rows<{ id: string }>(`SELECT id FROM "${table}" WHERE "tenantId" = $1 AND "${column}" = $2`, [tenantId, value]))[0]!.id

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_sync' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    const storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    const profiles: Array<[string, string, string | null, string | null, string, string]> = [
      ['ap-a', 'P-A', storeA, null, tenantId, 'ACTIVE'],
      ['ap-b', 'P-B', storeB, null, tenantId, 'ACTIVE'],
      ['ap-c', 'P-C', storeA, 'ACC-OLD', tenantId, 'INACTIVE'],
      ['ap-x', 'P-X', null, null, tenantId, 'ACTIVE'],
      ['ap-o', 'P-O', b.sellerAccountId, null, otherTenantId, 'ACTIVE'],
    ]
    for (const [id, profileId, store, account, tenant, status] of profiles) {
      await insertRow(h.client, 'AdsProfile', {
        id,
        tenantId: tenant,
        profileId,
        status,
        ...(store ? { sellerAccountId: store, bindingStatus: 'MANUAL' } : {}),
        ...(account ? { adsAccountId: account } : {}),
      })
    }
    // 旧接口同步来的活动：没有账户编号；系统内标签与乐观锁版本必须原样保留
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-1',
      tenantId,
      adsProfileId: 'ap-a',
      externalCampaignId: 'C1',
      adProduct: 'SPONSORED_PRODUCTS',
      name: '春季推广',
      state: 'ENABLED',
      budget: 10,
      tags: ['重点'],
      version: 3,
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-gone',
      tenantId,
      adsProfileId: 'ap-a',
      externalCampaignId: 'C-GONE',
      adProduct: 'SPONSORED_PRODUCTS',
      name: '亚马逊已归档的活动',
      state: 'ENABLED',
      sourceUpdatedAt: '2026-01-01T00:00:00Z',
    })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('ads_sync', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ctx.prisma = tenantDb
    const worker = (path: string) => import(/* @vite-ignore */ String(`../../../worker/src/${path}`))
    discover = (await worker('ads-entities/accounts')).discoverAdsAccounts
    sync = (await worker('ads-entities/sync')).syncAdsEntities
    processEntities = (await worker('ads-entities/dispatch')).processAdsEntities
    evaluateAll = (await worker('platform/alert-evaluate')).evaluateAllTenants
    provision = (await worker('alerts/provision')).ensureDefaultRules
    createEvaluators = (await worker('alerts/register')).createAlertEvaluators
    admin = await h.createMember(tenantId, 'admin', ['ads.read'])
    scopedA = await h.createMember(tenantId, 'scopeda', ['ads.read'], { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', ['ads.read'], { scopes: [{ sellerAccountId: storeB }] })
    other = await h.createMember(otherTenantId, 'other', ['ads.read'])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  it('账户发现：按旧档案编号把账户编号填进档案并建账户行；已有的不改、冲突只计数、没有对应档案的不建；重复发现幂等', async () => {
    const accounts = [
      { adsAccountId: 'ACC-A', accountName: '主账户', status: 'CREATED', alternateIds: [{ profileId: 'P-A', entityId: 'ENT-A' }, { profileId: 'P-ZZ' }] },
      { adsAccountId: 'ACC-B', alternateIds: [{ profileId: 'P-B' }] },
      { adsAccountId: 'ACC-NEW', alternateIds: [{ profileId: 'P-C' }] }, // P-C 已经是 ACC-OLD：冲突，不换
      { adsAccountId: 'ACC-NONE', alternateIds: [{ profileId: 'P-NOPE' }] },
      { adsAccountId: 'ACC-O', alternateIds: [{ profileId: 'P-O' }] }, // 对方企业的档案：这个企业里没有，不能挂上
      { accountName: '没有编号' },
    ]
    const client = { listAdsAccounts: vi.fn().mockResolvedValue(accounts) }
    expect(await inTenant(tenantId, () => discover(tenantDb, client, tenantId))).toEqual({ found: 5, linked: 2, alreadyLinked: 0, unmatched: 2, conflicts: 1 })
    expect(await rows(`SELECT id, "adsAccountId" FROM "AdsProfile" ORDER BY id`)).toEqual([
      { id: 'ap-a', adsAccountId: 'ACC-A' },
      { id: 'ap-b', adsAccountId: 'ACC-B' },
      { id: 'ap-c', adsAccountId: 'ACC-OLD' },
      { id: 'ap-o', adsAccountId: null },
      { id: 'ap-x', adsAccountId: null },
    ])
    expect(await rows(`SELECT "adsAccountId", "adsProfileId", name, "entityId", status FROM "AdsAccount" ORDER BY "adsAccountId"`)).toEqual([
      { adsAccountId: 'ACC-A', adsProfileId: 'ap-a', name: '主账户', entityId: 'ENT-A', status: 'ACTIVE' },
      { adsAccountId: 'ACC-B', adsProfileId: 'ap-b', name: 'ACC-B', entityId: null, status: 'ACTIVE' },
    ])
    expect(await inTenant(tenantId, () => discover(tenantDb, client, tenantId))).toEqual({ found: 5, linked: 0, alreadyLinked: 2, unmatched: 2, conflicts: 1 })
    expect(await rows(`SELECT 1 FROM "AdsAccount"`)).toHaveLength(2)
  })

  it('拉取 → 落库：活动、广告组、广告、关键词、投放、否定投放、组合；没有广告产品的活动跳过并说明，旧活动补上账户编号且保留标签与版本，亚马逊没有的旧活动归档', async () => {
    const result = await runSync(fakeApi(DATA))
    expect(result.tables.campaigns).toMatchObject({ read: 2, created: 1, updated: 1, archived: 1, archiveSkipped: null })
    expect(result.tables.adGroups).toMatchObject({ read: 2, created: 2 })
    expect(result.tables.ads).toMatchObject({ read: 1, created: 1 })
    expect(result.tables.keywords).toMatchObject({ read: 2, created: 2 })
    expect(result.tables.targets).toMatchObject({ read: 1, created: 1 })
    expect(result.tables.negatives).toMatchObject({ read: 2, created: 2 })
    expect(result.tables.portfolios).toMatchObject({ read: 1, created: 1 })
    expect(result.skipped).toEqual({ NO_PRODUCT: 1 })
    expect(result.skippedText).toContain('活动没有可识别的广告产品：1 个')
    expect(result.incompleteResources).toEqual([])

    const cam = (
      await rows(`SELECT name, state, budget::float AS budget, "budgetType", "servingStatus", "portfolioId", "targetingType", "adsAccountId", tags, version FROM "AdsCampaign" WHERE id = 'cam-1'`)
    )[0]
    expect(cam).toEqual({
      name: '春季推广(新)',
      state: 'ENABLED',
      budget: 50,
      budgetType: 'DAILY',
      servingStatus: 'CAMPAIGN_STATUS_ENABLED',
      portfolioId: 'PF1',
      targetingType: 'MANUAL',
      adsAccountId: 'ACC-A',
      tags: ['重点'],
      version: 3,
    })
    expect((await rows(`SELECT state FROM "AdsCampaign" WHERE id = 'cam-gone'`))[0]!.state).toBe('ARCHIVED')
    expect(await rows(`SELECT "externalCampaignId", "servingStatus" FROM "AdsCampaign" WHERE "externalCampaignId" = 'C3'`)).toEqual([])
    // 关键词 K2 的接口响应里没有活动编号，用它所在的广告组补上
    expect(await rows(`SELECT "keywordId", "campaignId", "adGroupId", text, "matchType", bid::float AS bid FROM "AdsKeyword" ORDER BY "keywordId"`)).toEqual([
      { keywordId: 'K1', campaignId: 'C1', adGroupId: 'G1', text: 'yoga mat', matchType: 'EXACT', bid: 0.8 },
      { keywordId: 'K2', campaignId: 'C2', adGroupId: 'G2', text: 'cheap mat', matchType: 'BROAD', bid: 0.4 },
    ])
    expect(await rows(`SELECT "negativeId", level, "campaignId", "adGroupId", expression FROM "AdsNegativeTarget" ORDER BY "negativeId"`)).toEqual([
      { negativeId: 'N1', level: 'AD_GROUP', campaignId: 'C1', adGroupId: 'G1', expression: 'free' },
      { negativeId: 'N2', level: 'CAMPAIGN', campaignId: 'C1', adGroupId: null, expression: 'cheap' },
    ])
    expect((await rows(`SELECT "portfolioId", name, "budgetCap"::float AS cap, "budgetPeriod", status FROM "AdsPortfolio"`))[0]).toEqual({
      portfolioId: 'PF1',
      name: '旺季组合',
      cap: 900,
      budgetPeriod: 'MONTHLY',
      status: 'ENABLED',
    })
  })

  it('页面接口返回同步下来的数据：活动详情、广告组、投放对象、广告商品、否定投放、广告组合', async () => {
    const list = await get(admin, '/ads/campaigns?pageSize=50')
    const byName = new Map<string, Row>(list.items.map((item: Row) => [item.name, item]))
    expect(byName.has('春季推广(新)')).toBe(true)
    expect(byName.has('超预算活动')).toBe(true)
    const detail = await get(admin, '/ads/campaigns/cam-1')
    expect(detail.identity).toMatchObject({ id: 'cam-1', name: '春季推广(新)', budget: 50, portfolio: { id: 'PF1', name: '旺季组合' }, version: 3 })
    expect((await get(admin, '/ads/campaigns/cam-1/ad-groups')).items[0]).toMatchObject({ adGroupId: 'G1', name: '核心词组', defaultBid: 1.2 })
    const targets = await get(admin, '/ads/campaigns/cam-1/targets')
    expect(targets.items.map((item: Row) => item.expression).sort()).toEqual(['B0BBB', 'yoga mat'])
    const groupId = await idOf('AdsAdGroup', 'adGroupId', 'G1')
    expect((await get(admin, `/ads/ad-groups/${groupId}/products`)).items[0]).toMatchObject({ adId: 'AD1', asin: 'B0AAA', sku: 'SKU-1' })
    const negatives = await get(admin, `/ads/ad-groups/${groupId}/negatives`)
    expect(negatives.items.map((item: Row) => item.negativeId).sort()).toEqual(['N1', 'N2'])
    const portfolios = await get(admin, '/ads/portfolios')
    expect(portfolios.items.map((item: Row) => item.name)).toContain('旺季组合')
  })

  it('再同步一次数据没变：不改任何行（同步时间不变），也不重复建', async () => {
    const before = await rows(`SELECT id, "syncedAt" FROM "AdsCampaign" ORDER BY id`)
    const result = await runSync(fakeApi(DATA))
    expect(result.changed).toBe(0)
    expect(result.imported).toBe(11)
    expect(await rows(`SELECT id, "syncedAt" FROM "AdsCampaign" ORDER BY id`)).toEqual(before)
    expect(await rows(`SELECT 1 FROM "AdsAdGroup"`)).toHaveLength(2)
    expect(await rows(`SELECT 1 FROM "AdsKeyword"`)).toHaveLength(2)
  })

  it('超预算预警由同步下来的投放状态触发；预算恢复后再同步，预警自动恢复；预警只在自己的企业里', async () => {
    await inTenant(otherTenantId, () => discover(tenantDb, { listAdsAccounts: async () => [{ adsAccountId: 'ACC-O', alternateIds: [{ profileId: 'P-O' }] }] }, otherTenantId))
    await inTenant(otherTenantId, () =>
      sync(ctx, {
        profile: { id: 'ap-o', tenantId: otherTenantId, adsAccountId: 'ACC-O', displayName: null, currencyCode: 'USD' },
        api: fakeApi({ campaigns: [campaign('C1', '对方的超预算活动', 'CAMPAIGN_OUT_OF_BUDGET', 5)] }),
        loadPortfolios: async () => [],
        now: new Date(),
      }),
    )
    await alertRun()
    const c2 = await idOf('AdsCampaign', 'externalCampaignId', 'C2')
    expect((await budgetAlerts(tenantId)).map(item => [item.entityId, item.status])).toEqual([[c2, 'NEW']])
    const theirs = await budgetAlerts(otherTenantId)
    expect(theirs).toHaveLength(1)
    expect(theirs[0]!.entityId).not.toBe(c2)
    const changed = { ...DATA, campaigns: [DATA.campaigns![0]!, campaign('C2', '超预算活动', 'CAMPAIGN_STATUS_ENABLED', 30), DATA.campaigns![2]!] }
    await runSync(fakeApi(changed))
    await alertRun()
    expect((await budgetAlerts(tenantId)).map(item => [item.entityId, item.status])).toEqual([[c2, 'AUTO_CLOSED']])
    expect((await budgetAlerts(otherTenantId)).map(item => item.status)).toEqual(['NEW'])
  })

  it('归档的保护：翻页没翻完不归档；接口返回空不归档；部分失败时其余部分照常写完，错误原样抛出且不误归档', async () => {
    const group = async (id: string) => (await rows<{ state: string }>(`SELECT state FROM "AdsAdGroup" WHERE "adGroupId" = $1`, [id]))[0]!.state
    const partial = await runSync(fakeApi({ ...DATA, adGroups: [DATA.adGroups![0]!] }, ['adGroups']))
    expect(partial.incompleteResources).toEqual(['adGroups'])
    expect(partial.tables.adGroups.archiveSkipped).toBe('INCOMPLETE')
    expect(await group('G2')).toBe('ENABLED')

    const empty = await runSync(fakeApi({}), async () => [])
    expect(empty.tables.campaigns.archiveSkipped).toBe('EMPTY_RESPONSE')
    expect(empty.tables.portfolios.archiveSkipped).toBe('EMPTY_RESPONSE')
    expect(await group('G2')).toBe('ENABLED')
    expect((await rows(`SELECT state FROM "AdsCampaign" WHERE "externalCampaignId" = 'C1'`))[0]!.state).toBe('ENABLED')

    await expect(
      runSync(fakeApi({ campaigns: [...DATA.campaigns!, campaign('C4', '新活动', 'CAMPAIGN_STATUS_ENABLED', 8)] }), async () => Promise.reject(new Error('portfolios 403'))),
    ).rejects.toThrow('portfolios 403')
    expect(await rows(`SELECT name FROM "AdsCampaign" WHERE "externalCampaignId" = 'C4'`)).toEqual([{ name: '新活动' }])
    expect((await rows(`SELECT status FROM "AdsPortfolio" WHERE "portfolioId" = 'PF1'`))[0]!.status).toBe('ENABLED')
  })

  it('任务分发：档案不属于本企业或没有账户编号是不重试的失败；有账户编号时用账户编号请求并落库', async () => {
    const deps = { prisma: tenantDb, logger } as unknown as Ctx
    const run = (profileId: string, client: unknown = {}) => inTenant(tenantId, () => processEntities(deps, client, { tenantId }, { adsProfileId: profileId }))
    await expect(run('ap-o')).rejects.toMatchObject({ code: 'ADS_ENTITY_PROFILE_MISSING' }) // 对方企业的档案
    await expect(run('nope')).rejects.toMatchObject({ code: 'ADS_ENTITY_PROFILE_MISSING' })
    await expect(run('ap-x')).rejects.toMatchObject({ code: 'ADS_ACCOUNT_MISSING' })
    await expect(inTenant(tenantId, () => processEntities(deps, {}, { tenantId }, {}))).rejects.toMatchObject({ code: 'ADS_ENTITY_PROFILE_MISSING' })
    const request = vi.fn(async ({ path }: { path: string; adsAccountId?: string }) =>
      path.endsWith('/query/campaigns') ? { campaigns: [campaign('CB1', '店铺 B 活动', 'CAMPAIGN_STATUS_ENABLED', 20)] } : {},
    )
    const result = await run('ap-b', { request, listPortfolios: vi.fn().mockResolvedValue([]) })
    expect(result).toMatchObject({ adsProfileId: 'ap-b', tables: { campaigns: { created: 1 } } })
    expect(request.mock.calls.every(call => call[0].adsAccountId === 'ACC-B')).toBe(true)
    expect(await rows(`SELECT "adsAccountId", name FROM "AdsCampaign" WHERE "adsProfileId" = 'ap-b'`)).toEqual([{ adsAccountId: 'ACC-B', name: '店铺 B 活动' }])
  })

  it('跨企业与数据范围：别的企业同编号的活动互不覆盖；对方成员和范围外的成员看不到、直接访问像不存在', async () => {
    expect((await rows(`SELECT name FROM "AdsCampaign" WHERE "tenantId" = $1 AND "externalCampaignId" = 'C1'`, [otherTenantId]))[0]!.name).toBe('对方的超预算活动')
    expect((await rows(`SELECT name FROM "AdsCampaign" WHERE "tenantId" = $1 AND "externalCampaignId" = 'C1'`, [tenantId]))[0]!.name).toBe('春季推广(新)')
    const theirs = await get(other, '/ads/campaigns')
    expect(theirs.items.map((item: Row) => item.name)).toEqual(['对方的超预算活动'])
    expect((await h.call(other.token, 'GET', '/ads/campaigns/cam-1')).status).toBe(404)
    expect((await get(scopedA, '/ads/campaigns')).items.map((item: Row) => item.name)).toContain('春季推广(新)')
    expect((await h.call(scopedB.token, 'GET', '/ads/campaigns/cam-1')).status).toBe(404)
    expect((await h.call(scopedB.token, 'GET', '/ads/campaigns/cam-1/ad-groups')).status).toBe(404)
    const groupId = await idOf('AdsAdGroup', 'adGroupId', 'G1')
    expect((await h.call(scopedB.token, 'GET', `/ads/ad-groups/${groupId}/negatives`)).status).toBe(404)
    expect((await get(scopedB, '/ads/campaigns')).items.map((item: Row) => item.name)).toEqual(['店铺 B 活动'])
  })
})
