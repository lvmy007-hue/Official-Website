import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 今日广告（P3-06，真实数据库 + 完整应用）：小时指标的真实聚合（只取活动级美元行）、数据范围过滤（经广告档案绑定的店铺）、未绑定账户只有“全部店铺”成员可见、
// 企业隔离、预算与超预算状态、异常、断货仍在投放（被推广商品 × 库存快照）、接收端未配置时退化展示日报表。
// 用真实时钟：小时指标都落在“当前这一小时”（企业时区设为 UTC，必然是今天），断言只依赖这些数，不依赖现在是几点。

type Member = { userId: string; token: string }
const HOUR = 3_600_000
const hourStart = (offsetHours: number) => new Date(Math.floor(Date.now() / HOUR) * HOUR + offsetHours * HOUR).toISOString()
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * 24 * HOUR).toISOString().slice(0, 10)

describe('今日广告（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let otherTenantId: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member

  const today = async (member: Member, query = '') => {
    const res = await h.call(member.token, 'GET', `/ads/today${query}`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }

  const account = (profile: string, tenant: string) =>
    insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })
  const hourly = (id: string, profile: string, entity: string, offset: number, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsPerformanceHourly', {
      id,
      tenantId: profile === 'ap-o' ? otherTenantId : tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      entityType: 'CAMPAIGN',
      entityId: entity,
      hourStart: hourStart(offset),
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const campaign = (id: string, profile: string, external: string, name: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId,
      adsProfileId: profile,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const advertised = (id: string, profile: string, campaignId: string, asin: string, date: string, spend: number, tenant = tenantId) =>
    insertRow(h.client, 'AdsAdvertisedProductMetric', {
      id,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      campaignId,
      advertisedAsin: asin,
      reportDate: date,
      spend,
      sourceUpdatedAt: new Date().toISOString(),
    })
  const snapshot = (id: string, store: string, asin: string, sellable: number | null) =>
    insertRow(h.client, 'InventoryDailySnapshot', {
      id,
      tenantId,
      sellerAccountId: store,
      snapshotDate: dayText(-1),
      sku: `SKU-${id}`,
      asin,
      sellable,
      source: 'API',
      sourceUpdatedAt: new Date().toISOString(),
    })
  const summary = (id: string, profile: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsDailySummary', { id, tenantId, adsProfileId: profile, adProduct: 'SPONSORED_PRODUCTS', campaignId: 'c1', summaryDate: date, metricVersion: 'ads.v1', ...values })

  beforeAll(async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    h = await createDbTestApp({ database: 'ads_today' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)

    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P-F' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const profile of ['ap-a', 'ap-b', 'ap-free']) await account(profile, tenantId)
    await account('ap-o', otherTenantId)

    // 当前这一小时：店铺 A 两个活动、店铺 B 一个活动、未绑定账户一个活动、别的企业一个活动；加上不该被算进去的行
    await hourly('h1', 'ap-a', 'c1', 0, { impressions: 900, clicks: 20, spend: 14, sales: 40, orders: 1 })
    await hourly('h2', 'ap-a', 'c2', 0, { impressions: 700, clicks: 30, spend: 25, sales: 0, orders: 0 })
    await hourly('h3', 'ap-b', 'c9', 0, { impressions: 100, clicks: 5, spend: 5, sales: 10, orders: 1 })
    await hourly('h4', 'ap-free', 'cf1', 0, { impressions: 50, clicks: 3, spend: 3, sales: null, orders: 0 })
    await hourly('h5', 'ap-o', 'co1', 0, { impressions: 9, clicks: 9, spend: 999, sales: 999, orders: 9 })
    await hourly('h6', 'ap-a', 'g1', 0, { entityType: 'AD_GROUP', impressions: 5000, clicks: 500, spend: 99, sales: 99, orders: 9 })
    await hourly('h7', 'ap-a', 'c1', 0, { entityId: 'c1x', currency: 'CAD', clicks: 7, spend: 7 })
    // 昨天同一时刻与三天前：对比与单次点击成本基线
    await hourly('h8', 'ap-a', 'c1', -24, { impressions: 400, clicks: 10, spend: 6, sales: 12, orders: 0 })
    await hourly('h9', 'ap-a', 'c1', -72, { impressions: 2000, clicks: 100, spend: 40, sales: 120, orders: 5 })

    // 活动：c1 日预算 100，c2 日预算 30（投放状态预算用完），c9 日预算 20，cf1 日预算 10（未绑定账户），已暂停的 c3 不算
    await campaign('cam-1', 'ap-a', 'c1', '春季推广', { budget: 100, budgetType: 'DAILY', servingStatus: 'CAMPAIGN_STATUS_ENABLED' })
    await campaign('cam-2', 'ap-a', 'c2', '清仓', { budget: 30, budgetType: 'DAILY', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
    await campaign('cam-3', 'ap-a', 'c3', '已暂停', { budget: 50, budgetType: 'DAILY', state: 'PAUSED', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
    await campaign('cam-9', 'ap-b', 'c9', '店铺 B 活动', { budget: 20, budgetType: 'DAILY', servingStatus: 'CAMPAIGN_STATUS_ENABLED' })
    await campaign('cam-f', 'ap-free', 'cf1', '未绑定活动', { budget: 10, budgetType: 'DAILY' })

    // 被推广商品（昨天）与库存快照（昨天，接口来源）：店铺 A 的 B0AAA 没货、店铺 B 的 B0BBB 有货、未绑定账户的 B0FFF 对不上库存
    await advertised('ad1', 'ap-a', 'c1', 'B0AAA', dayText(-1), 12)
    await advertised('ad2', 'ap-a', 'c1', 'B0AAA', dayText(-2), 6)
    await advertised('ad3', 'ap-b', 'c9', 'B0BBB', dayText(-1), 8)
    await advertised('ad4', 'ap-free', 'cf1', 'B0FFF', dayText(-1), 9)
    await advertised('ad5', 'ap-o', 'co1', 'B0AAA', dayText(-1), 77, otherTenantId)
    await snapshot('sn1', storeA, 'B0AAA', 0)
    await snapshot('sn2', storeB, 'B0BBB', 10)

    // 日报表汇总（接收端未配置时退化展示）：最近一天是昨天
    await summary('sm1', 'ap-a', dayText(-1), { impressions: 1000, clicks: 50, spend: 40, sales: 160, orders: 5 })
    await summary('sm2', 'ap-b', dayText(-1), { impressions: 500, clicks: 30, spend: 20, sales: 60, orders: 2 })
    await summary('sm3', 'ap-a', dayText(-2), { impressions: 9000, clicks: 900, spend: 900, sales: 900, orders: 90 })

    const read = ['ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', read)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('全部店铺成员：今日合计只含活动级美元行（广告组行、其他币种、别的企业都不算）；其他币种单独列出', async () => {
    const data = await today(admin)
    expect(data.streamState).toBe('LIVE')
    expect(data.businessDate).toBe(dayText(0))
    expect(data.totals.value).toMatchObject({ spend: 47, clicks: 58, impressions: 1750, sales: 50, orders: 2 })
    expect(data.totals.value.cpc).toBeCloseTo(47 / 58, 9)
    expect(data.otherCurrencies).toEqual([{ currency: 'CAD', spend: 7 }])
    expect(data.fallback).toBeNull()
    expect(data.asOf).toBeTruthy()
    // 昨天截至同一时刻只有那一条小时指标
    expect(data.totals.yesterdaySameHour).toMatchObject({ spend: 6, clicks: 10 })
  })

  it('小时曲线：24 个小时，当前小时有数，未到的小时是空位', async () => {
    const data = await today(admin)
    const items = data.hours.items as Array<{ hourStart: string; elapsed: boolean; spend: number | null }>
    expect(items).toHaveLength(24)
    const current = items.find(item => item.hourStart === hourStart(0))!
    expect(current).toMatchObject({ elapsed: true, spend: 47 })
    expect(items.filter(item => item.spend !== null)).toHaveLength(1)
    for (const item of items.filter(item => !item.elapsed)) expect(item.spend).toBeNull()
  })

  it('范围过滤：受限成员只看到绑定到自己店铺的广告账户；未绑定账户与别的店铺的看不到', async () => {
    expect((await today(scopedA)).totals.value).toMatchObject({ spend: 39, clicks: 50 })
    expect((await today(scopedB)).totals.value).toMatchObject({ spend: 5, clicks: 5 })
    expect((await today(scopedA)).otherCurrencies).toEqual([{ currency: 'CAD', spend: 7 }])
    expect((await today(scopedB)).otherCurrencies).toEqual([])
  })

  it('预算：当前日预算 × 今日花费；已暂停的活动、没同步预算类型的活动不算；受限成员只含自己店铺', async () => {
    const all = (await today(admin)).budget
    expect(all).toMatchObject({ state: 'OK', dailyBudgetTotal: 160, spentToday: 47, budgetedCampaigns: 4, ambiguous: 0 })
    expect(all.progress).toBeCloseTo(47 / 160, 9)
    const c2 = all.rows.find((row: { campaignId: string }) => row.campaignId === 'c2')
    expect(c2).toMatchObject({ name: '清仓', dailyBudget: 30, spend: 25 })
    expect(c2.progress).toBeCloseTo(25 / 30, 9)
    const a = (await today(scopedA)).budget
    expect(a).toMatchObject({ dailyBudgetTotal: 130, spentToday: 39, budgetedCampaigns: 2 })
    expect((await today(scopedB)).budget).toMatchObject({ dailyBudgetTotal: 20, spentToday: 5, budgetedCampaigns: 1 })
  })

  it('超预算状态来自活动管理的投放状态：只算启用中的活动；没同步过投放状态的范围是“尚无记录”', async () => {
    const all = (await today(admin)).outOfBudget
    expect(all).toMatchObject({ state: 'OK', count: 1 })
    expect(all.rows[0]).toMatchObject({ campaignId: 'c2', name: '清仓', servingStatus: 'CAMPAIGN_OUT_OF_BUDGET' })
    expect((await today(scopedB)).outOfBudget).toMatchObject({ state: 'OK', count: 0 })
  })

  it('异常：花费无转化与单次点击成本突增，活动名来自活动管理；受限成员只看到自己范围的活动', async () => {
    const data = (await today(admin)).anomalies
    const pairs = data.items.map((item: { campaignId: string; kind: string; name: string }) => [item.campaignId, item.kind, item.name])
    expect(pairs).toContainEqual(['c2', 'SPEND_NO_CONVERSION', '清仓'])
    expect(pairs).toContainEqual(['c1', 'CPC_SURGE', '春季推广'])
    expect(data.items.find((item: { kind: string }) => item.kind === 'CPC_SURGE')).toMatchObject({ spend: 14, clicks: 20 })
    expect((await today(scopedB)).anomalies.count).toBe(0)
  })

  it('断货仍在投放：近 3 天有花费、最近一次库存快照可售为 0 的商品；日均浪费 = 花费 ÷ 有花费的天数；没绑定店铺的花费对不上库存', async () => {
    const all = (await today(admin)).stockout
    expect(all.state).toBe('OK')
    expect(all.items).toHaveLength(1)
    expect(all.items[0]).toMatchObject({ asin: 'B0AAA', sellerAccountId: storeA, sellable: 0, spend: 18, days: 2, dailyWaste: 9 })
    expect(all.note).toContain('没有绑定店铺')
    expect((await today(scopedA)).stockout.items).toHaveLength(1)
    expect((await today(scopedB)).stockout).toMatchObject({ state: 'OK', items: [] })
  })

  it('接收端未配置：不显示今日数字，退化展示最近一天的日报表汇总（只含该成员范围）；预算外的区块照常', async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
    try {
      const data = await today(admin)
      expect(data.streamState).toBe('NOT_CONNECTED')
      expect(data.totals).toMatchObject({ state: 'NOT_CONNECTED', value: null })
      expect(data.hours.items).toEqual([])
      expect(data.fallback.summaryDate).toBe(dayText(-1))
      expect(data.fallback.totals).toMatchObject({ spend: 60, clicks: 80, sales: 220, orders: 7 })
      expect((await today(scopedB)).fallback.totals).toMatchObject({ spend: 20, clicks: 30 })
      expect(data.budget).toMatchObject({ state: 'NOT_CONNECTED', rows: [], dailyBudgetTotal: 160 })
      expect(data.outOfBudget.count).toBe(1)
      expect(data.stockout.items).toHaveLength(1)
    } finally {
      vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    }
  })

  it('没有 ads.read 403；别的企业的成员只看到自己企业的数据', async () => {
    expect((await h.call(noAds.token, 'GET', '/ads/today')).status).toBe(403)
    const mine = await today(other)
    expect(mine.totals.value).toMatchObject({ spend: 999, clicks: 9 })
    expect(mine.budget.state).toBe('NO_DATA')
    expect(mine.stockout.items).toEqual([])
  })
})
