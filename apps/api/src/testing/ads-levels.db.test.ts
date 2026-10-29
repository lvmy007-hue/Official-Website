import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告层级页（P6-23，真实数据库 + 完整应用）：五个层级的指标区间筛选、汇总行、分类计数（GET /ads/:level/counts，level 白名单）、
// 广告组列表（新增）、数据范围与权限先于参数校验。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

describe('广告层级页（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let storeB: string
  let admin: Member
  let scopedB: Member
  let noAds: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const idsOf = (data: Record<string, any>) => (data.items as Array<{ id: string }>).map(item => item.id)
  const keysOf = (data: Record<string, any>) => (data.items as Array<{ key: string }>).map(item => item.key)

  let seq = 0
  const campaign = (id: string, profile: string, external: string, name: string) =>
    insertRow(h.client, 'AdsCampaign', {
      id,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      externalCampaignId: external,
      adProduct: 'SPONSORED_PRODUCTS',
      name,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
  const summary = (profile: string, external: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsDailySummary', {
      id: `ds-${++seq}`,
      tenantId,
      adsProfileId: profile,
      adProduct: 'SPONSORED_PRODUCTS',
      campaignId: external,
      summaryDate: dayText(-1),
      metricVersion: 'ads.v1',
      ...values,
    })
  const group = (id: string, profile: string, adGroupId: string, campaignId: string, name: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'AdsAdGroup', {
      id,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      adGroupId,
      campaignId,
      name,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      ...values,
    })
  const groupMetric = (profile: string, entityId: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsMetric', {
      id: `gm-${++seq}`,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
      reportDate: dayText(-1),
      adProduct: 'SPONSORED_PRODUCTS',
      entityType: 'AD_GROUP',
      entityId,
      ...values,
    })
  const product = (profile: string, asin: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsAdvertisedProductMetric', {
      id: `apm-${++seq}`,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      campaignId: 'c1',
      advertisedAsin: asin,
      reportDate: dayText(-1),
      impressions: 100,
      clicks: 10,
      orders: 0,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const termMetric = (level: 'SEARCH_TERM' | 'KEYWORD', values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsTermMetric', {
      id: `tm-${++seq}`,
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      adProduct: 'SPONSORED_PRODUCTS',
      level,
      externalCampaignId: 'c1',
      adGroupId: 'AG1',
      reportDate: dayText(-1),
      rowKey: `rk-${seq}`,
      impressions: 100,
      clicks: 10,
      sales: 0,
      purchases: 0,
      keywordText: 'yoga mat',
      matchType: 'EXACT',
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_levels' })
    const a = await h.createTenant('a')
    tenantId = a.tenantId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: a.sellerAccountId, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    for (const profile of ['ap-a', 'ap-b']) await insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })

    // 活动：c1 与 c2 有成交（广告成本销售比 0.4、0.15）；c3 有点击无成交；c4 有曝光无点击；c5 无曝光；c6 没有汇总行；c9 在店铺 B
    for (const [id, profile, external, name] of [
      ['cam-1', 'ap-a', 'c1', '春季推广'],
      ['cam-2', 'ap-a', 'c2', '夏季清仓'],
      ['cam-3', 'ap-a', 'c3', '秋季测试'],
      ['cam-4', 'ap-a', 'c4', '冬季曝光'],
      ['cam-5', 'ap-a', 'c5', '无曝光'],
      ['cam-6', 'ap-a', 'c6', '没有汇总'],
      ['cam-9', 'ap-b', 'c9', '店铺B活动'],
    ] as const)
      await campaign(id, profile, external, name)
    await summary('ap-a', 'c1', { impressions: 1000, clicks: 100, spend: 40, sales: 100, orders: 5 })
    await summary('ap-a', 'c2', { impressions: 800, clicks: 60, spend: 30, sales: 200, orders: 8 })
    await summary('ap-a', 'c3', { impressions: 500, clicks: 50, spend: 20, sales: 0, orders: 0 })
    await summary('ap-a', 'c4', { impressions: 200, clicks: 0, spend: 0, orders: 0 })
    await summary('ap-a', 'c5', { impressions: 0, clicks: 0, spend: 0, orders: 0 })
    await summary('ap-b', 'c9', { impressions: 100, clicks: 10, spend: 5, sales: 10, orders: 1 })

    // 广告组：AG1 有成交；AG2 有点击无成交；AG9（店铺 B）有曝光无点击；AG3 没有指标
    await group('ag-1', 'ap-a', 'AG1', 'c1', '核心词组', { defaultBid: 1.2 })
    await group('ag-2', 'ap-a', 'AG2', 'c2', '清仓组')
    await group('ag-3', 'ap-a', 'AG3', 'c3', '无指标组')
    await group('ag-9', 'ap-b', 'AG9', 'c9', '店铺 B 词组')
    await groupMetric('ap-a', 'AG1', { impressions: 100, clicks: 10, cost: 10, sales: 40, purchases: 2 })
    await groupMetric('ap-a', 'AG2', { impressions: 100, clicks: 5, cost: 20, sales: 0, purchases: 0 })
    await groupMetric('ap-b', 'AG9', { impressions: 50, clicks: 0, cost: 0, sales: 0, purchases: 0 })

    // 广告商品：B0AAA 与 B0BBB 有成交，广告成本销售比都是 0.2；B0CCC 有点击无成交且没有销售额
    await product('ap-a', 'B0AAA', { spend: 12, sales: 60, orders: 2 })
    await product('ap-a', 'B0BBB', { spend: 20, sales: 100, orders: 4 })
    await product('ap-a', 'B0CCC', { spend: 3, sales: null })

    // 词级：三个搜索词（有成交、有点击无成交、有曝光无点击）与一个投放词（关键词表里有同步记录）
    await termMetric('SEARCH_TERM', { searchTerm: 'yoga mat', cost: 10, sales: 40, purchases: 2 })
    await termMetric('SEARCH_TERM', { searchTerm: 'cheap mat', cost: 6, clicks: 8 })
    await termMetric('SEARCH_TERM', { searchTerm: 'mat stand', cost: 2, impressions: 50, clicks: 0 })
    await termMetric('KEYWORD', { targetId: 'T1', keywordId: 'T1', cost: 10, sales: 40, purchases: 1 })
    await insertRow(h.client, 'AdsKeyword', {
      id: 'kw-1',
      tenantId,
      adsProfileId: 'ap-a',
      adsAccountId: 'ACC-ap-a',
      keywordId: 'T1',
      campaignId: 'c1',
      adGroupId: 'AG1',
      text: 'yoga mat',
      matchType: 'EXACT',
      bid: 1.5,
      state: 'ENABLED',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    admin = await h.createMember(tenantId, 'admin', ['ads.read'])
    scopedB = await h.createMember(tenantId, 'scopedb', ['ads.read'], { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('活动列表：广告成本销售比区间只留区间内的活动；没有销售额算不出比率的活动不命中；汇总行是筛选后全部行的合计', async () => {
    const mid = await get(admin, '/ads/campaigns?acosMin=0.1&acosMax=0.2')
    expect(idsOf(mid)).toEqual(['cam-2'])
    expect(mid.summary).toMatchObject({ total: 1, withoutMetrics: 0, totals: { spend: 30, sales: 200, orders: 8 } })
    expect(mid.summary.ratios.acos).toBeCloseTo(0.15)
    expect(idsOf(await get(admin, '/ads/campaigns?acosMin=0.3&acosMax=0.45'))).toEqual(['cam-1'])
    const spend = await get(admin, '/ads/campaigns?spendMin=25&sort=spend:asc')
    expect(idsOf(spend)).toEqual(['cam-2', 'cam-1'])
    expect(spend.summary.totals.spend).toBe(70)
    const all = await get(admin, '/ads/campaigns')
    expect(all.summary).toMatchObject({ total: 7, withoutMetrics: 1, totals: { spend: 95, orders: 14 } })
  })

  it('活动列表：分类筛选只留对应一类；没有指标的活动不进任何一类', async () => {
    expect(idsOf(await get(admin, '/ads/campaigns?bucket=CLICK_NO_ORDER'))).toEqual(['cam-3'])
    expect(idsOf(await get(admin, '/ads/campaigns?bucket=IMPRESSION_NO_CLICK'))).toEqual(['cam-4'])
    expect(idsOf(await get(admin, '/ads/campaigns?bucket=NO_IMPRESSION'))).toEqual(['cam-5'])
    const converted = await get(admin, '/ads/campaigns?bucket=CONVERTED')
    expect([...idsOf(converted)].sort()).toEqual(['cam-1', 'cam-2', 'cam-9'])
    expect(converted.summary.total).toBe(3)
  })

  it('分类计数：五类互斥、没有指标的单独数；筛选与列表一致，分类参数与分页参数被忽略；数据范围生效', async () => {
    const counts = await get(admin, '/ads/campaigns/counts')
    expect(counts).toMatchObject({ level: 'campaigns', state: 'OK', total: 7, withoutMetrics: 1, buckets: { CONVERTED: 3, CLICK_NO_ORDER: 1, IMPRESSION_NO_CLICK: 1, NO_IMPRESSION: 1 } })
    expect(counts.rule).toContain('互斥')
    const withIgnored = await get(admin, '/ads/campaigns/counts?bucket=CONVERTED&pageSize=1&sort=spend:asc')
    expect(withIgnored.buckets).toEqual(counts.buckets)
    const filtered = await get(admin, '/ads/campaigns/counts?acosMax=0.2')
    expect(filtered).toMatchObject({ total: 1, buckets: { CONVERTED: 1, CLICK_NO_ORDER: 0 } })
    const scoped = await get(scopedB, '/ads/campaigns/counts')
    expect(scoped).toMatchObject({ total: 1, buckets: { CONVERTED: 1 } })
  })

  it('计数接口：level 是白名单，其余 404；没有权限 403 且先于参数校验；下限大于上限 422；不影响活动详情路由', async () => {
    expect((await h.call(admin.token, 'GET', '/ads/portfolios/counts')).status).toBe(404)
    expect((await h.call(admin.token, 'GET', '/ads/unknown/counts')).status).toBe(404)
    expect((await h.call(noAds.token, 'GET', '/ads/campaigns/counts?acosMin=2&acosMax=1')).status).toBe(403)
    expect((await h.call(admin.token, 'GET', '/ads/campaigns/counts?acosMin=0.5&acosMax=0.1')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/ads/campaigns?acosMin=0.5&acosMax=0.1')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/ads/campaigns?bucket=OTHER')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/ads/campaigns?acosMin=-1')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/ads/campaigns/cam-1')).status).toBe(200)
  })

  it('广告组列表：指标来自指标表；区间、上级活动、分类筛选；没有指标的排最后；数据范围按档案绑定的店铺', async () => {
    const all = await get(admin, '/ads/ad-groups')
    expect(idsOf(all)).toEqual(['ag-2', 'ag-1', 'ag-9', 'ag-3'])
    expect(all.summary).toMatchObject({ total: 4, withoutMetrics: 1, totals: { spend: 30, orders: 2 } })
    const first = (all.items as Array<Record<string, any>>).find(item => item.id === 'ag-1')!
    expect(first).toMatchObject({ name: '核心词组', campaignName: '春季推广', campaignId: 'cam-1', defaultBid: 1.2 })
    expect(first.ratios.acos).toBeCloseTo(0.25)
    expect((all.items as Array<Record<string, any>>).find(item => item.id === 'ag-3')!.totals).toBeNull()
    expect(idsOf(await get(admin, '/ads/ad-groups?acosMin=0.2&acosMax=0.3'))).toEqual(['ag-1'])
    expect(idsOf(await get(admin, '/ads/ad-groups?campaignId=cam-2'))).toEqual(['ag-2'])
    expect(idsOf(await get(admin, '/ads/ad-groups?bucket=CLICK_NO_ORDER'))).toEqual(['ag-2'])
    expect(idsOf(await get(admin, `/ads/ad-groups?q=${encodeURIComponent('词组')}&sort=name:asc`))).toEqual(['ag-9', 'ag-1'])
    const counts = await get(admin, '/ads/ad-groups/counts')
    expect(counts).toMatchObject({ level: 'ad-groups', total: 4, withoutMetrics: 1, buckets: { CONVERTED: 1, CLICK_NO_ORDER: 1, IMPRESSION_NO_CLICK: 1, NO_IMPRESSION: 0 } })
    expect(idsOf(await get(scopedB, '/ads/ad-groups'))).toEqual(['ag-9'])
    expect((await h.call(noAds.token, 'GET', '/ads/ad-groups')).status).toBe(403)
    // 详情路由不受影响
    expect((await h.call(admin.token, 'GET', '/ads/ad-groups/ag-1')).status).toBe(200)
  })

  it('广告商品：区间筛选与汇总；分类计数', async () => {
    const ranged = await get(admin, '/ads/products?acosMax=0.3')
    expect(keysOf(ranged).sort()).toHaveLength(2)
    expect(ranged.level).toMatchObject({ total: 2, totals: { spend: 32, orders: 6 } })
    expect(ranged.level.ratios.acos).toBeCloseTo(0.2)
    const counts = await get(admin, '/ads/products/counts')
    expect(counts).toMatchObject({ level: 'products', total: 3, buckets: { CONVERTED: 2, CLICK_NO_ORDER: 1 } })
    expect(keysOf(await get(admin, '/ads/products?bucket=CLICK_NO_ORDER'))).toHaveLength(1)
  })

  it('搜索词与投放：区间与分类筛选、汇总、分类计数；投放行带对象的系统编号；其它页签不接受区间与分类', async () => {
    const terms = await get(admin, '/ads/search-terms/counts')
    expect(terms).toMatchObject({ level: 'search-terms', total: 3, buckets: { CONVERTED: 1, CLICK_NO_ORDER: 1, IMPRESSION_NO_CLICK: 1, NO_IMPRESSION: 0 } })
    const click = await get(admin, '/ads/terms?tab=search-terms&bucket=CLICK_NO_ORDER')
    expect((click.items as Array<{ searchTerm: string }>).map(item => item.searchTerm)).toEqual(['cheap mat'])
    expect(click.summary.total).toBe(1)
    const ranged = await get(admin, '/ads/terms?tab=search-terms&spendMin=5')
    expect((ranged.items as Array<{ searchTerm: string }>).map(item => item.searchTerm).sort()).toEqual(['cheap mat', 'yoga mat'])
    expect(ranged.summary.totals.spend).toBe(16)
    const targets = await get(admin, '/ads/terms?tab=targets')
    expect((targets.items as Array<Record<string, any>>)[0]).toMatchObject({ expression: 'yoga mat', entityId: 'kw-1' })
    expect(await get(admin, '/ads/targets/counts')).toMatchObject({ level: 'targets', total: 1, buckets: { CONVERTED: 1 } })
    expect((await h.call(admin.token, 'GET', '/ads/terms?tab=negatives&spendMin=1')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/ads/terms?tab=quadrant&bucket=CONVERTED')).status).toBe(422)
  })
})
