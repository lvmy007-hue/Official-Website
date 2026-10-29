import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// ASIN 360 流量转化、刊登、评价、定价、竞品、内容页签与建议规则（P4-08，真实数据库 + 完整应用）：
// 逐日流量取数据中心优先、只取子体粒度、别的店铺与别的企业的同 ASIN 行不并入、没有记录的日子是空；搜索漏斗与断点（品牌分析，需 analytics.brand.read，没有权限是“受限”而不是 403）；
// 目录表现；定价的成交均价与购物车获得率；竞品只对照热门搜索词里的点击前三（认出本品与我方其他商品）；五个页签的“尚未接入”区块；数据范围与权限的 403 / 404 / 422。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const RANGE = `from=${dayText(-3)}&to=${dayText(-1)}`
const US = 'ATVPDKIKX0DER'
const WEEK = '2026-10-18'
const PREVIOUS_WEEK = '2026-10-11'

describe('ASIN 360 流量、刊登、评价、定价、竞品、内容页签（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let storeA: string
  let storeB: string
  let admin: Member
  let noBrand: Member
  let scopedB: Member
  let baseOnly: Member
  let other: Member

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  let seq = 0
  const traffic = (store: string, asin: string, date: string, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'SalesTrafficAsinDaily', {
      id: `st-${++seq}`,
      tenantId: tenant,
      sellerAccountId: store,
      date,
      asin,
      asinGranularity: 'CHILD',
      sku: '',
      source: 'DATA_KIOSK',
      currency: 'USD',
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const sqp = (store: string, period: string, asin: string, query: string, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'BrandSearchQueryPerformance', {
      id: `sqp-${++seq}`,
      tenantId: tenant,
      sellerAccountId: store,
      reportPeriod: 'WEEK',
      periodStart: period,
      periodEnd: period,
      asin,
      searchQuery: query,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  // 全部 / 我方相同数量的展示、点击、加购、购买：份额是 own ÷ total
  const counts = (volume: number, own: { clicks: number; cartAdds?: number; purchases?: number }) => ({
    searchVolume: volume,
    impressionsTotal: 100,
    impressionsOwn: 50,
    clicksTotal: 100,
    clicksOwn: own.clicks,
    cartAddsTotal: 100,
    cartAddsOwn: own.cartAdds ?? own.clicks,
    purchasesTotal: 100,
    purchasesOwn: own.purchases ?? own.clicks,
  })
  const hot = (store: string, period: string, term: string, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'BrandSearchTerm', {
      id: `bt-${++seq}`,
      tenantId: tenant,
      sellerAccountId: store,
      reportPeriod: 'WEEK',
      periodStart: period,
      periodEnd: period,
      department: '',
      searchTerm: term,
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const product = (id: string, store: string, sku: string, asin: string, tenant = tenantId, extra: Record<string, unknown> = {}) =>
    insertRow(h.client, 'FbaProduct', { id, tenantId: tenant, sellerAccountId: store, marketplaceId: US, sellerSku: sku, asin, title: `商品 ${sku}`, ...extra })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'products_more' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-m2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-M2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)

    await product('prod-a', storeA, 'SKU-1', 'B0AAA', tenantId, { brand: '示例品牌', price: 19.9 })
    await product('prod-a2', storeA, 'SKU-1B', 'B0AAA')
    await product('prod-b', storeB, 'SKU-B', 'B0AAA')
    await product('prod-own', storeA, 'SKU-OWN', 'B0OWN00001')
    await product('prod-o', b.sellerAccountId, 'SKU-O', 'B0AAA', otherTenantId)

    // 逐日流量：昨天数据中心 100 会话（报告来源同一天 1 个会话，不用）、前天 300 会话；母体粒度、别的店铺、别的企业、范围外的行都不并入
    await traffic(storeA, 'B0AAA', dayText(-1), { sessions: 100, pageViews: 150, units: 5, orderedSales: 100, buyBoxPct: 0.9, unitSessionPct: 0.05 })
    await traffic(storeA, 'B0AAA', dayText(-1), { sessions: 1, units: 1, source: 'REPORT' })
    await traffic(storeA, 'B0AAA', dayText(-2), { sessions: 300, pageViews: 450, units: 0, orderedSales: 0, buyBoxPct: 0.5 })
    await traffic(storeA, 'B0AAA', dayText(-1), { sessions: 9999, asinGranularity: 'PARENT' })
    await traffic(storeB, 'B0AAA', dayText(-1), { sessions: 7777 })
    await traffic(b.sellerAccountId, 'B0AAA', dayText(-1), { sessions: 5555 }, otherTenantId)
    await traffic(storeA, 'B0AAA', dayText(-100), { sessions: 4444 })

    // 搜索查询表现：本周 6 个词（1 个点击份额偏低），上周只有 yoga mat；店铺 B 与别的企业的同 ASIN 行不并入
    await sqp(storeA, WEEK, 'B0AAA', '低点击词', counts(5000, { clicks: 10 }))
    await sqp(storeA, WEEK, 'B0AAA', 'yoga mat', counts(3000, { clicks: 50 }))
    for (const [index, query] of ['term b', 'term c', 'term d', 'term e'].entries()) await sqp(storeA, WEEK, 'B0AAA', query, counts(400 - index * 100, { clicks: 50 }))
    await sqp(storeA, PREVIOUS_WEEK, 'B0AAA', 'yoga mat', counts(2500, { clicks: 25 }))
    await sqp(storeB, WEEK, 'B0AAA', 'storeb term', counts(9000, { clicks: 90 }))
    await sqp(b.sellerAccountId, WEEK, 'B0AAA', 'other tenant term', counts(9000, { clicks: 90 }), otherTenantId)

    await insertRow(h.client, 'BrandSearchCatalogPerformance', {
      id: 'cat-1',
      tenantId,
      sellerAccountId: storeA,
      reportPeriod: 'WEEK',
      periodStart: WEEK,
      periodEnd: WEEK,
      asin: 'B0AAA',
      impressions: 1000,
      clicks: 50,
      cartAdds: 10,
      purchases: 4,
      clickRate: 0.05,
      conversionRate: 0.08,
      searchTrafficSales: 80,
      currency: 'USD',
      sourceUpdatedAt: new Date().toISOString(),
    })

    // 热门搜索词：yoga mat 点击前三是对手、本品、我方另一个商品；店铺 B 同一个词的排名不并入
    await hot(storeA, WEEK, 'yoga mat', {
      searchFrequencyRank: 120,
      clickedAsin1: 'B0RIVAL001',
      clickedTitle1: '对手一',
      clickShare1: 0.3,
      conversionShare1: 0.2,
      clickedAsin2: 'B0AAA',
      clickShare2: 0.2,
      conversionShare2: 0.1,
      clickedAsin3: 'B0OWN00001',
      clickShare3: 0.1,
      conversionShare3: 0.1,
    })
    await hot(storeB, WEEK, 'yoga mat', { searchFrequencyRank: 999, clickedAsin1: 'B0STOREB' })

    // 定价：昨天 5 件销售额 100，前天 0 件
    await insertRow(h.client, 'AsinDailySummary', { id: 'asd-1', tenantId, sellerAccountId: storeA, summaryDate: dayText(-1), asin: 'B0AAA', units: 5, salesAmount: 100, metricVersion: 'p2a-01@1' })
    await insertRow(h.client, 'AsinDailySummary', { id: 'asd-2', tenantId, sellerAccountId: storeA, summaryDate: dayText(-2), asin: 'B0AAA', units: 0, salesAmount: 0, metricVersion: 'p2a-01@1' })

    // 库存：补货建议会触发（可售为 0 的断货）
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

    const all = ['products.read', 'listing.read', 'reviews.read', 'pricing.read', 'competitors.read', 'aplus.read', 'analytics.brand.read', 'inventory.read']
    admin = await h.createMember(tenantId, 'admin', all)
    noBrand = await h.createMember(
      tenantId,
      'nobrand',
      all.filter(permission => permission !== 'analytics.brand.read'),
    )
    scopedB = await h.createMember(tenantId, 'scopedb', all, { scopes: [{ sellerAccountId: storeB }] })
    baseOnly = await h.createMember(tenantId, 'baseonly', ['products.read'])
    other = await h.createMember(otherTenantId, 'other', all)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('权限、范围与参数：缺页签权限 403（坏参数也是 403）；商品不存在、别的企业与范围外 404；日期与周期不合法 422', async () => {
    for (const tab of ['listing', 'reviews', 'content', 'pricing', 'competitors']) expect((await h.call(baseOnly.token, 'GET', `/products/prod-a/${tab}?from=bad`)).status, tab).toBe(403)
    await get(baseOnly, `/products/prod-a/traffic?${RANGE}`)
    await get(admin, '/products/nope/traffic', 404)
    await get(admin, '/products/prod-o/traffic', 404)
    await get(other, '/products/prod-a/traffic', 404)
    await get(scopedB, '/products/prod-a/traffic', 404)
    await get(scopedB, '/products/prod-b/listing')
    expect((await h.call(admin.token, 'GET', '/products/prod-a/traffic?from=bad&to=also-bad')).status).toBe(422)
    expect((await h.call(admin.token, 'GET', `/products/prod-a/traffic?period=WEEK&periodStart=2026-10-19`)).status).toBe(422)
    expect((await h.call(admin.token, 'GET', '/products/prod-a/competitors?period=DAY')).status).toBe(422)
  })

  it('逐日流量：数据中心优先于报告；只取子体粒度；别的店铺、别的企业与范围外不并入；没有记录的日子是空', async () => {
    const data = await get(admin, `/products/prod-a/traffic?${RANGE}`)
    expect(await get(admin, `/products/prod-a2/traffic?${RANGE}`)).toMatchObject({ daily: data.daily })
    expect(data.range).toEqual({ from: dayText(-3), to: dayText(-1), defaulted: false })
    expect(data.daily.state).toBe('OK')
    expect(data.daily.points.map((point: { date: string }) => point.date)).toEqual([dayText(-3), dayText(-2), dayText(-1)])
    expect(data.daily.points[0]).toEqual({ date: dayText(-3), sessions: null, pageViews: null, units: null, sales: null, buyBoxPct: null, unitSessionPct: null })
    expect(data.daily.points[1]).toMatchObject({ sessions: 300, units: 0, unitSessionPct: 0, buyBoxPct: 0.5 })
    expect(data.daily.points[2]).toMatchObject({ sessions: 100, units: 5, sales: 100, buyBoxPct: 0.9 })
    expect(data.daily.summary).toMatchObject({ sessions: 400, pageViews: 600, units: 5, sales: 100, days: 2 })
    expect(data.daily.summary.unitSessionPct).toBeCloseTo(5 / 400)
    expect(data.daily.summary.buyBoxPct).toBeCloseTo(0.6)
  })

  it('搜索漏斗：份额 = 我方 ÷ 全部，断点以自己全部搜索词的中位数为界；默认取最近一期；店铺 B 与别的企业的词不并入', async () => {
    const { searchFunnel } = await get(admin, `/products/prod-a/traffic?${RANGE}`)
    expect(searchFunnel.state).toBe('OK')
    expect(searchFunnel.period).toMatchObject({ kind: 'WEEK', start: WEEK, previousStart: PREVIOUS_WEEK, available: [WEEK, PREVIOUS_WEEK] })
    const clicks = searchFunnel.stages.find((stage: { key: string }) => stage.key === 'clicks')
    expect(clicks.market).toBe(600)
    expect(clicks.own).toBe(260)
    expect(clicks.share).toBeCloseTo(260 / 600)
    const impressions = searchFunnel.stages.find((stage: { key: string }) => stage.key === 'impressions')
    expect(impressions.share).toBeCloseTo(0.5)
    expect(impressions.shareChange).toBeCloseTo(0)
    expect(searchFunnel.termCount).toBe(6)
    expect(searchFunnel.terms.map((term: { searchQuery: string }) => term.searchQuery)).toEqual(['低点击词', 'yoga mat', 'term b', 'term c', 'term d', 'term e'])
    expect(searchFunnel.terms[0]).toMatchObject({ breakpoint: 'CLICK', ownPurchases: 10 })
    expect(searchFunnel.terms[1].breakpoint).toBeNull()
    expect(searchFunnel.breakpoints).toMatchObject({ state: 'OK', counts: { CLICK: 1, CART: 0, PURCHASE: 0 } })
    const text = JSON.stringify(searchFunnel)
    expect(text).not.toContain('storeb term')
    expect(text).not.toContain('other tenant term')
  })

  it('选上一周：只有 yoga mat 一个词，词数不足 5 个时不做断点诊断；换成没有数据的月周期时不显示数据', async () => {
    const { searchFunnel } = await get(admin, `/products/prod-a/traffic?${RANGE}&period=WEEK&periodStart=${PREVIOUS_WEEK}`)
    expect(searchFunnel.period).toMatchObject({ start: PREVIOUS_WEEK, previousStart: '2026-10-04' })
    expect(searchFunnel.terms).toHaveLength(1)
    expect(searchFunnel.breakpoints.state).toBe('INSUFFICIENT')
    const month = (await get(admin, `/products/prod-a/traffic?${RANGE}&period=MONTH`)).searchFunnel
    expect(month.state).not.toBe('OK')
    expect(month.terms).toEqual([])
  })

  it('目录表现：本周期的展示、点击、加购、购买；没有上一周期就是空', async () => {
    const { catalogFunnel } = await get(admin, `/products/prod-a/traffic?${RANGE}`)
    expect(catalogFunnel).toMatchObject({ state: 'OK', previous: null, current: { impressions: 1000, clicks: 50, cartAdds: 10, purchases: 4, searchTrafficSales: 80, currency: 'USD' } })
  })

  it('没有品牌分析权限：品牌区块是“无权查看”（不是 403），逐日流量照常；从没同步过的商品是“尚未接入”', async () => {
    const data = await get(noBrand, `/products/prod-a/traffic?${RANGE}`)
    expect(data.daily.state).toBe('OK')
    expect(data.searchFunnel).toMatchObject({ state: 'RESTRICTED', terms: [], period: null })
    expect(data.searchFunnel.stages.every((stage: { share: number | null }) => stage.share === null)).toBe(true)
    expect(data.catalogFunnel).toMatchObject({ state: 'RESTRICTED', current: null })
    const noRows = await get(admin, `/products/prod-b/traffic?${RANGE}`)
    expect(noRows.daily.summary.sessions).toBe(7777)
    expect(noRows.searchFunnel.terms.map((term: { searchQuery: string }) => term.searchQuery)).toEqual(['storeb term'])
    const never = await get(admin, `/products/prod-own/traffic?${RANGE}`)
    expect(never.searchFunnel.state).toBe('NOT_CONNECTED')
    expect(never.searchFunnel.note).toBeTruthy()
    expect(never.daily.summary).toBeNull()
    expect(never.daily.state).not.toBe('OK')
  })

  it('没有来源的区块逐项列出并写明负责的工作包：流量 3 项、刊登 4 项、评价 4 项、定价 4 项、竞品 2 项、内容 3 项', async () => {
    const traffic = await get(admin, `/products/prod-a/traffic?${RANGE}`)
    expect(traffic.pending.map((section: { key: string }) => section.key)).toEqual(['device', 'cartRate', 'hourly'])
    const expected: Record<string, number> = { listing: 4, reviews: 1, pricing: 4, competitors: 0, content: 3 }
    for (const [tab, count] of Object.entries(expected)) {
      const data = await get(admin, `/products/prod-a/${tab}?${RANGE}`)
      expect(data.pending, tab).toHaveLength(count)
      for (const section of data.pending) expect(section.state).toBe('NOT_CONNECTED')
      expect(data.basis).toBeTruthy()
    }
  })

  it('刊登与内容：已同步的资料给真实值，没有取值为空；评价没有任何评分字段', async () => {
    const listing = await get(admin, '/products/prod-a/listing')
    expect(listing.facts.find((fact: { label: string }) => fact.label === '刊登状态')).toMatchObject({ value: '在售' })
    expect(listing.facts.find((fact: { label: string }) => fact.label === '商品类型')).toMatchObject({ value: null })
    const content = await get(admin, '/products/prod-a/content')
    expect(content.facts.find((fact: { label: string }) => fact.label === '品牌')).toMatchObject({ value: '示例品牌' })
    expect(await get(admin, '/products/prod-a/reviews')).toMatchObject({ rating: { state: 'NO_DATA', latest: null, points: [] } })
  })

  it('定价：标价取最近一次同步值；成交均价 = 销售额 ÷ 件数，没有件数的日子是空；购物车获得率按会话加权', async () => {
    const data = await get(admin, `/products/prod-a/pricing?${RANGE}`)
    expect(data.listPrice).toMatchObject({ value: 19.9, currency: 'USD' })
    expect(data.daily.avgPrice).toBe(20)
    expect(data.daily.buyBoxPct).toBeCloseTo(0.6)
    const byDate = Object.fromEntries(data.daily.points.map((point: { date: string }) => [point.date, point]))
    expect(byDate[dayText(-1)]).toMatchObject({ units: 5, sales: 100, avgPrice: 20, buyBoxPct: 0.9 })
    expect(byDate[dayText(-2)]).toMatchObject({ units: 0, avgPrice: null })
    expect(byDate[dayText(-3)]).toMatchObject({ units: null, avgPrice: null, buyBoxPct: null })
    const noPrice = await get(admin, `/products/prod-b/pricing?${RANGE}`)
    expect(noPrice.listPrice.value).toBeNull()
  })

  it('竞品：核心搜索词在热门搜索词里的点击前三；认出本品与我方其他商品；只含本店铺的排名', async () => {
    const { terms } = await get(admin, '/products/prod-a/competitors')
    expect(terms.state).toBe('OK')
    expect(terms.rows).toHaveLength(1)
    const [row] = terms.rows
    expect(row).toMatchObject({ searchTerm: 'yoga mat', frequencyRank: 120, selfRank: 2 })
    expect(row.slots).toMatchObject([
      { rank: 1, asin: 'B0RIVAL001', title: '对手一', isSelf: false, isOwn: false },
      { rank: 2, asin: 'B0AAA', isSelf: true },
      { rank: 3, asin: 'B0OWN00001', isOwn: true, isSelf: false },
    ])
    expect(JSON.stringify(terms)).not.toContain('B0STOREB')
    const none = (await get(admin, '/products/prod-b/competitors')).terms
    expect(none.state).toBe('NOT_CONNECTED')
    expect(none.rows).toEqual([])
  })

  it('建议规则：库存类按库存详情的建议判断，其余四条一律“尚未接入”；没有库存权限是“无权查看”', async () => {
    const { rules } = await get(admin, '/products/prod-a/actions')
    expect(rules.map((rule: { key: string }) => rule.key)).toEqual(['PRICE_ABOVE_WIN', 'LOW_COVER', 'LISTING_ERROR', 'NEGATIVE_REVIEW', 'AGING_FEE', 'CONTENT_CHANGED'])
    const state = (key: string) => rules.find((rule: { key: string }) => rule.key === key).state
    for (const key of ['PRICE_ABOVE_WIN', 'LISTING_ERROR', 'NEGATIVE_REVIEW', 'CONTENT_CHANGED']) expect(state(key)).toBe('NOT_CONNECTED')
    expect(['TRIGGERED', 'CLEAR', 'NO_DATA']).toContain(state('LOW_COVER'))
    expect(['TRIGGERED', 'CLEAR', 'NO_DATA']).toContain(state('AGING_FEE'))
    const restricted = (await get(baseOnly, '/products/prod-a/actions')).rules
    expect(restricted.find((rule: { key: string }) => rule.key === 'LOW_COVER').state).toBe('RESTRICTED')
    expect(restricted.find((rule: { key: string }) => rule.key === 'PRICE_ABOVE_WIN').state).toBe('NOT_CONNECTED')
  })
})
