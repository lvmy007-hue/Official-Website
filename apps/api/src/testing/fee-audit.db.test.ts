import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 费用核查（P2b-06，真实数据库 + 完整应用 + 后台核查任务代码）：
// 迁移升级、约束、行级隔离、回滚闭环；四类核查按种子数据算出确切的应收、实收与多收；重复核查幂等、不再成立的当日旧行被清掉；
// 列表（排序、筛选、游标、汇总、尺寸分段变化、数据范围、跨企业隔离）；转为赔付机会（权限、幂等、已转的对象保持已转、审计）。

type Member = { userId: string; token: string }
const TARGET = '20261031010000_fee_audit'
const NOW = new Date()
const DAY = 86_400_000
const dayOf = (offset: number) => new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), NOW.getUTCDate()) + offset * DAY).toISOString().slice(0, 10)
const POSTED = new Date(NOW.getTime() - 2 * DAY).toISOString()
const MONTH = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1)).toISOString().slice(0, 10)

describe('费用核查迁移（P2b-06）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('fee_audit_migrate')
    client = await db.connect('fee_audit_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const exists = async (table: string) => ((await client.query(`SELECT to_regclass($1) IS NOT NULL AS found`, [`"${table}"`])).rows[0] as { found: boolean }).found

  it('升级建表并带行级隔离与授权；约束拒绝非法取值与重复；回滚去掉两张表，再升级闭环', async () => {
    expect(await exists('FeeAudit')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    for (const table of ['FeeBaseline', 'FeeAudit']) expect(await exists(table), table).toBe(true)
    const rls = await client.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [['FeeBaseline', 'FeeAudit']])
    expect(rls.rows.every(row => row.relrowsecurity)).toBe(true)
    const policies = await client.query(`SELECT tablename FROM pg_policies WHERE schemaname = 'public' AND tablename = ANY($1) AND qual LIKE '%nova_current_tenant%'`, [['FeeBaseline', 'FeeAudit']])
    expect(policies.rowCount).toBe(2)

    const tenant = await insertRow(client, 'Tenant', { id: 't-fa', slug: 't-fa', name: '租户' })
    const legal = await insertRow(client, 'LegalEntity', { id: 'le-fa', tenantId: tenant.id })
    const seller = await insertRow(client, 'SellerAccount', { id: 's-fa', tenantId: tenant.id, legalEntityId: legal.id })
    const base = { tenantId: tenant.id, sellerAccountId: seller.id }
    const audit = (id: string, over: Record<string, unknown> = {}) =>
      insertRow(client, 'FeeAudit', {
        id,
        ...base,
        feeKind: 'FULFILLMENT',
        subjectKey: id,
        snapshotDate: '2026-10-23',
        currency: 'USD',
        expectedAmount: 1,
        actualAmount: 2,
        diffAmount: 1,
        occurrences: 1,
        checkedCount: 1,
        ...over,
      })
    expect(await audit('fa-1')).toMatchObject({ status: 'NORMAL', overchargeAmount: '0.000000' })
    await expect(audit('fa-dup', { subjectKey: 'fa-1' })).rejects.toMatchObject({ code: '23505' })
    await expect(audit('fa-bad-kind', { feeKind: 'REFUND' })).rejects.toMatchObject({ code: '23514' })
    await expect(audit('fa-bad-status', { status: 'DONE' })).rejects.toMatchObject({ code: '23514' })
    await expect(audit('fa-bad-count', { occurrences: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(audit('fa-bad-over', { overchargeAmount: -1 })).rejects.toMatchObject({ code: '23514' })
    await insertRow(client, 'FeeBaseline', { id: 'fb-1', ...base, sku: 'SKU-1', snapshotDate: '2026-10-23', currency: 'USD' })
    await expect(insertRow(client, 'FeeBaseline', { id: 'fb-dup', ...base, sku: 'SKU-1', snapshotDate: '2026-10-23', currency: 'USD' })).rejects.toMatchObject({ code: '23505' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await exists('FeeAudit')).toBe(false)
    expect(await exists('FeeBaseline')).toBe(false)
    await applyMigrations(client, { only: TARGET })
    expect(((await client.query(`SELECT count(*)::int AS n FROM "FeeAudit"`)).rows[0] as { n: number }).n).toBe(0)
  })
})

describe('费用核查（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let secondSellerId: string
  let otherTenantId: string
  let otherSellerId: string
  let reader: Member
  let converter: Member
  let noFinance: Member
  let scoped: Member
  let other: Member
  let tenantDb: PrismaClient
  let auditTenant: (
    db: PrismaClient,
    tenantId: string,
    now?: Date,
  ) => Promise<{ results: Array<{ kind: string; subjects: number; suspected: number }>; written: number; removed: number; errors: string[] }>

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const ok = async (member: Member, path: string) => {
    const res = await get(member, path)
    expect(res.status, `GET ${path} → ${JSON.stringify(res.json)}`).toBe(200)
    return res.json.data
  }
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const run = (id: string) => runWithTenant(id, () => auditTenant(tenantDb, id, NOW))
  const audits = (kind?: string) =>
    rows<{
      id: string
      feeKind: string
      subjectKey: string
      expectedAmount: string
      actualAmount: string
      overchargeAmount: string
      occurrences: number
      checkedCount: number
      status: string
      basisJson: any
    }>(`SELECT * FROM "FeeAudit" WHERE "tenantId" = $1 ${kind ? `AND "feeKind" = '${kind}'` : ''} ORDER BY "feeKind", "subjectKey"`, [tenantId])
  const seed = async (id: string, store: string, order: string, sku: string, quantity: number, price: number) => {
    await insertRow(h.client, 'Order', { id: `ord-${order}`, tenantId: id, sellerAccountId: store, amazonOrderId: order, purchaseDate: POSTED, status: 'Shipped', currency: 'USD' })
    await insertRow(h.client, 'OrderItem', {
      id: `oi-${order}`,
      tenantId: id,
      sellerAccountId: store,
      orderId: `ord-${order}`,
      orderPurchaseDate: POSTED,
      amazonOrderId: order,
      orderItemId: `item-${order}`,
      sellerSku: sku,
      quantityOrdered: quantity,
      quantityShipped: quantity,
      itemPrice: price,
      currency: 'USD',
      sourceUpdatedAt: POSTED,
    })
  }
  const fee = (id: string, store: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'FbaFeeEvent', { id, tenantId: id.startsWith('o-') ? otherTenantId : tenantId, sellerAccountId: store, sourceEventId: `${id}:0`, currency: 'USD', postedAt: POSTED, ...over })
  const baseline = (id: string, tid: string, store: string, sku: string, over: Record<string, unknown>) =>
    insertRow(h.client, 'FeeBaseline', { id, tenantId: tid, sellerAccountId: store, sku, snapshotDate: dayOf(0), currency: 'USD', ...over })

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'fee_audit', db })
    const a = await h.createTenant('fa-a')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-fa-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-FA-2' })).id
    const b = await h.createTenant('fa-b')
    otherTenantId = b.tenantId
    otherSellerId = b.sellerAccountId
    reader = await h.createMember(tenantId, 'fa-read', ['finance.read'])
    converter = await h.createMember(tenantId, 'fa-conv', ['finance.read', 'reimbursements.read', 'reimbursements.write'])
    noFinance = await h.createMember(tenantId, 'fa-none', ['orders.read'])
    scoped = await h.createMember(tenantId, 'fa-scoped', ['finance.read', 'reimbursements.write'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(otherTenantId, 'fa-other', ['*'])
    const base = new PrismaClient({ datasourceUrl: db.urlFor('fee_audit', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    ;({ auditTenant } = await import(/* @vite-ignore */ String('../../../worker/src/fee-audit/run')))

    // 配送费与佣金：SKU-1 两个订单（一个多收），SKU-OK 一个订单（正常）；SKU-1 的亚马逊测量体积是我方登记的 8 倍
    await seed(tenantId, sellerId, '111-0000001-0000001', 'SKU-1', 2, 60)
    await seed(tenantId, sellerId, '111-0000001-0000002', 'SKU-1', 1, 30)
    await seed(tenantId, sellerId, '111-0000001-0000003', 'SKU-OK', 1, 30)
    await baseline('fb-1', tenantId, sellerId, 'SKU-1', {
      expectedFulfillmentFee: 3,
      expectedReferralFee: 4.5,
      salesPrice: 30,
      lengthCm: 20,
      widthCm: 20,
      heightCm: 20,
      weightKg: 1,
      sizeTier: 'Large Standard',
    })
    await baseline('fb-ok', tenantId, sellerId, 'SKU-OK', { expectedFulfillmentFee: 3 })
    await insertRow(h.client, 'FbaProduct', {
      id: 'prod-1',
      tenantId,
      sellerAccountId: sellerId,
      sellerSku: 'SKU-1',
      asin: 'B0TESTASIN1',
      title: '商品一',
      packageLengthCm: 10,
      packageWidthCm: 10,
      packageHeightCm: 10,
      sizeTier: 'Large Standard',
      sourceUpdatedAt: POSTED,
    })
    const line = { amazonOrderId: '', asin: 'B0TESTASIN1', sellerSku: 'SKU-1', sourceRecordId: 'tx-x' }
    await fee('fe-f1', sellerId, { ...line, amazonOrderId: '111-0000001-0000001', feeCategory: 'FULFILLMENT', amount: -9 })
    await fee('fe-f2', sellerId, { ...line, amazonOrderId: '111-0000001-0000002', feeCategory: 'FULFILLMENT', amount: -3 })
    await fee('fe-f3', sellerId, { ...line, amazonOrderId: '111-0000001-0000003', sellerSku: 'SKU-OK', feeCategory: 'FULFILLMENT', amount: -3 })
    await fee('fe-c1', sellerId, { ...line, amazonOrderId: '111-0000001-0000001', feeCategory: 'COMMISSION', amount: -18 })
    await fee('fe-c2', sellerId, { ...line, amazonOrderId: '111-0000001-0000002', feeCategory: 'COMMISSION', amount: -4.5 })
    // 仓储费：本月 80，按体积折算应收 10
    await insertRow(h.client, 'StorageFeeRecord', {
      id: 'sf-1',
      tenantId,
      sellerAccountId: sellerId,
      chargeMonth: MONTH,
      feeKind: 'STORAGE',
      fnsku: 'X001',
      sku: 'SKU-1',
      amount: 80,
      currency: 'USD',
      sourceUpdatedAt: POSTED,
    })
    // 入仓配置费：方案费用 10 减折扣 2，实收 20
    await insertRow(h.client, 'FbaInboundPlan', { id: 'plan-fa-1', tenantId, sellerAccountId: sellerId, name: '十月补货', sourceAddress: '仓库', selectedPlacementOptionId: 'po-1' })
    await insertRow(h.client, 'FbaInboundShipment', { id: 'ship-fa-1', planId: 'plan-fa-1', shipmentId: 'SHIP-FA-1', shipmentConfirmationId: 'FBA-SHIP-1' })
    await insertRow(h.client, 'PlacementOption', {
      id: 'pl-fa-1',
      tenantId,
      planId: 'plan-fa-1',
      placementOptionId: 'po-1',
      shipmentCount: 1,
      fees: 10,
      discounts: 2,
      shipmentsJson: '[]',
      status: 'ACCEPTED',
      confirmed: true,
    })
    await insertRow(h.client, 'FbaFinancialTransaction', {
      id: 'tx-row-pl',
      tenantId,
      sellerAccountId: sellerId,
      externalTransactionId: 'tx-pl',
      transactionType: 'ServiceFee',
      transactionStatus: 'RELEASED',
      amount: -20,
      postedAt: POSTED,
      relatedIdentifiers: JSON.stringify([{ name: 'SHIPMENT_ID', value: 'FBA-SHIP-1' }]),
    })
    await fee('fe-pl', sellerId, { feeCategory: 'INBOUND_PLACEMENT', eventType: 'FBAInboundPlacementServiceFee', feeSubtype: 'FBAInboundPlacementServiceFee', sourceRecordId: 'tx-pl', amount: -20 })
    // 第二家店：SKU-2 多收 3
    await seed(tenantId, secondSellerId, '222-0000001-0000001', 'SKU-2', 1, 30)
    await baseline('fb-2', tenantId, secondSellerId, 'SKU-2', { expectedFulfillmentFee: 3 })
    await fee('fe-s2', secondSellerId, { amazonOrderId: '222-0000001-0000001', sellerSku: 'SKU-2', feeCategory: 'FULFILLMENT', amount: -6, sourceRecordId: 'tx-s2' })
    // 尺寸分段变化：一个真变化、一个只是大小写不同；还有一份过期很久的变化
    await baseline('fb-tier', tenantId, sellerId, 'SKU-9', { sizeTier: 'Large Standard', prevSizeTier: 'Small Standard', snapshotDate: dayOf(-1) })
    await baseline('fb-case', tenantId, sellerId, 'SKU-C', { sizeTier: 'Large Standard', prevSizeTier: 'large standard', snapshotDate: dayOf(-1) })
    await baseline('fb-old', tenantId, sellerId, 'SKU-OLD', { sizeTier: 'Large Standard', prevSizeTier: 'Small Standard', snapshotDate: dayOf(-40) })
    // 另一家企业：同名 SKU 同样多收，用来证明互不串
    await seed(otherTenantId, otherSellerId, '333-0000001-0000001', 'SKU-1', 1, 30)
    await baseline('fb-other', otherTenantId, otherSellerId, 'SKU-1', { expectedFulfillmentFee: 3 })
    await fee('o-fe-f1', otherSellerId, { amazonOrderId: '333-0000001-0000001', sellerSku: 'SKU-1', feeCategory: 'FULFILLMENT', amount: -30, sourceRecordId: 'tx-o' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('没有运行核查之前：列表为空并写明原因；有数据范围外的基准不影响', async () => {
    const empty = await ok(reader, '/finance/fee-audit')
    expect(empty).toMatchObject({ state: 'NO_DATA', items: [], snapshotDate: null, canConvert: false })
    expect(empty.note).toContain('尚无费用核查结果')
    expect(empty.summary).toHaveLength(4)
    expect(empty.summary.every((item: { subjects: number }) => item.subjects === 0)).toBe(true)
  })

  it('核查任务：四类核查按种子数据算出确切的应收、实收与多收；没有基准、没有登记尺寸的不产出', async () => {
    const result = await run(tenantId)
    expect(result.errors).toEqual([])
    expect(result.results).toEqual([
      { kind: 'FULFILLMENT', subjects: 3, suspected: 2, truncated: false },
      { kind: 'COMMISSION', subjects: 1, suspected: 1, truncated: false },
      { kind: 'STORAGE', subjects: 1, suspected: 1, truncated: false },
      { kind: 'INBOUND_PLACEMENT', subjects: 1, suspected: 1, truncated: false },
    ])
    const all = await audits()
    const pick = (kind: string, key: string) => all.find(item => item.feeKind === kind && item.subjectKey === key)!
    expect(pick('FULFILLMENT', 'SKU-1')).toMatchObject({ expectedAmount: '9.000000', actualAmount: '12.000000', overchargeAmount: '3.000000', occurrences: 1, checkedCount: 2, status: 'SUSPECTED' })
    expect(pick('FULFILLMENT', 'SKU-OK')).toMatchObject({ overchargeAmount: '0.000000', occurrences: 0, checkedCount: 1, status: 'NORMAL' })
    expect(pick('FULFILLMENT', 'SKU-2')).toMatchObject({ overchargeAmount: '3.000000', status: 'SUSPECTED' })
    expect(pick('COMMISSION', 'SKU-1')).toMatchObject({ expectedAmount: '13.500000', actualAmount: '22.500000', overchargeAmount: '9.000000', occurrences: 1, checkedCount: 2 })
    expect(pick('STORAGE', 'SKU-1')).toMatchObject({ expectedAmount: '10.000000', actualAmount: '80.000000', overchargeAmount: '70.000000', occurrences: 1 })
    expect(pick('INBOUND_PLACEMENT', 'plan-fa-1')).toMatchObject({ expectedAmount: '8.000000', actualAmount: '20.000000', overchargeAmount: '12.000000', occurrences: 1 })
    // SKU-OK 没有佣金基准，不出现在佣金里；SKU-9 等只有尺寸分段、没有费用基准的不出现
    expect(all.some(item => item.feeKind === 'COMMISSION' && item.subjectKey === 'SKU-OK')).toBe(false)
    expect(all.some(item => item.subjectKey === 'SKU-9')).toBe(false)
    // 依据：多收明细与尺寸对比、限制都写进依据
    const basis = pick('FULFILLMENT', 'SKU-1').basisJson
    expect(basis.lines).toHaveLength(1)
    expect(basis.lines[0]).toMatchObject({ ref: '111-0000001-0000001', quantity: 2, expected: 6, actual: 9, diff: 3 })
    expect(basis.dims).toMatchObject({ volumeRatio: 8, tierAmazon: 'Large Standard', tierOurs: 'Large Standard' })
    expect(basis.notes.join('；')).toContain('8.00 倍')
    expect(pick('INBOUND_PLACEMENT', 'plan-fa-1').basisJson.summary).toContain('十月补货')
    // 另一家企业的数据没有被带进来
    expect((await rows(`SELECT 1 FROM "FeeAudit" WHERE "tenantId" = $1`, [otherTenantId])).length).toBe(0)
  })

  it('重复核查幂等；不再成立的当日旧行被清掉，其它行不动', async () => {
    const before = await audits()
    const again = await run(tenantId)
    expect(again.errors).toEqual([])
    expect(again.removed).toBe(0)
    const after = await audits()
    expect(after.map(item => item.id)).toEqual(before.map(item => item.id))
    // SKU-OK 的基准没了（比如报告停止同步）：它的核查行不再成立，被清掉
    await h.client.query(`DELETE FROM "FeeBaseline" WHERE "id" = 'fb-ok'`)
    const cleaned = await run(tenantId)
    expect(cleaned.removed).toBe(1)
    expect((await audits('FULFILLMENT')).map(item => item.subjectKey)).toEqual(['SKU-1', 'SKU-2'])
    await baseline('fb-ok', tenantId, sellerId, 'SKU-OK', { expectedFulfillmentFee: 3 })
    await run(tenantId)
    expect((await audits('FULFILLMENT')).map(item => item.subjectKey)).toEqual(['SKU-1', 'SKU-2', 'SKU-OK'])
  })

  it('过期的基准不使用：停止同步超过 7 天的基准不产出结果', async () => {
    await h.client.query(`UPDATE "FeeBaseline" SET "snapshotDate" = $1 WHERE "id" = 'fb-2'`, [dayOf(-10)])
    await run(tenantId)
    expect((await audits('FULFILLMENT')).map(item => item.subjectKey)).toEqual(['SKU-1', 'SKU-OK'])
    await h.client.query(`UPDATE "FeeBaseline" SET "snapshotDate" = $1 WHERE "id" = 'fb-2'`, [dayOf(0)])
    await run(tenantId)
    expect((await audits('FULFILLMENT')).map(item => item.subjectKey)).toEqual(['SKU-1', 'SKU-2', 'SKU-OK'])
  })

  it('列表：默认按累计差额从大到小，汇总与口径、尺寸分段变化、新鲜度；筛选与游标', async () => {
    const data = await ok(reader, '/finance/fee-audit')
    expect(data.state).toBe('OK')
    expect(data.snapshotDate).toBe(dayOf(0))
    expect(data.canConvert).toBe(false)
    const over = data.items.map((item: { overchargeAmount: number }) => item.overchargeAmount)
    expect(over).toEqual([...over].sort((a: number, b: number) => b - a))
    expect(data.items.slice(0, 3).map((item: { feeKind: string }) => item.feeKind)).toEqual(['STORAGE', 'INBOUND_PLACEMENT', 'COMMISSION'])
    const byKind = Object.fromEntries(data.summary.map((item: { kind: string }) => [item.kind, item]))
    expect(byKind.FULFILLMENT).toMatchObject({ subjects: 3, suspected: 2, occurrences: 2, overcharge: [{ currency: 'USD', amount: 6 }] })
    expect(byKind.STORAGE).toMatchObject({ subjects: 1, suspected: 1, overcharge: [{ currency: 'USD', amount: 70 }] })
    expect(data.sizeTierChanges).toEqual([expect.objectContaining({ sku: 'SKU-9', previousTier: 'Small Standard', currentTier: 'Large Standard', changedOn: dayOf(-1) })])
    expect(data.freshness).toBeDefined()
    // 筛选
    expect((await ok(reader, '/finance/fee-audit?kind=STORAGE')).items.map((item: { subjectKey: string }) => item.subjectKey)).toEqual(['SKU-1'])
    expect((await ok(reader, '/finance/fee-audit?kind=FULFILLMENT&status=NORMAL')).items.map((item: { subjectKey: string }) => item.subjectKey)).toEqual(['SKU-OK'])
    expect((await ok(reader, '/finance/fee-audit?q=sku-ok')).items.map((item: { subjectKey: string }) => item.subjectKey)).toEqual(['SKU-OK'])
    const none = await ok(reader, '/finance/fee-audit?kind=STORAGE&status=NORMAL')
    expect(none).toMatchObject({ state: 'NO_DATA', items: [] })
    expect(none.note).toContain('放宽')
    expect((await get(reader, '/finance/fee-audit?kind=NOPE')).status).toBe(422)
    expect((await get(reader, '/finance/fee-audit?cursor=not-a-cursor')).status).toBeGreaterThanOrEqual(400)
    // 游标：每页 2 条走完，不重不漏
    const seen: string[] = []
    let cursor = ''
    for (let page = 0; page < 10; page += 1) {
      const res = await ok(reader, `/finance/fee-audit?pageSize=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)
      seen.push(...res.items.map((item: { id: string }) => item.id))
      if (!res.pageInfo.hasMore) break
      cursor = res.pageInfo.nextCursor
    }
    expect(seen).toHaveLength(6)
    expect(new Set(seen).size).toBe(6)
  })

  it('权限、数据范围与跨企业隔离', async () => {
    expect((await get(noFinance, '/finance/fee-audit')).status).toBe(403)
    const mine = await ok(scoped, '/finance/fee-audit')
    expect(mine.items.map((item: { subjectKey: string }) => item.subjectKey)).toEqual(['SKU-2'])
    expect(mine.summary.find((item: { kind: string }) => item.kind === 'FULFILLMENT').subjects).toBe(1)
    expect(mine.sizeTierChanges).toEqual([])
    expect(mine.canConvert).toBe(true)
    await run(otherTenantId)
    const theirs = await ok(other, '/finance/fee-audit')
    expect(theirs.items.map((item: { subjectKey: string; overchargeAmount: number }) => [item.subjectKey, item.overchargeAmount])).toEqual([['SKU-1', 27]])
    expect((await ok(reader, '/finance/fee-audit')).items.every((item: { sellerAccountId: string }) => item.sellerAccountId !== otherSellerId)).toBe(true)
  })

  it('转为赔付机会：权限、金额与证据、幂等、审计；没有多收的不能转；数据范围外 404', async () => {
    const list = await ok(converter, '/finance/fee-audit?kind=FULFILLMENT')
    const suspect = list.items.find((item: { subjectKey: string }) => item.subjectKey === 'SKU-1')
    const normal = list.items.find((item: { subjectKey: string }) => item.subjectKey === 'SKU-OK')
    const post = (member: Member, id: string) => h.call(member.token, 'POST', `/finance/fee-audit/${id}/reimbursement`, { body: {} })
    expect((await post(reader, suspect.id)).status).toBe(403)
    expect((await post(converter, normal.id)).status).toBe(409)
    expect((await post(converter, 'missing-id')).status).toBe(404)
    expect((await post(converter, 'bad id!')).status).toBe(404)
    const second = list.items.find((item: { subjectKey: string }) => item.subjectKey === 'SKU-2')
    expect((await post(scoped, suspect.id)).status).toBe(404)
    expect((await post(other, suspect.id)).status).toBe(404)

    const res = await post(converter, suspect.id)
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ id: suspect.id, status: 'APPEALED', created: true })
    const opps = await rows<{
      id: string
      ruleCode: string
      dedupKey: string
      estimatedAmount: string
      currency: string
      status: string
      sku: string
      evidenceRefsJson: Array<{ kind: string; id: string }>
    }>(`SELECT * FROM "ReimbursementOpportunity" WHERE "tenantId" = $1 AND "ruleCode" = 'FEE_OVERCHARGE'`, [tenantId])
    expect(opps).toHaveLength(1)
    expect(opps[0]).toMatchObject({ dedupKey: 'fee-audit:FULFILLMENT:SKU-1', estimatedAmount: '3.000000', currency: 'USD', status: 'PENDING', sku: 'SKU-1' })
    expect(opps[0].evidenceRefsJson[0]).toMatchObject({ kind: 'FEE_AUDIT', id: suspect.id })
    expect(res.json.data.opportunityId).toBe(opps[0].id)
    const audit = await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND "action" = 'FEE_AUDIT_CONVERTED' AND "resourceId" = $2 AND "result" = 'SUCCEEDED'`, [tenantId, suspect.id])
    expect(audit).toHaveLength(1)

    // 再转一次：返回已有机会，不重复建
    const again = await post(converter, suspect.id)
    expect(again.json.data).toMatchObject({ created: false, opportunityId: opps[0].id, status: 'APPEALED' })
    expect(await rows(`SELECT 1 FROM "ReimbursementOpportunity" WHERE "tenantId" = $1 AND "ruleCode" = 'FEE_OVERCHARGE'`, [tenantId])).toHaveLength(1)

    // 页面上变成“已转赔付机会”，并且下一轮核查不会改回“疑似多收”
    await run(tenantId)
    const after = (await ok(converter, '/finance/fee-audit?kind=FULFILLMENT&status=APPEALED')).items
    expect(after.map((item: { subjectKey: string; opportunityId: string }) => [item.subjectKey, item.opportunityId])).toEqual([['SKU-1', opps[0].id]])
    expect((await ok(converter, '/finance/fee-audit?kind=FULFILLMENT&status=SUSPECTED')).items.map((item: { subjectKey: string }) => item.subjectKey)).toEqual(['SKU-2'])

    // 机会被忽略后不重建，提示去赔付中心
    await h.client.query(`UPDATE "ReimbursementOpportunity" SET "status" = 'IGNORED' WHERE "id" = $1`, [opps[0].id])
    const ignored = await post(converter, suspect.id)
    expect(ignored.status).toBe(409)
    expect(JSON.stringify(ignored.json)).toContain('赔付中心')
    expect(await rows(`SELECT 1 FROM "ReimbursementOpportunity" WHERE "tenantId" = $1 AND "ruleCode" = 'FEE_OVERCHARGE'`, [tenantId])).toHaveLength(1)

    // 范围内的另一家店可以转，且金额与币种来自该行
    const converted = await post(scoped, second.id)
    expect(converted.status, JSON.stringify(converted.json)).toBe(201)
    const secondOpp = await rows<{ estimatedAmount: string; sellerAccountId: string }>(`SELECT * FROM "ReimbursementOpportunity" WHERE "dedupKey" = 'fee-audit:FULFILLMENT:SKU-2'`)
    expect(secondOpp[0]).toMatchObject({ estimatedAmount: '3.000000', sellerAccountId: secondSellerId })
  })

  it('清理：超过保留期的核查结果与基准快照被删除', async () => {
    await insertRow(h.client, 'FeeAudit', {
      id: 'fa-ancient',
      tenantId,
      sellerAccountId: sellerId,
      feeKind: 'STORAGE',
      subjectKey: 'ANCIENT',
      snapshotDate: dayOf(-90),
      currency: 'USD',
      expectedAmount: 1,
      actualAmount: 1,
      diffAmount: 0,
      occurrences: 0,
      checkedCount: 1,
    })
    await baseline('fb-ancient', tenantId, sellerId, 'SKU-ANCIENT', { snapshotDate: dayOf(-120) })
    await run(tenantId)
    expect(await rows(`SELECT 1 FROM "FeeAudit" WHERE "id" = 'fa-ancient'`)).toHaveLength(0)
    expect(await rows(`SELECT 1 FROM "FeeBaseline" WHERE "id" = 'fb-ancient'`)).toHaveLength(0)
    expect(await rows(`SELECT 1 FROM "FeeBaseline" WHERE "id" = 'fb-old'`)).toHaveLength(1)
  })
})
