import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// ASIN 360“广告”页签（P3-19，真实数据库 + 完整应用）：同一 ASIN 的多个 SKU 合在一起、同一店铺多个广告档案合并、只含美元与花费不为空的行、别的店铺与别的企业同 ASIN 的行不并入、
// 逐日趋势里没有记录的日子是空而不是 0、全部销售额与广告占比与自然销售额、光环销售三种状态、库存与断货仍在花钱、关联的活动与广告组（带广告组内商品数）、投放对象与搜索词（已投放/已否定、跨档案合并）、
// 四种数据状态（尚未接入 / 尚无记录 / 有数据）与数据范围（范围外 404）。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const RANGE = `from=${dayText(-3)}&to=${dayText(-1)}`
const US = 'ATVPDKIKX0DER'

describe('ASIN 360 广告页签（真实数据库）', () => {
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
  let tenantC: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  let seq = 0
  const metric = (profile: string, campaignId: string, asin: string, date: string, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'AdsAdvertisedProductMetric', {
      id: `apm-${++seq}`,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      campaignId,
      advertisedAsin: asin,
      reportDate: date,
      impressions: 100,
      clicks: 10,
      orders: 1,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const converted = (profile: string, advertised: string, purchased: string, isHalo: boolean, sales: number) =>
    insertRow(h.client, 'AdsConvertedProductDaily', {
      id: `acp-${++seq}`,
      tenantId,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      campaignId: 'c1',
      advertisedAsin: advertised,
      purchasedAsin: purchased,
      reportDate: dayText(-1),
      units: 1,
      sales,
      isHalo,
      sourceUpdatedAt: new Date().toISOString(),
    })
  const asinSales = (store: string, asin: string, date: string, salesAmount: number) =>
    insertRow(h.client, 'AsinDailySummary', { id: `asd-${++seq}`, tenantId, sellerAccountId: store, summaryDate: date, asin, salesAmount, metricVersion: 'p2a-01@1' })
  const base = (profile: string) => ({ tenantId, adsProfileId: profile, adsAccountId: `ACC-${profile}`, sourceUpdatedAt: '2026-10-01T00:00:00Z' })
  const ad = (id: string, profile: string, adGroupId: string, asin: string, state: string) => insertRow(h.client, 'AdsAd', { id, ...base(profile), adId: id, adGroupId, asin, state })
  const group = (id: string, profile: string, adGroupId: string, campaignId: string, name: string) =>
    insertRow(h.client, 'AdsAdGroup', { id, ...base(profile), adGroupId, campaignId, name, state: 'ENABLED', defaultBid: 1.2 })
  const campaign = (id: string, profile: string, externalCampaignId: string, name: string) =>
    insertRow(h.client, 'AdsCampaign', { id, ...base(profile), externalCampaignId, adProduct: 'SPONSORED_PRODUCTS', name, state: 'ENABLED' })
  const term = (id: string, profile: string, adGroupId: string, date: string, values: Record<string, unknown>) =>
    insertRow(h.client, 'AdsTermMetric', {
      id,
      ...base(profile),
      adProduct: 'SPONSORED_PRODUCTS',
      externalCampaignId: 'c1',
      adGroupId,
      level: 'SEARCH_TERM',
      reportDate: date,
      rowKey: id,
      impressions: 100,
      clicks: 5,
      purchases: 0,
      sales: 0,
      ...values,
    })
  const product = (id: string, store: string, sku: string, asin: string, tenant = tenantId) =>
    insertRow(h.client, 'FbaProduct', { id, tenantId: tenant, sellerAccountId: store, marketplaceId: US, sellerSku: sku, asin, title: `商品 ${sku}` })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'products_ads' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    const c = await h.createTenant('c')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-a2'
    const storeC = 'seller-a3'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await insertRow(h.client, 'SellerAccount', { id: storeC, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A3', logicalRegion: 'NA', displayName: '店铺 C（未绑定广告账户）' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    // 店铺 A 有两个广告档案（两个站点）；店铺 B 一个；店铺 C 没有；别的企业与企业 C 各一个
    for (const [id, tenant, store] of [
      ['ap-a', tenantId, storeA],
      ['ap-a2', tenantId, storeA],
      ['ap-b', tenantId, storeB],
      ['ap-o', otherTenantId, b.sellerAccountId],
      ['ap-c', c.tenantId, c.sellerAccountId],
    ] as const) {
      await insertRow(h.client, 'AdsProfile', { id, tenantId: tenant, profileId: `P-${id}`, sellerAccountId: store, bindingStatus: 'MANUAL' })
      await insertRow(h.client, 'AdsAccount', { id: `acct-${id}`, tenantId: tenant, adsProfileId: id, adsAccountId: `ACC-${id}`, name: id })
    }

    // 商品：同一个 ASIN 两个 SKU；店铺 B 的同 ASIN；没有广告行的 ASIN；店铺 C；别的企业
    await product('prod-a', storeA, 'SKU-1', 'B0AAA')
    await product('prod-a2', storeA, 'SKU-1B', 'B0AAA')
    await product('prod-b', storeB, 'SKU-B', 'B0AAA')
    await product('prod-new', storeA, 'SKU-N', 'B0NEW')
    await product('prod-u', storeC, 'SKU-U', 'B0CCC')
    await product('prod-o', b.sellerAccountId, 'SKU-O', 'B0AAA', otherTenantId)
    await product('prod-c', c.sellerAccountId, 'SKU-C', 'B0AAA', c.tenantId)

    // 被推广商品：B0AAA 在店铺 A 两个档案三个活动共花 30（销售 90，订单 4）；店铺 B 花 7；别的企业同 ASIN 花 50
    await metric('ap-a', 'c1', 'B0AAA', dayText(-1), { spend: 12, sales: 60, orders: 2 })
    await metric('ap-a', 'c1', 'B0AAA', dayText(-2), { spend: 8, sales: 20 })
    await metric('ap-a', 'c2', 'B0AAA', dayText(-1), { spend: 5, sales: 0, orders: 0 })
    await metric('ap-a2', 'c7', 'B0AAA', dayText(-1), { spend: 5, sales: 10 })
    await metric('ap-b', 'c9', 'B0AAA', dayText(-1), { spend: 7, sales: 14 })
    await metric('ap-o', 'co1', 'B0AAA', dayText(-1), { spend: 50, sales: 50 }, otherTenantId)
    await metric('ap-a', 'c1', 'B0OTHER', dayText(-1), { spend: 3, sales: 3 })
    // 不并入的行：加元、花费为空、范围之外
    await metric('ap-a', 'c4', 'B0AAA', dayText(-1), { spend: 99, sales: 99, currency: 'CAD' })
    await metric('ap-a', 'c5', 'B0AAA', dayText(-3), { spend: null, sales: 5 })
    await metric('ap-a', 'c1', 'B0AAA', dayText(-100), { spend: 50, sales: 50 })

    // 全部销售额：店铺 A 的 B0AAA 昨天 300、前天 100（大前天没有汇总）
    await asinSales(storeA, 'B0AAA', dayText(-1), 300)
    await asinSales(storeA, 'B0AAA', dayText(-2), 100)
    // 光环：店铺 A 有一笔 15（另一个档案或另一个 ASIN 的不算）；店铺 B 的档案有一笔 100；企业 C 没有转化商品行
    await converted('ap-a', 'B0AAA', 'B0XXX', true, 15)
    await converted('ap-a', 'B0AAA', 'B0AAA', false, 60)
    await converted('ap-b', 'B0AAA', 'B0YYY', true, 100)

    // 广告：B0AAA 在店铺 A 的三个广告组里（AG1 里还推广 B0ZZZ），AGX 里没有 B0AAA；店铺 B 的广告表没有任何行
    await campaign('cam-1', 'ap-a', 'c1', '春季推广')
    await campaign('cam-7', 'ap-a2', 'c7', '夏季推广')
    await campaign('cam-8', 'ap-a', 'c8', '秋季推广')
    await group('ag-1', 'ap-a', 'AG1', 'c1', '核心词组')
    await group('ag-7', 'ap-a2', 'AG7', 'c7', '词组七')
    await group('ag-8', 'ap-a', 'AG8', 'c8', '词组八')
    await group('ag-x', 'ap-a', 'AGX', 'c1', '别的词组')
    await ad('ad-1', 'ap-a', 'AG1', 'B0AAA', 'ENABLED')
    await ad('ad-2', 'ap-a', 'AG1', 'B0AAA', 'PAUSED')
    await ad('ad-3', 'ap-a', 'AG1', 'B0ZZZ', 'ENABLED')
    await ad('ad-4', 'ap-a2', 'AG7', 'B0AAA', 'enabled')
    await ad('ad-5', 'ap-a', 'AG8', 'B0AAA', 'ENABLED')
    await ad('ad-x', 'ap-a', 'AGX', 'B0OTHER', 'ENABLED')
    await insertRow(h.client, 'AdsMetric', {
      id: 'adm-1',
      ...base('ap-a'),
      reportDate: dayText(-1),
      adProduct: 'SPONSORED_PRODUCTS',
      entityType: 'AD_GROUP',
      entityId: 'AG1',
      impressions: 500,
      clicks: 40,
      cost: 30,
      sales: 90,
      purchases: 4,
    })
    // 投放对象与搜索词
    await insertRow(h.client, 'AdsKeyword', { id: 'kw-1', ...base('ap-a'), keywordId: 'K1', campaignId: 'c1', adGroupId: 'AG1', text: 'yoga mat', matchType: 'EXACT', bid: 1.5, state: 'ENABLED' })
    await insertRow(h.client, 'AdsTarget', { id: 'tg-1', ...base('ap-a'), targetId: 'T1', adGroupId: 'AG1', kind: 'PRODUCT', expression: 'asin="B0XYZ"', bid: 0.9, state: 'ENABLED' })
    await insertRow(h.client, 'AdsKeyword', { id: 'kw-x', ...base('ap-a'), keywordId: 'KX', campaignId: 'c1', adGroupId: 'AGX', text: 'unrelated word', matchType: 'BROAD', bid: 1, state: 'ENABLED' })
    await insertRow(h.client, 'AdsNegativeTarget', { id: 'neg-c', ...base('ap-a'), negativeId: 'N1', level: 'CAMPAIGN', campaignId: 'c1', expression: 'cheap yoga mat', matchType: 'NEGATIVE_EXACT' })
    await term('t1', 'ap-a', 'AG1', dayText(-1), { searchTerm: 'yoga mat', cost: 12, sales: 90, purchases: 3 })
    await term('t2', 'ap-a', 'AG1', dayText(-1), { searchTerm: 'cheap yoga mat', cost: 25 })
    await term('t3', 'ap-a', 'AG1', dayText(-2), { searchTerm: 'yoga block', cost: 4 })
    await term('t4', 'ap-a2', 'AG7', dayText(-1), { searchTerm: 'yoga mat', cost: 6, sales: 10, purchases: 1 })
    await term('t5', 'ap-a', 'AGX', dayText(-1), { searchTerm: 'unrelated word', cost: 40 })

    // 库存：B0AAA 断货（SKU-1 有快照，SKU-1B 没有）
    await insertRow(h.client, 'InventoryDailySnapshot', {
      id: 'sn-1',
      tenantId,
      sellerAccountId: storeA,
      snapshotDate: dayText(-1),
      sku: 'SKU-1',
      asin: 'B0AAA',
      sellable: 0,
      source: 'API',
      sourceUpdatedAt: new Date().toISOString(),
    })

    const read = ['products.read', 'ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['products.read'])
    other = await h.createMember(otherTenantId, 'other', read)
    tenantC = await h.createMember(c.tenantId, 'tenantc', read)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('没有 ads.read 返回 403（坏参数也是 403）；商品不存在或别的企业的商品返回 404；日期不合法返回 422', async () => {
    expect((await h.call(noAds.token, 'GET', '/products/prod-a/ads?from=bad')).status).toBe(403)
    await get(admin, '/products/nope/ads', 404)
    await get(admin, '/products/prod-o/ads', 404)
    await get(other, '/products/prod-a/ads', 404)
    expect((await h.call(admin.token, 'GET', '/products/prod-a/ads?from=bad&to=also-bad')).status).toBe(422)
  })

  it('同一 ASIN 的两个 SKU 看到同一份数据；两个档案三个活动合并；加元、花费为空、范围外、别的店铺与别的企业的同 ASIN 行都不并入并披露币种', async () => {
    const data = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(await get(admin, `/products/prod-a2/ads?${RANGE}`)).toEqual(data)
    expect(data).toMatchObject({ state: 'OK', currency: 'USD', range: { from: dayText(-3), to: dayText(-1), defaulted: false } })
    expect(data.note).toContain('非美元')
    expect(data.summary.totals).toMatchObject({ spend: 30, sales: 90, clicks: 40, orders: 4 })
    expect(data.summary.ratios.acos).toBeCloseTo(30 / 90)
    expect(data.summary).toMatchObject({ totalSales: 400, organicSales: 310, organicIssue: null, campaigns: 3, ads: { enabled: 3, total: 4 } })
    expect(data.summary.adsShare).toBeCloseTo(30 / 400)
  })

  it('逐日趋势：每一天一个点；没有广告行与没有销售汇总的日子是空，不是 0', async () => {
    const { trend } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(trend.map((point: { date: string }) => point.date)).toEqual([dayText(-3), dayText(-2), dayText(-1)])
    expect(trend[0]).toEqual({ date: dayText(-3), impressions: null, clicks: null, spend: null, sales: null, orders: null, totalSales: null, acos: null, adsShare: null })
    expect(trend[1]).toMatchObject({ spend: 8, sales: 20, totalSales: 100 })
    expect(trend[1].adsShare).toBeCloseTo(0.08)
    expect(trend[2]).toMatchObject({ spend: 22, sales: 70, orders: 3, totalSales: 300 })
    expect(trend[2].acos).toBeCloseTo(22 / 70)
  })

  it('光环销售只取这个店铺的档案：店铺 A 是 15，店铺 B 是它自己的 100，没有转化商品行的企业显示“尚未接入”', async () => {
    expect((await get(admin, `/products/prod-a/ads?${RANGE}`)).halo).toEqual({ state: 'OK', note: null, sales: 15 })
    expect((await get(admin, `/products/prod-b/ads?${RANGE}`)).halo).toEqual({ state: 'OK', note: null, sales: 100 })
    const never = (await get(tenantC, `/products/prod-c/ads?${RANGE}`)).halo
    expect(never).toMatchObject({ state: 'NOT_CONNECTED', sales: null })
    expect(never.note).toBeTruthy()
  })

  it('断货仍在花钱：库存与范围内花费一起给出', async () => {
    const { stock } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(stock).toMatchObject({ stock: 'OUT_OF_STOCK', sellable: 0, spend: 30 })
    expect(stock.snapshotDate).toBe(dayText(-1))
    expect((await get(admin, `/products/prod-b/ads?${RANGE}`)).stock).toMatchObject({ stock: 'UNKNOWN', sellable: null, spend: 7 })
  })

  it('活动：这个 ASIN 自己的数字按花费从高到低；没有活动记录的没有名称与链接编号；只有广告关联、没有报表行的排在最后，指标为空', async () => {
    const { campaigns } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(campaigns.state).toBe('OK')
    expect(campaigns.items.map((row: { key: string }) => row.key)).toEqual(['ap-a|c1', 'ap-a|c2', 'ap-a2|c7', 'ap-a|c8'])
    const [c1, c2, c7, c8] = campaigns.items
    expect(c1).toMatchObject({ id: 'cam-1', name: '春季推广', state: 'ENABLED', productLabel: expect.any(String), metrics: { spend: 20, sales: 80, orders: 3 } })
    expect(c2).toMatchObject({ id: null, name: null, metrics: { spend: 5, sales: 0 } })
    expect(c7).toMatchObject({ id: 'cam-7', metrics: { spend: 5, sales: 10 } })
    expect(c8).toMatchObject({ id: 'cam-8', name: '秋季推广', metrics: null })
  })

  it('广告组：只列广告表里关联这个 ASIN 的；写明本 ASIN 的广告数、组内商品数和组自己的合计；没有指标是空', async () => {
    const { adGroups, sharedNote } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(sharedNote).toContain('亚马逊没有按 ASIN 拆开')
    expect(adGroups.items.map((row: { adGroupId: string }) => row.adGroupId)).toEqual(['AG1', 'AG7', 'AG8'])
    const [ag1, ag7] = adGroups.items
    expect(ag1).toMatchObject({ id: 'ag-1', name: '核心词组', campaignName: '春季推广', asinAds: { enabled: 1, total: 2 }, groupAsins: 2, metrics: { spend: 30, sales: 90 } })
    expect(ag7).toMatchObject({ asinAds: { enabled: 1, total: 1 }, groupAsins: 1, metrics: null })
  })

  it('投放对象与搜索词：别的广告组的不出现；搜索词跨档案合并并标出已投放与已否定', async () => {
    const { targets, searchTerms } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(targets.items.map((row: { expression: string }) => row.expression).sort()).toEqual(['asin="B0XYZ"', 'yoga mat'])
    expect(searchTerms.items.map((row: { searchTerm: string }) => row.searchTerm)).toEqual(['cheap yoga mat', 'yoga mat', 'yoga block'])
    expect(searchTerms.items[0]).toMatchObject({ status: 'NEGATED', metrics: { spend: 25 } })
    expect(searchTerms.items[1]).toMatchObject({ status: 'TARGETED', metrics: { spend: 18, sales: 100, orders: 4, clicks: 10 } })
    expect(searchTerms.items[2]).toMatchObject({ status: 'UNTARGETED' })
    expect(searchTerms.matchBasis).toBeTruthy()
    expect(searchTerms.truncated).toBe(false)
  })

  it('品牌分析缺口恒为“尚未接入”（P4-04 之前）', async () => {
    const { brandGaps } = await get(admin, `/products/prod-a/ads?${RANGE}`)
    expect(brandGaps.state).toBe('NOT_CONNECTED')
    expect(brandGaps.note).toContain('P4-04')
  })

  it('店铺 B：只有它自己的档案；广告表没同步过，广告组、投放对象与搜索词是“尚未接入”，没有全部销售额时占比为空', async () => {
    const data = await get(admin, `/products/prod-b/ads?${RANGE}`)
    expect(data.state).toBe('OK')
    expect(data.summary).toMatchObject({ totalSales: null, adsShare: null, organicSales: null, campaigns: 1, ads: null })
    expect(data.summary.totals).toMatchObject({ spend: 7, sales: 14 })
    for (const key of ['adGroups', 'targets', 'searchTerms']) expect(data[key], key).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
    expect(data.campaigns.items.map((row: { key: string }) => row.key)).toEqual(['ap-b|c9'])
  })

  it('已绑定广告账户、范围内这个 ASIN 没有报表行：“尚无记录”，趋势全空，广告组是“尚无记录”且说明依赖关系', async () => {
    const data = await get(admin, `/products/prod-new/ads?${RANGE}`)
    expect(data).toMatchObject({ state: 'NO_DATA', summary: { totals: { spend: null, sales: null }, ads: null, campaigns: 0 } })
    expect(data.note).toContain('没有被推广商品的报表行')
    expect(data.trend).toHaveLength(3)
    expect(data.trend.every((point: { spend: number | null }) => point.spend === null)).toBe(true)
    expect(data.campaigns).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(data.adGroups.state).toBe('NO_DATA')
    expect(data.targets.state).toBe('NO_DATA')
  })

  it('广告账户已绑定但报表从没同步过：整页“尚未接入”；店铺没有绑定广告账户：“尚未接入”并说明', async () => {
    const never = await get(tenantC, `/products/prod-c/ads?${RANGE}`)
    expect(never).toMatchObject({ state: 'NOT_CONNECTED', campaigns: { state: 'NOT_CONNECTED' }, summary: { totals: { spend: null } } })
    expect(never.note).toContain('还没有同步')
    const unbound = await get(admin, `/products/prod-u/ads?${RANGE}`)
    expect(unbound).toMatchObject({ state: 'NOT_CONNECTED', trend: [], campaigns: { state: 'NOT_CONNECTED', items: [] } })
    expect(unbound.note).toContain('没有绑定广告账户')
  })

  it('范围之外只有旧数据：指定较早的日期范围只合计那一段', async () => {
    const data = await get(admin, `/products/prod-a/ads?from=${dayText(-110)}&to=${dayText(-90)}`)
    expect(data.summary.totals).toMatchObject({ spend: 50, sales: 50 })
    expect(data.campaigns.items.map((row: { key: string }) => row.key)).toEqual(['ap-a|c1', 'ap-a2|c7', 'ap-a|c8'])
  })

  it('数据范围：只看店铺 A 的成员能看店铺 A 的商品、看不到店铺 B 的；只看店铺 B 的成员相反；数字与全部店铺成员一致', async () => {
    expect(await get(scopedA, `/products/prod-a/ads?${RANGE}`)).toEqual(await get(admin, `/products/prod-a/ads?${RANGE}`))
    await get(scopedA, `/products/prod-b/ads?${RANGE}`, 404)
    await get(scopedB, `/products/prod-a/ads?${RANGE}`, 404)
    expect((await get(scopedB, `/products/prod-b/ads?${RANGE}`)).summary.totals).toMatchObject({ spend: 7 })
  })

  it('不选日期：默认最近 30 天并写明', async () => {
    const data = await get(admin, '/products/prod-a/ads')
    expect(data.range.defaulted).toBe(true)
    expect(data.trend).toHaveLength(30)
    expect(data.summary.totals.spend).toBe(30)
  })
})
