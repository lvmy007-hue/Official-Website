import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告控制台（P3-05，真实数据库 + 完整应用）：广告日汇总与店铺经营日汇总的真实聚合、数据范围过滤（经广告档案绑定的店铺）、
// 未绑定账户只有“全部店铺”范围成员可见、美元之外的币种不并入、企业隔离、活动预算与异常。
// 日期都用显式范围，避免随“今天”失效。

type Member = { userId: string; token: string }
const RANGE = '?from=2026-10-01&to=2026-10-04&compare=previous'

describe('广告控制台（真实数据库）', () => {
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

  const overview = async (member: Member, query = RANGE) => {
    const res = await h.call(member.token, 'GET', `/ads/overview${query}`)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    return res.json.data as Record<string, any>
  }
  const card = (data: Record<string, any>, key: string) => (data.cards as Array<{ key: string }>).find(item => item.key === key) as Record<string, any>

  const summary = (id: string, profile: string, product: string, campaign: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsDailySummary', {
      id,
      tenantId: profile === 'ap-b-other' ? otherTenantId : tenantId,
      adsProfileId: profile,
      adProduct: product,
      campaignId: campaign,
      summaryDate: date,
      metricVersion: 'ads.v1',
      ...values,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_overview' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })

    // 三个广告档案：绑店铺 A、绑店铺 B、未绑定；别的企业一个
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b1', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P-F' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b-other', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })

    // 本期 10-01 至 10-04；对比期 09-27 至 09-30
    const sp = 'SPONSORED_PRODUCTS'
    await summary('s1', 'ap-a', sp, 'CA1', '2026-10-01', { impressions: 1000, clicks: 50, spend: 40, sales: 160, orders: 5 })
    await summary('s2', 'ap-a', sp, 'CA1', '2026-10-02', { impressions: 2000, clicks: 100, spend: 60, sales: 240, orders: 8 })
    await summary('s3', 'ap-a', sp, 'CA2', '2026-10-02', { impressions: 800, clicks: 40, spend: 30, sales: 0, orders: 0 })
    await summary('s4', 'ap-a', 'SPONSORED_BRANDS', 'CA3', '2026-10-03', { impressions: 500, clicks: 10, spend: 10, orders: 0 })
    await summary('s5', 'ap-b1', sp, 'CB1', '2026-10-01', { impressions: 3000, clicks: 90, spend: 20, sales: 100, orders: 4 })
    await summary('s6', 'ap-free', sp, 'CF1', '2026-10-01', { impressions: 100, clicks: 10, spend: 25, sales: 50, orders: 1 })
    await summary('s7', 'ap-a', sp, 'CA1', '2026-10-01', { impressions: 700, clicks: 7, spend: 7, sales: 14, orders: 1, currency: 'CAD' })
    await summary('s8', 'ap-a', sp, 'CA1', '2026-09-28', { impressions: 1500, clicks: 100, spend: 80, sales: 200, orders: 4 })
    await summary('s9', 'ap-b-other', sp, 'CO1', '2026-10-01', { impressions: 9, clicks: 9, spend: 999, sales: 999, orders: 9 })

    for (const [id, store, date, sales, adsSpend, adsSales] of [
      ['d1', storeA, '2026-10-01', 400, 40, 160],
      ['d2', storeA, '2026-10-02', 600, 90, 240],
      ['d3', storeB, '2026-10-01', 300, 20, 100],
      ['d4', storeA, '2026-09-28', 500, 80, 200],
    ] as const)
      await insertRow(h.client, 'StoreDailySummary', { id, tenantId, sellerAccountId: store, summaryDate: date, salesAmount: sales, adsSpend, adsSales, metricVersion: 'store.v1' })

    // 活动：CA1 是启用中的日预算 10 美元；CA2 预算类型没同步
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-1',
      tenantId,
      adsProfileId: 'ap-a',
      externalCampaignId: 'CA1',
      adProduct: sp,
      name: '春季推广',
      state: 'ENABLED',
      budget: 50,
      budgetType: 'DAILY',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'AdsCampaign', {
      id: 'cam-2',
      tenantId,
      adsProfileId: 'ap-a',
      externalCampaignId: 'CA2',
      adProduct: sp,
      name: '清仓',
      state: 'ENABLED',
      budget: 5,
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    const read = ['ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', read)
  })
  afterAll(async () => {
    await h?.close()
  })

  it('全部店铺成员：合计所有可见美元广告；其他币种不并入；未绑定账户的花费单独给出', async () => {
    const data = await overview(admin)
    expect(data.state).toBe('OK')
    // 美元：40+60+30+10+20+25 = 185；销售 160+240+0+(无)+100+50 = 550；订单 5+8+0+0+4+1 = 18
    expect(card(data, 'spend')).toMatchObject({ state: 'OK', value: 185 })
    expect(card(data, 'sales')).toMatchObject({ state: 'OK', value: 550 })
    expect(data.otherCurrencies).toEqual([{ currency: 'CAD', spend: 7 }])
    expect(data.unboundSpend).toBe(25)
    expect(data.funnel.value).toMatchObject({ clicks: 300, orders: 18 })
    expect(data.refreshedAt).toBeTruthy()
    // 对比期：09-28 花费 80，变化 = (185 - 80) / 80
    expect(card(data, 'spend').compareValue).toBe(80)
    expect(card(data, 'spend').change).toBeCloseTo(105 / 80, 9)
  })

  it('范围过滤：受限成员只看到绑定到自己店铺的广告账户；未绑定账户与别的店铺的看不到，也没有未绑定花费', async () => {
    const a = await overview(scopedA)
    expect(card(a, 'spend').value).toBe(140)
    expect(a.unboundSpend).toBeNull()
    expect(a.otherCurrencies).toEqual([{ currency: 'CAD', spend: 7 }])
    const b = await overview(scopedB)
    expect(card(b, 'spend').value).toBe(20)
    expect(card(b, 'sales').value).toBe(100)
    expect(b.products.find((row: { adProduct: string }) => row.adProduct === 'SPONSORED_BRANDS')).toMatchObject({ state: 'NOT_CONNECTED', spend: null })
    expect(b.otherCurrencies).toEqual([])
  })

  it('改绑立刻生效：把未绑定账户绑到店铺 B 后，店铺 B 的成员才看得到它的花费', async () => {
    await h.client.query(`UPDATE "AdsProfile" SET "sellerAccountId" = $1, "bindingStatus" = 'MANUAL' WHERE id = 'ap-free'`, [storeB])
    expect(card(await overview(scopedB), 'spend').value).toBe(45)
    expect((await overview(admin)).unboundSpend).toBeNull()
    await h.client.query(`UPDATE "AdsProfile" SET "sellerAccountId" = NULL, "bindingStatus" = 'UNBOUND' WHERE id = 'ap-free'`)
    expect(card(await overview(scopedB), 'spend').value).toBe(20)
  })

  it('广告占总销售比与自然销售额用店铺经营日汇总（只含该成员范围内的店铺）', async () => {
    const all = await overview(admin)
    // 全部：总销售 400+600+300 = 1300，广告花费 40+90+20 = 150，广告销售 160+240+100 = 500
    expect(card(all, 'adsShare').value).toBeCloseTo(150 / 1300, 9)
    expect(card(all, 'organicSales').value).toBe(800)
    const a = await overview(scopedA)
    expect(card(a, 'adsShare').value).toBeCloseTo(130 / 1000, 9)
    expect(card(a, 'organicSales').value).toBe(600)
    expect(a.mix.points).toEqual([
      { key: '2026-10-01', totalSales: 400, adSales: 160, organicSales: 240, adSpend: 40, adsShare: 0.1 },
      { key: '2026-10-02', totalSales: 600, adSales: 240, organicSales: 360, adSpend: 90, adsShare: 0.15 },
      { key: '2026-10-03', totalSales: null, adSales: null, organicSales: null, adSpend: null, adsShare: null },
      { key: '2026-10-04', totalSales: null, adSales: null, organicSales: null, adSpend: null, adsShare: null },
    ])
  })

  it('广告产品结构：品牌推广有行，展示型与电视推广标“未接入”；趋势里没有记录的日子为空而不是 0', async () => {
    const data = await overview(scopedA)
    expect(data.products.map((row: { adProduct: string; state: string }) => [row.adProduct, row.state])).toEqual([
      ['SPONSORED_PRODUCTS', 'OK'],
      ['SPONSORED_BRANDS', 'OK'],
      ['SPONSORED_DISPLAY', 'NOT_CONNECTED'],
      ['SPONSORED_TELEVISION', 'NOT_CONNECTED'],
    ])
    expect(data.trend.points.map((point: { key: string; spend: number | null }) => [point.key, point.spend])).toEqual([
      ['2026-10-01', 40],
      ['2026-10-02', 90],
      ['2026-10-03', 10],
      ['2026-10-04', null],
    ])
  })

  it('活动：名称来自活动管理；花费无转化的活动被标出；四象限只画有广告销售额的活动', async () => {
    const data = await overview(scopedA)
    expect(data.anomalies.count).toBe(1)
    expect(data.anomalies.items[0]).toMatchObject({ campaignId: 'CA2', kind: 'NO_CONVERSION', name: '清仓', spend: 30 })
    expect(data.quadrant.withoutSales).toBe(2)
    expect(data.quadrant.points.map((point: { campaignId: string; name: string }) => [point.campaignId, point.name])).toEqual([['CA1', '春季推广']])
    expect(data.quadrant.points[0].acos).toBeCloseTo(100 / 400, 9)
  })

  it('预算利用率：按当前日预算 × 天数估算；预算类型没同步的活动不计入', async () => {
    const data = await overview(scopedA)
    expect(data.budget).toMatchObject({ state: 'OK', dailyBudgetTotal: 50, budgetedCampaigns: 1 })
    expect(data.budget.utilization).toBeCloseTo(100 / (50 * 4), 9)
    expect(card(data, 'budgetUtilization')).toMatchObject({ state: 'OK' })
    expect(data.budget.overBudget.state).toBe('NOT_CONNECTED')
  })

  it('指标树归因：本期对比期都有数据时拆花费与广告销售额', async () => {
    const data = await overview(scopedA)
    expect(data.attribution.state).toBe('OK')
    expect(data.attribution.spend).toMatchObject({ before: 80, after: 140 })
    expect(data.attribution.sales).toMatchObject({ before: 200, after: 400 })
  })

  it('没有 ads.read 403；别的企业的成员只看到自己企业的数据（此处是它自己的 999）；没有数据的范围显示尚无记录', async () => {
    expect((await h.call(noAds.token, 'GET', `/ads/overview${RANGE}`)).status).toBe(403)
    const mine = await overview(other)
    expect(card(mine, 'spend').value).toBe(999)
    expect(mine.unboundSpend).toBeNull()
    const empty = await overview(admin, '?from=2026-01-01&to=2026-01-05')
    expect(empty.state).toBe('NO_DATA')
    expect(card(empty, 'spend')).toMatchObject({ state: 'NO_DATA', value: null })
  })
})
