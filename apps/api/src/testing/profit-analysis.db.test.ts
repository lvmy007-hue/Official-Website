import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 利润分析（P2b-10，真实数据库 + 完整应用）：6 条只读路由按种子数据数值确切。
// 种子（下单口径，范围 2026-10-01 至 2026-10-10）：美国店 SKU A 两天（利润 50 与 30，成本折算 CNY）、SKU B（缺成本，利润为空）、店铺级行（广告 25、订阅费 5）；欧洲店 SKU C（利润 16）。
// 另有结算释放口径一行、对比期一行。覆盖：整体净利润在有一行缺成本时不给、部分利润另列；口径切换；字段权限与数据范围；游标翻页；跨企业隔离。

type Member = { userId: string; token: string }
const RANGE = 'from=2026-10-01&to=2026-10-10'

describe('利润分析（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let s1: string
  let s2: string
  let full: Member
  let noCost: Member
  let noField: Member
  let noPermission: Member
  let scoped: Member
  let other: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const item = (data: { bridge: { items: Array<{ key: string; value: number | null; state: string }> } }, key: string) => data.bridge.items.find(entry => entry.key === key)!

  const day = (store: string, sku: string, date: string, over: Record<string, unknown> = {}, id = `pd-${store}-${sku}-${date}-${String(over.basis ?? 'ORDERED')}`) =>
    insertRow(h.client, 'ProfitDaily', {
      id,
      tenantId,
      sellerAccountId: store,
      sku,
      profitDate: date,
      basis: 'ORDERED',
      costing: 'FIFO',
      metricVersion: 'p2b-09@1',
      ...over,
    })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'profit_analysis', db })
    const a = await h.createTenant('pa-a')
    tenantId = a.tenantId
    s1 = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-pa-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PA-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('pa-b')
    full = await h.createMember(tenantId, 'pa-full', ['profit.read', 'field.profit', 'field.cost'])
    noCost = await h.createMember(tenantId, 'pa-nocost', ['profit.read', 'field.profit'])
    noField = await h.createMember(tenantId, 'pa-nofield', ['profit.read'])
    noPermission = await h.createMember(tenantId, 'pa-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'pa-scoped', ['profit.read', 'field.profit', 'field.cost'], { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'pa-other', ['*'])
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没有利润数据：各接口给空状态说明，不是 0', async () => {
    const overview = await ok(full, `/profit/overview?${RANGE}`)
    expect(overview).toMatchObject({ state: 'NO_DATA', recognition: 'ORDERED', summary: { revenue: null, netProfit: null, margin: null, rows: 0 } })
    expect(overview.note).toContain('尚无利润数据')
    expect(overview.trend).toEqual([])
    expect(item(overview, 'DUTY').state).toBe('NO_DATA')
    expect(item(overview, 'NET_PROFIT').state).toBe('NO_DATA')
    const stores = await ok(full, `/profit/stores?${RANGE}`)
    expect(stores.state).toBe('NO_DATA')
    expect(stores.items.map((row: { revenue: number | null }) => row.revenue)).toEqual([null, null])
    expect((await ok(full, `/profit/asins?${RANGE}`)).items).toEqual([])
    expect((await ok(full, `/profit/cost-coverage?${RANGE}`)).adsUnallocated).toMatchObject({ state: 'NOT_CONNECTED', total: null })
  })

  describe('有数据', () => {
    beforeAll(async () => {
      const a1 = { asin: 'B0A', units: 10, costedUnits: 10, revenue: 200, refunds: 10, feeCommission: 30, feeFulfillment: 40, productCost: 60, firstMileCost: 10, profit: 50 }
      await day(s1, 'SKU-A', '2026-10-01', { ...a1, costCurrency: 'CNY', productCostOriginal: 432, fxRate: 7.2, fxSource: 'MANUAL' })
      await day(s1, 'SKU-A', '2026-10-02', {
        asin: 'B0A',
        units: 5,
        costedUnits: 5,
        revenue: 100,
        feeCommission: 15,
        feeFulfillment: 20,
        productCost: 30,
        firstMileCost: 5,
        profit: 30,
        costCurrency: 'CNY',
        productCostOriginal: 216,
        fxRate: 7.2,
        fxSource: 'MANUAL',
        fxFallback: true,
        flags: ['FX_FALLBACK'],
      })
      await day(s1, 'SKU-B', '2026-10-01', { asin: 'B0B', units: 4, costedUnits: 0, revenue: 80, feeCommission: 12, feeFulfillment: 16, profit: null, flags: ['COST_MISSING'] })
      await day(s1, '__STORE__', '2026-10-01', { units: 0, feeOther: 5, adsUnallocated: 25, profit: -30, flags: ['ADS_UNALLOCATED'] })
      await day(s2, 'SKU-C', '2026-10-03', { asin: 'B0C', units: 2, costedUnits: 2, revenue: 40, feeCommission: 6, feeFulfillment: 8, productCost: 10, profit: 16 })
      // 另一种口径与对比期
      await day(s1, 'SKU-A', '2026-10-01', { asin: 'B0A', basis: 'SETTLED', units: 10, costedUnits: 10, revenue: 999, productCost: 499, profit: 500 })
      await day(s1, 'SKU-A', '2026-09-25', { asin: 'B0A', units: 10, costedUnits: 10, revenue: 100, feeCommission: 15, productCost: 30, profit: 55 })
      for (const [sku, asin, parent, title] of [
        ['SKU-A', 'B0A', 'PARENT1', '商品 A'],
        ['SKU-B', 'B0B', 'PARENT1', '商品 B'],
      ] as const)
        await insertRow(h.client, 'FbaProduct', { id: `prod-${sku}`, tenantId, sellerAccountId: s1, sellerSku: sku, asin, parentAsin: parent, title })
      await insertRow(h.client, 'FbaProduct', { id: 'prod-SKU-C', tenantId, sellerAccountId: s2, sellerSku: 'SKU-C', asin: 'B0C', title: '商品 C' })
      await insertRow(h.client, 'CostVersion', {
        id: 'cv-a',
        tenantId,
        sku: 'SKU-A',
        versionNo: 1,
        effectiveFrom: '2020-01-01',
        currency: 'CNY',
        unitProductCost: 43.2,
        source: 'MANUAL',
        status: 'ACTIVE',
      })
      await insertRow(h.client, 'CostVersion', {
        id: 'cv-c',
        tenantId,
        sku: 'SKU-C',
        versionNo: 1,
        effectiveFrom: new Date().toISOString().slice(0, 10),
        currency: 'USD',
        unitProductCost: 5,
        source: 'MANUAL',
        status: 'ACTIVE',
      })
    })

    it('总览：整体净利润在有一行缺成本时不给，部分利润另列；利润桥各项按种子数据确切；关税与汇兑损益尚未接入；标记汇总', async () => {
      const data = await ok(full, `/profit/overview?${RANGE}`)
      expect(data).toMatchObject({ state: 'OK', basisLabel: '下单口径', currency: 'USD', range: { from: '2026-10-01', to: '2026-10-10', days: 10, defaulted: false } })
      expect(data.summary).toMatchObject({ revenue: 420, units: 21, netProfit: null, margin: null, coveredProfit: 66, incompleteRows: 1, rows: 5 })
      expect(data.summary.costCoverage).toBeCloseTo(17 / 21, 5)
      const values = Object.fromEntries(data.bridge.items.map((entry: { key: string; value: number | null }) => [entry.key, entry.value]))
      expect(values).toMatchObject({
        REVENUE: 420,
        REFUNDS: 10,
        COMMISSION: 63,
        FULFILLMENT: 84,
        OTHER_FEES: 5,
        ADS: 25,
        PRODUCT_COST: 100,
        FIRST_MILE: 15,
        REIMBURSEMENT: 0,
        DUTY: null,
        FX_GAIN_LOSS: null,
        NET_PROFIT: null,
      })
      expect(item(data, 'DUTY')).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('没有关税') })
      expect(item(data, 'NET_PROFIT')).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('1 行因缺少成本算不出利润') })
      expect(data.flags.map((flag: { flag: string; rows: number }) => [flag.flag, flag.rows]).sort()).toEqual([
        ['ADS_UNALLOCATED', 1],
        ['COST_MISSING', 1],
        ['FX_FALLBACK', 1],
      ])
      expect(data.trend.map((point: { date: string }) => point.date)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
      expect(data.trend[0]).toMatchObject({ revenue: 280, profit: null, coveredProfit: 20 })
      expect(data.trend[1]).toMatchObject({ revenue: 100, profit: 30 })
      expect(data.refreshedAt).toEqual(expect.any(String))
    })

    it('把缺成本的 SKU 排除后（只看欧洲店）净利润与利润率给出；口径切换后只看结算释放的行', async () => {
      const eu = await ok(full, `/profit/overview?${RANGE}&storeIds=${s2}`)
      expect(eu.summary).toMatchObject({ revenue: 40, netProfit: 16, margin: 0.4, incompleteRows: 0 })
      expect(item(eu, 'NET_PROFIT')).toMatchObject({ value: 16, state: 'OK' })
      const settled = await ok(full, `/profit/overview?${RANGE}&recognition=SETTLED`)
      expect(settled).toMatchObject({ basisLabel: '结算释放口径' })
      expect(settled.summary).toMatchObject({ revenue: 999, netProfit: 500, rows: 1 })
      expect((await get(full, `/profit/overview?${RANGE}&recognition=BAD`)).status).toBe(422)
    })

    it('店铺利润：每个店铺一行，各带利润桥；有缺成本的店铺净利润为空', async () => {
      const data = await ok(full, `/profit/stores?${RANGE}`)
      const [first, second] = data.items
      expect(first).toMatchObject({ sellerAccountId: s1, revenue: 380, netProfit: null, margin: null })
      expect(first.bridge).toMatchObject({ incompleteRows: 1, rows: 4, coveredProfit: 50 })
      expect(second).toMatchObject({ sellerAccountId: s2, storeName: '欧洲店', revenue: 40, netProfit: 16, margin: 0.4 })
      expect(item(second, 'PRODUCT_COST').value).toBe(10)
    })

    it('ASIN 利润（按 SKU）：单位经济、成本折算明细（原币、折算、汇率、来源）、店铺级行单列、官方对照尚未接入', async () => {
      const data = await ok(full, `/profit/asins?${RANGE}`)
      expect(data.dimension).toBe('SKU')
      expect(data.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-A', 'SKU-B', 'SKU-C'])
      const [a, b] = data.items
      expect(a).toMatchObject({ units: 15, revenue: 300, fees: 105, profit: 80, costCoverage: 1, productCost: 90, title: '商品 A', productId: 'prod-SKU-A', parentAsin: 'PARENT1' })
      expect(a.margin).toBeCloseTo(80 / 300, 5)
      expect(a.perUnit).toMatchObject({ revenue: 20, profit: expect.closeTo(80 / 15, 5), productCost: 6 })
      expect(a.costDetail).toEqual([{ currency: 'CNY', rate: 7.2, source: 'MANUAL', fallbackRows: 1, productOriginal: 648, productConverted: 90, firstMileOriginal: null, firstMileConverted: 15 }])
      expect(a.official).toMatchObject({ state: 'NOT_CONNECTED', note: expect.stringContaining('官方经济数据对账') })
      expect(b).toMatchObject({ profit: null, margin: null, productCost: null, costCoverage: 0, incompleteRows: 1 })
      expect(b.perUnit.productCost).toBeNull()
      expect(data.storeLevel.items.find((entry: { key: string }) => entry.key === 'ADS')).toMatchObject({ value: 25 })
      expect(data.storeLevel).toMatchObject({ rows: 1, netProfit: -30 })
      expect(data.pageInfo).toMatchObject({ hasMore: false, approxTotal: 3 })
    })

    it('按 ASIN、按父体合并；关键字与排序；缺成本的排在最后', async () => {
      const asin = await ok(full, `/profit/asins?${RANGE}&by=ASIN`)
      expect(asin.items.map((row: { key: string }) => row.key)).toEqual(['B0A', 'B0B', 'B0C'])
      const parent = await ok(full, `/profit/asins?${RANGE}&by=PARENT`)
      expect(parent.items.map((row: { key: string; revenue: number; profit: number | null }) => [row.key, row.revenue, row.profit])).toEqual([
        ['PARENT1', 380, null],
        ['B0C', 40, 16],
      ])
      expect((await ok(full, `/profit/asins?${RANGE}&q=b0b`)).items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-B'])
      const byProfit = await ok(full, `/profit/asins?${RANGE}&sort=profit:desc`)
      expect(byProfit.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-A', 'SKU-C', 'SKU-B'])
      expect((await get(full, `/profit/asins?${RANGE}&sort=bogus`)).status).toBe(422)
    })

    it('游标翻页：下一页接着上一页；换了条件的旧游标与伪造游标返回 400', async () => {
      const first = await ok(full, `/profit/asins?${RANGE}&pageSize=2`)
      expect(first.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-A', 'SKU-B'])
      expect(first.pageInfo).toMatchObject({ pageSize: 2, hasMore: true, approxTotal: 3 })
      const second = await ok(full, `/profit/asins?${RANGE}&pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(second.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-C'])
      expect(second.pageInfo).toMatchObject({ hasMore: false, nextCursor: null })
      expect((await get(full, `/profit/asins?${RANGE}&pageSize=2&by=ASIN&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
      expect((await get(full, `/profit/asins?${RANGE}&cursor=forged.value`)).status).toBe(400)
    })

    it('广告利润：广告尚未分摊，店铺层面给出广告花费与广告前后利润；各行判断是“尚未分摊”或“缺成本”', async () => {
      const data = await ok(full, `/profit/ads?${RANGE}`)
      expect(data.allocation).toMatchObject({ state: 'NOT_ALLOCATED', note: expect.stringContaining('没有广告分摊结果') })
      const us = data.stores.find((row: { sellerAccountId: string }) => row.sellerAccountId === s1)
      expect(us).toMatchObject({ revenue: 380, adsSpend: 25, netProfit: null, profitBeforeAds: null })
      expect(us.adsShare).toBeCloseTo(25 / 380, 5)
      const eu = data.stores.find((row: { sellerAccountId: string }) => row.sellerAccountId === s2)
      expect(eu).toMatchObject({ adsSpend: null, adsShare: null, profitBeforeAds: 16, netProfit: 16 })
      expect(data.items.map((row: { sku: string; verdict: string; adsAllocated: number | null }) => [row.sku, row.verdict, row.adsAllocated])).toEqual([
        ['SKU-A', 'NOT_ALLOCATED', null],
        ['SKU-B', 'NO_COST', null],
        ['SKU-C', 'NOT_ALLOCATED', null],
      ])
    })

    it('成本覆盖：只列有问题的 SKU（缺成本、汇率沿用、成本版本过期）；广告未分摊金额；汇率分组', async () => {
      const data = await ok(full, `/profit/cost-coverage?${RANGE}`)
      expect(data.summary).toMatchObject({ skus: 3, skusWithIssues: 2, staleSkus: 1, units: 21, costedUnits: 17 })
      expect(data.items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-A', 'SKU-B'])
      const [a, b] = data.items
      expect(a.issues.map((entry: { issue: string }) => entry.issue)).toEqual(['FX_FALLBACK', 'COST_STALE'])
      expect(a).toMatchObject({ coverage: 1, latestCostEffective: '2020-01-01', title: '商品 A' })
      expect(a.costAgeDays).toBeGreaterThan(180)
      expect(b.issues.map((entry: { issue: string }) => entry.issue)).toEqual(['COST_MISSING'])
      expect(b).toMatchObject({ coverage: 0, latestCostEffective: null, costAgeDays: null })
      expect(data.adsUnallocated).toMatchObject({ state: 'OK', total: 25, stores: [{ sellerAccountId: s1, amount: 25 }] })
      expect(data.fx).toMatchObject({ fallbackRows: 1, missingRows: 0 })
      expect(data.fx.items).toEqual([
        { currency: 'CNY', source: 'MANUAL', fallback: false, rows: 1, rate: 7.2 },
        { currency: 'CNY', source: 'MANUAL', fallback: true, rows: 1, rate: 7.2 },
      ])
      expect(data.staleDays).toBe(180)
      expect((await ok(full, `/profit/cost-coverage?${RANGE}&q=sku-b`)).items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-B'])
    })

    it('利润桥对比：逐项给对净利润的影响，影响之和等于净利润变化；任一期缺数据的项目不给影响；净利润算不出时不给变化', async () => {
      const data = await ok(full, `/profit/bridge?from=2026-10-03&to=2026-10-03&compare=custom&compareFrom=2026-09-25&compareTo=2026-09-25`)
      expect(data).toMatchObject({ compareMode: 'custom', range: { from: '2026-10-03' }, baseRange: { from: '2026-09-25', to: '2026-09-25' } })
      expect(data.base).toMatchObject({ revenue: 100, netProfit: 55 })
      expect(data.current).toMatchObject({ revenue: 40, netProfit: 16 })
      expect(data.netImpact).toBe(-39)
      const impact = Object.fromEntries(data.rows.map((row: { key: string; impact: number | null }) => [row.key, row.impact]))
      expect(impact).toMatchObject({ REVENUE: -60, COMMISSION: 9, FULFILLMENT: -8, PRODUCT_COST: 20, FIRST_MILE: null, ADS: null, DUTY: null })
      expect(data.unexplained).toBe(0)
      expect(data.rows.find((row: { key: string }) => row.key === 'DUTY')).toMatchObject({ state: 'NO_DATA' })

      const partial = await ok(full, `/profit/bridge?${RANGE}&compare=custom&compareFrom=2026-09-25&compareTo=2026-09-25`)
      expect(partial.netImpact).toBeNull()
      expect(partial.note).toContain('净利润变化不给')
      expect(partial.note).toContain('两期天数不同')
      expect(partial.rows.find((row: { key: string }) => row.key === 'REVENUE')).toMatchObject({ base: 100, current: 420, impact: 320 })
      // 没选对比期：用上一期
      expect((await ok(full, `/profit/bridge?${RANGE}`)).compareMode).toBe('previous')
    })

    it('字段权限：没有利润字段权限 403；没有成本字段权限：成本项“无权限”、成本类键不存在、成本覆盖 403', async () => {
      expect((await get(noPermission, `/profit/overview?${RANGE}&recognition=BAD`)).status).toBe(403)
      for (const path of ['overview', 'stores', 'asins', 'ads', 'bridge']) {
        const res = await get(noField, `/profit/${path}?${RANGE}`)
        expect(res.status, path).toBe(403)
        expect(res.json.error.code).toBe('TENANT_ACCESS_DENIED')
        expect(res.json.error.message).toContain('field.profit')
      }
      expect((await get(noCost, `/profit/cost-coverage?${RANGE}`)).status).toBe(403)

      const overview = await ok(noCost, `/profit/overview?${RANGE}&storeIds=${s2}`)
      expect(overview.summary).toMatchObject({ netProfit: 16 })
      expect(overview.summary).not.toHaveProperty('costCoverage')
      expect(item(overview, 'PRODUCT_COST')).toMatchObject({ state: 'RESTRICTED', value: null })
      expect(item(overview, 'FIRST_MILE').state).toBe('RESTRICTED')
      const asins = await ok(noCost, `/profit/asins?${RANGE}`)
      for (const row of asins.items) for (const key of ['productCost', 'firstMileCost', 'otherCost', 'costCoverage', 'costDetail']) expect(row).not.toHaveProperty(key)
      expect(asins.items[0].perUnit).not.toHaveProperty('productCost')
      expect(asins.items[0]).toHaveProperty('profit')
    })

    it('数据范围：只看欧洲店的成员看不到美国店的行；跨企业隔离', async () => {
      const mine = await ok(scoped, `/profit/overview?${RANGE}`)
      expect(mine.summary).toMatchObject({ revenue: 40, rows: 1, netProfit: 16 })
      expect((await ok(scoped, `/profit/asins?${RANGE}`)).items.map((row: { sku: string }) => row.sku)).toEqual(['SKU-C'])
      expect((await ok(scoped, `/profit/stores?${RANGE}`)).items.map((row: { sellerAccountId: string }) => row.sellerAccountId)).toEqual([s2])
      expect((await ok(scoped, `/profit/cost-coverage?${RANGE}`)).items).toEqual([])
      expect((await ok(scoped, `/profit/ads?${RANGE}`)).stores.map((row: { sellerAccountId: string }) => row.sellerAccountId)).toEqual([s2])

      const theirs = await ok(other, `/profit/overview?${RANGE}`)
      expect(theirs).toMatchObject({ state: 'NO_DATA', summary: { rows: 0 } })
      expect((await ok(other, `/profit/asins?${RANGE}`)).items).toEqual([])
    })
  })
})
