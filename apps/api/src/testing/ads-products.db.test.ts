import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 广告商品（P3-09，真实数据库 + 完整应用）：按“店铺 × ASIN”汇总被推广商品日报表（同一店铺多个广告档案合成一行、活动数去重）、
// 全部销售额与广告销售占比、自然销售额（广告销售额大于全部销售额时不给数）、光环销售（没有转化商品行为空）、在投广告数、库存与断货汇总、
// 数据范围（经广告档案绑定的店铺，未绑定账户只有“全部店铺”成员可见）、企业隔离、筛选排序翻页与游标绑定条件、非美元与花费为空的行不并入。日期都相对现在，企业时区设为 UTC。

type Member = { userId: string; token: string }
const DAY = 86_400_000
const dayText = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10)

describe('广告商品（真实数据库）', () => {
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
  let empty: Member
  let otherStore: string

  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Record<string, any>
  }
  const keysOf = (data: Record<string, any>) => (data.items as Array<{ key: string }>).map(item => item.key)
  const rowOf = (data: Record<string, any>, key: string) => (data.items as Array<Record<string, any>>).find(item => item.key === key)!

  const account = (profile: string, tenant: string) =>
    insertRow(h.client, 'AdsAccount', { id: `acct-${profile}`, tenantId: tenant, adsProfileId: profile, adsAccountId: `ACC-${profile}`, name: profile })
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
  const ad = (id: string, profile: string, asin: string, state: string) =>
    insertRow(h.client, 'AdsAd', { id, tenantId, adsProfileId: profile, adsAccountId: `ACC-${profile}`, adId: id, adGroupId: 'AG1', asin, state, sourceUpdatedAt: '2026-10-01T00:00:00Z' })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'ads_products' })
    const a = await h.createTenant('a')
    const b = await h.createTenant('b')
    const c = await h.createTenant('c')
    tenantId = a.tenantId
    otherTenantId = b.tenantId
    storeA = a.sellerAccountId
    otherStore = b.sellerAccountId
    storeB = 'seller-a2'
    await insertRow(h.client, 'SellerAccount', { id: storeB, tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-A2', logicalRegion: 'NA', displayName: '店铺 B' })
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    // 店铺 A 有两个广告档案（两个站点）；店铺 B 一个；一个没有绑定店铺；别的企业一个
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a', tenantId, profileId: 'P-A', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-a2', tenantId, profileId: 'P-A2', sellerAccountId: storeA, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-b', tenantId, profileId: 'P-B', sellerAccountId: storeB, bindingStatus: 'MANUAL' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-free', tenantId, profileId: 'P-F' })
    await insertRow(h.client, 'AdsProfile', { id: 'ap-o', tenantId: otherTenantId, profileId: 'P-O', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL' })
    for (const profile of ['ap-a', 'ap-a2', 'ap-b', 'ap-free']) await account(profile, tenantId)
    await account('ap-o', otherTenantId)

    // 被推广商品：B0AAA 在店铺 A 两个档案三个活动共花 30（销售 90）；B0BBB 花 20；B0CCC 花 3 且没有销售额；店铺 B 的 B0AAA 花 7；未绑定的 B0DDD 花 4
    await metric('ap-a', 'c1', 'B0AAA', dayText(-1), { spend: 12, sales: 60, clicks: 10, orders: 2 })
    await metric('ap-a', 'c1', 'B0AAA', dayText(-2), { spend: 8, sales: 20 })
    await metric('ap-a', 'c2', 'B0AAA', dayText(-1), { spend: 5, sales: 0, orders: 0 })
    await metric('ap-a2', 'c7', 'B0AAA', dayText(-1), { spend: 5, sales: 10 })
    await metric('ap-a', 'c1', 'B0BBB', dayText(-1), { spend: 20, sales: 100, orders: 4 })
    await metric('ap-a', 'c3', 'B0CCC', dayText(-1), { spend: 3, sales: null })
    await metric('ap-b', 'c9', 'B0AAA', dayText(-1), { spend: 7, sales: 14 })
    await metric('ap-free', 'cf', 'B0DDD', dayText(-1), { spend: 4, sales: 8 })
    // 不并入的行：加元、花费为空
    await metric('ap-a', 'c4', 'B0EEE', dayText(-1), { spend: 99, sales: 99, currency: 'CAD' })
    await metric('ap-a', 'c5', 'B0NUL', dayText(-1), { spend: null, sales: 5 })
    // 范围之外的旧数据
    await metric('ap-a', 'c1', 'B0OLD', dayText(-100), { spend: 50, sales: 50 })
    await metric('ap-o', 'co1', 'B0OOO', dayText(-1), { spend: 11, sales: 22 }, otherTenantId)

    // 全部销售额：店铺 A 的 B0AAA 共 400；B0BBB 只有 50（比广告销售额 100 小）；店铺 B 没有汇总
    await asinSales(storeA, 'B0AAA', dayText(-1), 300)
    await asinSales(storeA, 'B0AAA', dayText(-2), 100)
    await asinSales(storeA, 'B0BBB', dayText(-1), 50)

    // 光环销售：B0AAA 有一笔光环 15 与一笔本品 60；B0BBB 只有本品（光环为 0）；B0CCC 没有转化商品行
    await converted('ap-a', 'B0AAA', 'B0XXX', true, 15)
    await converted('ap-a', 'B0AAA', 'B0AAA', false, 60)
    await converted('ap-a', 'B0BBB', 'B0BBB', false, 40)

    // 广告：B0AAA 在两个档案里共 3 条（2 条在投）
    await ad('ad-1', 'ap-a', 'B0AAA', 'ENABLED')
    await ad('ad-2', 'ap-a', 'B0AAA', 'PAUSED')
    await ad('ad-3', 'ap-a2', 'B0AAA', 'enabled')

    // 商品资料与库存：B0AAA 断货，B0BBB 有货
    for (const [id, asin, sku, title] of [
      ['fp-1', 'B0AAA', 'SKU-1', '瑜伽垫 加厚'],
      ['fp-2', 'B0BBB', 'SKU-2', '泡沫轴'],
    ] as const)
      await insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: storeA, sellerSku: sku, asin, title })
    for (const [id, asin, sku, sellable] of [
      ['sn-1', 'B0AAA', 'SKU-1', 0],
      ['sn-2', 'B0BBB', 'SKU-2', 5],
    ] as const)
      await insertRow(h.client, 'InventoryDailySnapshot', {
        id,
        tenantId,
        sellerAccountId: storeA,
        snapshotDate: dayText(-1),
        sku,
        asin,
        sellable,
        source: 'API',
        sourceUpdatedAt: new Date().toISOString(),
      })

    const read = ['ads.read']
    admin = await h.createMember(tenantId, 'admin', read)
    scopedA = await h.createMember(tenantId, 'scopeda', read, { scopes: [{ sellerAccountId: storeA }] })
    scopedB = await h.createMember(tenantId, 'scopedb', read, { scopes: [{ sellerAccountId: storeB }] })
    noAds = await h.createMember(tenantId, 'noads', ['overview.read'])
    other = await h.createMember(otherTenantId, 'other', read)
    empty = await h.createMember(c.tenantId, 'empty', read)
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await h?.close()
  })

  it('没有 ads.read 返回 403；全部店铺成员看到本企业全部“店铺 × ASIN”，按花费从高到低；别的企业的数据看不到', async () => {
    expect((await h.call(noAds.token, 'GET', '/ads/products')).status).toBe(403)
    const data = await get(admin, '/ads/products')
    expect(keysOf(data)).toEqual([`${storeA}|B0AAA`, `${storeA}|B0BBB`, `${storeB}|B0AAA`, '-|B0DDD', `${storeA}|B0CCC`])
    expect(data.state).toBe('OK')
    expect(data.range.defaulted).toBe(true)
    expect(keysOf(await get(other, '/ads/products'))).toEqual([`${otherStore}|B0OOO`])
  })

  it('同一店铺两个档案、三个活动的同一 ASIN 合成一行：合计、活动数、全部销售额、占比、自然销售额、光环、广告数、库存', async () => {
    const row = rowOf(await get(admin, '/ads/products'), `${storeA}|B0AAA`)
    expect(row).toMatchObject({ asin: 'B0AAA', title: '瑜伽垫 加厚', storeId: storeA, campaigns: 3, totals: { spend: 30, sales: 90, clicks: 40, orders: 4 } })
    expect(row.ratios.acos).toBeCloseTo(30 / 90)
    expect(row).toMatchObject({ totalSales: 400, organicSales: 310, organicIssue: null, haloSales: 15, ads: { enabled: 2, total: 3 }, stock: 'OUT_OF_STOCK', sellable: 0 })
    expect(row.adsShare).toBeCloseTo(30 / 400)
  })

  it('广告销售额大于全部销售额：不给自然销售额并标出原因；只有本品转化行光环是 0；没有销售额与转化的商品全部为空而不是 0', async () => {
    const data = await get(admin, '/ads/products')
    expect(rowOf(data, `${storeA}|B0BBB`)).toMatchObject({ totalSales: 50, organicSales: null, organicIssue: 'ATTRIBUTION_EXCEEDS_TOTAL', haloSales: 0, stock: 'IN_STOCK', sellable: 5 })
    const blank = rowOf(data, `${storeA}|B0CCC`)
    expect(blank).toMatchObject({ totals: { spend: 3, sales: null }, totalSales: null, adsShare: null, organicSales: null, haloSales: null, ads: null, stock: 'UNKNOWN', sellable: null, title: null })
    expect(blank.ratios.acos).toBeNull()
  })

  it('没有 ASIN 日汇总的店铺没有全部销售额；未绑定店铺的账户不借用任何店铺的资料；非美元、花费为空、范围外的行不并入并披露', async () => {
    const data = await get(admin, '/ads/products')
    expect(rowOf(data, `${storeB}|B0AAA`)).toMatchObject({ storeName: '店铺 B', totalSales: null, adsShare: null, organicSales: null, stock: 'UNKNOWN', title: null })
    expect(rowOf(data, '-|B0DDD')).toMatchObject({ storeId: null, storeName: null, totalSales: null, title: null, stock: 'UNKNOWN' })
    const keys = keysOf(data)
    for (const asin of ['B0EEE', 'B0NUL', 'B0OLD', 'B0OOO']) expect(keys.some(key => key.endsWith(asin))).toBe(false)
    expect(data.note).toContain('非美元')
    expect(data.summary).toEqual({ products: 5, spend: 64, sales: 212, outOfStock: { products: 1, spend: 30 } })
    expect(data.halo.state).toBe('OK')
    expect(data.profit.state).toBe('NOT_CONNECTED')
    expect(data.write.state).toBe('NOT_CONNECTED')
  })

  it('数据范围：只看店铺 A 的成员看不到店铺 B 与未绑定账户的行；只看店铺 B 的成员没有转化商品行，光环显示尚未接入', async () => {
    const a = await get(scopedA, '/ads/products')
    expect(keysOf(a)).toEqual([`${storeA}|B0AAA`, `${storeA}|B0BBB`, `${storeA}|B0CCC`])
    expect(a.halo.state).toBe('OK')
    const b = await get(scopedB, '/ads/products')
    expect(keysOf(b)).toEqual([`${storeB}|B0AAA`])
    expect(b.halo.state).toBe('NOT_CONNECTED')
    expect(rowOf(b, `${storeB}|B0AAA`).haloSales).toBeNull()
    // 请求里主动收窄到别的店铺也拿不到范围外的数据
    expect(keysOf(await get(admin, `/ads/products?storeIds=${storeB}`))).toEqual([`${storeB}|B0AAA`])
  })

  it('筛选：库存状态、ASIN 或商品名称关键字；汇总跟着筛选走', async () => {
    const out = await get(admin, '/ads/products?stock=OUT_OF_STOCK')
    expect(keysOf(out)).toEqual([`${storeA}|B0AAA`])
    expect(out.summary).toEqual({ products: 1, spend: 30, sales: 90, outOfStock: { products: 1, spend: 30 } })
    expect(keysOf(await get(admin, `/ads/products?q=${encodeURIComponent('泡沫')}`))).toEqual([`${storeA}|B0BBB`])
    expect(keysOf(await get(admin, '/ads/products?q=b0ccc'))).toEqual([`${storeA}|B0CCC`])
    const none = await get(admin, '/ads/products?q=nothing-like-this')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.note).toContain('没有符合筛选条件')
  })

  it('排序：空值永远在最后（升降序都一样）；比率按 ratios 排', async () => {
    const asc = keysOf(await get(admin, '/ads/products?sort=acos:asc'))
    const desc = keysOf(await get(admin, '/ads/products?sort=acos:desc'))
    expect(asc.at(-1)).toBe(`${storeA}|B0CCC`)
    expect(desc.at(-1)).toBe(`${storeA}|B0CCC`)
    // 广告成本销售比：B0BBB 0.2、店铺 B 的 B0AAA 0.5、B0AAA 0.333、B0DDD 0.5
    expect(asc[0]).toBe(`${storeA}|B0BBB`)
    const organic = keysOf(await get(admin, '/ads/products?sort=organicSales:desc'))
    expect(organic[0]).toBe(`${storeA}|B0AAA`)
    expect(organic.slice(1)).toContain(`${storeA}|B0BBB`)
  })

  it('翻页：游标带出下一页；换了筛选条件的旧游标返回 400；每页条数不合法返回 422', async () => {
    const first = await get(admin, '/ads/products?pageSize=2')
    expect(keysOf(first)).toHaveLength(2)
    expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 5 })
    const second = await get(admin, `/ads/products?pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    expect(keysOf(second)).toEqual([`${storeB}|B0AAA`, '-|B0DDD'])
    const last = await get(admin, `/ads/products?pageSize=2&cursor=${encodeURIComponent(second.pageInfo.nextCursor)}`)
    expect(keysOf(last)).toEqual([`${storeA}|B0CCC`])
    expect(last.pageInfo.hasMore).toBe(false)
    expect((await h.call(admin.token, 'GET', `/ads/products?pageSize=2&stock=IN_STOCK&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    expect((await h.call(admin.token, 'GET', '/ads/products?pageSize=99999')).status).toBe(422)
  })

  it('所选日期范围内没有记录是“尚无记录”；从没同步过被推广商品是“尚未接入”', async () => {
    const quiet = await get(admin, `/ads/products?from=${dayText(-300)}&to=${dayText(-270)}`)
    expect(quiet).toMatchObject({ state: 'NO_DATA', items: [], range: { defaulted: false } })
    expect(quiet.note).toContain('没有被推广商品的报表行')
    const never = await get(empty, '/ads/products')
    expect(never).toMatchObject({ state: 'NOT_CONNECTED', items: [] })
    expect(never.note).toContain('还没有同步')
    expect(never.summary).toEqual({ products: 0, spend: null, sales: null, outOfStock: { products: 0, spend: null } })
  })

  it('指定较早的日期范围：只合计那一段的行', async () => {
    const data = await get(admin, `/ads/products?from=${dayText(-110)}&to=${dayText(-90)}`)
    expect(keysOf(data)).toEqual([`${storeA}|B0OLD`])
    expect(rowOf(data, `${storeA}|B0OLD`).totals).toMatchObject({ spend: 50, sales: 50 })
  })
})
