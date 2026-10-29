import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告组与投放对象详情（P3-08，真实数据库 + 完整应用）：身份区与指标、数据范围（经广告档案绑定的店铺）、企业隔离、范围外与不存在都是 404、
// 广告组 7 个页签（投放对象带建议竞价、搜索词已投放/已否定、广告商品带库存、否定投放两级、分时表现、操作记录）、
// 投放对象页签（带来的搜索词、竞价历史与调价前后效果、品牌分析只有关键词类、广告位没有数据源）。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

describe('广告组与投放对象详情（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const base = { adsAccountId: 'ACC-ap-a', adsProfileId: 'ap-a', sourceUpdatedAt: '2026-10-01T00:00:00Z' }
  const metric = (id: string, entityType: string, entityId: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsMetric', {
      id,
      tenantId,
      ...base,
      reportDate: date,
      adProduct: 'SPONSORED_PRODUCTS',
      entityType,
      entityId,
      impressions: 100,
      clicks: 10,
      cost: 10,
      sales: 40,
      purchases: 2,
      ...values,
    })
  const term = (id: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsTermMetric', {
      id,
      tenantId,
      ...base,
      adProduct: 'SPONSORED_PRODUCTS',
      externalCampaignId: 'c1',
      adGroupId: 'AG1',
      level: 'SEARCH_TERM',
      reportDate: date,
      rowKey: id,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })

  beforeAll(async () => {
    vi.stubEnv('AMAZON_ADS_STREAM_SINK', 'sqs://ads-stream')
    h = await createDbTestApp({ database: 'ads_groups' })
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
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const [profile, tenant] of [
      ['ap-a', tenantId],
      ['ap-b', tenantId],
      ['ap-o', otherTenantId],
    ] as const)
      await insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })

    await insertRow(h.client, 'AdsCampaign', { id: 'cam-1', tenantId, ...base, externalCampaignId: 'c1', adProduct: 'SPONSORED_PRODUCTS', name: '春季推广', state: 'ENABLED' })
    const group = (id: string, profile: string, tenant: string, adGroupId: string, campaignId: string, name: string, values: Record<string, unknown> = {}) =>
      insertRow(h.client, 'AdsAdGroup', {
        id,
        tenantId: tenant,
        adsProfileId: profile,
        adsAccountId: `ACC-${profile}`,
        adGroupId,
        campaignId,
        name,
        state: 'ENABLED',
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
        ...values,
      })
    await group('ag-1', 'ap-a', tenantId, 'AG1', 'c1', '核心词组', { defaultBid: 1.2 })
    await group('ag-9', 'ap-b', tenantId, 'AG9', 'c9', '店铺 B 词组')
    await group('ag-o', 'ap-o', otherTenantId, 'AGO', 'co1', '别的企业词组')

    await insertRow(h.client, 'AdsKeyword', { id: 'kw-1', tenantId, ...base, keywordId: 'K1', campaignId: 'c1', adGroupId: 'AG1', text: 'yoga mat', matchType: 'EXACT', bid: 1.5, state: 'ENABLED' })
    await insertRow(h.client, 'AdsTarget', { id: 'tg-1', tenantId, ...base, targetId: 'T1', adGroupId: 'AG1', kind: 'PRODUCT', expression: 'asin="B0XYZ"', bid: 0.9, state: 'ENABLED' })
    await insertRow(h.client, 'AdsTarget', {
      id: 'tg-9',
      tenantId,
      adsProfileId: 'ap-b',
      adsAccountId: 'ACC-ap-b',
      targetId: 'T9',
      adGroupId: 'AG9',
      kind: 'CATEGORY',
      expression: 'category=1',
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsAd', { id: 'ad-1', tenantId, ...base, adId: 'AD1', adGroupId: 'AG1', asin: 'B0AAA', sku: 'SKU-1', state: 'ENABLED' })
    await insertRow(h.client, 'AdsAd', { id: 'ad-2', tenantId, ...base, adId: 'AD2', adGroupId: 'AG1', state: 'PAUSED' })
    await insertRow(h.client, 'AdsNegativeTarget', { id: 'neg-c', tenantId, ...base, negativeId: 'N1', level: 'CAMPAIGN', campaignId: 'c1', expression: 'cheap yoga mat', matchType: 'NEGATIVE_EXACT' })
    await insertRow(h.client, 'AdsNegativeTarget', {
      id: 'neg-g',
      tenantId,
      ...base,
      negativeId: 'N2',
      level: 'AD_GROUP',
      campaignId: 'c1',
      adGroupId: 'AG1',
      expression: 'free yoga',
      matchType: 'NEGATIVE_PHRASE',
    })
    await insertRow(h.client, 'AdsNegativeTarget', {
      id: 'neg-x',
      tenantId,
      ...base,
      negativeId: 'N3',
      level: 'AD_GROUP',
      campaignId: 'c1',
      adGroupId: 'AG-OTHER',
      expression: 'other group word',
      matchType: 'NEGATIVE_EXACT',
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

    // 指标：广告组两天；关键词 K1 在调价前（-5）与调价后（-2、-1）；调价发生在 -3 天
    await metric('m1', 'AD_GROUP', 'AG1', dayText(-1), { cost: 40, sales: 160, purchases: 5 })
    await metric('m2', 'AD_GROUP', 'AG1', dayText(-2), { cost: 20, sales: 40, purchases: 1 })
    await metric('m3', 'KEYWORD', 'K1', dayText(-5), { cost: 10, sales: 20, purchases: 1 })
    await metric('m4', 'KEYWORD', 'K1', dayText(-2), { cost: 12, sales: 48, purchases: 3 })
    await metric('m5', 'KEYWORD', 'K1', dayText(-1), { cost: 8, sales: 32, purchases: 2 })
    await metric('m6', 'AD', 'AD1', dayText(-1), { cost: 12, sales: 30, purchases: 2 })
    await insertRow(h.client, 'AdsPerformanceHourly', {
      id: 'hr1',
      tenantId,
      ...base,
      entityType: 'AD_GROUP',
      entityId: 'AG1',
      hourStart: `${dayText(-1)}T10:00:00Z`,
      clicks: 4,
      orders: 1,
      spend: 5,
      sales: 20,
    })

    // 词级报表：yoga mat 已被关键词 K1 投放；cheap yoga mat 在活动级否定；yoga block 没有投放；free yoga 在广告组级否定
    await term('t1', dayText(-1), { searchTerm: 'yoga mat', keywordId: 'K1', matchedTargetExpression: 'yoga mat', impressions: 900, clicks: 30, cost: 12, sales: 90, purchases: 3 })
    await term('t2', dayText(-1), { searchTerm: 'cheap yoga mat', impressions: 400, clicks: 40, cost: 25, sales: 0, purchases: 0 })
    await term('t3', dayText(-2), { searchTerm: 'yoga block', impressions: 100, clicks: 5, cost: 4, sales: 0, purchases: 0 })
    await term('t4', dayText(-1), { searchTerm: 'free yoga', impressions: 50, clicks: 5, cost: 2, sales: 0, purchases: 0 })
    await insertRow(h.client, 'AdsRecommendation', {
      id: 'rec-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      recommendationId: 'R1',
      type: 'BID',
      entityType: 'KEYWORD',
      entityId: 'K1',
      payloadJson: { suggestedBidLow: 0.8, suggestedBidHigh: 1.6, suggestedBid: 1.2 },
      status: 'NEW',
      receivedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    })
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-bid',
      tenantId,
      entityType: 'ADS_TARGET',
      entityId: 'kw-1',
      kind: 'ads.target.bid',
      title: '竞价 1.2 → 1.5',
      occurredAt: `${dayText(-3)}T12:00:00Z`,
      detailJson: { before: { bid: 1.2 }, after: { bid: 1.5 } },
    })

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

  describe('数据范围与隔离', () => {
    it('没有权限 403；范围外、别的企业、不存在的对象一律 404；全部店铺成员能看', async () => {
      expect((await h.call(noAds.token, 'GET', '/ads/ad-groups/ag-1')).status).toBe(403)
      for (const path of ['/ads/ad-groups/ag-1', '/ads/ad-groups/ag-1/targets', '/ads/targets/kw-1', '/ads/targets/tg-1/bid-history']) {
        expect((await h.call(scopedB.token, 'GET', path)).status, path).toBe(404)
        expect((await h.call(other.token, 'GET', path)).status, path).toBe(404)
      }
      expect((await h.call(admin.token, 'GET', '/ads/ad-groups/ag-none')).status).toBe(404)
      expect((await h.call(admin.token, 'GET', '/ads/targets/nope/trend')).status).toBe(404)
      await get(scopedA, '/ads/ad-groups/ag-1')
      await get(scopedB, '/ads/ad-groups/ag-9')
      await get(scopedB, '/ads/targets/tg-9')
      await get(other, '/ads/ad-groups/ag-o')
    })
  })

  describe('广告组', () => {
    it('身份区与指标：来自指标表的 AD_GROUP 行，合计与比率正确，7 个页签', async () => {
      const data = await get(admin, '/ads/ad-groups/ag-1')
      expect(data.identity).toMatchObject({ name: '核心词组', defaultBid: 1.2, currency: 'USD', campaign: { id: 'cam-1', externalCampaignId: 'c1', name: '春季推广' } })
      expect(data.metrics.totals).toMatchObject({ spend: 60, sales: 200, orders: 6 })
      expect(data.metrics.ratios.acos).toBeCloseTo(0.3, 9)
      expect(data.tabs.map((tab: { key: string }) => tab.key)).toEqual(['trend', 'targets', 'search-terms', 'products', 'negatives', 'hourly', 'history'])
      expect(data.write.state).toBe('NOT_CONNECTED')
      expect((await get(admin, '/ads/ad-groups/ag-9')).identity.campaign).toMatchObject({ id: null, externalCampaignId: 'c9', name: null })
    })

    it('趋势：没有指标的天是 null 不是 0', async () => {
      const data = await get(admin, `/ads/ad-groups/ag-1/trend?from=${dayText(-3)}&to=${dayText(-1)}`)
      const byDate = new Map<string, any>(data.points.map((point: { date: string }) => [point.date, point]))
      expect(byDate.get(dayText(-3)).spend).toBeNull()
      expect(byDate.get(dayText(-1)).spend).toBe(40)
      expect(data.amazonEvents.state).toBe('NOT_CONNECTED')
    })

    it('投放对象：关键词与投放合并，带建议竞价区间之外的单点建议，点进详情用的系统编号', async () => {
      const data = await get(admin, '/ads/ad-groups/ag-1/targets')
      expect(new Map<string, any>(data.items.map((item: { id: string }) => [item.id, item])).get('kw-1')).toMatchObject({ expression: 'yoga mat', bid: 1.5, suggestedBid: 1.2, metrics: { spend: 30 } })
      expect(data.items.map((item: { id: string }) => item.id).sort()).toEqual(['kw-1', 'tg-1'])
    })

    it('搜索词：已投放、已否定（活动级与本广告组级）、未投放', async () => {
      const data = await get(admin, '/ads/ad-groups/ag-1/search-terms')
      const status = Object.fromEntries(data.items.map((item: { searchTerm: string; status: string }) => [item.searchTerm, item.status]))
      expect(status['cheap yoga mat']).toBe('NEGATED')
      expect(status['free yoga']).toBe('NEGATED')
      expect(status['yoga block']).toBe('UNTARGETED')
      expect(status['yoga mat']).toBe('TARGETED')
    })

    it('广告商品：带库存状态，断货的在页面标红；没有指标的排最后；没有 ASIN 的广告库存是未知', async () => {
      const data = await get(admin, '/ads/ad-groups/ag-1/products')
      expect(data.items.map((item: { adId: string }) => item.adId)).toEqual(['AD1', 'AD2'])
      expect(data.items[0]).toMatchObject({ asin: 'B0AAA', sku: 'SKU-1', metrics: { spend: 12 }, sellable: 0 })
      expect(data.items[0].stock).toBe('OUT_OF_STOCK')
      expect(data.items[1]).toMatchObject({ metrics: null, sellable: null })
    })

    it('否定投放：活动级与本广告组级一起，别的广告组的不出现', async () => {
      const data = await get(admin, '/ads/ad-groups/ag-1/negatives')
      expect(data.items.map((item: { negativeId: string }) => item.negativeId).sort()).toEqual(['N1', 'N2'])
      expect(data.items.find((item: { negativeId: string }) => item.negativeId === 'N1').level).toBe('CAMPAIGN')
      expect(data.write.state).toBe('NOT_CONNECTED')
    })

    it('分时表现与操作记录：有数据流时按小时汇总；操作记录还没有改动时说明原因与入口', async () => {
      const hourly = await get(admin, '/ads/ad-groups/ag-1/hourly')
      expect(hourly).toMatchObject({ state: 'OK', streamConnected: true })
      expect(hourly.cells.reduce((sum: number, cell: { clicks: number }) => sum + cell.clicks, 0)).toBe(4)
      const history = await get(admin, '/ads/ad-groups/ag-1/history')
      expect(history).toMatchObject({ state: 'NO_DATA', items: [] })
      expect(history.note).toContain('还没有对这个广告组做过改动')
      expect(history.note).toContain('先预览再提交')
    })

    it('列表型页签换条件后旧游标失效（400），分页参数不合法 422', async () => {
      const page = await get(admin, '/ads/ad-groups/ag-1/targets?pageSize=1')
      expect(page.pageInfo.hasMore).toBe(true)
      await get(admin, `/ads/ad-groups/ag-1/targets?pageSize=1&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)
      expect((await h.call(admin.token, 'GET', `/ads/ad-groups/ag-1/targets?pageSize=1&q=yoga&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)).status).toBe(400)
      expect((await h.call(admin.token, 'GET', '/ads/ad-groups/ag-1/targets?pageSize=0')).status).toBe(422)
    })
  })

  describe('投放对象', () => {
    it('身份区：关键词与投放都能按系统编号打开，带上级广告组、活动与建议竞价区间', async () => {
      const keyword = await get(admin, '/ads/targets/kw-1')
      expect(keyword.identity).toMatchObject({ kind: 'KEYWORD', expression: 'yoga mat', matchType: 'EXACT', bid: 1.5, adGroup: { id: 'ag-1', name: '核心词组' }, campaign: { id: 'cam-1' } })
      expect(keyword.identity.suggestedBid).toMatchObject({ low: 0.8, high: 1.6, point: 1.2 })
      expect(keyword.metrics.totals).toMatchObject({ spend: 30, orders: 6 })
      expect(keyword.tabs.map((tab: { key: string }) => tab.key)).toContain('brand-analytics')
      const target = await get(admin, '/ads/targets/tg-1')
      expect(target.identity).toMatchObject({ kind: 'PRODUCT', bid: 0.9, suggestedBid: null })
      expect(target.tabs.map((tab: { key: string }) => tab.key)).not.toContain('brand-analytics')
      expect(target.metrics.totals).toBeNull()
    })

    it('带来的搜索词：只列指向这个投放对象的词，带命中的投放表达式', async () => {
      const data = await get(admin, '/ads/targets/kw-1/search-terms')
      expect(data.items).toEqual([{ searchTerm: 'yoga mat', matchedExpression: 'yoga mat', metrics: { impressions: 900, clicks: 30, spend: 12, sales: 90, orders: 3 } }])
      expect((await get(admin, '/ads/targets/tg-1/search-terms')).state).toBe('NO_DATA')
    })

    it('广告位没有数据源：尚未接入并指向活动页', async () => {
      expect(await get(admin, '/ads/targets/kw-1/placements')).toMatchObject({ state: 'NOT_CONNECTED', campaignId: 'cam-1' })
    })

    it('竞价历史：当前竞价与建议竞价、调价前后各 7 天的对照（调价当天不计）；亚马逊侧尚未接入', async () => {
      const data = await get(admin, '/ads/targets/kw-1/bid-history')
      expect(data.current).toMatchObject({ bid: 1.5, currency: 'USD', suggestedBid: { low: 0.8, high: 1.6 } })
      expect(data.amazonSide.state).toBe('NOT_CONNECTED')
      expect(data.changes.state).toBe('OK')
      const [change] = data.changes.items
      expect(change).toMatchObject({ beforeBid: 1.2, afterBid: 1.5 })
      expect(change.before).toMatchObject({ daysWithData: 1, totals: { spend: 10, sales: 20, orders: 1 } })
      expect(change.after).toMatchObject({ daysWithData: 2, totals: { spend: 20, sales: 80, orders: 5 } })
      expect(change.after.ratios.acos).toBeCloseTo(0.25, 9)
      const none = await get(admin, '/ads/targets/tg-1/bid-history')
      expect(none.changes).toMatchObject({ state: 'NO_DATA', items: [] })
    })

    it('品牌分析：关键词是尚未接入；投放类对象没有这个页签，直接 404', async () => {
      expect(await get(admin, '/ads/targets/kw-1/brand-analytics')).toMatchObject({ state: 'NOT_CONNECTED', keyword: 'yoga mat' })
      expect((await h.call(admin.token, 'GET', '/ads/targets/tg-1/brand-analytics')).status).toBe(404)
    })

    it('趋势与分时：投放对象按关键词指标读，没有分时数据说明原因', async () => {
      const trend = await get(admin, `/ads/targets/kw-1/trend?from=${dayText(-5)}&to=${dayText(-1)}`)
      expect(trend.totals).toMatchObject({ spend: 30, sales: 100, orders: 6 })
      expect(await get(admin, '/ads/targets/kw-1/hourly')).toMatchObject({ state: 'NO_DATA' })
    })
  })
})
