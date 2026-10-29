import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告活动列表与详情（P3-07，真实数据库 + 完整应用）：列表的汇总指标（只含美元活动）、排序空值在后、筛选与翻页、数据范围（经广告档案绑定的店铺，未绑定账户只有“全部店铺”成员可见）、
// 企业隔离、详情与 12 个页签的可见性、搜索词已投放/已否定判定、建议规则、批量标签与负责人的乐观锁与整批全有或全无、忽略官方推荐。
// 汇总日期都落在昨天、前天（企业时区设为 UTC），所以不依赖现在是几点。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

describe('广告活动（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeA: string
  let storeB: string
  let otherTenantId: string
  let admin: Member
  let reader: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const patch = (member: Member, body: unknown) => h.call(member.token, 'PATCH', '/ads/campaigns/meta', { body })
  const idsOf = (data: Record<string, any>) => (data.items as Array<{ id: string }>).map(item => item.id)

  const account = (profile: string, tenant: string) =>
    insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })
  const campaign = (id: string, profile: string, external: string, name: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId: profile === 'ap-o' ? otherTenantId : tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const summary = (id: string, profile: string, external: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsDailySummary', { id, tenantId, adsProfileId: profile, adProduct: 'SPONSORED_PRODUCTS', campaignId: external, summaryDate: date, metricVersion: 'ads.v1', ...values })
  const term = (id: string, level: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsTermMetric', {
      id,
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      adProduct: 'SPONSORED_PRODUCTS',
      externalCampaignId: 'c1',
      level,
      reportDate: date,
      rowKey: id,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })

  beforeAll(async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    h = await createDbTestApp({ database: 'ads_campaigns' })
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
    await insertRow(h.client, 'AdsPortfolio', {
      id: 'pf-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      portfolioId: 'PF1',
      name: '春季组合',
      status: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    // 活动：cam-1 手动、日预算 100、属于组合 PF1；cam-2 自动；cam-sb 品牌推广（没有汇总）；cam-cad 加元（指标不折算）；cam-9 店铺 B；cam-f 未绑定；cam-o 别的企业
    await campaign('cam-1', 'ap-a', 'c1', '春季推广', { budget: 100, budgetType: 'DAILY', targetingType: 'MANUAL', portfolioId: 'PF1', servingStatus: 'CAMPAIGN_STATUS_ENABLED' })
    await campaign('cam-2', 'ap-a', 'c2', '清仓 自动', { budget: 30, budgetType: 'DAILY', targetingType: 'AUTO', state: 'PAUSED' })
    await campaign('cam-sb', 'ap-a', 'c3', '品牌旗舰', { adProduct: 'SPONSORED_BRANDS', budget: 50, budgetType: 'DAILY' })
    await campaign('cam-cad', 'ap-a', 'c4', '加元活动', { currency: 'CAD', budget: 10, budgetType: 'DAILY' })
    await campaign('cam-9', 'ap-b', 'c9', '店铺 B 活动', { budget: 20, budgetType: 'DAILY' })
    await campaign('cam-f', 'ap-free', 'cf1', '未绑定活动', { budget: 10, budgetType: 'DAILY' })
    await campaign('cam-o', 'ap-o', 'co1', '别的企业活动')

    // 汇总（美元）：cam-1 两天合计花费 60、销售额 200、订单 6；cam-2 花费 30 没有成交；cam-9 花费 5；cam-f 花费 3；cam-cad 有加元汇总但不并入
    await summary('sm1', 'ap-a', 'c1', dayText(-1), { impressions: 1000, clicks: 50, spend: 40, sales: 160, orders: 5 })
    await summary('sm2', 'ap-a', 'c1', dayText(-2), { impressions: 500, clicks: 25, spend: 20, sales: 40, orders: 1 })
    await summary('sm3', 'ap-a', 'c2', dayText(-1), { impressions: 800, clicks: 40, spend: 30, sales: 0, orders: 0 })
    await summary('sm4', 'ap-b', 'c9', dayText(-1), { impressions: 100, clicks: 5, spend: 5, sales: 10, orders: 1 })
    await summary('sm5', 'ap-free', 'cf1', dayText(-1), { impressions: 50, clicks: 3, spend: 3, sales: null, orders: 0 })
    await summary('sm6', 'ap-a', 'c4', dayText(-1), { impressions: 10, clicks: 1, spend: 1, sales: 2, orders: 1, currency: 'CAD' })

    // 广告组、投放对象、词级报表、否定词
    await insertRow(h.client, 'AdsAdGroup', {
      id: 'ag-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      adGroupId: 'AG1',
      campaignId: 'c1',
      name: '核心词组',
      state: 'ENABLED',
      defaultBid: 1.2,
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsKeyword', {
      id: 'kw-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      keywordId: 'K1',
      campaignId: 'c1',
      adGroupId: 'AG1',
      text: 'yoga mat',
      matchType: 'EXACT',
      bid: 1.5,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsNegativeTarget', {
      id: 'neg-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      negativeId: 'N1',
      level: 'CAMPAIGN',
      campaignId: 'c1',
      expression: 'cheap yoga mat',
      matchType: 'NEGATIVE_EXACT',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await term('t1', 'SEARCH_TERM', dayText(-1), { searchTerm: 'Yoga  Mat', impressions: 900, clicks: 30, cost: 12, sales: 90, purchases: 3 })
    await term('t2', 'SEARCH_TERM', dayText(-1), { searchTerm: 'cheap yoga mat', impressions: 400, clicks: 40, cost: 25, sales: 0, purchases: 0 })
    await term('t3', 'SEARCH_TERM', dayText(-2), { searchTerm: 'yoga block', impressions: 100, clicks: 5, cost: 4, sales: 0, purchases: 0 })
    await term('t4', 'KEYWORD', dayText(-1), { keywordId: 'K1', keywordText: 'yoga mat', matchType: 'EXACT', impressions: 1000, clicks: 30, cost: 30, sales: 0, purchases: 0 })

    // 被推广商品与库存快照：B0AAA 在店铺 A 没货，仍在花钱
    await insertRow(h.client, 'AdsAdvertisedProductMetric', {
      id: 'ad1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      campaignId: 'c1',
      advertisedAsin: 'B0AAA',
      reportDate: dayText(-1),
      spend: 12,
      clicks: 10,
      sourceUpdatedAt: new Date().toISOString(),
    })
    await insertRow(h.client, 'InventoryDailySnapshot', {
      id: 'sn1',
      tenantId,
      sellerAccountId: storeA,
      snapshotDate: dayText(-1),
      sku: 'SKU-1',
      asin: 'B0AAA',
      sellable: 0,
      source: 'API',
      sourceUpdatedAt: new Date().toISOString(),
    })

    // 官方推荐：cam-1 一条待处理；cam-9（店铺 B）一条
    await insertRow(h.client, 'AdsRecommendation', {
      id: 'rec-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      recommendationId: 'R1',
      type: 'BUDGET_RULE',
      entityType: 'CAMPAIGN',
      entityId: 'c1',
      payloadJson: { title: '建议提高预算', suggestedBudget: 150 },
      status: 'NEW',
      receivedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })
    await insertRow(h.client, 'AdsRecommendation', {
      id: 'rec-9',
      tenantId,
      adsProfileId: 'ap-b',
      adsAccountId: 'ACC-ap-b',
      recommendationId: 'R9',
      type: 'BUDGET_RULE',
      entityType: 'CAMPAIGN',
      entityId: 'c9',
      payloadJson: { title: '店铺 B 推荐' },
      status: 'NEW',
      receivedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })

    const read = ['ads.read']
    const write = ['ads.read', 'ads.campaign.write']
    admin = await h.createMember(tenantId, 'admin', write)
    reader = await h.createMember(tenantId, 'reader', read)
    scopedA = await h.createMember(tenantId, 'scopeda', write, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', write, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', write)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  describe('列表', () => {
    it('没有 ads.read 返回 403；全部店铺成员看到本企业全部活动，别的企业的看不到', async () => {
      expect((await h.call(noAds.token, 'GET', '/ads/campaigns')).status).toBe(403)
      const data = await get(admin, '/ads/campaigns')
      expect(idsOf(data).sort()).toEqual(['cam-1', 'cam-2', 'cam-9', 'cam-cad', 'cam-f', 'cam-sb'])
      expect((await get(other, '/ads/campaigns')).items.map((item: { id: string }) => item.id)).toEqual(['cam-o'])
    })

    it('指标：来自广告日汇总；没有汇总行与非美元活动的指标是 null，不是 0', async () => {
      const data = await get(admin, '/ads/campaigns')
      const byId = new Map<string, any>(data.items.map((item: { id: string }) => [item.id, item]))
      expect(byId.get('cam-1')).toMatchObject({ name: '春季推广', portfolioName: '春季组合', targetingType: 'MANUAL', totals: { spend: 60, sales: 200, orders: 6, clicks: 75, impressions: 1500 } })
      expect(byId.get('cam-1').ratios.acos).toBeCloseTo(0.3, 9)
      expect(byId.get('cam-1').ratios.roas).toBeCloseTo(200 / 60, 9)
      expect(byId.get('cam-2').totals).toMatchObject({ spend: 30, orders: 0 })
      expect(byId.get('cam-sb').totals).toBeNull()
      expect(byId.get('cam-cad').totals).toBeNull()
      expect(byId.get('cam-f').totals.sales).toBeNull()
      expect(data.currency).toBe('USD')
      expect(data.note).toContain('美元')
      expect(data.avgOverBudget.state).toBe('NOT_CONNECTED')
      expect(data.write.state).toBe('NOT_CONNECTED')
    })

    it('默认按花费降序，没有指标的活动排在最后（升序也是）', async () => {
      const desc = idsOf(await get(admin, '/ads/campaigns'))
      expect(desc.slice(0, 4)).toEqual(['cam-1', 'cam-2', 'cam-9', 'cam-f'])
      expect(new Set(desc.slice(4))).toEqual(new Set(['cam-sb', 'cam-cad']))
      const asc = idsOf(await get(admin, '/ads/campaigns?sort=spend:asc'))
      expect(asc.slice(0, 4)).toEqual(['cam-f', 'cam-9', 'cam-2', 'cam-1'])
    })

    it('筛选：广告产品、状态、名称包含与不包含、广告组合；参数不合法返回 422', async () => {
      expect(idsOf(await get(admin, '/ads/campaigns?adProduct=SPONSORED_BRANDS'))).toEqual(['cam-sb'])
      expect(idsOf(await get(admin, '/ads/campaigns?state=paused'))).toEqual(['cam-2'])
      expect(idsOf(await get(admin, '/ads/campaigns?q=推广'))).toEqual(['cam-1'])
      expect(idsOf(await get(admin, '/ads/campaigns?q=活动&qMode=excludes'))).toEqual(expect.not.arrayContaining(['cam-9', 'cam-cad', 'cam-f']))
      expect(idsOf(await get(admin, '/ads/campaigns?portfolioId=PF1'))).toEqual(['cam-1'])
      expect((await h.call(admin.token, 'GET', '/ads/campaigns?sort=password')).status).toBe(422)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns?from=2026-10-10&to=2026-10-01')).status).toBe(422)
    })

    it('筛选下拉给出可见范围内的广告组合', async () => {
      expect((await get(admin, '/ads/campaigns')).filterOptions.portfolios).toEqual([{ id: 'PF1', name: '春季组合' }])
    })

    it('翻页：游标绑定查询条件，换条件或篡改都不能用', async () => {
      const first = await get(admin, '/ads/campaigns?pageSize=2')
      expect(first.items).toHaveLength(2)
      expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 6 })
      const second = await get(admin, `/ads/campaigns?pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(idsOf(second)).toEqual(['cam-9', 'cam-f'])
      const reused = await h.call(admin.token, 'GET', `/ads/campaigns?pageSize=2&sort=name:asc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(reused.status).toBe(400)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns?cursor=garbage')).status).toBe(400)
    })

    it('数据范围：受限成员只看到绑定到自己店铺的活动；未绑定账户的活动只有“全部店铺”成员看得到', async () => {
      expect(idsOf(await get(scopedA, '/ads/campaigns')).sort()).toEqual(['cam-1', 'cam-2', 'cam-cad', 'cam-sb'])
      expect(idsOf(await get(scopedB, '/ads/campaigns'))).toEqual(['cam-9'])
    })

    it('可写者才返回可指派的在职成员；只读成员 canWrite 为 false', async () => {
      const writer = await get(admin, '/ads/campaigns')
      expect(writer.canWrite).toBe(true)
      expect(writer.members.length).toBeGreaterThan(0)
      const readOnly = await get(reader, '/ads/campaigns')
      expect(readOnly).toMatchObject({ canWrite: false, members: [] })
    })

    it('没有任何活动的企业：尚未接入；有活动但筛选没命中：尚无记录', async () => {
      const lonely = await h.createTenant('lonely')
      const member = await h.createMember(lonely.tenantId, 'lonely', ['ads.read'])
      expect(await get(member, '/ads/campaigns')).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
      expect(await get(admin, '/ads/campaigns?q=不存在的名字')).toMatchObject({ state: 'NO_DATA', items: [] })
    })
  })

  describe('详情与页签', () => {
    it('详情：身份、指标、建议规则、页签；创意只有品牌推广与展示型推广', async () => {
      const data = await get(admin, '/ads/campaigns/cam-1')
      expect(data.identity).toMatchObject({ id: 'cam-1', name: '春季推广', budget: 100, portfolio: { id: 'PF1', name: '春季组合' }, account: { storeName: expect.any(String) }, version: 1 })
      expect(data.identity.placementAdjustments.state).toBe('NOT_CONNECTED')
      expect(data.metrics.totals).toMatchObject({ spend: 60, sales: 200 })
      expect(data.advice.map((rule: { kind: string }) => rule.kind)).toEqual(['RAISE_BUDGET', 'WASTED_TARGETS', 'OFFICIAL_RECOMMENDATION', 'STOCKOUT_PRODUCTS'])
      expect(data.tabs.map((tab: { key: string }) => tab.key)).not.toContain('creatives')
      expect(data.tabs).toHaveLength(10)
      const brand = await get(admin, '/ads/campaigns/cam-sb')
      expect(brand.tabs.map((tab: { key: string }) => tab.key)).toContain('creatives')
      expect(brand.metrics.totals).toBeNull()
    })

    it('范围外与别的企业的活动像不存在一样返回 404；页签同样', async () => {
      expect((await h.call(scopedB.token, 'GET', '/ads/campaigns/cam-1')).status).toBe(404)
      expect((await h.call(scopedB.token, 'GET', '/ads/campaigns/cam-1/search-terms')).status).toBe(404)
      expect((await h.call(other.token, 'GET', '/ads/campaigns/cam-1')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-o')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/not-exist')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-f')).status).toBe(200)
      expect((await h.call(scopedA.token, 'GET', '/ads/campaigns/cam-f')).status).toBe(404)
    })

    it('不适用的页签返回 404：搜索结果以外，创意属于品牌推广、受众属于展示型推广', async () => {
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-1/creatives')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-sb/audiences')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-sb/creatives')).status).toBe(200)
    })

    it('搜索词：汇总并判定已投放与已否定（完全相同才算，不分大小写与空格）；状态筛选可用', async () => {
      const data = await get(admin, '/ads/campaigns/cam-1/search-terms')
      const rows = new Map<string, any>(data.items.map((item: { searchTerm: string }) => [item.searchTerm, item]))
      expect(rows.get('cheap yoga mat')).toMatchObject({ status: 'NEGATED', metrics: { spend: 25, clicks: 40, orders: 0 } })
      expect(rows.get('Yoga  Mat')).toMatchObject({ status: 'TARGETED', metrics: { spend: 12, orders: 3 } })
      expect(rows.get('yoga block')).toMatchObject({ status: 'UNTARGETED' })
      const negated = await get(admin, '/ads/campaigns/cam-1/search-terms?status=NEGATED')
      expect(negated.items.map((item: { searchTerm: string }) => item.searchTerm)).toEqual(['cheap yoga mat'])
      expect(data.matchBasis).toContain('完全相同')
    })

    it('没有词级报表的活动：搜索词页签是尚未接入或尚无记录，不是空表装作有数据', async () => {
      const data = await get(admin, '/ads/campaigns/cam-2/search-terms')
      expect(data.items).toEqual([])
      expect(['NOT_CONNECTED', 'NO_DATA']).toContain(data.state)
    })

    it('广告组、投放对象、广告商品（带库存判断）', async () => {
      expect((await get(admin, '/ads/campaigns/cam-1/ad-groups')).items[0]).toMatchObject({ adGroupId: 'AG1', name: '核心词组', defaultBid: 1.2 })
      const targets = await get(admin, '/ads/campaigns/cam-1/targets')
      expect(targets.items[0]).toMatchObject({ expression: 'yoga mat', matchType: 'EXACT', bid: 1.5 })
      const products = await get(admin, '/ads/campaigns/cam-1/products')
      expect(products.items[0]).toMatchObject({ asin: 'B0AAA', sellable: 0, stock: 'OUT_OF_STOCK', metrics: { spend: 12 } })
    })

    it('建议规则：投放词花费高无订单命中；断货仍在投放命中；官方推荐命中；提预算因缺预算消耗数据是“尚未接入”', async () => {
      const advice = (await get(admin, '/ads/campaigns/cam-1')).advice as Array<{ kind: string; state: string; hits: Array<{ id: string; title: string; recommendationId: string | null }> }>
      const byKind = new Map(advice.map(rule => [rule.kind, rule]))
      expect(byKind.get('RAISE_BUDGET')!.state).toBe('NOT_CONNECTED')
      expect(byKind.get('WASTED_TARGETS')).toMatchObject({ state: 'HIT' })
      expect(byKind.get('WASTED_TARGETS')!.hits[0]!.title).toContain('yoga mat')
      expect(byKind.get('STOCKOUT_PRODUCTS')).toMatchObject({ state: 'HIT' })
      expect(byKind.get('STOCKOUT_PRODUCTS')!.hits[0]!.id).toBe('stockout:B0AAA')
      expect(byKind.get('OFFICIAL_RECOMMENDATION')!.hits[0]!.recommendationId).toBe('rec-1')
      // 没有词级报表、被推广商品、推荐的活动：同一企业别处有数据，所以是“没命中”而不是“尚未接入”
      const quiet = (await get(admin, '/ads/campaigns/cam-2')).advice as Array<{ kind: string; state: string }>
      expect(quiet.find(rule => rule.kind === 'WASTED_TARGETS')!.state).toBe('NO_HIT')
      expect(quiet.find(rule => rule.kind === 'OFFICIAL_RECOMMENDATION')!.state).toBe('NO_HIT')
    })

    it('分时表现：数据流已配置时按星期 × 小时累加；未配置时是“尚未接入”', async () => {
      await insertRow(h.client, 'AdsPerformanceHourly', {
        id: 'hr-1',
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        entityType: 'CAMPAIGN',
        entityId: 'c1',
        hourStart: `${dayText(-1)}T10:00:00Z`,
        clicks: 9,
        spend: 4,
        sales: 20,
        orders: 2,
        sourceUpdatedAt: new Date().toISOString(),
      })
      const live = await get(admin, '/ads/campaigns/cam-1/hourly')
      expect(live.streamConnected).toBe(true)
      expect(live.cells).toHaveLength(1)
      expect(live.cells[0]).toMatchObject({ hour: 10, spend: 4, clicks: 9, orders: 2, samples: 1 })
      vi.stubEnv('AMAZON_ADS_STREAM_SINK', '')
      try {
        const off = await get(admin, '/ads/campaigns/cam-1/hourly')
        expect(off).toMatchObject({ state: 'NOT_CONNECTED', streamConnected: false, cells: [] })
      } finally {
        vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
      }
    })

    it('表现趋势按天给点；预测与推荐、操作记录页签可读', async () => {
      const trend = await get(admin, '/ads/campaigns/cam-1/trend')
      expect(trend.points.find((point: { date: string }) => point.date === dayText(-1))).toMatchObject({ spend: 40, sales: 160 })
      expect(trend.amazonEvents.state).toBe('NOT_CONNECTED')
      expect((await get(admin, '/ads/campaigns/cam-1/recommendations')).items[0]).toMatchObject({ id: 'rec-1', status: 'NEW', suggestedBudget: 150 })
      expect(await get(admin, '/ads/campaigns/cam-1/forecast')).toHaveProperty('items')
      expect(await get(admin, '/ads/campaigns/cam-1/changes')).toHaveProperty('amazonSide')
    })
  })

  describe('批量标签与负责人', () => {
    it('没有写权限 403（先于参数校验）；只读成员也不行', async () => {
      expect((await patch(reader, {})).status).toBe(403)
      expect((await patch(noAds, { items: [{ id: 'cam-1', version: 1 }], ownerId: null })).status).toBe(403)
    })

    it('参数不合法：没改任何东西、版本缺失返回 422；标签含逗号、同一活动重复返回 409', async () => {
      expect((await patch(admin, { items: [{ id: 'cam-1', version: 1 }] })).status).toBe(422)
      expect((await patch(admin, { items: [{ id: 'cam-1' }], ownerId: null })).status).toBe(422)
      expect((await patch(admin, { items: [{ id: 'cam-1', version: 1 }], tags: { mode: 'ADD', values: ['a,b'] } })).status).toBe(409)
      expect(
        (
          await patch(admin, {
            items: [
              { id: 'cam-1', version: 1 },
              { id: 'cam-1', version: 1 },
            ],
            ownerId: null,
          })
        ).status,
      ).toBe(409)
    })

    it('追加标签并指派负责人：版本加一，审计与变更记录各写一条；列表可按标签与负责人筛选', async () => {
      const res = await patch(admin, {
        items: [
          { id: 'cam-1', version: 1 },
          { id: 'cam-2', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['主推', '春季'] },
        ownerId: admin.userId,
      })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
      expect(res.json.data).toMatchObject({ updated: 2, unchanged: 0 })
      expect(res.json.data.items.find((item: { id: string }) => item.id === 'cam-1')).toMatchObject({ version: 2, tags: ['主推', '春季'], ownerId: admin.userId })
      const audits = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "action" = 'ADS_CAMPAIGN_META_UPDATED' AND "result" = 'SUCCEEDED' AND "tenantId" = $1`, [tenantId])
      expect(audits.rows[0].n).toBe(2)
      const events = await h.client.query(`SELECT "title" FROM "EntityEvent" WHERE "entityType" = 'ADS_CAMPAIGN' AND "entityId" = 'cam-1'`)
      expect(events.rows).toHaveLength(1)
      expect(events.rows[0].title).toContain('主推')
      expect(idsOf(await get(admin, '/ads/campaigns?tag=主推')).sort()).toEqual(['cam-1', 'cam-2'])
      expect(idsOf(await get(admin, `/ads/campaigns?ownerId=${admin.userId}`)).sort()).toEqual(['cam-1', 'cam-2'])
      const changes = await get(admin, '/ads/campaigns/cam-1/changes')
      expect(changes.items[0]).toMatchObject({ source: 'manual' })
      expect(changes.items[0].title).toContain('标签')
      expect((await get(admin, '/ads/campaigns/cam-1')).identity).toMatchObject({ version: 2, tags: ['主推', '春季'], owner: { id: admin.userId } })
    })

    it('版本已被推进：409，整批没有修改', async () => {
      const res = await patch(admin, {
        items: [
          { id: 'cam-9', version: 1 },
          { id: 'cam-1', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['冲突'] },
      })
      expect(res.status).toBe(409)
      expect(idsOf(await get(admin, '/ads/campaigns?tag=冲突'))).toEqual([])
    })

    it('整批全有或全无：含范围外活动时 404，其他活动也不生效', async () => {
      const res = await patch(scopedA, {
        items: [
          { id: 'cam-sb', version: 1 },
          { id: 'cam-9', version: 1 },
        ],
        tags: { mode: 'ADD', values: ['越权'] },
      })
      expect(res.status).toBe(404)
      expect(idsOf(await get(admin, '/ads/campaigns?tag=越权'))).toEqual([])
      expect((await patch(other, { items: [{ id: 'cam-sb', version: 1 }], tags: { mode: 'ADD', values: ['越权'] } })).status).toBe(404)
    })

    it('负责人必须是本企业在职成员；移除标签与清空负责人；没有变化的活动不涨版本', async () => {
      expect((await patch(admin, { items: [{ id: 'cam-sb', version: 1 }], ownerId: other.userId })).status).toBe(409)
      const unchanged = await patch(admin, { items: [{ id: 'cam-1', version: 2 }], tags: { mode: 'ADD', values: ['主推'] } })
      expect(unchanged.json.data).toMatchObject({ updated: 0, unchanged: 1 })
      expect(unchanged.json.data.items[0].version).toBe(2)
      const cleared = await patch(admin, { items: [{ id: 'cam-1', version: 2 }], tags: { mode: 'REMOVE', values: ['春季'] }, ownerId: null })
      expect(cleared.json.data.items[0]).toMatchObject({ version: 3, tags: ['主推'], ownerId: null })
    })
  })

  describe('忽略官方推荐', () => {
    const dismiss = (member: Member, id: string, body: unknown) => h.call(member.token, 'POST', `/ads/recommendations/${id}/dismiss`, { body })

    it('先校验权限再校验参数：没有写权限 403；原因太短 422', async () => {
      expect((await dismiss(reader, 'rec-1', { reason: '不适用于本活动' })).status).toBe(403)
      expect((await dismiss(admin, 'rec-1', { reason: '短' })).status).toBe(422)
    })

    it('范围外的推荐像不存在一样返回 404', async () => {
      expect((await dismiss(scopedA, 'rec-9', { reason: '不适用于本活动' })).status).toBe(404)
      expect((await dismiss(other, 'rec-1', { reason: '不适用于本活动' })).status).toBe(404)
    })

    it('忽略成功后状态变为已忽略并写审计；再次忽略 409；建议规则不再命中', async () => {
      const res = await dismiss(admin, 'rec-1', { reason: '这个活动预算已经够用' })
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect((await dismiss(admin, 'rec-1', { reason: '再忽略一次' })).status).toBe(409)
      const row = await h.client.query(`SELECT "status", "decidedBy" FROM "AdsRecommendation" WHERE "id" = 'rec-1'`)
      expect(row.rows[0]).toMatchObject({ status: 'IGNORED', decidedBy: admin.userId })
      const audits = await h.client.query(`SELECT count(*)::int AS n FROM "AuditEvent" WHERE "action" = 'ADS_RECOMMENDATION_DISMISSED' AND "result" = 'SUCCEEDED'`)
      expect(audits.rows[0].n).toBe(1)
      const rules = (await get(admin, '/ads/campaigns/cam-1')).advice as Array<{ kind: string; state: string }>
      expect(rules.find(rule => rule.kind === 'OFFICIAL_RECOMMENDATION')!.state).toBe('NO_HIT')
      expect((await get(admin, '/ads/campaigns/cam-1/recommendations')).items[0]).toMatchObject({ status: 'IGNORED' })
    })
  })
})
