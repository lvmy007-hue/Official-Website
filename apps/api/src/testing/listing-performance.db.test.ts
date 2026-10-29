import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 刊登表现（P4-09，真实数据库 + 完整应用）：销售与流量按店铺 × ASIN 汇总、数据中心优先于报告、同 ASIN 共用、
// 转化率骤降（对比上一周期、样本不足不报）、广告与退货与可售天数三列各自的权限与“尚未接入”、排序空值在后、
// 全部筛选、偏移游标（改条件即失效）、数据范围与企业隔离、没有任何商品时的状态。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)
const US = 'ATVPDKIKX0DER'
// 当前周期 7 天 [今天-14, 今天-8]，上一周期 [今天-21, 今天-15]
const RANGE = () => `from=${dayText(-14)}&to=${dayText(-8)}`

describe('刊登表现（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let otherTenantId: string
  let emptyTenantId: string
  let storeA: string
  let storeB: string
  let owner: Member
  let reader: Member
  let scopedB: Member
  let outsider: Member
  let lonely: Member
  let seq = 0

  const get = async (member: Member, query = '', expected = 200) => {
    const res = await h.call(member.token, 'GET', `/listings/performance?${RANGE()}${query ? `&${query}` : ''}`)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const ids = (data: Record<string, any>) => (data.items as Array<{ id: string }>).map(item => item.id)
  const rowOf = (data: Record<string, any>, id: string) => (data.items as Array<Record<string, any>>).find(item => item.id === id)!

  const product = (id: string, sku: string, asin: string, values: Record<string, unknown> = {}) =>
    insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: storeA, marketplaceId: US, sellerSku: sku, asin, title: `商品 ${sku}`, sourceUpdatedAt: new Date().toISOString(), ...values })
  const traffic = (store: string, asin: string, offsetDays: number, values: Record<string, unknown>, tenant = tenantId) =>
    insertRow(h.client, 'SalesTrafficAsinDaily', {
      id: `st-${(seq += 1)}`,
      tenantId: tenant,
      sellerAccountId: store,
      date: dayText(offsetDays),
      asin,
      asinGranularity: 'CHILD',
      sku: '',
      source: 'DATA_KIOSK',
      currency: 'USD',
      sourceUpdatedAt: new Date().toISOString(),
      ...values,
    })
  const summary = (store: string, asin: string, offsetDays: number, values: Record<string, unknown>) =>
    insertRow(h.client, 'AsinDailySummary', { id: `sum-${(seq += 1)}`, tenantId, sellerAccountId: store, summaryDate: dayText(offsetDays), asin, metricVersion: 'p2a-01@1', ...values })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'listing_perf' })
    const a = await h.createTenant('lp-a')
    const b = await h.createTenant('lp-b')
    const c = await h.createTenant('lp-c')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    emptyTenantId = c.tenantId
    storeA = a.sellerAccountId
    storeB = 'seller-lp-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-LP-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)

    owner = await h.createMember(tenantId, 'lp-owner', ['*'])
    reader = await h.createMember(tenantId, 'lp-reader', ['listing.read'])
    scopedB = await h.createMember(tenantId, 'lp-scoped', ['*'], { scopes: [{ sellerAccountId: storeB }] })
    outsider = await h.createMember(otherTenantId, 'lp-outsider', ['*'])
    lonely = await h.createMember(emptyTenantId, 'lp-lonely', ['*'])

    // 商品：p1、p2 同 ASIN（共用销售）；p3 没有流量；p4 在店铺 B；p5 转化率骤降
    await product('p1', 'SKU-A', 'B0AAAAAAAA', { brand: 'Acme', price: 20, categoryPath: 'Home > Kitchen', ownerUserId: owner.userId })
    await product('p2', 'SKU-A2', 'B0AAAAAAAA', { brand: 'Acme', fulfillmentChannel: 'MFN', categoryPath: 'Home > Kitchen' })
    await product('p3', 'SKU-C', 'B0CCCCCCCC', { brand: 'Zeta', listingStatus: 'INACTIVE', title: '没有流量的商品' })
    await product('p4', 'SKU-D', 'B0DDDDDDDD', { sellerAccountId: storeB, brand: 'Acme', price: 5 })
    await product('p5', 'SKU-E', 'B0EEEEEEEE', { brand: 'Zeta' })
    await insertRow(h.client, 'FbaProduct', {
      id: 'p-other',
      tenantId: otherTenantId,
      sellerAccountId: b.sellerAccountId,
      marketplaceId: US,
      sellerSku: 'SKU-A',
      asin: 'B0AAAAAAAA',
      title: '别的企业',
      sourceUpdatedAt: new Date().toISOString(),
    })

    // ASIN A：当前两天各 100 会话 10 件 200 美元；数据中心优先，同日的报告行（会话 9999）不计入
    await traffic(storeA, 'B0AAAAAAAA', -14, { sessions: 100, pageViews: 150, units: 10, orderedSales: 200, buyBoxPct: 0.9 })
    await traffic(storeA, 'B0AAAAAAAA', -13, { sessions: 100, pageViews: 150, units: 10, orderedSales: 200, buyBoxPct: 0.7 })
    await traffic(storeA, 'B0AAAAAAAA', -14, { source: 'REPORT', sessions: 9999, units: 999, orderedSales: 99999 })
    await traffic(storeA, 'B0AAAAAAAA', -21, { sessions: 200, pageViews: 300, units: 20, orderedSales: 400 })
    // ASIN E：当前转化率 5%，上一周期 10%（相对下降 50%，两期会话都 ≥ 100）
    await traffic(storeA, 'B0EEEEEEEE', -14, { sessions: 100, units: 5, orderedSales: 50 })
    await traffic(storeA, 'B0EEEEEEEE', -13, { sessions: 100, units: 5, orderedSales: 50 })
    await traffic(storeA, 'B0EEEEEEEE', -21, { sessions: 200, units: 20, orderedSales: 200 })
    // ASIN D（店铺 B）：只有当前周期，没有上一周期可比
    await traffic(storeB, 'B0DDDDDDDD', -14, { sessions: 50, units: 5, orderedSales: 50 })
    // 别的企业的同 ASIN：不可见
    await traffic(b.sellerAccountId, 'B0AAAAAAAA', -14, { sessions: 777, units: 7, orderedSales: 7777 }, otherTenantId)

    // 广告销售额、最近 7 天订购件数、库存、退货
    await summary(storeA, 'B0AAAAAAAA', -13, { adsSales: 100 })
    await summary(storeA, 'B0AAAAAAAA', -10, { units: 14 })
    await insertRow(h.client, 'FbaInventoryRecord', { id: 'inv-a', tenantId, sellerAccountId: storeA, marketplaceId: US, sellerSku: 'SKU-A', asin: 'B0AAAAAAAA', fulfillableQuantity: 20 })
    await insertRow(h.client, 'FbaReturnCase', {
      id: 'rc-1',
      tenantId,
      sellerAccountId: storeA,
      marketplaceId: US,
      amazonOrderId: '111-0000001',
      asin: 'B0AAAAAAAA',
      sellerSku: 'SKU-A',
      quantity: 2,
      returnDate: `${dayText(-12)}T05:00:00Z`,
    })
  })

  afterAll(async () => {
    await h?.close()
  })

  it('汇总：会话、浏览、销量、销售额、转化率、购物车获得率；数据中心优先；同 ASIN 共用；没有流量是 null 不是 0', async () => {
    const data = await get(owner)
    expect(ids(data).sort()).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(data).toMatchObject({ state: 'OK', currency: 'USD', truncated: false, range: { days: 7, defaulted: false }, gates: { traffic: { state: 'OK' } } })
    expect(data.previousRange).toMatchObject({ from: dayText(-21), to: dayText(-15) })
    expect(rowOf(data, 'p1')).toMatchObject({
      sessions: 200,
      pageViews: 300,
      units: 20,
      sales: 400,
      conversion: 0.1,
      buyBox: 0.8,
      price: 20,
      salesShared: true,
      sessionsPrev: 200,
      conversionPrev: 0.1,
    })
    expect(rowOf(data, 'p2')).toMatchObject({ sessions: 200, sales: 400, salesShared: true, fulfillmentChannel: 'MFN' })
    expect(rowOf(data, 'p5')).toMatchObject({ sessions: 200, units: 10, sales: 100, conversion: 0.05, conversionPrev: 0.1, salesShared: false })
    expect(rowOf(data, 'p3')).toMatchObject({ sessions: null, pageViews: null, units: null, sales: null, conversion: null, buyBox: null, salesShared: false })
    expect(data.filterOptions).toMatchObject({ brands: ['Acme', 'Zeta'], categories: ['Home > Kitchen'], statuses: ['ACTIVE', 'INACTIVE'] })
    expect(data.freshness).toBeDefined()
    expect(data.pending.map((column: { key: string }) => column.key)).toEqual(expect.arrayContaining(['rating', 'issueCount']))
  })

  it('广告销售、退货率、可售天数：有数据的算出，没有记录的是 null；有数据的销量为 0 不会除零', async () => {
    const data = await get(owner)
    // 退货 2 件 ÷ 订购 20 件；可售 20 ÷（最近 7 天 14 件 ÷ 7 天）= 10 天
    expect(rowOf(data, 'p1')).toMatchObject({ adsSales: 100, returnRate: 0.1, daysOfSupply: 10 })
    expect(rowOf(data, 'p2')).toMatchObject({ adsSales: 100, returnRate: 0.1, daysOfSupply: null })
    expect(rowOf(data, 'p3')).toMatchObject({ adsSales: null, returnRate: null, daysOfSupply: null })
    expect(rowOf(data, 'p5')).toMatchObject({ adsSales: null, returnRate: 0, daysOfSupply: null })
    expect(data.gates).toMatchObject({ ads: { state: 'OK' }, returns: { state: 'OK' }, stock: { state: 'OK' } })
  })

  it('趋势：逐日跨店铺相加，同日数据中心优先；没有记录的日期是 null', async () => {
    const data = await get(owner)
    expect(data.trend.state).toBe('OK')
    expect(data.trend.points).toHaveLength(7)
    expect(data.trend.points[0]).toMatchObject({ date: dayText(-14), sessions: 250, units: 20, sales: 300, conversion: 0.08, buyBox: 0.9 })
    expect(data.trend.points[1]).toMatchObject({ date: dayText(-13), sessions: 200, units: 15, sales: 250, buyBox: 0.7 })
    expect(data.trend.points[2]).toMatchObject({ date: dayText(-12), sessions: null, units: null, sales: null, conversion: null, buyBox: null })
  })

  it('转化率骤降：两期样本都足够且相对下降 ≥ 30% 才报；没有上一周期可比的不报；其余三类异常尚未接入', async () => {
    const data = await get(owner)
    expect(rowOf(data, 'p5').anomalies).toEqual(['CONVERSION_DROP'])
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(rowOf(data, id).anomalies).toEqual([])
    const [drop, ...pending] = data.anomalies as Array<Record<string, any>>
    expect(drop).toMatchObject({ kind: 'CONVERSION_DROP', state: 'OK', count: 1 })
    expect(pending.map(item => [item.kind, item.state, item.count])).toEqual([
      ['OFFER_LOST', 'NOT_CONNECTED', null],
      ['ISSUE_NEW', 'NOT_CONNECTED', null],
      ['SUPPRESSED', 'NOT_CONNECTED', null],
    ])
    const only = await get(owner, 'anomaly=CONVERSION_DROP')
    expect(ids(only)).toEqual(['p5'])
    // 异常分布不随异常筛选变化
    expect(only.anomalies[0]).toMatchObject({ count: 1 })
  })

  it('权限：只有刊登读取权限时广告、退货、库存三列是“无权限”，其余照常；没有读取权限 403', async () => {
    const data = await get(reader)
    expect(data.gates).toMatchObject({ ads: { state: 'RESTRICTED' }, returns: { state: 'RESTRICTED' }, stock: { state: 'RESTRICTED' }, traffic: { state: 'OK' } })
    expect(rowOf(data, 'p1')).toMatchObject({ sessions: 200, adsSales: null, returnRate: null, daysOfSupply: null })
    const none = await h.createMember(tenantId, 'lp-none', ['products.read'])
    expect((await h.call(none.token, 'GET', '/listings/performance?sort=bad')).status).toBe(403)
    expect((await h.call(null, 'GET', '/listings/performance')).status).toBe(401)
  })

  it('排序：数值列没有值的永远在最后；字段不在白名单 422', async () => {
    expect(ids(await get(owner, 'sort=sales:desc'))).toEqual(['p1', 'p2', 'p5', 'p4', 'p3'])
    expect(ids(await get(owner, 'sort=sales:asc'))).toEqual(['p4', 'p5', 'p1', 'p2', 'p3'])
    expect(ids(await get(owner, 'sort=sku:asc'))).toEqual(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(ids(await get(owner, 'sort=price:desc')).slice(0, 2)).toEqual(['p1', 'p4'])
    expect((await h.call(owner.token, 'GET', '/listings/performance?sort=password:asc')).status).toBe(422)
  })

  it('筛选：搜索、品牌、状态、配送、类目、负责人，可以组合；被筛空是“没有符合条件”而不是“未连接”', async () => {
    expect(ids(await get(owner, 'q=sku-a')).sort()).toEqual(['p1', 'p2'])
    expect(ids(await get(owner, 'brand=zeta')).sort()).toEqual(['p3', 'p5'])
    expect(ids(await get(owner, 'status=INACTIVE'))).toEqual(['p3'])
    expect(ids(await get(owner, 'fulfillment=MFN'))).toEqual(['p2'])
    expect(ids(await get(owner, `category=${encodeURIComponent('Home > Kitchen')}`)).sort()).toEqual(['p1', 'p2'])
    expect(ids(await get(owner, `ownerId=${owner.userId}`))).toEqual(['p1'])
    expect(ids(await get(owner, 'brand=Zeta&status=ACTIVE'))).toEqual(['p5'])
    const empty = await get(owner, 'brand=不存在')
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(empty.note).toContain('筛选')
  })

  it('偏移游标：逐页取全；改了筛选或排序再用旧游标是 400；换企业也失效', async () => {
    const first = await get(owner, 'pageSize=2&sort=sku:asc')
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 5 })
    expect(ids(first)).toEqual(['p1', 'p2'])
    const cursor = encodeURIComponent(first.pageInfo.nextCursor)
    const second = await get(owner, `pageSize=2&sort=sku:asc&cursor=${cursor}`)
    expect(ids(second)).toEqual(['p3', 'p4'])
    const third = await get(owner, `pageSize=2&sort=sku:asc&cursor=${encodeURIComponent(second.pageInfo.nextCursor)}`)
    expect(ids(third)).toEqual(['p5'])
    expect(third.pageInfo.hasMore).toBe(false)
    const call = (member: Member, query: string) => h.call(member.token, 'GET', `/listings/performance?${RANGE()}&${query}`)
    expect((await call(owner, `pageSize=2&sort=sku:desc&cursor=${cursor}`)).status).toBe(400)
    expect((await call(owner, `pageSize=2&sort=sku:asc&brand=Acme&cursor=${cursor}`)).status).toBe(400)
    expect((await call(outsider, `pageSize=2&sort=sku:asc&cursor=${cursor}`)).status).toBe(400)
    expect((await call(owner, 'cursor=garbage')).status).toBe(400)
  })

  it('数据范围与企业隔离：只授权店铺 B 的成员只看到店铺 B；别的企业看不到本企业，也没退货记录时退货列“尚未接入”', async () => {
    const scoped = await get(scopedB)
    expect(ids(scoped)).toEqual(['p4'])
    expect(rowOf(scoped, 'p4')).toMatchObject({ sessions: 50, sales: 50, conversion: 0.1 })
    const other = await get(outsider)
    expect(ids(other)).toEqual(['p-other'])
    expect(rowOf(other, 'p-other')).toMatchObject({ sessions: 777, sales: 7777 })
    expect(other.filterOptions.brands).toEqual([])
    expect(other.gates.returns.state).toBe('NOT_CONNECTED')
    expect(rowOf(other, 'p-other').returnRate).toBeNull()
  })

  it('没有任何商品：未连接（不是 0 行的表格）；没有流量时各列是“无数据”', async () => {
    const data = await get(lonely)
    expect(data).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
    expect(data.note).toContain('同步')
    expect(data.trend.state).toBe('NO_DATA')
    expect(data.gates.traffic.state).toBe('NO_DATA')
    expect(data.anomalies[0]).toMatchObject({ state: 'NO_DATA', count: null })
  })

  it('默认范围：没有传日期时按近 30 天并标明是默认', async () => {
    const res = await h.call(owner.token, 'GET', '/listings/performance')
    expect(res.status).toBe(200)
    expect(res.json?.data).toMatchObject({ range: { defaulted: true, days: 30 } })
  })
})
