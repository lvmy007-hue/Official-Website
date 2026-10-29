import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 业务报告（P4-02，真实数据库 + 完整应用）：按种子数据确切的销售仪表盘、按日期、按 ASIN 与单个 ASIN 趋势；
// 同店同日两个来源只用数据中心、非美元行不统计、空值不当 0；ASIN 汇总由数据库 groupBy 完成（含分区表）；
// 游标翻页；权限、数据范围与跨企业隔离。
// 种子（范围 2026-10-08 至 2026-10-14，对比期 10-01 至 10-07）：主店 10-08（数据中心 100 与报告 999）、10-09（60，会话为空）、10-10（欧元 500）；欧洲店 10-08（40）；对比期主店 10-02（50）。

type Member = { userId: string; token: string }
const RANGE = 'from=2026-10-08&to=2026-10-14'
const BASE = '/analytics/sales-traffic'
const NOW = '2026-10-20T00:00:00Z'

describe('业务报告（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let s1: string
  let s2: string
  let reader: Member
  let noRead: Member
  let scoped: Member
  let other: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const dailyRow = (tenant: string, store: string, date: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'SalesTrafficDaily', {
      id: `std-${tenant}-${store}-${date}-${String(over.source ?? 'DATA_KIOSK')}-${String(over.currency ?? 'USD')}-${String(over.granularity ?? 'DAY')}`,
      tenantId: tenant,
      sellerAccountId: store,
      date,
      granularity: 'DAY',
      source: 'DATA_KIOSK',
      sourceUpdatedAt: NOW,
      ...over,
    })
  const asinRow = (tenant: string, store: string, date: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'SalesTrafficAsinDaily', {
      id: `sta-${tenant}-${store}-${date}-${String(over.asin ?? 'B000000001')}-${String(over.source ?? 'DATA_KIOSK')}-${String(over.asinGranularity ?? 'CHILD')}`,
      tenantId: tenant,
      sellerAccountId: store,
      date,
      asin: 'B000000001',
      asinGranularity: 'CHILD',
      sku: '',
      source: 'DATA_KIOSK',
      sourceUpdatedAt: NOW,
      ...over,
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'business_reports', db })
    const a = await h.createTenant('br-a')
    tenantId = a.tenantId
    s1 = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = '美国主店' WHERE id = $1`, [s1])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-br-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-BR-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('br-b')
    reader = await h.createMember(tenantId, 'br-read', ['analytics.read'])
    noRead = await h.createMember(tenantId, 'br-none', ['finance.read'])
    scoped = await h.createMember(tenantId, 'br-scoped', ['analytics.read'], { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'br-other', ['*'])

    const full = { orderedSales: 100, unitsOrdered: 10, ordersCount: 8, sessions: 200, pageViews: 400, buyBoxPct: 0.9, unitSessionPct: 0.05, unitsRefunded: 1 }
    await dailyRow(tenantId, s1, '2026-10-08', full)
    await dailyRow(tenantId, s1, '2026-10-08', { ...full, source: 'REPORT', orderedSales: 999 })
    await dailyRow(tenantId, s1, '2026-10-09', { orderedSales: 60, unitsOrdered: 6, ordersCount: 5 }) // 会话、浏览量、退款官方没给
    await dailyRow(tenantId, s1, '2026-10-10', { ...full, currency: 'EUR', orderedSales: 500 })
    await dailyRow(tenantId, s2, '2026-10-08', { orderedSales: 40, unitsOrdered: 4, ordersCount: 3, sessions: 80, pageViews: 100 })
    await dailyRow(tenantId, s1, '2026-10-02', { ...full, orderedSales: 50, unitsOrdered: 5, ordersCount: 4, sessions: 100, pageViews: 200 })
    await dailyRow(tenantId, s1, '2026-10-04', { ...full, granularity: 'WEEK', orderedSales: 700 })
    await dailyRow(b.tenantId, b.sellerAccountId, '2026-10-08', { orderedSales: 7777, unitsOrdered: 1 })

    const child = { orderedSales: 60, units: 3, ordersCount: 2, sessions: 100, pageViews: 150 }
    await asinRow(tenantId, s1, '2026-10-08', { ...child, buyBoxPct: 0.8 })
    await asinRow(tenantId, s1, '2026-10-09', { ...child, buyBoxPct: 0.6 })
    await asinRow(tenantId, s1, '2026-10-08', { ...child, source: 'REPORT', orderedSales: 999 })
    await asinRow(tenantId, s2, '2026-10-08', { orderedSales: 40, units: 4 })
    await asinRow(tenantId, s1, '2026-10-08', { asin: 'B000000002', asinGranularity: 'SKU', sku: 'SKU-2', orderedSales: 10, units: 1 })
    await asinRow(b.tenantId, b.sellerAccountId, '2026-10-08', { orderedSales: 5555, units: 9 })

    await insertRow(h.client, 'FbaProduct', { id: 'prod-br-1', tenantId, sellerAccountId: s1, sellerSku: 'SKU-1', asin: 'B000000001', title: '护眼台灯', parentAsin: 'B00000000P' })
    await insertRow(h.client, 'StoreDailySummary', { id: 'sds-br-1', tenantId, sellerAccountId: s1, summaryDate: '2026-10-08', adsSales: 30, metricVersion: 'test@1' })
    await insertRow(h.client, 'DataFreshness', { id: 'df-br-1', tenantId, sellerAccountId: s1, sourceKey: 'dk.sales-traffic.date', lastAttemptAt: NOW, lastSuccessAt: NOW, status: 'NORMAL' })
    await insertRow(h.client, 'DataFreshness', {
      id: 'df-br-2',
      tenantId,
      sellerAccountId: s2,
      sourceKey: 'dk.sales-traffic.date',
      lastAttemptAt: NOW,
      status: 'UNAUTHORIZED',
      lastErrorCode: 'DK_NO_BRAND',
    })
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('销售仪表盘：同店同日只用数据中心、非美元不统计、空值不当 0；对比期、广告拆分、各店取得情况', async () => {
    const data = await ok(reader, `${BASE}/summary?${RANGE}&compare=previous`)
    const card = (key: string) => data.cards.find((item: { key: string }) => item.key === key)
    expect(card('orderedSales')).toMatchObject({ value: 200, compareValue: 50 })
    expect(card('unitsOrdered')).toMatchObject({ value: 20, compareValue: 5 })
    expect(card('sessions')).toMatchObject({ value: 280, compareValue: 100 })
    expect(card('unitsRefunded')).toMatchObject({ value: 1 })
    expect(data.trend[0]).toMatchObject({ date: '2026-10-08', orderedSales: 140, source: 'DATA_KIOSK' })
    expect(data.trend[1]).toMatchObject({ date: '2026-10-09', orderedSales: 60, sessions: null, pageViews: null })
    expect(data.trend[2]).toMatchObject({ date: '2026-10-10', orderedSales: null, source: null })
    expect(data.coverage).toEqual({ days: 7, withData: 2, reportOnly: 0 })
    expect(data.attribution.sales).toEqual({ before: 50, after: 200 })
    expect(data.split).toEqual({ state: 'OK', note: null, adsSales: 30, organicSales: 170, adsShare: 0.15 })
    const states = Object.fromEntries(data.stores.map((store: { storeName: string; state: string }) => [store.storeName, store.state]))
    expect(states).toEqual({ 欧洲店: 'NO_BRAND', 美国主店: 'AVAILABLE' })
    expect(data.freshness.lastSuccessAt).toBeTruthy()
  })

  it('按日期：日粒度合计与对比点；周粒度只读周行', async () => {
    const day = await ok(reader, `${BASE}/by-date?${RANGE}&compare=previous`)
    expect(day.totals).toMatchObject({ orderedSales: 200, unitsOrdered: 20 })
    expect(day.comparePoints[1]).toMatchObject({ date: '2026-10-02', orderedSales: 50 })
    const week = await ok(reader, `${BASE}/by-date?${RANGE}&granularity=WEEK`)
    expect(week.points.map((point: { date: string; orderedSales: number }) => [point.date, point.orderedSales])).toEqual([['2026-10-04', 700]])
  })

  it('按 ASIN：数据库按店铺汇总范围内合计；报告来源被数据中心取代；比率由合计相除；带商品标题', async () => {
    const data = await ok(reader, `${BASE}/by-asin?${RANGE}`)
    expect(data.items.map((item: { asin: string; storeName: string; orderedSales: number }) => [item.asin, item.storeName, item.orderedSales])).toEqual([
      ['B000000001', '美国主店', 120],
      ['B000000001', '欧洲店', 40],
    ])
    expect(data.items[0]).toMatchObject({
      unitsOrdered: 6,
      sessions: 200,
      pageViews: 300,
      unitSessionPct: 0.03,
      avgPrice: 20,
      buyBoxPct: 0.7,
      title: '护眼台灯',
      productId: 'prod-br-1',
      parentAsin: 'B00000000P',
    })
    expect(data.items[1]).toMatchObject({ sessions: null, unitSessionPct: null, buyBoxPct: null, avgPrice: 10 })
    const sku = await ok(reader, `${BASE}/by-asin?${RANGE}&level=SKU`)
    expect(sku.items).toHaveLength(1)
    expect(sku.items[0]).toMatchObject({ asin: 'B000000002', sku: 'SKU-2', orderedSales: 10 })
    const found = await ok(reader, `${BASE}/by-asin?${RANGE}&q=b000000001`)
    expect(found.items).toHaveLength(2)
  })

  it('游标翻页在真实数据上接得上，条件变了游标失效', async () => {
    const first = await get(reader, `${BASE}/by-asin?${RANGE}&pageSize=1`)
    expect(first.json.data.items).toHaveLength(1)
    const cursor = encodeURIComponent(first.json.data.pageInfo.nextCursor)
    const second = await ok(reader, `${BASE}/by-asin?${RANGE}&pageSize=1&cursor=${cursor}`)
    expect(second.items[0]).toMatchObject({ storeName: '欧洲店' })
    expect(second.pageInfo.hasMore).toBe(false)
    expect((await get(reader, `${BASE}/by-asin?${RANGE}&pageSize=1&level=SKU&cursor=${cursor}`)).status).toBe(400)
  })

  it('单个 ASIN 趋势：跨店铺逐日相加，同店同日只用数据中心', async () => {
    const data = await ok(reader, `${BASE}/trends?${RANGE}&asin=B000000001`)
    expect(data).toMatchObject({ title: '护眼台灯', productId: 'prod-br-1' })
    expect(data.points[0]).toMatchObject({ date: '2026-10-08', orderedSales: 100, unitsOrdered: 7 })
    expect(data.points[1]).toMatchObject({ date: '2026-10-09', orderedSales: 60 })
    expect(data.points[2]).toMatchObject({ orderedSales: null })
  })

  it('权限：没有 analytics.read 403；数据范围：限定店铺只看到自己的；跨企业完全隔离', async () => {
    for (const route of ['summary', 'by-date', 'by-asin', 'trends?asin=B000000001']) expect((await get(noRead, `${BASE}/${route}`)).status).toBe(403)
    const mine = await ok(scoped, `${BASE}/summary?${RANGE}`)
    expect(mine.cards.find((item: { key: string }) => item.key === 'orderedSales').value).toBe(40)
    expect(mine.stores.map((store: { storeName: string }) => store.storeName)).toEqual(['欧洲店'])
    expect(mine.split.state).toBe('NO_DATA')
    const asins = await ok(scoped, `${BASE}/by-asin?${RANGE}`)
    expect(asins.items.map((item: { storeName: string }) => item.storeName)).toEqual(['欧洲店'])
    const theirs = await ok(other, `${BASE}/summary?${RANGE}`)
    expect(theirs.cards.find((item: { key: string }) => item.key === 'orderedSales').value).toBe(7777)
    const theirAsins = await ok(other, `${BASE}/by-asin?${RANGE}`)
    expect(theirAsins.items.map((item: { orderedSales: number }) => item.orderedSales)).toEqual([5555])
    expect(JSON.stringify(theirAsins)).not.toContain('护眼台灯')
  })
})
