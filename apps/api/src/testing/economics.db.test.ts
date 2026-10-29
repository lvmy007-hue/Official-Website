import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 官方经济数据对账（P2b-11，真实数据库 + 完整应用 + 后台数据集写入代码）：
// 迁移升级与回滚、唯一键与检查约束；官方单品经济与费用预览在行级隔离的租户连接下写入（重复写覆盖不重复）；
// 双源核对的数值、排序、游标翻页、数据范围、字段权限、跨企业隔离；费用预览只看每个店铺最近一次查询；情景模拟的建任务、轮询与结果。

type Member = { userId: string; token: string }
const TARGET = '20261104010000_economics'
const RANGE = 'from=2026-10-01&to=2026-10-10'
const amount = (value: number) => ({ amount: value, currencyCode: 'USD' })
const logger = { warn: () => undefined, info: () => undefined, error: () => undefined }

describe('官方经济数据表迁移（P2b-11）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('economics_migrate')
    client = await db.connect('economics_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => (await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0].found as boolean

  it('升级建两张表、回滚全部删除、再次升级闭环成功；唯一键与检查约束由数据库保证', async () => {
    expect(await exists('EconomicsDaily')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of ['EconomicsDaily', 'EconomicsPreview']) expect(await exists(table)).toBe(true)
    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    for (const table of ['EconomicsDaily', 'EconomicsPreview']) expect(await exists(table)).toBe(false)
    await applyMigrations(client, { only: TARGET })

    const ids = await seedTenant(client, 'eco-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    const daily = (over: Record<string, unknown>) => insertRow(client, 'EconomicsDaily', { id: 'ed-1', ...base, date: '2026-10-05', msku: 'SKU-A', ...over })
    expect(await daily({})).toMatchObject({ aggregation: 'DAY', currency: 'USD', sellerCostPerUnit: null, netProceeds: null, adsSpend: '0.000000' })
    await expect(daily({ id: 'ed-2' })).rejects.toMatchObject({ code: '23505' }) // 同店铺同 SKU 同日
    await expect(daily({ id: 'ed-3', msku: 'SKU-B', aggregation: 'WEEK' })).rejects.toMatchObject({ code: '23514' })
    await expect(daily({ id: 'ed-4', msku: 'SKU-C', unitsOrdered: -1 })).rejects.toMatchObject({ code: '23514' })
    const preview = (over: Record<string, unknown>) =>
      insertRow(client, 'EconomicsPreview', {
        id: 'ep-1',
        ...base,
        msku: 'SKU-A',
        feeType: 'REFERRAL_FEES',
        rangeStart: '2026-10-23',
        rangeEnd: '2027-01-14',
        estimatedAmount: 10,
        queriedAt: '2026-10-23T08:00:00Z',
        ...over,
      })
    expect(await preview({})).toMatchObject({ quantity: null, amountPerUnitDelta: null })
    await expect(preview({ id: 'ep-2' })).rejects.toMatchObject({ code: '23505' })
    await expect(preview({ id: 'ep-3', feeType: 'X', rangeEnd: '2026-10-01' })).rejects.toMatchObject({ code: '23514' })
  })
})

describe('官方经济数据对账（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let s1: string
  let s2: string
  let full: Member
  let noField: Member
  let noPermission: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  let writeDaily: (ctx: unknown, row: unknown, scope: { tenantId: string; sellerAccountId: string }, params: Record<string, string>) => Promise<string>
  let writePreview: typeof writeDaily
  let writeSimulation: typeof writeDaily

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const write = (fn: typeof writeDaily, sellerAccountId: string, row: unknown, params: Record<string, string> = {}) =>
    runWithTenant(tenantId, () => fn({ prisma: tenantDb, logger }, row, { tenantId, sellerAccountId }, params))
  const kiosk = (msku: string, date: string, sales: number, fees: number, ads: number, cost: { cogs: number; ship: number } | null = null) => ({
    startDate: date,
    msku,
    childAsin: `ASIN-${msku}`,
    sales: { orderedProductSales: amount(sales), refundedProductSales: amount(0), netProductSales: amount(sales), unitsOrdered: 5, unitsRefunded: 0, netUnitsSold: 5 },
    fees: [{ feeTypeName: 'FBA fulfillment fees', charges: [{ aggregatedDetail: { totalAmount: amount(fees) } }] }],
    ads: ads > 0 ? [{ adTypeName: 'SP', charge: { totalAmount: amount(ads) } }] : [],
    cost: cost ? { costOfGoodsSold: amount(cost.cogs), fbaCost: { shippingToAmazonCost: amount(cost.ship) } } : null,
    netProceeds: { total: amount(sales - fees - ads) },
  })
  const profit = (store: string, sku: string, date: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'ProfitDaily', {
      id: `pd-${store}-${sku}-${date}`,
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
    h = await createDbTestApp({ database: 'economics', db })
    const a = await h.createTenant('eco-a')
    tenantId = a.tenantId
    s1 = a.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    s2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-eco-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-ECO-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('eco-b')
    full = await h.createMember(tenantId, 'eco-full', ['finance.read', 'field.cost'])
    noField = await h.createMember(tenantId, 'eco-nofield', ['finance.read'])
    noPermission = await h.createMember(tenantId, 'eco-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'eco-scoped', ['finance.read', 'field.cost'], { scopes: [{ sellerAccountId: s2 }] })
    other = await h.createMember(b.tenantId, 'eco-other', ['*'])
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-eco', tenantId, provider: 'AMAZON_SP_API', state: 'AUTHORIZED', encryptedRefreshToken: 'cipher', sellerAccountId: s1 })
    const base = new PrismaClient({ datasourceUrl: db.urlFor('economics', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    const load = async (name: string) => import(/* @vite-ignore */ String(`../../../worker/src/datakiosk/${name}`))
    writeDaily = (await load('economics-daily')).economicsDailyDataset.handle
    writePreview = (await load('economics-preview')).economicsPreviewDataset.handle
    writeSimulation = (await load('economics-simulation')).economicsSimulationDataset.handle
  }, 120_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有任何数据：各接口给空状态说明，不是 0', async () => {
    const compare = await ok(full, `/finance/economics/compare?${RANGE}`)
    expect(compare).toMatchObject({ state: 'NO_DATA', items: [], officialCoverage: null, summary: { comparable: 0, netDiff: null, ads: { state: 'NO_DATA' } } })
    expect(compare.note).toContain('尚无记录')
    expect(await ok(full, '/finance/economics/preview')).toMatchObject({ state: 'NO_DATA', items: [], horizon: null })
  })

  it('官方单品经济写入：在行级隔离的租户连接下写入；同一天重复写覆盖不重复；缺成本存空不是 0', async () => {
    expect(await write(writeDaily, s1, kiosk('SKU-A', '2026-10-05', 100, 30, 8), { startDate: '2026-10-01', endDate: '2026-10-10' })).toBe('imported')
    await write(writeDaily, s1, kiosk('SKU-A', '2026-10-06', 120, 30, 0, { cogs: 3, ship: 1 }))
    await write(writeDaily, s1, kiosk('SKU-B', '2026-10-05', 40, 10, 0))
    await write(writeDaily, s2, kiosk('SKU-C', '2026-10-05', 50, 10, 0))
    await write(writeDaily, s1, kiosk('SKU-A', '2026-10-05', 100, 30, 8)) // 重复写
    const stored = await rows<{ msku: string; date: string; sellerCostPerUnit: string | null; feesJson: unknown }>(
      `SELECT msku, to_char("date", 'YYYY-MM-DD') AS date, "sellerCostPerUnit", "feesJson" FROM "EconomicsDaily" WHERE "tenantId" = $1 ORDER BY msku, date`,
      [tenantId],
    )
    expect(stored).toHaveLength(4)
    expect(stored[0]).toMatchObject({ msku: 'SKU-A', date: '2026-10-05', sellerCostPerUnit: null, feesJson: [{ type: 'FBA fulfillment fees', amount: 30 }] })
    expect(Number(stored[1]!.sellerCostPerUnit)).toBe(4)
  })

  it('双源核对：差异按来源拆开，数值确切；无法核对的单列；默认按差异绝对值从大到小，无法核对排最后', async () => {
    // 我方：SKU-A 10-05 未分摊广告（官方 8 扣款 → 广告口径 −8）；10-06 成本 17（官方 4×5=20 → 成本口径 −3）；SKU-C 完全一致；SKU-B 我方没有记录；店铺级行有账户级广告 20
    const common = { units: 5, costedUnits: 5, refunds: 0 }
    await profit(s1, 'SKU-A', '2026-10-05', { ...common, asin: 'ASIN-SKU-A', revenue: 100, feeCommission: 15, feeFulfillment: 15, productCost: 12, firstMileCost: 3, profit: 55 })
    await profit(s1, 'SKU-A', '2026-10-06', { ...common, asin: 'ASIN-SKU-A', revenue: 120, feeCommission: 15, feeFulfillment: 15, productCost: 15, firstMileCost: 2, profit: 88 })
    await profit(s2, 'SKU-C', '2026-10-05', { ...common, asin: 'ASIN-SKU-C', revenue: 50, feeCommission: 5, feeFulfillment: 5, productCost: 0, profit: 40 })
    await profit(s1, '__STORE__', '2026-10-05', { units: 0, adsUnallocated: 20, profit: -20 })

    const data = await ok(full, `/finance/economics/compare?${RANGE}`)
    expect(data).toMatchObject({ state: 'OK', recognition: 'ORDERED', currency: 'USD', truncated: false, officialCoverage: { from: '2026-10-05', to: '2026-10-06' } })
    expect(data.items.map((item: { msku: string; date: string }) => `${item.msku}@${item.date}`)).toEqual(['SKU-A@2026-10-05', 'SKU-A@2026-10-06', 'SKU-C@2026-10-05', 'SKU-B@2026-10-05'])
    const [adsRow, costRow, matchRow, blocked] = data.items
    expect(adsRow).toMatchObject({ verdict: 'ADS', storeName: expect.any(String), parts: { ADS: -8, COST: 0, TIME: 0, UNEXPLAINED: 0 }, impact: { net: -8, cost: null } })
    expect(costRow).toMatchObject({ verdict: 'COST', parts: { COST: -3 }, impact: { net: -3, cost: -3 }, official: { cost: 20, costPerUnit: 4 }, ours: { cost: 17 } })
    expect(matchRow).toMatchObject({ verdict: 'MATCH', storeName: '欧洲店' })
    expect(blocked).toMatchObject({ verdict: 'NOT_COMPARABLE', notComparable: 'OURS_NO_RECORD', impact: null })
    expect(data.summary).toMatchObject({ rows: 4, comparable: 3, matched: 1, notComparable: 1, netDiff: -11, byClass: { ADS: { amount: -8, rows: 1 }, COST: { amount: -3, rows: 1 } } })
    // 店铺层面的广告：官方各商品广告扣款 8，我方账户级 20，官方减我方
    expect(data.summary.ads).toMatchObject({ state: 'OK', official: 8, ours: 20, diff: -12 })
  })

  it('结论过滤、搜索、日期排序、游标翻页不重复不遗漏；条件变了旧游标失效', async () => {
    expect((await ok(full, `/finance/economics/compare?${RANGE}&verdict=DIFF`)).items).toHaveLength(2)
    expect((await ok(full, `/finance/economics/compare?${RANGE}&verdict=NOT_COMPARABLE`)).items.map((item: { msku: string }) => item.msku)).toEqual(['SKU-B'])
    expect((await ok(full, `/finance/economics/compare?${RANGE}&q=asin-sku-c`)).items.map((item: { msku: string }) => item.msku)).toEqual(['SKU-C'])
    expect((await ok(full, `/finance/economics/compare?${RANGE}&sort=date:desc`)).items[0].date).toBe('2026-10-06')
    const page1 = await ok(full, `/finance/economics/compare?${RANGE}&pageSize=3`)
    expect(page1.pageInfo).toMatchObject({ hasMore: true, approxTotal: 4 })
    const page2 = await ok(full, `/finance/economics/compare?${RANGE}&pageSize=3&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect([...page1.items, ...page2.items].map((item: { key: string }) => item.key)).toHaveLength(4)
    expect(new Set([...page1.items, ...page2.items].map((item: { key: string }) => item.key)).size).toBe(4)
    expect(page2.pageInfo.hasMore).toBe(false)
    const stale = await get(full, `/finance/economics/compare?${RANGE}&pageSize=3&verdict=DIFF&cursor=${encodeURIComponent(page1.pageInfo.nextCursor)}`)
    expect(stale.status).toBe(400)
  })

  it('我方口径可切换：结算释放口径下我方没有记录，官方的行都无法核对', async () => {
    const data = await ok(full, `/finance/economics/compare?${RANGE}&recognition=SETTLED`)
    expect(data.summary).toMatchObject({ comparable: 0, notComparable: 4, netDiff: null, ads: { state: 'NOT_CONNECTED' } })
  })

  it('数据范围、字段权限与跨企业隔离', async () => {
    const scopedData = await ok(scoped, `/finance/economics/compare?${RANGE}`)
    expect(scopedData.items.map((item: { msku: string }) => item.msku)).toEqual(['SKU-C'])
    expect(scopedData.officialCoverage).toEqual({ from: '2026-10-05', to: '2026-10-05' })
    expect((await get(noField, `/finance/economics/compare?${RANGE}`)).status).toBe(403)
    expect((await get(noPermission, `/finance/economics/compare?${RANGE}`)).status).toBe(403)
    expect((await get(noPermission, '/finance/economics/preview')).status).toBe(403)
    expect(await ok(other, `/finance/economics/compare?${RANGE}`)).toMatchObject({ state: 'NO_DATA', items: [] })
    expect((await ok(noField, '/finance/economics/preview')).state).toBe('NO_DATA') // 预览只需要 finance.read
  })

  it('费用预览：每个店铺只看最近一次查询；超过 3 天的不展示；有调整的排前面；影响按单件变化 × 数量', async () => {
    const hour = 3_600_000
    const charge = (start: string, end: string, total: number, quantity: number, perUnit: number, delta: number | null) => ({
      startDate: start,
      endDate: end,
      aggregatedDetail: { totalAmount: amount(total), quantity, amountPerUnit: amount(perUnit), ...(delta === null ? {} : { amountPerUnitDelta: amount(delta) }) },
    })
    const line = (msku: string, fees: unknown[]) => ({ msku, childAsin: `ASIN-${msku}`, startDate: '2026-10-23', endDate: '2027-02-18', fees })
    const old = { startDate: '2026-10-23', endDate: '2027-02-18', queriedAt: new Date(Date.now() - 2 * hour).toISOString() }
    const latest = { ...old, queriedAt: new Date(Date.now() - hour).toISOString() }
    await write(writePreview, s1, line('SKU-OLD', [{ feeTypeName: 'REFERRAL_FEES', charges: [charge('2026-10-23', '2027-02-18', 5, 10, 0.5, null)] }]), old) // 旧查询里有、新查询里没有
    await write(
      writePreview,
      s1,
      line('SKU-A', [
        { feeTypeName: 'FBA_FULFILLMENT_FEES', charges: [charge('2026-10-23', '2027-01-14', 300, 100, 3, null), charge('2027-01-15', '2027-02-18', 360, 100, 3.6, 0.6)] },
        { feeTypeName: 'REFERRAL_FEES', charges: [charge('2026-10-23', '2027-02-18', 90, 100, 0.9, null)] },
      ]),
      latest,
    )
    await write(writePreview, s2, line('SKU-C', [{ feeTypeName: 'REFERRAL_FEES', charges: [charge('2026-10-23', '2027-02-18', 7, 10, 0.7, null)] }]), {
      ...old,
      queriedAt: new Date(Date.now() - 5 * 24 * hour).toISOString(),
    })
    await write(writePreview, s1, line('SKU-A', [{ feeTypeName: 'REFERRAL_FEES', charges: [charge('2026-10-23', '2027-02-18', 90, 100, 0.9, null)] }]), latest) // 重复写不重复

    const data = await ok(full, '/finance/economics/preview')
    expect(data.items.map((item: { msku: string; feeType: string; rangeStart: string }) => `${item.msku}|${item.feeType}|${item.rangeStart}`)).toEqual([
      'SKU-A|FBA_FULFILLMENT_FEES|2027-01-15',
      'SKU-A|FBA_FULFILLMENT_FEES|2026-10-23',
      'SKU-A|REFERRAL_FEES|2026-10-23',
    ])
    expect(data.items[0]).toMatchObject({ impact: -60, impactState: 'OK', amountPerUnitDelta: 0.6, quantity: 100, storeName: expect.any(String) })
    expect(data.items[1]).toMatchObject({ impact: null, impactState: 'NO_CHANGE' })
    expect(data.summary).toMatchObject({ products: 1, rows: 3, changedRows: 1, unknownRows: 0, totalImpact: -60 })
    expect(data.summary.byFeeType.map((group: { feeType: string; estimated: number }) => [group.feeType, group.estimated])).toEqual([
      ['FBA_FULFILLMENT_FEES', 660],
      ['REFERRAL_FEES', 90],
    ])
    expect(data.horizon).toEqual({ from: '2026-10-23', to: '2027-02-18' })
    expect((await ok(full, '/finance/economics/preview?changedOnly=true')).items).toHaveLength(1)
    expect((await ok(full, '/finance/economics/preview?feeType=REFERRAL_FEES')).items).toHaveLength(1)
    expect((await ok(scoped, '/finance/economics/preview')).state).toBe('NO_DATA') // s2 的预览已过期，不展示
    expect((await ok(scoped, '/finance/economics/preview')).note).toContain('不再展示')
    expect((await ok(other, '/finance/economics/preview')).state).toBe('NO_DATA')
  })

  it('情景模拟：建运行与同步任务；轮询进行中；后台写入结果并完成后给出合计；范围与企业隔离', async () => {
    const post = (member: Member, body: unknown) => h.call(member.token, 'POST', '/finance/economics/simulate', { body })
    const sipp = { sellerAccountId: s1, sku: 'SKU-A', actionType: 'SIPP', itemPrice: 19.99, endInDays: 30 }
    expect((await post(noPermission, sipp)).status).toBe(403)
    expect((await post(scoped, sipp)).status).toBe(403) // 店铺不在数据范围内
    const created = await post(full, sipp)
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    const runId = created.json.data.runId as string
    expect(created.json.data).toMatchObject({ status: 'PENDING', result: null, input: { actionType: 'SIPP', quantity: null, itemPrice: 19.99, sku: 'SKU-A' } })
    const [job] = await rows<{ id: string; type: string; status: string; context: { dataset: string; params: Record<string, string> } }>(
      `SELECT id, type, status, context FROM "SyncJob" WHERE "tenantId" = $1`,
      [tenantId],
    )
    expect(job).toMatchObject({ type: 'DATA_KIOSK_QUERY', status: 'PENDING', context: { dataset: 'dk.economics-simulation', params: { runId, actionType: 'SIPP', price: '19.99' } } })
    expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ syncJobId: job!.id }), job!.id, expect.anything())
    expect((await ok(full, `/finance/economics/simulations/${runId}`)).status).toBe('PENDING')

    // 后台：用数据集写入器写结果（同一行重试不重复累加），任务置为成功
    const row = {
      msku: 'SKU-A',
      startDate: '2026-10-23',
      endDate: '2026-11-22',
      sales: { netProductSales: amount(500), netUnitsSold: 25 },
      fees: [{ feeTypeName: 'FBA', charges: [{ aggregatedDetail: { totalAmount: amount(120) } }] }],
      netProceeds: { total: amount(300) },
    }
    expect(await write(writeSimulation, s1, row, { runId })).toBe('imported')
    await write(writeSimulation, s1, row, { runId })
    await h.client.query(`UPDATE "SyncJob" SET status = 'SUCCEEDED' WHERE id = $1`, [job!.id])
    const done = await ok(full, `/finance/economics/simulations/${runId}`)
    expect(done).toMatchObject({ status: 'DONE', note: null, result: { currency: 'USD', sales: 500, fees: 120, netProceeds: 300, units: 25, rows: 1 } })
    expect(done.result).not.toHaveProperty('entries')
    expect((await get(scoped, `/finance/economics/simulations/${runId}`)).status).toBe(403)
    expect((await get(other, `/finance/economics/simulations/${runId}`)).status).toBe(404)
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'ECONOMICS_SIMULATED'`, [tenantId])).length).toBeGreaterThan(0)
  })
})
