import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// ASIN 360“利润与成本”与“退货”页签（P2b-17，真实数据库 + 完整应用）：
// 只取这个商品（店铺 × SKU，退货是店铺 × ASIN）自己的行，不混入同店铺别的 SKU、店铺级行、别的口径、别的店铺；
// 每件折算按种子数据确切；官方对照、费用预览、成本版本、关联赔付的真实查询；字段权限、数据范围与跨企业隔离。
// 种子（下单口径，范围 2026-10-01 至 2026-10-10）：SKU-A 两天（共 15 件、销售额 300、净利润 85）、同店铺 SKU-X、店铺级行、结算释放口径一行。

type Member = { userId: string; token: string }
const US = 'ATVPDKIKX0DER'
const RANGE = 'from=2026-10-01&to=2026-10-10'
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

describe('ASIN 360 利润与成本、退货（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let s1: string
  let s2: string
  let full: Member
  let noCost: Member
  let noField: Member
  let scoped: Member
  let other: Member

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const profit = (store: string, sku: string, date: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'ProfitDaily', {
      id: `pd-${store}-${sku}-${date}-${String(over.basis ?? 'ORDERED')}`,
      tenantId,
      sellerAccountId: store,
      sku,
      profitDate: date,
      basis: 'ORDERED',
      costing: 'FIFO',
      metricVersion: 'p2b-09@1',
      ...over,
    })
  const official = (sku: string, date: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'EconomicsDaily', {
      id: `ed-${sku}-${date}`,
      tenantId,
      sellerAccountId: s1,
      date,
      msku: sku,
      asin: 'B0A',
      currency: 'USD',
      netUnits: 0,
      orderedSales: 0,
      refundedSales: 0,
      sales: 0,
      feesTotal: 0,
      adsSpend: 0,
      ...over,
    })
  const returned = (id: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'FbaReturnCase', { id, tenantId, sellerAccountId: s1, amazonOrderId: `111-${id}`, asin: 'B0A', sellerSku: 'SKU-A', quantity: 1, returnDate: ago(3), ...over })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'products_economics', db })
    const a = await h.createTenant('pe-a')
    tenantId = a.tenantId
    s1 = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-pe-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-PE-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('pe-b')
    const fullPermissions = ['products.read', 'profit.read', 'field.profit', 'field.cost', 'finance.read', 'returns.read', 'reimbursements.read', 'costs.read']
    full = await h.createMember(tenantId, 'pe-full', fullPermissions)
    noCost = await h.createMember(tenantId, 'pe-nocost', ['products.read', 'profit.read', 'field.profit', 'finance.read', 'returns.read'])
    noField = await h.createMember(tenantId, 'pe-nofield', ['products.read', 'profit.read', 'returns.read'])
    scoped = await h.createMember(tenantId, 'pe-scoped', fullPermissions, { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'pe-other', ['*'])

    const product = (id: string, store: string, sku: string, asin: string) =>
      insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: store, marketplaceId: US, sellerSku: sku, asin, title: `商品 ${sku}`, price: 19.9, currency: 'USD' })
    await product('prod-a', s1, 'SKU-A', 'B0A')
    await product('prod-a2', s1, 'SKU-A2', 'B0A') // 同 ASIN 的另一个 SKU
    await product('prod-x', s1, 'SKU-X', 'B0X')

    // 利润日表
    const a1 = { asin: 'B0A', units: 10, costedUnits: 10, revenue: 200, refunds: 10, feeCommission: 30, feeFulfillment: 40, promotion: 10, productCost: 50, firstMileCost: 10, profit: 50 }
    await profit(s1, 'SKU-A', '2026-10-01', a1)
    await profit(s1, 'SKU-A', '2026-10-02', { asin: 'B0A', units: 5, costedUnits: 5, revenue: 100, feeCommission: 15, feeFulfillment: 20, productCost: 25, firstMileCost: 5, profit: 35 })
    await profit(s1, 'SKU-X', '2026-10-01', { asin: 'B0X', units: 100, costedUnits: 100, revenue: 1000, productCost: 100, profit: 900 })
    await profit(s1, '__STORE__', '2026-10-01', { units: 0, feeOther: 5, adsUnallocated: 25, profit: -30 })
    await profit(s1, 'SKU-A', '2026-10-01', { ...a1, basis: 'SETTLED', revenue: 999, profit: 500 })

    // 官方单品经济：SKU-A 第一天与我方一致，第二天官方有而我方少 5 美元费用；SKU-X 不应出现
    await official('SKU-A', '2026-10-01', { netUnits: 10, orderedSales: 200, refundedSales: 10, sales: 190, feesTotal: 70, sellerCostPerUnit: 6, netProceeds: 60 })
    await official('SKU-A', '2026-10-02', { netUnits: 5, orderedSales: 100, sales: 100, feesTotal: 40, sellerCostPerUnit: 6, netProceeds: 30 })
    await official('SKU-X', '2026-10-01', { asin: 'B0X', netUnits: 100, orderedSales: 1000, sales: 1000, feesTotal: 100, netProceeds: 900 })

    // 费用预览：同一次查询里有 SKU-A 与 SKU-X
    const queriedAt = ago(0) // 同一次查询的行同一个时间，“最近一次查询”按它取
    const preview = (sku: string, feeType: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'EconomicsPreview', {
        id: `ep-${sku}-${feeType}`,
        tenantId,
        sellerAccountId: s1,
        msku: sku,
        feeType,
        rangeStart: '2026-10-24',
        rangeEnd: '2027-01-15',
        estimatedAmount: 100,
        queriedAt,
        ...over,
      })
    await preview('SKU-A', 'FBA_FULFILLMENT', { quantity: 30, amountPerUnit: 4, amountPerUnitDelta: 0.2 })
    await preview('SKU-A', 'STORAGE', { estimatedAmount: 12 })
    await preview('SKU-X', 'FBA_FULFILLMENT', { estimatedAmount: 999 })

    // 成本版本
    await insertRow(h.client, 'CostVersion', { id: 'cv-a', tenantId, sku: 'SKU-A', versionNo: 1, effectiveFrom: '2020-01-01', currency: 'USD', unitProductCost: 5, source: 'MANUAL', status: 'ACTIVE' })

    // 退货（店铺 × ASIN B0A）：近 3 天 2 件（SKU-A，承运人损坏，原因有缺陷）、近 5 天 1 件（SKU-A2，可售，未提供原因）；
    // 其余：别的 ASIN、早于 90 天、别的店铺都不应计入
    await returned('r1', { quantity: 2, reason: 'DEFECTIVE', detailedDisposition: 'CARRIER_DAMAGED', returnDate: ago(3) })
    await returned('r2', { quantity: 1, sellerSku: 'SKU-A2', reason: null, detailedDisposition: 'SELLABLE', returnDate: ago(5) })
    await returned('r3', { asin: 'B0X', sellerSku: 'SKU-X', quantity: 9, returnDate: ago(3) })
    await returned('r4', { quantity: 7, returnDate: ago(120) })
    await returned('r5', { sellerAccountId: s2, quantity: 6, returnDate: ago(3) })
    const sold = (date: string, units: number, asin = 'B0A', store = s1) =>
      insertRow(h.client, 'AsinDailySummary', { id: `sum-${store}-${asin}-${date}`, tenantId, sellerAccountId: store, summaryDate: date, asin, units, metricVersion: 'v1' })
    await sold(ago(3).slice(0, 10), 20)
    await sold(ago(5).slice(0, 10), 10)
    await sold(ago(3).slice(0, 10), 500, 'B0X')

    // 关联赔付：同 ASIN 的 SKU-A2 有一条退货处置异常机会（已立案）；费用多收不属于退货类
    const opp = (id: string, over: Record<string, unknown>) =>
      insertRow(h.client, 'ReimbursementOpportunity', {
        id,
        tenantId,
        sellerAccountId: s1,
        ruleCode: 'RETURN_DISPOSITION',
        dedupKey: id,
        evidenceRefsJson: '[]',
        sku: 'SKU-A2',
        estimatedAmount: 24.5,
        currency: 'USD',
        qty: 2,
        ...over,
      })
    await opp('opp-1', { status: 'CASE_CREATED' })
    await opp('opp-2', { ruleCode: 'FEE_OVERCHARGE', sku: 'SKU-A' })
    await opp('opp-3', { sku: 'SKU-X' })
    await insertRow(h.client, 'ReimbursementCase', {
      id: 'case-1',
      tenantId,
      sellerAccountId: s1,
      caseNo: 'RC-1',
      opportunityId: 'opp-1',
      ruleCode: 'RETURN_DISPOSITION',
      status: 'SUBMITTED',
      sku: 'SKU-A2',
      ownerId: full.userId,
      createdBy: full.userId,
      evidenceRefsJson: '[]',
    })
  })
  afterAll(async () => {
    await h?.close()
  })

  describe('利润与成本', () => {
    it('每件折算按种子数据确切，只含这个 SKU 自己的下单口径行（不含同店铺别的 SKU、店铺级行、别的口径）', async () => {
      const data = await ok(full, `/products/prod-a/economics?${RANGE}`)
      expect(data).toMatchObject({ state: 'OK', recognition: 'ORDERED', currency: 'USD', listPrice: 19.9, costCoverage: 1 })
      expect(data.unit).toMatchObject({ state: 'OK', units: 15, avgPrice: 20, netPerUnit: 5.666667, proportionalShare: 0.216667 })
      const line = (key: string) => data.unit.lines.find((entry: { key: string }) => entry.key === key)
      expect(line('REVENUE').perUnit).toBe(20)
      expect(line('COMMISSION').perUnit).toBe(3)
      expect(line('FULFILLMENT').perUnit).toBe(4)
      expect(line('PRODUCT_COST').perUnit).toBe(5)
      expect(line('FIRST_MILE').perUnit).toBe(1)
      expect(line('ADS')).toMatchObject({ perUnit: null, state: 'NO_DATA' })
      expect(line('DUTY')).toMatchObject({ perUnit: null, state: 'NO_DATA' })
      expect(data.bridge).toMatchObject({ netProfit: 85, rows: 2 })
      expect(data.trend.map((point: { date: string; profit: number }) => [point.date, point.profit])).toEqual([
        ['2026-10-01', 50],
        ['2026-10-02', 35],
      ])
    })

    it('收入确认口径切换只读那一种口径的行', async () => {
      const data = await ok(full, `/products/prod-a/economics?${RANGE}&recognition=SETTLED`)
      expect(data.recognition).toBe('SETTLED')
      expect(data.unit).toMatchObject({ units: 10, avgPrice: 99.9, netPerUnit: 50 })
    })

    it('这个商品在范围内没有利润行：无数据说明，每件金额为空', async () => {
      const data = await ok(full, `/products/prod-a2/economics?${RANGE}`)
      expect(data).toMatchObject({ state: 'NO_DATA', trend: [] })
      expect(data.unit).toMatchObject({ state: 'NO_UNITS', avgPrice: null, netPerUnit: null })
    })

    it('有一行缺成本：整体净利润不给，每件净利润为空，价格模拟不可用', async () => {
      await profit(s1, 'SKU-B', '2026-10-03', { asin: 'B0B', units: 4, costedUnits: 0, revenue: 80, feeCommission: 12, profit: null })
      await insertRow(h.client, 'FbaProduct', { id: 'prod-b', tenantId, sellerAccountId: s1, marketplaceId: US, sellerSku: 'SKU-B', asin: 'B0B', title: '缺成本商品' })
      const data = await ok(full, `/products/prod-b/economics?${RANGE}`)
      expect(data.unit).toMatchObject({ state: 'INCOMPLETE', netPerUnit: null, avgPrice: 20 })
      expect(data.bridge.netProfit).toBeNull()
      expect(data.costCoverage).toBe(0)
    })

    it('没有成本字段权限：成本类项目写无权限，成本覆盖率不给；官方对照与成本时间线是 403', async () => {
      const data = await ok(noCost, `/products/prod-a/economics?${RANGE}`)
      expect(data.unit.lines.find((entry: { key: string }) => entry.key === 'PRODUCT_COST')).toMatchObject({ perUnit: null, state: 'RESTRICTED' })
      expect(data.costCoverage).toBeNull()
      expect(data.unit.netPerUnit).toBe(5.666667)
      expect((await get(noCost, `/products/prod-a/economics/official?${RANGE}`)).status).toBe(403)
      expect((await get(noCost, '/products/prod-a/economics/costs')).status).toBe(403)
    })

    it('没有利润字段权限：403；数据范围外的商品与别的企业：404', async () => {
      expect((await get(noField, `/products/prod-a/economics?${RANGE}`)).status).toBe(403)
      expect((await get(scoped, `/products/prod-a/economics?${RANGE}`)).status).toBe(404)
      expect((await get(other, `/products/prod-a/economics?${RANGE}`)).status).toBe(404)
    })

    it('官方对照：只含这个 SKU 的官方行与我方行，逐日对照，日期新的在前', async () => {
      const data = await ok(full, `/products/prod-a/economics/official?${RANGE}`)
      expect(data).toMatchObject({ state: 'OK', officialCoverage: { from: '2026-10-01', to: '2026-10-02' }, truncated: false })
      expect(data.items.map((row: { date: string; msku: string }) => [row.date, row.msku])).toEqual([
        ['2026-10-02', 'SKU-A'],
        ['2026-10-01', 'SKU-A'],
      ])
      expect(data.items[1]).toMatchObject({ verdict: 'MATCH', storeName: expect.any(String) })
      expect(data.items[0].verdict).not.toBe('MATCH') // 第二天官方费用 40，我方 35
      expect(data.summary).toMatchObject({ rows: 2, comparable: 2 })
    })

    it('官方对照范围超过 90 天：422；这个商品官方没有记录：无数据说明', async () => {
      expect((await get(full, '/products/prod-a/economics/official?from=2026-06-01&to=2026-10-10')).status).toBe(422)
      const none = await ok(full, `/products/prod-a2/economics/official?${RANGE}`)
      expect(none).toMatchObject({ state: 'NO_DATA', items: [], officialCoverage: null })
    })

    it('费用预览：只取这个 SKU 在最近一次查询里的行，有费用调整的算出影响', async () => {
      const data = await ok(noCost, '/products/prod-a/economics/preview')
      expect(data.state).toBe('OK')
      expect(data.items.map((row: { msku: string; feeType: string }) => [row.msku, row.feeType])).toEqual([
        ['SKU-A', 'FBA_FULFILLMENT'],
        ['SKU-A', 'STORAGE'],
      ])
      expect(data.items[0]).toMatchObject({ impact: -6, impactState: 'OK' })
      expect(data.summary).toMatchObject({ rows: 2, products: 1, totalImpact: -6 })
      const none = await ok(noCost, '/products/prod-a2/economics/preview')
      expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
      expect(none.note).toContain('没有这个 SKU')
    })

    it('成本版本时间线：这个 SKU 的版本；没有版本给出空状态', async () => {
      const data = await ok(full, '/products/prod-a/economics/costs')
      expect(data).toMatchObject({ state: 'OK', sku: 'SKU-A', versionsTruncated: false })
      expect(data.versions).toHaveLength(1)
      expect(data.versions[0]).toMatchObject({ versionNo: 1, status: 'ACTIVE', currency: 'USD' })
      const none = await ok(full, '/products/prod-a2/economics/costs')
      expect(none).toMatchObject({ state: 'NO_DATA', versions: [] })
      expect(none.note).toContain('还没有任何成本版本')
    })
  })

  describe('退货', () => {
    it('按店铺 × ASIN 汇总：同 ASIN 的多个 SKU 合计，不含别的 ASIN、更早的、别的店铺；退货率按同期销售件数', async () => {
      const data = await ok(full, '/products/prod-a/returns')
      expect(data).toMatchObject({ state: 'OK', range: { defaulted: true }, totals: { returnedUnits: 3, soldUnits: 30, rate: 0.1 }, truncated: false })
      expect(data.reasons).toEqual([
        { reason: 'DEFECTIVE', label: '商品有缺陷', units: 2, share: 0.6667 },
        { reason: 'UNSPECIFIED', label: '未提供原因', units: 1, share: 0.3333 },
      ])
      expect(data.dispositions).toEqual([
        { group: 'CARRIER_DAMAGED', label: '承运人损坏', units: 2, share: 0.6667 },
        { group: 'SELLABLE', label: '可售', units: 1, share: 0.3333 },
      ])
      expect(data.recent.map((row: { id: string; sku: string }) => [row.id, row.sku])).toEqual([
        ['r1', 'SKU-A'],
        ['r2', 'SKU-A2'],
      ])
      expect(data.trend.reduce((sum: number, point: { returnedUnits: number }) => sum + point.returnedUnits, 0)).toBe(3)
      expect(data.categoryThemes.state).toBe('NOT_CONNECTED')
    })

    it('关联赔付：同 ASIN 各 SKU 的退货类机会与已立案件；费用多收与别的商品不算', async () => {
      const { reimbursements } = await ok(full, '/products/prod-a/returns')
      expect(reimbursements.state).toBe('OK')
      expect(reimbursements.items).toHaveLength(1)
      expect(reimbursements.items[0]).toMatchObject({ id: 'opp-1', ruleCode: 'RETURN_DISPOSITION', caseId: 'case-1', caseNo: 'RC-1', estimatedAmount: 24.5, qty: 2 })
    })

    it('没有赔付读取权限：只是不显示赔付，退货数据照常；没有任何记录的商品给出空状态', async () => {
      const data = await ok(noCost, '/products/prod-a/returns')
      expect(data.reimbursements).toMatchObject({ state: 'RESTRICTED', items: [] })
      expect(data.totals.returnedUnits).toBe(3)
      const empty = await ok(full, '/products/prod-b/returns')
      expect(empty).toMatchObject({ state: 'NO_DATA', trend: [], reasons: [], recent: [] })
      expect(empty.reimbursements.state).toBe('NO_DATA')
    })

    it('没有 returns.read：403；数据范围外与别的企业：404；坏日期 422', async () => {
      const member = await h.createMember(tenantId, 'pe-noreturns', ['products.read'])
      expect((await get(member, '/products/prod-a/returns')).status).toBe(403)
      expect((await get(scoped, '/products/prod-a/returns')).status).toBe(404)
      expect((await get(other, '/products/prod-a/returns')).status).toBe(404)
      expect((await get(full, '/products/prod-a/returns?from=nope&to=2026-10-10')).status).toBe(422)
    })
  })
})
