import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { classifyFeeLine } from '@nova/api-contracts'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow, seedTenant } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 费用事件（P2b-05，真实数据库 + 完整应用 + 后台写入器代码）：
// 迁移升级、回填、回滚闭环，SQL 回填与 TypeScript 分类器逐条一致；检查约束；
// 写入器在租户行级隔离下分类、重复写入不丢人工对账；页签、筛选、游标、统计、证据、标记差异（乐观锁、审计、变更记录）；数据范围与跨企业隔离。

type Member = { userId: string; token: string }
const TARGET = '20261030010000_fee_events'
const T0 = '2026-10-10T08:00:00.000Z'

// 每条：来源交易类型、明细路径（叶子是费用类型）。期望值不手写，直接用契约里的分类器，核对数据库回填与它一致；另外几条钉死预期的类别防止两边一起漂移。
const SAMPLES: Array<{ transactionType: string; path: string; expected?: string }> = [
  { transactionType: 'Shipment', path: 'Amazon Fees/FBAPerUnitFulfillmentFee', expected: 'FULFILLMENT' },
  { transactionType: 'Shipment', path: 'Amazon Fees/Commission', expected: 'COMMISSION' },
  { transactionType: 'Shipment', path: 'Product Charges/Principal', expected: 'NON_FEE' },
  { transactionType: 'Refund', path: 'Amazon Fees/RefundCommission', expected: 'REFUND' },
  { transactionType: 'Shipment', path: 'Fees/FBAStorageFee', expected: 'STORAGE' },
  { transactionType: 'ServiceFee', path: 'Fees/AgedInventorySurcharge', expected: 'AGED_SURCHARGE' },
  { transactionType: 'ServiceFee', path: 'Fees/FBAInboundPlacementServiceFee', expected: 'INBOUND_PLACEMENT' },
  { transactionType: 'ServiceFee', path: 'Fees/FBARemovalOrderDisposalFee', expected: 'REMOVAL_DISPOSAL' },
  { transactionType: 'Adjustment', path: 'Reimbursement/WarehouseDamage', expected: 'REIMBURSEMENT' },
  { transactionType: 'Adjustment', path: 'Misc/SomethingUnheardOf', expected: 'OTHER' },
  { transactionType: 'Shipment', path: 'Promotion/PromotionMetaDataDefinitionValue' },
  { transactionType: 'ServiceFee', path: 'Fees/FBALongTermStorageFee' },
  { transactionType: 'ServiceFee', path: 'Fees/LowInventoryLevelFee' },
  { transactionType: 'Shipment', path: 'Amazon Fees/Variable Closing Fee' },
  { transactionType: 'Shipment', path: 'Amazon Fees/FBA Weight Based Fee' },
]

describe('费用事件迁移（P2b-05）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('fee_migrate')
    client = await db.connect('fee_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const columns = async () =>
    ((await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'FbaFeeEvent'`)).rows as Array<{ column_name: string }>).map(row => row.column_name)

  it('升级：历史明细按名称回填分类与交易状态，且与契约分类器逐条一致；报告类按费用类型归类；约束与索引生效；回滚去掉新增列再升级闭环', async () => {
    const ids = await seedTenant(client, 'fee-mig')
    const base = { tenantId: ids.tenantId, sellerAccountId: ids.sellerAccountId }
    for (const [index, sample] of SAMPLES.entries()) {
      await insertRow(client, 'FbaFinancialTransaction', {
        id: `tx-row-${index}`,
        ...base,
        externalTransactionId: `tx-${index}`,
        transactionType: sample.transactionType,
        transactionStatus: 'DEFERRED',
        amount: 1,
        postedAt: T0,
      })
      await insertRow(client, 'FbaFeeEvent', {
        id: `fe-${index}`,
        ...base,
        eventType: sample.path.split('/').pop(),
        description: sample.path,
        sourceRecordId: `tx-${index}`,
        sourceEventId: `tx-${index}:0`,
        amount: -1,
        postedAt: T0,
      })
    }
    await insertRow(client, 'FbaFeeEvent', { id: 'fe-storage', ...base, eventType: 'STORAGE_FEE', sourceEventId: 'storage:1', amount: 5, postedAt: T0, description: null })
    await insertRow(client, 'FbaFeeEvent', { id: 'fe-nc', ...base, eventType: 'INBOUND_NONCOMPLIANCE', sourceEventId: 'noncompliance:1', amount: 3, postedAt: T0, description: 'Labeling' })
    expect(await columns()).not.toContain('feeCategory')

    await applyMigrations(client, { only: TARGET })
    const rows = (await client.query(`SELECT "id", "feeCategory", "feeSubtype", "transactionStatus", "reconciliationStatus", "version" FROM "FbaFeeEvent" WHERE "tenantId" = $1`, [ids.tenantId]))
      .rows as Array<Record<string, any>>
    const byId = new Map(rows.map(row => [row.id, row]))
    for (const [index, sample] of SAMPLES.entries()) {
      const row = byId.get(`fe-${index}`) as Record<string, any>
      const leaf = sample.path.split('/').pop() as string
      const expected = classifyFeeLine({ path: sample.path, eventType: leaf, transactionType: sample.transactionType })
      expect(row.feeCategory, sample.path).toBe(expected.category)
      if (sample.expected) expect(row.feeCategory, sample.path).toBe(sample.expected)
      expect(row.feeSubtype, sample.path).toBe(expected.subtype)
      expect(row).toMatchObject({ transactionStatus: 'DEFERRED', reconciliationStatus: 'UNRECONCILED', version: 1 })
    }
    expect(byId.get('fe-storage')).toMatchObject({ feeCategory: 'STORAGE', feeSubtype: 'STORAGE_FEE', transactionStatus: null })
    expect(byId.get('fe-nc')).toMatchObject({ feeCategory: 'INBOUND_PLACEMENT', transactionStatus: null })

    // 新行默认 OTHER：漏分类的写入点会落在“其他调整”里被看见
    expect(await insertRow(client, 'FbaFeeEvent', { id: 'fe-default', ...base, sourceEventId: 'x:1', amount: 1, postedAt: T0 })).toMatchObject({
      feeCategory: 'OTHER',
      reconciliationStatus: 'UNRECONCILED',
      version: 1,
    })
    await expect(insertRow(client, 'FbaFeeEvent', { id: 'fe-bad-1', ...base, sourceEventId: 'x:2', amount: 1, postedAt: T0, feeCategory: 'WHATEVER' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(client, 'FbaFeeEvent', { id: 'fe-bad-2', ...base, sourceEventId: 'x:3', amount: 1, postedAt: T0, reconciliationStatus: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(insertRow(client, 'FbaFeeEvent', { id: 'fe-bad-3', ...base, sourceEventId: 'x:4', amount: 1, postedAt: T0, version: 0 })).rejects.toMatchObject({ code: '23514' })
    const index = await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'FbaFeeEvent_tenantId_feeCategory_postedAt_idx'`)
    expect(index.rowCount).toBe(1)

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    const after = await columns()
    for (const column of ['feeCategory', 'feeSubtype', 'transactionStatus', 'reconciliationStatus', 'reconciliationNote', 'reconciledBy', 'reconciledAt', 'version'])
      expect(after).not.toContain(column)
    expect(await columns()).toContain('eventType')
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toContain('feeCategory')
  })
})

describe('费用事件（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerAccountId: string
  let secondSellerId: string
  let reconciler: Member
  let reader: Member
  let noFinance: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const patch = (member: Member, id: string, body: unknown) => h.call(member.token, 'PATCH', `/finance/events/${id}/reconciliation`, { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const RANGE = 'from=2026-10-01&to=2026-10-31'
  const fee = (id: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'FbaFeeEvent', { id, tenantId, sellerAccountId, sourceEventId: `${id}:0`, amount: -1, currency: 'USD', postedAt: T0, ...over })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'fee_events', db })
    const a = await h.createTenant('fee-a')
    tenantId = a.tenantId
    sellerAccountId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-fee-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-FEE-2' })).id
    const b = await h.createTenant('fee-b')
    reconciler = await h.createMember(tenantId, 'fee-rec', ['finance.read', 'finance.reconcile', 'orders.read'])
    reader = await h.createMember(tenantId, 'fee-read', ['finance.read'])
    noFinance = await h.createMember(tenantId, 'fee-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'fee-scoped', ['finance.read', 'finance.reconcile'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'fee-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('fee_events', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient

    await insertRow(h.client, 'Order', { id: 'order-fee-1', tenantId, sellerAccountId, amazonOrderId: '111-0000001-0000001', purchaseDate: T0, status: 'Shipped', currency: 'USD' })
    await insertRow(h.client, 'FbaFinancialTransaction', {
      id: 'tx-row-1',
      tenantId,
      sellerAccountId,
      externalTransactionId: 'tx-1',
      transactionType: 'Shipment',
      transactionStatus: 'RELEASED',
      amount: 40,
      postedAt: T0,
      description: '订单结算',
      amazonOrderId: '111-0000001-0000001',
      relatedIdentifiers: JSON.stringify([
        { name: 'ORDER_ID', value: '111-0000001-0000001' },
        { name: 'SHIPMENT_ID', value: 'FBA15ABCDE' },
      ]),
    })
    // 同一笔交易拆出 3 条明细：配送费、佣金、销售收入（不是费用）
    const common = { sourceRecordId: 'tx-1', transactionStatus: 'RELEASED', amazonOrderId: '111-0000001-0000001', asin: 'B0TEST0001', sellerSku: 'SKU-1' }
    await fee('fe-ful', { ...common, feeCategory: 'FULFILLMENT', feeSubtype: 'FBAPerUnitFulfillmentFee', amount: -3.5, sourceEventId: 'tx-1:0:a' })
    await fee('fe-com', { ...common, feeCategory: 'COMMISSION', feeSubtype: 'Commission', amount: -6, sourceEventId: 'tx-1:0:b' })
    await fee('fe-inc', { ...common, feeCategory: 'NON_FEE', feeSubtype: 'Principal', amount: 50, sourceEventId: 'tx-1:0:c' })
    // 报告类：没有来源交易
    await fee('fe-sto', { feeCategory: 'STORAGE', feeSubtype: 'STORAGE_FEE', amount: -12.5, sourceEventId: 'storage:abc', postedAt: '2026-10-02T00:00:00.000Z', sellerSku: 'SKU-2' })
    await fee('fe-ref', {
      feeCategory: 'REFUND',
      feeSubtype: 'RefundCommission',
      amount: -2,
      sourceRecordId: 'tx-9',
      transactionStatus: 'DEFERRED',
      sourceEventId: 'tx-9:0:a',
      postedAt: '2026-10-12T08:00:00.000Z',
    })
    await fee('fe-gbp', { feeCategory: 'FULFILLMENT', feeSubtype: 'FBAPerUnitFulfillmentFee', amount: -4, currency: 'GBP', sourceEventId: 'gbp:1', postedAt: '2026-10-14T08:00:00.000Z' })
    await fee('fe-2nd', { sellerAccountId: secondSellerId, feeCategory: 'FULFILLMENT', amount: -7, sourceEventId: 'second:1', postedAt: '2026-10-15T08:00:00.000Z' })
    await fee('fe-old', { feeCategory: 'COMMISSION', amount: -9, sourceEventId: 'old:1', postedAt: '2026-09-15T08:00:00.000Z' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('写入器：在行级隔离的租户连接下分类并带交易状态；重复写入幂等，且不覆盖人工对账；交易状态变化会同步到明细', async () => {
    const { parseTransaction } = await import(/* @vite-ignore */ String('../../../worker/src/importers/finance/v2024-parse'))
    const { writeTransaction } = await import(/* @vite-ignore */ String('../../../worker/src/importers/finance/v2024-write'))
    const usd = (currencyAmount: number) => ({ currencyAmount, currencyCode: 'USD' })
    const raw = (status: string) => ({
      relatedIdentifiers: [{ relatedIdentifierName: 'ORDER_ID', relatedIdentifierValue: '902-1845936-5435065' }],
      transactionType: 'Shipment',
      transactionId: 'write-tx-1',
      transactionStatus: status,
      description: 'Order Payment',
      postedDate: '2026-10-11T03:35:13.214Z',
      totalAmount: usd(6),
      marketplaceDetails: { marketplaceId: 'ATVPDKIKX0DER' },
      items: [
        {
          totalAmount: usd(6),
          breakdowns: [
            {
              breakdownType: 'Amazon Fees',
              breakdownAmount: usd(-4),
              breakdowns: [
                { breakdownType: 'FBAPerUnitFulfillmentFee', breakdownAmount: usd(-3), breakdowns: [] },
                { breakdownType: 'Commission', breakdownAmount: usd(-1), breakdowns: [] },
              ],
            },
            { breakdownType: 'Product Charges', breakdownAmount: usd(10), breakdowns: [{ breakdownType: 'Principal', breakdownAmount: usd(10), breakdowns: [] }] },
          ],
          contexts: [{ contextType: 'ProductContext', asin: 'B07FGXZQZ1', sku: 'sku-12' }],
        },
      ],
    })
    const write = (status: string) => {
      const parsed = parseTransaction(raw(status))
      if ('skipped' in parsed) throw new Error(parsed.skipped)
      return runWithTenant(tenantId, () =>
        writeTransaction({ prisma: tenantDb, logger: { warn: () => undefined, info: () => undefined, error: () => undefined } }, { tenantId, sellerAccountId }, parsed),
      )
    }
    await write('DEFERRED')
    const written = await rows<{ id: string; eventType: string; feeCategory: string; transactionStatus: string | null }>(
      `SELECT "id", "eventType", "feeCategory", "transactionStatus" FROM "FbaFeeEvent" WHERE "sourceRecordId" = 'write-tx-1' ORDER BY "eventType"`,
    )
    expect(written.map(item => [item.eventType, item.feeCategory, item.transactionStatus])).toEqual([
      ['Commission', 'COMMISSION', 'DEFERRED'],
      ['FBAPerUnitFulfillmentFee', 'FULFILLMENT', 'DEFERRED'],
      ['Principal', 'NON_FEE', 'DEFERRED'],
    ])
    // 运营先标记了有差异
    const commission = written.find(item => item.eventType === 'Commission') as { id: string }
    await h.client.query(`UPDATE "FbaFeeEvent" SET "reconciliationStatus" = 'DISCREPANCY', "reconciliationNote" = '人工备注' WHERE "id" = $1`, [commission.id])
    // 交易后来变成已释放，同步器再次写入
    await write('RELEASED')
    const again = await rows<{ id: string; transactionStatus: string; reconciliationStatus: string; reconciliationNote: string | null }>(
      `SELECT "id", "transactionStatus", "reconciliationStatus", "reconciliationNote" FROM "FbaFeeEvent" WHERE "sourceRecordId" = 'write-tx-1'`,
    )
    expect(again).toHaveLength(3)
    expect(new Set(again.map(item => item.transactionStatus))).toEqual(new Set(['RELEASED']))
    expect(again.find(item => item.id === commission.id)).toMatchObject({ reconciliationStatus: 'DISCREPANCY', reconciliationNote: '人工备注' })
    await h.client.query(`DELETE FROM "FbaFeeEvent" WHERE "sourceRecordId" = 'write-tx-1'`)
  })

  it('列表：默认 9 类（不含销售收入）、页签筛选、交易状态与对账状态筛选、关键词、币种不混加；按入账时间新到旧', async () => {
    const all = await ok(reconciler, `/finance/events?${RANGE}`)
    expect(all.state).toBe('OK')
    const ids = all.items.map((item: { id: string }) => item.id)
    expect(ids).toEqual(['fe-2nd', 'fe-gbp', 'fe-ref', 'fe-ful', 'fe-com', 'fe-sto'])
    expect(ids).not.toContain('fe-inc')
    expect(ids).not.toContain('fe-old')
    expect(all.range).toMatchObject({ from: '2026-10-01', to: '2026-10-31', defaulted: false })
    const ful = all.items.find((item: { id: string }) => item.id === 'fe-ful')
    expect(ful).toMatchObject({
      categoryLabel: '配送费',
      amount: -3.5,
      storeName: expect.any(String),
      shipmentId: 'FBA15ABCDE',
      source: 'FINANCE_API',
      transactionStatusLabel: '已释放',
      reconciliationStatus: 'UNRECONCILED',
      version: 1,
    })
    expect(all.items.find((item: { id: string }) => item.id === 'fe-sto')).toMatchObject({ source: 'STORAGE_REPORT', transactionStatus: null, shipmentId: null })

    const only = (query: string) => ok(reconciler, `/finance/events?${RANGE}&${query}`).then(data => data.items.map((item: { id: string }) => item.id).sort())
    expect(await only('category=FULFILLMENT')).toEqual(['fe-2nd', 'fe-ful', 'fe-gbp'])
    expect(await only('category=STORAGE')).toEqual(['fe-sto'])
    expect(await only('status=DEFERRED')).toEqual(['fe-ref'])
    expect(await only('q=111-0000001')).toEqual(['fe-com', 'fe-ful'])
    expect(await only('q=sku-2')).toEqual(['fe-sto'])
    expect(await only('q=B0TEST')).toEqual(['fe-com', 'fe-ful'])
    expect(await only('reconciliation=DISCREPANCY')).toEqual([])
    expect((await ok(reconciler, `/finance/events?from=2026-09-01&to=2026-09-30`)).items.map((item: { id: string }) => item.id)).toEqual(['fe-old'])
    // 没有数据的页签：空列表，原因里不说“同步”之类的假话
    const empty = await ok(reconciler, `/finance/events?${RANGE}&category=REIMBURSEMENT`)
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(empty.note).toContain('放宽')
  })

  it('游标翻页：不重复不遗漏，升序降序都对；坏游标与换了筛选的游标被拒绝', async () => {
    const seen: string[] = []
    let cursor = ''
    for (let guard = 0; guard < 10; guard += 1) {
      const page = await ok(reconciler, `/finance/events?${RANGE}&pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...page.items.map((item: { id: string }) => item.id))
      if (!page.pageInfo.hasMore) break
      cursor = page.pageInfo.nextCursor
    }
    expect(seen).toEqual(['fe-2nd', 'fe-gbp', 'fe-ref', 'fe-ful', 'fe-com', 'fe-sto'].map(id => id))
    expect(new Set(seen).size).toBe(seen.length)
    const asc = await ok(reconciler, `/finance/events?${RANGE}&sort=postedAt:asc&pageSize=100`)
    expect(asc.items.at(0).id).toBe('fe-sto')
    const first = await ok(reconciler, `/finance/events?${RANGE}&pageSize=1`)
    const swapped = await get(reconciler, `/finance/events?${RANGE}&category=REFUND&pageSize=1&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
    expect([400, 422]).toContain(swapped.status)
    expect((await get(reconciler, `/finance/events?${RANGE}&cursor=not-a-cursor`)).status).toBeGreaterThanOrEqual(400)
  })

  it('页签统计：9 类都有一行；笔数、币种分别合计、有差异笔数；销售收入不进任何一类', async () => {
    const summary = await ok(reconciler, `/finance/events/summary?${RANGE}`)
    expect(summary.categories.map((item: { category: string }) => item.category)).toEqual([
      'FULFILLMENT',
      'COMMISSION',
      'STORAGE',
      'AGED_SURCHARGE',
      'INBOUND_PLACEMENT',
      'REMOVAL_DISPOSAL',
      'REFUND',
      'REIMBURSEMENT',
      'OTHER',
    ])
    const of = (category: string) => summary.categories.find((item: { category: string }) => item.category === category)
    expect(of('FULFILLMENT')).toMatchObject({
      count: 3,
      totals: [
        { currency: 'GBP', amount: -4 },
        { currency: 'USD', amount: -10.5 },
      ],
      discrepancyCount: 0,
    })
    expect(of('COMMISSION')).toMatchObject({ count: 1, totals: [{ currency: 'USD', amount: -6 }] })
    expect(of('STORAGE')).toMatchObject({ count: 1 })
    expect(of('REIMBURSEMENT')).toMatchObject({ count: 0, totals: [] })
    expect(summary.categories.reduce((total: number, item: { count: number }) => total + item.count, 0)).toBe(6)
    // 类别筛选不影响统计（页签本身就是类别）；其他筛选影响
    expect((await ok(reconciler, `/finance/events/summary?${RANGE}&category=STORAGE`)).categories.find((item: { category: string }) => item.category === 'FULFILLMENT').count).toBe(3)
    expect((await ok(reconciler, `/finance/events/summary?${RANGE}&status=DEFERRED`)).categories.find((item: { category: string }) => item.category === 'REFUND').count).toBe(1)
  })

  it('证据：来源交易与关联标识、同一笔交易的其他明细（不含销售收入以外的缺失）、订单链接；没有 orders.read 不给订单链接；报告类没有交易', async () => {
    const detail = await ok(reconciler, '/finance/events/fe-ful')
    expect(detail.event).toMatchObject({ id: 'fe-ful', categoryLabel: '配送费' })
    expect(detail.transaction).toMatchObject({
      transactionId: 'tx-1',
      transactionType: 'Shipment',
      transactionStatusLabel: '已释放',
      amount: 40,
      relatedIdentifiers: [{ name: 'ORDER_ID' }, { name: 'SHIPMENT_ID', value: 'FBA15ABCDE' }],
    })
    expect(detail.siblings.map((item: { id: string }) => item.id)).toEqual(['fe-com'])
    expect(detail.siblingsTruncated).toBe(false)
    expect(detail.orderId).toBe('order-fee-1')
    expect((await ok(reader, '/finance/events/fe-ful')).orderId).toBeNull()
    const report = await ok(reconciler, '/finance/events/fe-sto')
    expect(report).toMatchObject({ transaction: null, siblings: [], orderId: null })
    // 销售收入这类“不是费用”的明细不是费用事件：按编号也找不到
    expect((await get(reconciler, '/finance/events/fe-inc')).status).toBe(404)
  })

  it('标记有差异：乐观锁、审计、变更记录、备注必填；版本过期 409；“已对账”不能手工设置；清除标记', async () => {
    expect((await patch(reconciler, 'fe-ful', { version: 1, status: 'DISCREPANCY' })).status).toBe(422)
    expect((await patch(reconciler, 'fe-ful', { version: 1, status: 'RECONCILED', note: 'x' })).status).toBe(422)
    const marked = await patch(reconciler, 'fe-ful', { version: 1, status: 'DISCREPANCY', note: '与结算单金额不符' })
    expect(marked.status, JSON.stringify(marked.json)).toBe(200)
    expect(marked.json.data).toEqual({ id: 'fe-ful', version: 2, reconciliationStatus: 'DISCREPANCY' })
    const [stored] = await rows<Record<string, any>>(
      `SELECT "reconciliationStatus", "reconciliationNote", "reconciledBy", "reconciledAt", "version", "amount", "feeCategory" FROM "FbaFeeEvent" WHERE "id" = 'fe-ful'`,
    )
    expect(stored).toMatchObject({ reconciliationStatus: 'DISCREPANCY', reconciliationNote: '与结算单金额不符', reconciledBy: reconciler.userId, version: 2, feeCategory: 'FULFILLMENT' })
    expect(Number(stored.amount)).toBe(-3.5)
    expect(stored.reconciledAt).not.toBeNull()

    const stale = await patch(reconciler, 'fe-ful', { version: 1, note: '过期的修改' })
    expect(stale.status).toBe(409)
    expect(JSON.stringify(stale.json)).toContain('2')
    const unchanged = await patch(reconciler, 'fe-ful', { version: 2, status: 'DISCREPANCY', note: '与结算单金额不符' })
    expect(unchanged.status).toBeGreaterThanOrEqual(400)

    const audit = await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'FEE_EVENT_RECONCILED' AND "resourceId" = 'fe-ful'`, [tenantId])
    expect(audit).toHaveLength(1)
    const history = (await ok(reconciler, '/finance/events/fe-ful')).history
    expect(history).toHaveLength(1)
    expect(history[0].title).toContain('未对账 → 有差异')
    expect(history[0].actorName).toBeTruthy()
    // 有差异的筛选与统计
    expect((await ok(reconciler, `/finance/events?${RANGE}&reconciliation=DISCREPANCY`)).items.map((item: { id: string }) => item.id)).toEqual(['fe-ful'])
    expect((await ok(reconciler, `/finance/events/summary?${RANGE}`)).categories.find((item: { category: string }) => item.category === 'FULFILLMENT').discrepancyCount).toBe(1)

    // 清除标记，备注可以单独改
    const cleared = await patch(reconciler, 'fe-ful', { version: 2, status: 'UNRECONCILED', note: null })
    expect(cleared.status, JSON.stringify(cleared.json)).toBe(200)
    expect(cleared.json.data).toMatchObject({ version: 3, reconciliationStatus: 'UNRECONCILED' })
    const noteOnly = await patch(reconciler, 'fe-ful', { version: 3, note: '已和财务确认无误' })
    expect(noteOnly.json.data).toMatchObject({ version: 4, reconciliationStatus: 'UNRECONCILED' })
    expect((await ok(reconciler, '/finance/events/fe-ful')).history).toHaveLength(3)
  })

  it('权限与范围：没有 finance.read 403；只读角色不能写；范围外的店铺 404；其他企业看不到', async () => {
    expect((await get(noFinance, '/finance/events')).status).toBe(403)
    expect((await get(noFinance, '/finance/events/summary')).status).toBe(403)
    expect((await get(noFinance, '/finance/events/fe-ful')).status).toBe(403)
    expect((await patch(reader, 'fe-com', { version: 1, status: 'DISCREPANCY', note: 'x' })).status).toBe(403)
    expect((await rows(`SELECT "version" FROM "FbaFeeEvent" WHERE "id" = 'fe-com'`))[0]).toMatchObject({ version: 1 })

    expect((await ok(scoped, `/finance/events?${RANGE}`)).items.map((item: { id: string }) => item.id)).toEqual(['fe-2nd'])
    expect((await ok(scoped, `/finance/events/summary?${RANGE}`)).categories.find((item: { category: string }) => item.category === 'FULFILLMENT').count).toBe(1)
    expect((await get(scoped, '/finance/events/fe-com')).status).toBe(404)
    expect((await patch(scoped, 'fe-com', { version: 1, status: 'DISCREPANCY', note: 'x' })).status).toBe(404)
    expect((await patch(scoped, 'fe-2nd', { version: 1, status: 'DISCREPANCY', note: '范围内可以改' })).status).toBe(200)

    expect((await ok(other, `/finance/events?${RANGE}`)).items).toEqual([])
    expect((await get(other, '/finance/events/fe-com')).status).toBe(404)
    expect((await patch(other, 'fe-com', { version: 1, status: 'DISCREPANCY', note: 'x' })).status).toBe(404)
    // 行级隔离：别的企业的租户连接直接查表也看不到
    expect(await runWithTenant('tenant-fee-b', () => tenantDb.fbaFeeEvent.count())).toBe(0)
  })
})
