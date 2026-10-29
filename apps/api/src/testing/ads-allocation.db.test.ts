import { PROFIT_METRIC_VERSION } from '@nova/api-contracts'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow, seedTenant } from './db-fixtures'
import { startTestDatabase, type TestDatabase } from './test-database'

// 广告分摊进利润（P3-16，真实数据库 + 后台任务代码）：账户总花费先按广告商品报表归属到 ASIN，剩余按财务口径里的规则（销售额或销量）分摊到当天有销售的 SKU；
// 各 SKU 分摊额之和 + 店铺级行未分摊额 = 账户总花费（验收）；只认活动级花费行（广告组等细分行不重复计）；规则按天取生效版本；重复刷新幂等；跨企业隔离。

type Range = { tenantId: string; dateFrom: string; dateTo: string }
type Refresh = (db: unknown, range: Range, now?: Date) => Promise<number>
const loadRefresh = async () => (await import(/* @vite-ignore */ String('../../../worker/src/profit/run'))).refreshProfitDaily as Refresh

describe('广告分摊进利润（P3-16，真实数据库）', () => {
  let db: TestDatabase
  let admin: Client
  let base: PrismaClient
  let scoped: PrismaClient
  let refresh: Refresh
  let a: Awaited<ReturnType<typeof seedTenant>>
  let b: Awaited<ReturnType<typeof seedTenant>>
  let seq = 0
  const NOW = new Date('2026-10-20T12:00:00Z')

  const order = async (ids: typeof a, day: string, sku: string, asin: string, qty: number, price: number) => {
    const n = ++seq
    const purchaseDate = `${day}T18:00:00Z`
    const amazonOrderId = `111-${String(n).padStart(7, '0')}-0000001`
    await insertRow(admin, 'Order', {
      id: `o-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      amazonOrderId,
      purchaseDate,
      status: 'Shipped',
      currency: 'USD',
      sourceUpdatedAt: purchaseDate,
    })
    await insertRow(admin, 'OrderItem', {
      id: `oi-${n}`,
      tenantId: ids.tenantId,
      sellerAccountId: ids.sellerAccountId,
      orderId: `o-${n}`,
      orderPurchaseDate: purchaseDate,
      amazonOrderId,
      orderItemId: `item-${n}`,
      asin,
      sellerSku: sku,
      quantityOrdered: qty,
      quantityShipped: qty,
      itemPrice: price,
      currency: 'USD',
      sourceUpdatedAt: purchaseDate,
    })
  }
  const campaignSpend = (ids: typeof a, profile: string, day: string, campaign: string, cost: number, patch: Record<string, unknown> = {}) =>
    insertRow(admin, 'AdsMetric', {
      id: `am-${++seq}`,
      tenantId: ids.tenantId,
      adsProfileId: profile,
      reportDate: `${day}T00:00:00.000Z`,
      externalCampaignId: campaign,
      adProduct: 'SPONSORED_PRODUCTS',
      currency: 'USD',
      cost,
      sourceUpdatedAt: '2026-10-16T00:00:00Z',
      ...patch,
    })
  const advertised = (ids: typeof a, profile: string, account: string, day: string, asin: string, spend: number) =>
    insertRow(admin, 'AdsAdvertisedProductMetric', {
      id: `apm-${++seq}`,
      tenantId: ids.tenantId,
      adsProfileId: profile,
      adsAccountId: account,
      campaignId: 'C1',
      advertisedAsin: asin,
      reportDate: day,
      spend,
      sourceUpdatedAt: '2026-10-16T00:00:00Z',
    })
  const rowsOf = async (ids: typeof a, basis = 'ORDERED') =>
    (
      await admin.query(
        `SELECT to_char("profitDate", 'YYYY-MM-DD') AS d, "sku", "units", "revenue"::float AS revenue, "adsSpendAllocated"::float AS allocated, "adsUnallocated"::float AS unallocated, "profit"::float AS profit, "flags", "metricVersion"
         FROM "ProfitDaily" WHERE "tenantId" = $1 AND "basis" = $2 ORDER BY 1, 2`,
        [ids.tenantId, basis],
      )
    ).rows as Array<{ d: string; sku: string; units: number; revenue: number; allocated: number | null; unallocated: number | null; profit: number | null; flags: string[]; metricVersion: string }>
  const run = (ids: typeof a) => runWithTenant(ids.tenantId, () => refresh(scoped, { tenantId: ids.tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-15' }, NOW))
  /** 某一天店铺的广告合计：各 SKU 分摊额 + 店铺级行未分摊额。 */
  const dayTotal = (rows: Awaited<ReturnType<typeof rowsOf>>, day: string) => rows.filter(row => row.d === day).reduce((sum, row) => sum + (row.allocated ?? 0) + (row.unallocated ?? 0), 0)
  const at = (rows: Awaited<ReturnType<typeof rowsOf>>, day: string, sku: string) => rows.find(row => row.d === day && row.sku === sku)!

  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('ads_allocation')
    db.migrate('ads_allocation')
    admin = await db.connect('ads_allocation')
    a = await seedTenant(admin, 'a')
    b = await seedTenant(admin, 'b')
    base = new PrismaClient({ datasourceUrl: db.urlFor('ads_allocation', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    refresh = await loadRefresh()

    // 租户 A：10-05 两个 SKU 有销售（sku-1 销售额 60、2 件，sku-2 销售额 40、4 件）
    await order(a, '2026-10-05', 'sku-1', 'B0001', 2, 60)
    await order(a, '2026-10-05', 'sku-2', 'B0002', 4, 40)
    await insertRow(admin, 'AdsProfile', { id: 'ap-1', tenantId: a.tenantId, profileId: 'P1', sellerAccountId: a.sellerAccountId, bindingStatus: 'MANUAL', adsAccountId: 'ACC-1' })
    await insertRow(admin, 'AdsAccount', { id: 'acct-1', tenantId: a.tenantId, adsProfileId: 'ap-1', adsAccountId: 'ACC-1', name: '主账户' })
    // 账户 10-05 总花费 100（两个活动 70 + 30）；广告组细分行 999 是同一笔花费的拆分，不能重复计
    await campaignSpend(a, 'ap-1', '2026-10-05', 'C1', 70)
    await campaignSpend(a, 'ap-1', '2026-10-05', 'C2', 30)
    await campaignSpend(a, 'ap-1', '2026-10-05', 'AG-1', 999, { entityType: 'AD_GROUP', entityId: 'AG-1' })
    // 广告商品报表：B0001 花 40；B0999 花 5，商品目录里找不到对应 SKU
    await advertised(a, 'ap-1', 'ACC-1', '2026-10-05', 'B0001', 40)
    await advertised(a, 'ap-1', 'ACC-1', '2026-10-05', 'B0999', 5)
    // 10-06 总花费 10，当天没有任何销售；报表归属 B0003 花 6，商品目录里它对应 sku-3；剩下 4 没有可分摊的销售
    await campaignSpend(a, 'ap-1', '2026-10-06', 'C1', 10)
    await advertised(a, 'ap-1', 'ACC-1', '2026-10-06', 'B0003', 6)
    await insertRow(admin, 'FbaProduct', {
      id: 'fp-3',
      tenantId: a.tenantId,
      sellerAccountId: a.sellerAccountId,
      asin: 'B0003',
      sellerSku: 'sku-3',
      title: '商品三',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    // 租户 B：自己的广告账户，同样的 ASIN 花了 999——不能进 A 的分摊
    await order(b, '2026-10-05', 'sku-b', 'B0001', 1, 10)
    await insertRow(admin, 'AdsProfile', { id: 'ap-b', tenantId: b.tenantId, profileId: 'PB', sellerAccountId: b.sellerAccountId, bindingStatus: 'MANUAL', adsAccountId: 'ACC-B' })
    await insertRow(admin, 'AdsAccount', { id: 'acct-b', tenantId: b.tenantId, adsProfileId: 'ap-b', adsAccountId: 'ACC-B', name: 'B 账户' })
    await campaignSpend(b, 'ap-b', '2026-10-05', 'CB', 20)
    await advertised(b, 'ap-b', 'ACC-B', '2026-10-05', 'B0001', 999)
  })
  afterAll(async () => {
    await admin?.end()
    await base?.$disconnect()
    await db?.stop()
  })

  it('默认按销售额：报表归属的先归 ASIN，剩余按销售额分；各 SKU 分摊额 + 店铺级未分摊额 = 账户总花费（只认活动级花费行）', async () => {
    expect(await run(a)).toBeGreaterThan(0)
    const rows = await rowsOf(a)
    // 剩余 100 - 40 = 60 按销售额 60:40 分给两个 SKU（B0999 对不上 SKU，并入剩余、不单独归属）：sku-1 = 40 + 36，sku-2 = 24
    expect(at(rows, '2026-10-05', 'sku-1')).toMatchObject({ allocated: 76, units: 2, revenue: 60 })
    expect(at(rows, '2026-10-05', 'sku-2')).toMatchObject({ allocated: 24, units: 4, revenue: 40 })
    expect(at(rows, '2026-10-05', '__STORE__')).toMatchObject({ unallocated: 0 })
    expect(at(rows, '2026-10-05', '__STORE__').flags).toEqual(expect.arrayContaining(['ADS_ASIN_UNMAPPED']))
    expect(at(rows, '2026-10-05', '__STORE__').flags).not.toContain('ADS_UNALLOCATED')
    expect(dayTotal(rows, '2026-10-05')).toBeCloseTo(100, 6)
    // 利润扣了分摊的广告（没有成本版本，利润按“缺成本”为空；这里核对没有成本时不给利润）
    expect(at(rows, '2026-10-05', 'sku-1').profit).toBeNull()
    expect(rows.every(row => row.metricVersion === PROFIT_METRIC_VERSION)).toBe(true)
  })

  it('当天没有销售：报表归属的 ASIN 经商品目录生成 SKU 行（亏损如实显示），剩下的留在店铺级行并标“广告未分摊”；花费记录范围之外的日子是空', async () => {
    const rows = await rowsOf(a)
    expect(at(rows, '2026-10-06', 'sku-3')).toMatchObject({ allocated: 6, units: 0, revenue: 0, profit: -6 })
    expect(at(rows, '2026-10-06', '__STORE__')).toMatchObject({ unallocated: 4 })
    expect(at(rows, '2026-10-06', '__STORE__').flags).toContain('ADS_UNALLOCATED')
    expect(dayTotal(rows, '2026-10-06')).toBeCloseTo(10, 6)
    // 花费记录只覆盖 10-05 到 10-06：之外没有行
    expect(rows.filter(row => row.d > '2026-10-06')).toEqual([])
  })

  it('三种收入确认口径各自分摊：没有发货与结算数据时，只有下单口径有商品行', async () => {
    expect((await rowsOf(a, 'SHIPPED')).filter(row => row.sku !== '__STORE__' && row.d === '2026-10-05')).toEqual([])
    const shippedStore = (await rowsOf(a, 'SHIPPED')).find(row => row.d === '2026-10-05' && row.sku === '__STORE__')
    // 发货口径当天没有销售行：10-05 的 100 美元里归属不到 SKU 的全部留在店铺级行
    expect(shippedStore).toMatchObject({ unallocated: 100 })
  })

  it('财务口径里的规则按天取生效版本：改成按销量、生效日之后的日子才按销量；生效日之前仍按销售额', async () => {
    await insertRow(admin, 'FinancePolicyVersion', {
      id: 'fpv-1',
      tenantId: a.tenantId,
      versionNo: 1,
      effectiveFrom: '2026-10-06',
      revenueRecognition: 'ORDERED',
      inventoryCostMethod: 'FIFO',
      adsAllocationMode: 'BY_UNITS',
      storeFeeAllocation: 'BY_SALES',
      status: 'ACTIVE',
      reason: '测试',
      createdBy: a.userId,
    })
    await run(a)
    expect(at(await rowsOf(a), '2026-10-05', 'sku-1').allocated).toBe(76) // 生效日是 10-06，10-05 还是按销售额
    await admin.query(`UPDATE "FinancePolicyVersion" SET "effectiveFrom" = '2026-10-01' WHERE id = 'fpv-1'`)
    await run(a)
    const rows = await rowsOf(a)
    // 剩余 60 按件数 2:4 分：sku-1 = 40 + 20，sku-2 = 40
    expect(at(rows, '2026-10-05', 'sku-1').allocated).toBe(60)
    expect(at(rows, '2026-10-05', 'sku-2').allocated).toBe(40)
    expect(dayTotal(rows, '2026-10-05')).toBeCloseTo(100, 6)
    // 被替换的版本也要参与按天取值：它之后的版本生效前，仍按它计
    await admin.query(`UPDATE "FinancePolicyVersion" SET "status" = 'REPLACED' WHERE id = 'fpv-1'`)
    await run(a)
    expect(at(await rowsOf(a), '2026-10-05', 'sku-1').allocated).toBe(60)
    // 待审批与已驳回的版本不生效
    await admin.query(`UPDATE "FinancePolicyVersion" SET "status" = 'PENDING' WHERE id = 'fpv-1'`)
    await run(a)
    expect(at(await rowsOf(a), '2026-10-05', 'sku-1').allocated).toBe(76)
  })

  it('广告商品报表合计大于账户总花费：按比例缩小到总花费，打标记，总额仍等于账户总花费', async () => {
    await advertised(a, 'ap-1', 'ACC-1', '2026-10-05', 'B0002', 200)
    await run(a)
    const rows = await rowsOf(a)
    expect(at(rows, '2026-10-05', '__STORE__').flags).toContain('ADS_ATTRIBUTION_EXCEEDS')
    expect(dayTotal(rows, '2026-10-05')).toBeCloseTo(100, 6)
    await admin.query(`DELETE FROM "AdsAdvertisedProductMetric" WHERE "tenantId" = $1 AND "advertisedAsin" = 'B0002'`, [a.tenantId])
  })

  it('可重复执行：同一范围再刷新，结果完全相同', async () => {
    await run(a)
    const before = await rowsOf(a)
    await run(a)
    expect(await rowsOf(a)).toEqual(before)
  })

  it('跨企业隔离：B 的广告花费与报表只进 B 的分摊，A 的数字不受影响', async () => {
    await run(b)
    const rowsB = await rowsOf(b)
    expect(at(rowsB, '2026-10-05', 'sku-b')).toMatchObject({ allocated: 20 })
    expect(dayTotal(rowsB, '2026-10-05')).toBeCloseTo(20, 6)
    expect(dayTotal(await rowsOf(a), '2026-10-05')).toBeCloseTo(100, 6)
  })
})
