import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// ASIN 与父体分析（P4-03，真实数据库 + 完整应用）：父体树与家族归并（含变体属性 JSON 列与关系表）、逐日指标的来源取舍与非美元排除、
// 退货与排名与库存的真实查询、权限、数据范围、跨企业隔离。
// 种子（范围 2026-10-08 至 2026-10-14）：父体 PP 名下 C1（主店 100、欧洲店 40）、C2（主店 50）、C3（只在关系表、主店 20）；C1 另有报告来源 999、欧元 500。
type Member = { userId: string; token: string }
const RANGE = 'from=2026-10-08&to=2026-10-14'
const NOW = '2026-10-20T00:00:00Z'
const PP = 'B0PARENT01'

describe('ASIN 与父体分析（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let s1: string
  let s2: string
  let reader: Member
  let noRead: Member
  let wide: Member
  let scoped: Member
  let other: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const asinRow = (tenant: string, store: string, date: string, asin: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'SalesTrafficAsinDaily', {
      id: `sta-${tenant}-${store}-${date}-${asin}-${String(over.source ?? 'DATA_KIOSK')}-${String(over.currency ?? 'USD')}`,
      tenantId: tenant,
      sellerAccountId: store,
      date,
      asin,
      asinGranularity: 'CHILD',
      sku: '',
      source: 'DATA_KIOSK',
      sourceUpdatedAt: NOW,
      ...over,
    })
  const product = (id: string, tenant: string, store: string, asin: string, parentAsin: string | null, attrs: Record<string, string> | null) =>
    insertRow(h.client, 'FbaProduct', { id, tenantId: tenant, sellerAccountId: store, sellerSku: `SKU-${id}`, asin, title: `商品 ${asin}`, parentAsin, variantAttributes: attrs })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'asin_analytics', db })
    const a = await h.createTenant('aa-a')
    tenantId = a.tenantId
    s1 = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-aa-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-AA-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('aa-b')
    reader = await h.createMember(tenantId, 'aa-read', ['analytics.read'])
    noRead = await h.createMember(tenantId, 'aa-none', ['finance.read'])
    wide = await h.createMember(tenantId, 'aa-wide', ['analytics.read', 'inventory.read', 'ads.read'])
    scoped = await h.createMember(tenantId, 'aa-scoped', ['analytics.read'], { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'aa-other', ['*'])

    await product('pa-c1', tenantId, s1, 'B0CHILD001', PP, { color: 'Red', size: 'L' })
    await product('pa-c1e', tenantId, s2, 'B0CHILD001', PP, { color: 'Red', size: 'L' })
    await product('pa-c2', tenantId, s1, 'B0CHILD002', PP, { color: 'Red', size: 'S' })
    await product('pa-s1', tenantId, s1, 'B0SINGLE01', null, null)
    await product('pb-c1', b.tenantId, b.sellerAccountId, 'B0CHILDBB1', 'B0PARENTBB', { color: 'Black' })
    for (const child of ['B0CHILD001', 'B0CHILD002', 'B0CHILD003']) {
      await insertRow(h.client, 'ProductVariantRelation', { id: `pvr-${child}`, tenantId, sellerAccountId: s1, parentAsin: PP, childAsin: child, variationTheme: 'COLOR_SIZE' })
    }

    await asinRow(tenantId, s1, '2026-10-08', 'B0CHILD001', { orderedSales: 100, units: 10, ordersCount: 8, sessions: 200, pageViews: 300 })
    await asinRow(tenantId, s1, '2026-10-08', 'B0CHILD001', { source: 'REPORT', orderedSales: 999, units: 99 })
    await asinRow(tenantId, s1, '2026-10-08', 'B0CHILD001', { currency: 'EUR', sku: 'EUR-ROW', orderedSales: 500, units: 50 })
    await asinRow(tenantId, s2, '2026-10-08', 'B0CHILD001', { orderedSales: 40, units: 4 })
    await asinRow(tenantId, s1, '2026-10-09', 'B0CHILD002', { orderedSales: 50, units: 5, sessions: 100 })
    await asinRow(tenantId, s1, '2026-10-09', 'B0CHILD003', { orderedSales: 20, units: 2, sessions: 40 })
    await asinRow(b.tenantId, b.sellerAccountId, '2026-10-08', 'B0CHILDBB1', { orderedSales: 5555, units: 9 })

    await insertRow(h.client, 'AsinDailySummary', {
      id: 'ads-aa-1',
      tenantId,
      sellerAccountId: s1,
      summaryDate: '2026-10-08',
      asin: 'B0CHILD001',
      units: 10,
      adsSales: 30,
      inventoryAvailable: 100,
      metricVersion: 'test@1',
    })
    await insertRow(h.client, 'FbaReturnCase', { id: 'rc-aa-1', tenantId, sellerAccountId: s1, asin: 'B0CHILD001', sellerSku: 'SKU-pa-c1', quantity: 2, returnDate: '2026-10-08T05:00:00Z' })
    await insertRow(h.client, 'SalesRankSnapshot', {
      id: 'sr-aa-1',
      tenantId,
      sellerAccountId: s1,
      asin: 'B0CHILD001',
      classificationId: 'home',
      classificationName: '家居',
      rank: 50,
      snapshotDate: '2026-10-08',
    })
    await insertRow(h.client, 'FbaInventoryRecord', { id: 'inv-aa-1', tenantId, sellerAccountId: s1, asin: 'B0CHILD001', sellerSku: 'SKU-pa-c1', fulfillableQuantity: 30 })
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-aa-1',
      tenantId,
      sellerAccountId: s1,
      entityType: 'PARENT_ASIN',
      entityId: PP,
      kind: 'variation.child_added',
      occurredAt: '2026-10-12T01:00:00Z',
      title: '新增子体 B0CHILD003',
      detailJson: { childAsin: 'B0CHILD003', before: null, after: PP },
      actorKind: 'AMAZON',
    })
    await insertRow(h.client, 'EntityEvent', {
      id: 'ev-bb-1',
      tenantId: b.tenantId,
      sellerAccountId: b.sellerAccountId,
      entityType: 'PARENT_ASIN',
      entityId: PP,
      kind: 'variation.child_added',
      occurredAt: '2026-10-12T02:00:00Z',
      title: '别的企业',
    })
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('父体树：家族来自商品目录的父体字段，销售额跨店铺相加、报告来源与非美元不统计；没有销售的单项排在最后', async () => {
    const data = await ok(reader, `/analytics/asins?${RANGE}`)
    expect(data.tree.map((node: { key: string }) => node.key)).toEqual([`parent:${PP}`, 'asin:B0SINGLE01'])
    expect(data.tree[0]).toMatchObject({ childCount: 2, sales: 190 })
    expect(data.tree[0].children.map((child: { asin: string; sales: number }) => [child.asin, child.sales])).toEqual([
      ['B0CHILD001', 140],
      ['B0CHILD002', 50],
    ])
    expect(data.tree[1]).toMatchObject({ sales: null, sessions: null })
    expect(data.selectionDefaulted).toBe(true)
    expect(data.selection[0].key).toBe(`parent:${PP}`)
  })

  it('选中父体与子体：逐日相加、广告销售、退货率、排名都是真实查询；父体没有排名', async () => {
    const data = await ok(reader, `/analytics/asins?${RANGE}&select=parent:${PP},asin:B0CHILD001`)
    const [parent, child] = data.selection
    expect(parent.memberCount).toBe(3)
    expect(parent.totals).toMatchObject({ sales: 210, units: 21, adsSales: 30, salesRank: null })
    expect(parent.totals.returnRate).toBeCloseTo(2 / 21, 5)
    expect(parent.points[0]).toMatchObject({ date: '2026-10-08', sales: 140, daysOfSupply: 100 / (10 / 1) })
    expect(child.totals).toMatchObject({ sales: 140, salesRank: 50, adsSales: 30 })
  })

  it('父体身份区与子体贡献矩阵：子体包含只在关系表里的 C3；变体属性来自商品目录的 JSON 列', async () => {
    const identity = await ok(reader, `/analytics/parents/${PP}?${RANGE}`)
    expect(identity).toMatchObject({ childCount: 3, sales: 210, variationTheme: 'COLOR_SIZE' })
    expect(identity.storeNames.sort()).toEqual(['displayName-x', '欧洲店'].sort())
    expect(identity.netProfit.state).toBe('RESTRICTED')
    const matrix = await ok(reader, `/analytics/parents/${PP}/matrix?${RANGE}`)
    expect(matrix.rows.map((row: { asin: string; sales: number | null }) => [row.asin, row.sales])).toEqual([
      ['B0CHILD001', 140],
      ['B0CHILD002', 50],
      ['B0CHILD003', 20],
    ])
    expect(matrix.pivot).toMatchObject({ dimensions: ['color', 'size'], rowDim: 'color', colDim: 'size' })
    expect(matrix.pivot.cells.find((cell: { row: string; col: string }) => cell.row === 'Red' && cell.col === 'L')).toMatchObject({ sales: 140 })
    expect(matrix.pivot.cells.find((cell: { row: string }) => cell.row === '未填写')).toMatchObject({ asins: ['B0CHILD003'], sales: 20 })
  })

  it('流量、库存、广告、评论与变更历史页签', async () => {
    const traffic = await ok(reader, `/analytics/parents/${PP}/traffic?${RANGE}`)
    expect(traffic.totalSessions).toBe(340)
    const inventory = await ok(wide, `/analytics/parents/${PP}/inventory?${RANGE}`)
    expect(inventory).toMatchObject({ policyState: 'NOT_CONNECTED', replenishmentState: 'RESTRICTED' })
    expect(inventory.rows[0]).toMatchObject({ asin: 'B0CHILD001', sellable: 30, skuCount: 1 })
    const ads = await ok(wide, `/analytics/parents/${PP}/ads?${RANGE}`)
    expect(ads).toMatchObject({ adsState: 'NOT_CONNECTED', rows: [] })
    expect((await ok(reader, `/analytics/parents/${PP}/reviews`)).reviewsState).toBe('NOT_CONNECTED')
    const changes = await ok(reader, `/analytics/parents/${PP}/changes`)
    expect(changes.items.map((item: { id: string }) => item.id)).toEqual(['ev-aa-1'])
  })

  it('权限：没有 analytics.read 403，库存与广告页签要各自的权限；数据范围只看到自己的店铺；跨企业完全隔离', async () => {
    for (const path of ['/analytics/asins', `/analytics/parents/${PP}`, `/analytics/parents/${PP}/changes`]) expect((await get(noRead, path)).status).toBe(403)
    for (const tab of ['inventory', 'ads']) expect((await get(reader, `/analytics/parents/${PP}/${tab}`)).status).toBe(403)
    const mine = await ok(scoped, `/analytics/asins?${RANGE}`)
    expect(mine.tree.map((node: { key: string; sales: number }) => [node.key, node.sales])).toEqual([[`parent:${PP}`, 40]])
    const matrix = await ok(scoped, `/analytics/parents/${PP}/matrix?${RANGE}`)
    expect(matrix.rows.map((row: { asin: string }) => row.asin)).toEqual(['B0CHILD001'])
    expect((await get(other, `/analytics/parents/${PP}`)).status).toBe(404)
    const theirs = await ok(other, `/analytics/parents/B0PARENTBB?${RANGE}`)
    expect(theirs.sales).toBe(5555)
    expect(JSON.stringify(await ok(other, `/analytics/asins?${RANGE}`))).not.toContain('B0CHILD001')
  })
})
