import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 词级中心（P3-10，真实数据库 + 完整应用）：搜索词按词合并多个活动与店铺并按活动判断“已投放/已否定”（关键词、投放表经广告组归到活动、广告组级否定算活动已否定）、
// 异常分组、投放对象（竞价与状态只给当前页补）、否定词库（库内分页）、四象限、词根分析、词级分析页（趋势、关系、投放与否定记录、推荐与历史动作）、
// 数据范围、企业隔离、筛选排序翻页与游标绑定条件、非美元/花费为空/“其他”/范围外的行不并入。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

describe('词级中心（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let admin: Member
  let scopedA: Member
  let scopedB: Member
  let noAds: Member
  let other: Member
  let empty: Member
  let brandA: Member
  let brandB: Member
  let brandOther: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const keysOf = (data: Record<string, any>) => (data.items as Array<{ key: string }>).map(item => item.key)
  const termsOf = (data: Record<string, any>) => (data.items as Array<{ searchTerm: string }>).map(item => item.searchTerm)
  const rowOf = (data: Record<string, any>, searchTerm: string) => (data.items as Array<Record<string, any>>).find(item => item.searchTerm === searchTerm)!

  let seq = 0
  const metric = (level: 'SEARCH_TERM' | 'KEYWORD', profile: string, campaignId: string, date: string, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'AdsTermMetric', {
      id: `tm-${++seq}`,
      tenantId: tenant,
      adsProfileId: profile,
      adsAccountId: `ACC-${profile}`,
      adProduct: 'SPONSORED_PRODUCTS',
      level,
      externalCampaignId: campaignId,
      adGroupId: 'AG1',
      reportDate: date,
      rowKey: `rk-${seq}`,
      impressions: 100,
      clicks: 10,
      sales: 0,
      purchases: 0,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const term = (profile: string, campaignId: string, date: string, searchTerm: string, values: Record<string, unknown>, tenant = tenantId) =>
    metric('SEARCH_TERM', profile, campaignId, date, { searchTerm, keywordText: 'yoga mat', matchType: 'EXACT', ...values }, tenant)
  const keyword = (profile: string, campaignId: string, adGroupId: string, targetId: string, keywordText: string, values: Record<string, unknown>) =>
    metric('KEYWORD', profile, campaignId, dayText(-1), { adGroupId, targetId, keywordId: targetId, keywordText, matchType: 'EXACT', ...values })
  const entity = (table: string, id: string, profile: string, values: Record<string, unknown>) =>
    insertRow(h.client, table, { id, tenantId, adsProfileId: profile, adsAccountId: `ACC-${profile}`, sourceUpdatedAt: '2026-10-01T00:00:00Z', ...values })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ad_terms' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    const c = await h.createTenant('c')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    const storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    // 店铺 A 两个广告档案；店铺 B 一个；一个没有绑定店铺；别的企业一个
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL', displayName: '账户 A' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a2', tenantId, profileId: 'P-A2', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P-F' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const [profile, tenant] of [
      ['ap-a', tenantId],
      ['ap-a2', tenantId],
      ['ap-b', tenantId],
      ['ap-free', tenantId],
      ['ap-o', otherTenantId],
    ] as const)
      await insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })

    // 活动、广告组、关键词、投放、否定
    await entity('AdsCampaign', 'cam-1', 'ap-a', { adsAccountId: 'ACC-ap-a', externalCampaignId: 'c1', adProduct: 'SPONSORED_PRODUCTS', name: '春季推广', state: 'ENABLED' })
    await entity('AdsCampaign', 'cam-2', 'ap-a', { externalCampaignId: 'c2', adProduct: 'SPONSORED_PRODUCTS', name: '夏季推广', state: 'ENABLED' })
    await entity('AdsAdGroup', 'ag-1', 'ap-a', { adGroupId: 'AG1', campaignId: 'c1', name: '核心词组', state: 'ENABLED' })
    await entity('AdsAdGroup', 'ag-2', 'ap-a', { adGroupId: 'AG2', campaignId: 'c2', name: '长尾词组', state: 'ENABLED' })
    await entity('AdsKeyword', 'kw-1', 'ap-a', { keywordId: 'K1', campaignId: 'c1', adGroupId: 'AG1', text: 'Yoga Mat', matchType: 'EXACT', bid: 1.5, state: 'ENABLED' })
    await entity('AdsKeyword', 'kw-2', 'ap-a', { keywordId: 'K2', campaignId: 'c2', adGroupId: 'AG2', text: 'yoga block', matchType: 'EXACT', bid: 1.1, state: 'PAUSED' })
    await entity('AdsTarget', 'tg-2', 'ap-a', { targetId: 'T2', adGroupId: 'AG2', kind: 'KEYWORD', expression: 'foam roller', bid: 0.8, state: 'ENABLED' })
    await entity('AdsNegativeTarget', 'neg-c', 'ap-a', { negativeId: 'N1', level: 'CAMPAIGN', campaignId: 'c1', expression: 'cheap yoga mat', matchType: 'NEGATIVE_EXACT' })
    await entity('AdsNegativeTarget', 'neg-g', 'ap-a', { negativeId: 'N2', level: 'AD_GROUP', campaignId: 'c2', adGroupId: 'AG2', expression: 'free yoga', matchType: 'NEGATIVE_PHRASE' })
    await entity('AdsNegativeTarget', 'neg-b', 'ap-b', { negativeId: 'N5', level: 'CAMPAIGN', campaignId: 'c9', expression: 'b negative', matchType: 'NEGATIVE_EXACT' })
    await insertRow(h.client, 'AdsNegativeTarget', {
      id: 'neg-o',
      tenantId: otherTenantId,
      adsProfileId: 'ap-o',
      adsAccountId: 'ACC-ap-o',
      negativeId: 'N9',
      level: 'CAMPAIGN',
      campaignId: 'co',
      expression: 'other negative',
      matchType: 'NEGATIVE_EXACT',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })

    // 搜索词层：见各用例注释里的合计
    await term('ap-a', 'c1', dayText(-1), 'Yoga Mat', { impressions: 100, clicks: 20, cost: 30, sales: 100, purchases: 3 })
    await term('ap-a', 'c1', dayText(-2), 'Yoga Mat', { impressions: 50, clicks: 10, cost: 10, sales: 60, purchases: 1 })
    await term('ap-a', 'c2', dayText(-1), 'yoga mat', { impressions: 80, clicks: 8, cost: 10, sales: 0, purchases: 0, adGroupId: 'AG2' })
    await term('ap-a2', 'c7', dayText(-1), 'YOGA MAT', { impressions: 20, clicks: 2, cost: 5, sales: 10, purchases: 1 })
    await term('ap-b', 'c9', dayText(-2), 'yoga mat', { impressions: 30, clicks: 3, cost: 3, sales: 6, purchases: 1, adGroupId: 'AG9', campaignName: 'ap-b 活动' })
    await term('ap-a', 'c1', dayText(-1), 'cheap yoga mat', { impressions: 40, clicks: 12, cost: 8 })
    await term('ap-a', 'c2', dayText(-1), 'free yoga', { impressions: 30, clicks: 14, cost: 6, adGroupId: 'AG2' })
    await term('ap-a', 'c1', dayText(-1), 'yoga strap', { impressions: 60, clicks: 15, cost: 7 })
    await term('ap-free', 'cf', dayText(-1), 'yoga strap', { impressions: 10, clicks: 2, cost: 2 })
    await term('ap-a', 'c1', dayText(-1), 'best yoga blocks', { impressions: 50, clicks: 10, cost: 6, sales: 60, purchases: 2 })
    await term('ap-a', 'c2', dayText(-1), 'foam roller', { impressions: 200, clicks: 40, cost: 30, adGroupId: 'AG2' })
    // 不并入的行：亚马逊合并成“其他”（单独披露花费）、加元、花费为空、范围外的旧数据、别的企业
    await term('ap-a', 'c1', dayText(-1), 'other', { cost: 9, otherBucket: true })
    await term('ap-a', 'c1', dayText(-1), 'canada term', { cost: 99, currency: 'CAD' })
    await term('ap-a', 'c1', dayText(-1), 'null cost term', { cost: null })
    await term('ap-a', 'c1', dayText(-100), 'old term', { cost: 50 })
    await term('ap-o', 'co', dayText(-1), 'other tenant term', { cost: 11, sales: 22, purchases: 1 }, otherTenantId)

    // 投放层
    await keyword('ap-a', 'c1', 'AG1', 'K1', 'Yoga Mat', { impressions: 150, clicks: 30, cost: 40, sales: 150, purchases: 4 })
    await keyword('ap-a', 'c2', 'AG2', 'K2', 'yoga block', { clicks: 22, cost: 25 })
    await keyword('ap-a', 'c2', 'AG2', 'T2', 'foam roller', { matchType: null, clicks: 20, cost: 12, sales: 120, purchases: 4 })
    await keyword('ap-b', 'c9', 'AG9', 'K9', 'yoga mat', { matchType: 'PHRASE', clicks: 3, cost: 3, sales: 6, purchases: 1, campaignName: 'ap-b 活动' })
    await keyword('ap-a', 'c1', 'AG1', 'K-NONE', 'lonely word', { clicks: 1, cost: 1 })

    // 调价记录与前后指标：调价在 3 天前，之前窗口（4 天前）花 10，之后窗口（2 天前）花 20
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
    for (const [id, date, cost] of [
      ['am-1', dayText(-4), 10],
      ['am-2', dayText(-2), 20],
    ] as const)
      await insertRow(h.client, 'AdsMetric', {
        id,
        tenantId,
        adsProfileId: 'ap-a',
        adsAccountId: 'ACC-ap-a',
        reportDate: date,
        adProduct: 'SPONSORED_PRODUCTS',
        entityType: 'KEYWORD',
        entityId: 'K1',
        impressions: 100,
        clicks: 10,
        cost,
        sales: 40,
        purchases: 2,
        sourceUpdatedAt: '2026-10-01T00:00:00Z',
      })

    const read = ['ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', read)
    empty = await h.createMember(c.tenantId, 'empty', read)
    brandA = await h.createMember(tenantId, 'branda', [...read, 'analytics.brand.read'])
    brandB = await h.createMember(tenantId, 'brandb', [...read, 'analytics.brand.read'], { scopes: [{ sellerAccountId: storeB }] })
    brandOther = await h.createMember(otherTenantId, 'brandother', [...read, 'analytics.brand.read'])
  }, 120_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有 ads.read 返回 403；全部店铺成员按花费从高到低看到合并后的词，别的企业的数据看不到', async () => {
    expect((await h.call(noAds.token, 'GET', '/ads/terms')).status).toBe(403)
    const data = await get(admin, '/ads/terms')
    expect(termsOf(data)).toEqual(['Yoga Mat', 'foam roller', 'yoga strap', 'cheap yoga mat', 'best yoga blocks', 'free yoga'])
    expect(data).toMatchObject({ state: 'OK', range: { defaulted: true }, currency: 'USD', undisclosedSpend: 9, targetingNote: null })
    expect(data.write.state).toBe('NOT_CONNECTED')
    expect(termsOf(await get(other, '/ads/terms'))).toEqual(['other tenant term'])
  })

  it('同一个词的不同写法、多个活动与店铺合成一行：合计、活动数、店铺数、状态；汇总与异常计数', async () => {
    const data = await get(admin, '/ads/terms')
    const row = rowOf(data, 'Yoga Mat')
    expect(row).toMatchObject({
      key: 'yoga mat',
      status: 'TARGETED',
      stores: 2,
      campaigns: { total: 4, targeted: 1, negated: 0 },
      totals: { impressions: 280, clicks: 43, spend: 58, sales: 176, orders: 6 },
      anomalies: [],
    })
    expect(row.ratios.acos).toBeCloseTo(58 / 176)
    expect(data.summary).toMatchObject({
      total: 6,
      totals: { spend: 117, sales: 236, clicks: 136, orders: 8 },
      anomalies: { HIGH_SPEND_NO_ORDER: 1, SCALE_UP: 0, ADD_KEYWORD: 1, NEGATIVE_CANDIDATE: 1 },
    })
    // 未绑定店铺的广告账户不算店铺：yoga strap 在两个活动里出现，店铺只有 A
    expect(rowOf(data, 'yoga strap')).toMatchObject({ stores: 1, campaigns: { total: 2, targeted: 0, negated: 0 }, totals: { spend: 9, clicks: 17 } })
  })

  it('状态按活动判断：关键词、经广告组归到活动的投放、活动级与广告组级否定；异常分组', async () => {
    const data = await get(admin, '/ads/terms')
    expect(rowOf(data, 'cheap yoga mat')).toMatchObject({ status: 'NEGATED', anomalies: [] })
    expect(rowOf(data, 'free yoga')).toMatchObject({ status: 'NEGATED', campaigns: { total: 1, negated: 1 } })
    expect(rowOf(data, 'foam roller')).toMatchObject({ status: 'TARGETED', anomalies: ['HIGH_SPEND_NO_ORDER'] })
    expect(rowOf(data, 'yoga strap')).toMatchObject({ status: 'UNTARGETED', anomalies: ['NEGATIVE_CANDIDATE'] })
    expect(rowOf(data, 'best yoga blocks')).toMatchObject({ status: 'UNTARGETED', anomalies: ['ADD_KEYWORD'] })
  })

  it('筛选：状态、异常分组、关键字；汇总在状态与关键字之后、异常分组之前', async () => {
    const untargeted = await get(admin, '/ads/terms?status=UNTARGETED')
    expect(termsOf(untargeted)).toEqual(['yoga strap', 'best yoga blocks'])
    expect(untargeted.summary).toMatchObject({ total: 2, anomalies: { ADD_KEYWORD: 1, NEGATIVE_CANDIDATE: 1 } })
    expect(termsOf(await get(admin, '/ads/terms?status=NEGATED'))).toEqual(['cheap yoga mat', 'free yoga'])
    const negative = await get(admin, '/ads/terms?anomaly=NEGATIVE_CANDIDATE')
    expect(termsOf(negative)).toEqual(['yoga strap'])
    expect(negative.summary.total).toBe(6)
    expect(termsOf(await get(admin, '/ads/terms?q=ROLLER'))).toEqual(['foam roller'])
    const none = await get(admin, '/ads/terms?q=nothing-like-this')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.note).toContain('没有符合筛选条件')
    expect((await h.call(admin.token, 'GET', '/ads/terms?tab=targets&status=TARGETED')).status).toBe(422)
  })

  it('排序：词、比率；空值永远在最后', async () => {
    expect(termsOf(await get(admin, '/ads/terms?sort=term:asc'))).toEqual(['best yoga blocks', 'cheap yoga mat', 'foam roller', 'free yoga', 'Yoga Mat', 'yoga strap'])
    const acos = termsOf(await get(admin, '/ads/terms?sort=acos:asc'))
    expect(acos.slice(0, 2)).toEqual(['best yoga blocks', 'Yoga Mat'])
    expect(termsOf(await get(admin, '/ads/terms?sort=acos:desc')).slice(0, 2)).toEqual(['Yoga Mat', 'best yoga blocks'])
  })

  it('数据范围：只看店铺 A 的成员看不到店铺 B 与未绑定账户的行；只看店铺 B 的成员没有投放与否定记录，状态说明“不代表真的没有投放”', async () => {
    const a = await get(scopedA, '/ads/terms')
    expect(rowOf(a, 'Yoga Mat')).toMatchObject({ stores: 1, campaigns: { total: 3 }, totals: { spend: 55 } })
    expect(rowOf(a, 'yoga strap').totals.spend).toBe(7)
    expect(a.undisclosedSpend).toBe(9)
    const b = await get(scopedB, '/ads/terms')
    expect(termsOf(b)).toEqual(['yoga mat'])
    expect(rowOf(b, 'yoga mat')).toMatchObject({ status: 'UNTARGETED', totals: { spend: 3 } })
    expect(b.undisclosedSpend).toBeNull()
    expect(keysOf(await get(admin, `/ads/terms?storeIds=seller-a2`))).toEqual(['yoga mat'])
  })

  it('翻页：游标带出下一页；换了筛选条件的旧游标返回 400', async () => {
    const first = await get(admin, '/ads/terms?pageSize=4')
    expect(termsOf(first)).toHaveLength(4)
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 6 })
    const second = await get(admin, `/ads/terms?pageSize=4&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    expect(termsOf(second)).toEqual(['best yoga blocks', 'free yoga'])
    expect(second.pageInfo.hasMore).toBe(false)
    expect((await h.call(admin.token, 'GET', `/ads/terms?pageSize=4&status=NEGATED&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
  })

  it('投放对象：按花费排序；竞价与状态来自已同步的关键词与投放，没有同步为空；名称缺失时用报表里的名称；异常分组与筛选', async () => {
    const data = await get(admin, '/ads/terms?tab=targets')
    expect(data.items.map((item: { expression: string }) => item.expression)).toEqual(['Yoga Mat', 'yoga block', 'foam roller', 'yoga mat', 'lonely word'])
    expect(data.summary).toMatchObject({ total: 5, totals: { spend: 81, sales: 276, clicks: 76, orders: 9 }, anomalies: { HIGH_SPEND_NO_ORDER: 1, SCALE_UP: 1 } })
    const byExpression = (name: string) => (data.items as Array<Record<string, any>>).find(item => item.expression === name)!
    expect(byExpression('Yoga Mat')).toMatchObject({ campaignName: '春季推广', adGroupName: '核心词组', bid: 1.5, state: 'ENABLED', matchType: 'EXACT', anomalies: [] })
    expect(byExpression('yoga block')).toMatchObject({ campaignName: '夏季推广', adGroupName: '长尾词组', bid: 1.1, state: 'PAUSED', anomalies: ['HIGH_SPEND_NO_ORDER'] })
    expect(byExpression('foam roller')).toMatchObject({ bid: 0.8, state: 'ENABLED', anomalies: ['SCALE_UP'] })
    expect(byExpression('yoga mat')).toMatchObject({ campaignName: 'ap-b 活动', adGroupName: null, bid: null, state: null, storeName: '店铺 B' })
    expect(byExpression('lonely word')).toMatchObject({ bid: null, state: null })
    expect((await get(admin, '/ads/terms?tab=targets&matchType=exact')).items).toHaveLength(3)
    expect((await get(admin, '/ads/terms?tab=targets&anomaly=SCALE_UP')).items.map((item: { expression: string }) => item.expression)).toEqual(['foam roller'])
    expect((await get(admin, '/ads/terms?tab=targets&q=FOAM')).items).toHaveLength(1)
    expect((await get(scopedA, '/ads/terms?tab=targets')).items).toHaveLength(4)
  })

  it('否定词库：库内分页，默认按词排序；活动、广告组与店铺名；筛选；数据范围；企业隔离', async () => {
    const data = await get(admin, '/ads/negatives')
    expect(data.items.map((item: { expression: string }) => item.expression)).toEqual(['b negative', 'cheap yoga mat', 'free yoga'])
    expect(data).toMatchObject({ state: 'OK', total: 3 })
    expect(data.items[1]).toMatchObject({ level: 'CAMPAIGN', campaignName: '春季推广', adGroupId: null, accountName: '账户 A' })
    expect(data.items[2]).toMatchObject({ level: 'AD_GROUP', campaignName: '夏季推广', adGroupName: '长尾词组', externalCampaignId: 'c2' })
    expect(data.items[0].storeName).toBe('店铺 B')
    expect((await get(admin, '/ads/negatives?level=AD_GROUP')).items).toHaveLength(1)
    expect((await get(admin, '/ads/negatives?matchType=negative_exact')).items).toHaveLength(2)
    expect((await get(admin, '/ads/negatives?q=YOGA')).items).toHaveLength(2)
    expect((await get(admin, '/ads/terms?tab=negatives&sort=term:desc')).items[0].expression).toBe('free yoga')
    expect((await get(scopedA, '/ads/negatives')).total).toBe(2)
    expect((await get(other, '/ads/negatives')).items.map((item: { expression: string }) => item.expression)).toEqual(['other negative'])
    const page = await get(admin, '/ads/negatives?pageSize=2')
    expect(page.pageInfo).toMatchObject({ hasMore: true, approxTotal: 3 })
    const next = await get(admin, `/ads/negatives?pageSize=2&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)
    expect(next.items.map((item: { expression: string }) => item.expression)).toEqual(['free yoga'])
    expect((await h.call(admin.token, 'GET', '/ads/negatives?tab=targets')).status).toBe(422)
    const none = await get(admin, '/ads/negatives?q=zzzz')
    expect(none).toMatchObject({ state: 'NO_DATA', total: 0 })
  })

  it('四象限：分界线是平均花费与整体广告成本销售比；没有广告销售额的词不画、单独计数；异常分组与对象切换', async () => {
    const data = await get(admin, '/ads/terms?tab=quadrant')
    expect(data).toMatchObject({ state: 'OK', subject: 'search-terms', total: 2, counts: { STAR: 0, WASTE: 1, POTENTIAL: 1, LOW: 0 }, withoutSales: { terms: 4, spend: 53 } })
    expect(data.spendLine).toBe(32)
    expect(data.acosLine).toBeCloseTo(64 / 236)
    expect(data.points.map((point: { name: string; quadrant: string }) => [point.name, point.quadrant])).toEqual([
      ['Yoga Mat', 'WASTE'],
      ['best yoga blocks', 'POTENTIAL'],
    ])
    const targets = await get(admin, '/ads/terms?tab=quadrant&subject=targets')
    expect(targets).toMatchObject({ subject: 'targets', total: 3, counts: { STAR: 0, WASTE: 1, POTENTIAL: 1, LOW: 1 }, withoutSales: { terms: 2, spend: 26 } })
    expect((await get(admin, '/ads/terms?tab=quadrant&subject=targets&anomaly=SCALE_UP')).total).toBe(1)
    const none = await get(admin, '/ads/terms?tab=quadrant&anomaly=SCALE_UP')
    expect(none).toMatchObject({ state: 'OK', total: 0, points: [], spendLine: null, acosLine: null })
  })

  it('词根分析：词数、店铺数、合计与例子词；单复数合并；排序、关键字与翻页', async () => {
    const data = await get(admin, '/ads/terms/roots')
    const root = (name: string) => (data.items as Array<Record<string, any>>).find(item => item.root === name)!
    expect(data).toMatchObject({ state: 'OK', termCount: 6 })
    expect(data.items[0].root).toBe('yoga')
    expect(root('yoga')).toMatchObject({ terms: 5, stores: 2, totals: { spend: 87 } })
    expect(root('yoga').examples[0]).toEqual({ term: 'Yoga Mat', spend: 58 })
    expect(root('mat')).toMatchObject({ terms: 2, totals: { spend: 66 } })
    expect(root('block')).toMatchObject({ terms: 1, forms: ['blocks'] })
    expect(data.items.map((item: { root: string }) => item.root)).toEqual(['yoga', 'mat', 'foam', 'roller', 'strap', 'cheap', 'best', 'block', 'free'])
    expect((await get(admin, '/ads/terms/roots?q=OGA')).items.map((item: { root: string }) => item.root)).toEqual(['yoga'])
    expect((await get(admin, '/ads/terms/roots?sort=terms:desc')).items.slice(0, 2).map((item: { root: string }) => item.root)).toEqual(['yoga', 'mat'])
    const page = await get(admin, '/ads/terms/roots?pageSize=4')
    expect(page.pageInfo).toMatchObject({ hasMore: true, approxTotal: 9 })
    expect((await get(scopedB, '/ads/terms/roots')).items.map((item: { root: string }) => item.root)).toEqual(['mat', 'yoga'])
    expect(await get(admin, '/ads/terms/roots?q=nothing-like-this')).toMatchObject({ state: 'NO_DATA', items: [] })
  })

  it('词级分析页：合计、状态、活动数、趋势、关系、投放记录、历史动作与调价前后对照；写法不分大小写', async () => {
    const data = await get(admin, '/ads/terms/detail?term=YOGA%20MAT')
    expect(data).toMatchObject({
      term: 'Yoga Mat',
      state: 'OK',
      status: 'TARGETED',
      campaigns: { total: 4, targeted: 1, negated: 0 },
      totals: { spend: 58, sales: 176, orders: 6 },
      anomalies: [],
      advice: [],
      brand: null,
    })
    expect(data.write.state).toBe('NOT_CONNECTED')
    expect(data.trend).toHaveLength(30)
    const point = (offset: number) => data.trend.find((item: { date: string }) => item.date === dayText(offset))
    expect(point(-1)).toMatchObject({ spend: 45, orders: 4 })
    expect(point(-2)).toMatchObject({ spend: 13, orders: 2 })
    expect(point(-5)).toMatchObject({ spend: null, orders: null })
    expect(data.relations.items).toHaveLength(4)
    expect(data.relations.items.find((item: { externalCampaignId: string }) => item.externalCampaignId === 'c1')).toMatchObject({ campaignName: '春季推广', status: 'TARGETED', totals: { spend: 40 } })
    expect(data.relations.items.find((item: { externalCampaignId: string }) => item.externalCampaignId === 'c2')).toMatchObject({ status: 'UNTARGETED', adGroupName: '长尾词组' })
    expect(data.targeting).toMatchObject({ state: 'OK' })
    expect(data.targeting.items).toEqual([expect.objectContaining({ kind: 'KEYWORD', expression: 'Yoga Mat', bid: 1.5, state: 'ENABLED', externalCampaignId: 'c1' })])
    expect(data.history.state).toBe('OK')
    expect(data.history.items).toHaveLength(1)
    expect(data.history.items[0]).toMatchObject({
      beforeBid: 1.2,
      afterBid: 1.5,
      expression: 'Yoga Mat',
      source: 'system',
      before: { daysWithData: 1, totals: { spend: 10 } },
      after: { daysWithData: 1, totals: { spend: 20 } },
    })
  })

  it('词级分析页：推荐动作按状态与异常分组；已否定的词显示否定记录；这个词没有数据是“尚无记录”', async () => {
    const roller = await get(admin, '/ads/terms/detail?term=foam%20roller')
    expect(roller).toMatchObject({ status: 'TARGETED', anomalies: ['HIGH_SPEND_NO_ORDER'] })
    expect(roller.advice.map((item: { action: string }) => item.action)).toEqual(['LOWER_BID'])
    expect(roller.advice[0].reason).toContain('近 30 天')
    const strap = await get(admin, '/ads/terms/detail?term=yoga%20strap')
    expect(strap.advice.map((item: { action: string }) => item.action)).toEqual(['NEGATE'])
    expect(strap.targeting).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(strap.history).toMatchObject({ state: 'NO_DATA', items: [] })
    const cheap = await get(admin, '/ads/terms/detail?term=cheap%20yoga%20mat')
    expect(cheap).toMatchObject({ status: 'NEGATED', advice: [] })
    expect(cheap.targeting.items).toEqual([expect.objectContaining({ kind: 'NEGATIVE', matchType: 'NEGATIVE_EXACT', externalCampaignId: 'c1' })])
    const unknown = await get(admin, '/ads/terms/detail?term=zzz-unknown')
    expect(unknown).toMatchObject({ state: 'NO_DATA', status: null, totals: null, ratios: null, trend: [], advice: [] })
    expect(unknown.note).toContain('没有搜索词报表行')
  })

  it('词级分析页：数据范围与企业隔离；没同步过是“尚未接入”；没有权限 403；缺少词 422', async () => {
    const b = await get(scopedB, '/ads/terms/detail?term=yoga%20mat')
    expect(b).toMatchObject({ totals: { spend: 3 }, campaigns: { total: 1 }, targeting: { items: [] } })
    expect(b.history.note).toContain('没有对应的关键词')
    expect(await get(other, '/ads/terms/detail?term=yoga%20mat')).toMatchObject({ state: 'NO_DATA', totals: null })
    expect(await get(empty, '/ads/terms/detail?term=yoga%20mat')).toMatchObject({ state: 'NOT_CONNECTED', totals: null, targeting: { state: 'NOT_CONNECTED' } })
    expect((await h.call(noAds.token, 'GET', '/ads/terms/detail?term=yoga')).status).toBe(403)
    expect((await h.call(admin.token, 'GET', '/ads/terms/detail')).status).toBe(422)
  })

  it('所选范围没有记录是“尚无记录”；从没同步过是“尚未接入”（每个页签）', async () => {
    const quiet = await get(admin, `/ads/terms?from=${dayText(-300)}&to=${dayText(-270)}`)
    expect(quiet).toMatchObject({ state: 'NO_DATA', items: [], range: { defaulted: false } })
    expect(quiet.note).toContain('没有搜索词报表行')
    for (const path of ['/ads/terms', '/ads/terms?tab=targets', '/ads/negatives', '/ads/terms?tab=quadrant', '/ads/terms/roots']) {
      const never = await get(empty, path)
      expect(never.state, path).toBe('NOT_CONNECTED')
      expect(never.note, path).toContain('还没有同步')
    }
    const old = await get(admin, `/ads/terms?from=${dayText(-110)}&to=${dayText(-90)}`)
    expect(termsOf(old)).toEqual(['old term'])
  })

  it('词级分析页：品牌分析份额只给有品牌分析读取权限的人，取最近周期、按店铺汇总我方 ASIN；范围与企业隔离', async () => {
    const sqp = (tenant: string, store: string, periodStart: string, periodEnd: string, asin: string, values: Record<string, unknown>) =>
      insertRow(h.client, 'BrandSearchQueryPerformance', {
        id: `bsqp-${++seq}`,
        tenantId: tenant,
        sellerAccountId: store,
        reportPeriod: 'WEEK',
        periodStart,
        periodEnd,
        asin,
        searchQuery: 'yoga mat',
        sourceUpdatedAt: '2026-10-20T00:00:00Z',
        ...values,
      })
    // 旧周期不该被取到；最近周期里店铺 A 有两个我方 ASIN（市场总量相同、我方数量相加）
    await sqp(tenantId, storeA, '2026-09-27', '2026-10-03', 'B0AAAAAAA1', { searchVolume: 1000, clicksTotal: 100, clicksOwn: 90, purchasesTotal: 50, purchasesOwn: 45 })
    await sqp(tenantId, storeA, '2026-10-04', '2026-10-10', 'B0AAAAAAA1', { searchVolume: 2000, clicksTotal: 200, clicksOwn: 20, purchasesTotal: 40, purchasesOwn: 4 })
    await sqp(tenantId, storeA, '2026-10-04', '2026-10-10', 'B0AAAAAAA2', {
      searchVolume: 2000,
      clicksTotal: 200,
      clicksOwn: 30,
      purchasesTotal: 40,
      purchasesOwn: 6,
      sourceUpdatedAt: '2026-10-21T00:00:00Z',
    })
    const otherStore = (await h.client.query('SELECT id FROM "SellerAccount" WHERE "tenantId" = $1', [otherTenantId])).rows[0].id as string
    await sqp(otherTenantId, otherStore, '2026-10-11', '2026-10-17', 'B0ZZZZZZZ1', { searchVolume: 9, clicksTotal: 9, clicksOwn: 9 })

    const a = await get(brandA, '/ads/terms/detail?term=YOGA%20MAT')
    expect(a.brand).toMatchObject({ searchVolume: 2000, clickShare: 0.25, purchaseShare: 0.25 })
    expect(a.brand.periodText).toBe('周：2026-10-04 至 2026-10-10')
    expect(a.brand.sourceUpdatedAt).toBe('2026-10-21T00:00:00.000Z')
    // 没有品牌分析读取权限：整块为 null；店铺 B 的成员看不到店铺 A 的品牌数据；别的企业看不到；这个词没有记录也是 null
    expect((await get(admin, '/ads/terms/detail?term=YOGA%20MAT')).brand).toBeNull()
    expect((await get(brandB, '/ads/terms/detail?term=yoga%20mat')).brand).toBeNull()
    expect((await get(brandOther, '/ads/terms/detail?term=yoga%20mat')).brand).toMatchObject({ searchVolume: 9, clickShare: 1, purchaseShare: null })
    expect((await get(brandA, '/ads/terms/detail?term=foam%20roller')).brand).toBeNull()
  })
})
