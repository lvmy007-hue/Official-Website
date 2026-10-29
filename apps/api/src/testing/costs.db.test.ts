import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MIGRATIONS_DIR, applyMigrations, insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { startTestDatabase, type TestDatabase } from './test-database'

// 商品成本（P2b-14，真实数据库 + 完整应用）：
// 迁移升级（新列、约束、索引、既有数据不动）与回滚闭环；
// 录入 → 确认生效 → 同一生效日替换旧版本 → 已关账期间拒绝 → 乐观锁 → 导入草稿 → 采购收货批次压过价格版本；跨企业与数据范围隔离。

type Member = { userId: string; token: string }
const TARGET = '20261107010000_cost_versions'

describe('商品成本迁移（P2b-14）', () => {
  let db: TestDatabase
  let client: Client
  beforeAll(async () => {
    db = await startTestDatabase()
    await db.createDatabase('cost_migrate')
    client = await db.connect('cost_migrate')
    await applyMigrations(client, { before: TARGET })
  })
  afterAll(async () => {
    await client?.end()
    await db?.stop()
  })
  const columns = async () => (await client.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'CostVersion'`)).rows.map(row => (row as { column_name: string }).column_name)

  it('升级加列与约束且不动既有数据；约束拒绝非法取值；回滚闭环可再升级', async () => {
    const tenant = await insertRow(client, 'Tenant', { id: 't-cv', slug: 't-cv', name: '租户' })
    const base = { tenantId: tenant.id, currency: 'USD', source: 'MANUAL', effectiveFrom: '2026-01-01' }
    await insertRow(client, 'CostVersion', { id: 'old-1', sku: 'S1', versionNo: 1, unitProductCost: 5, status: 'ACTIVE', ...base })
    expect(await columns()).not.toContain('unitDutyCost')
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toEqual(expect.arrayContaining(['unitDutyCost', 'note', 'version', 'createdBy', 'activatedBy', 'activatedAt', 'replacedById', 'replacedAt']))
    expect((await client.query(`SELECT "version", "unitDutyCost", "status", "unitProductCost"::text AS cost FROM "CostVersion" WHERE id = 'old-1'`)).rows[0]).toEqual({
      version: 1,
      unitDutyCost: null,
      status: 'ACTIVE',
      cost: '5.000000',
    })
    expect((await client.query(`SELECT 1 FROM pg_indexes WHERE indexname = 'CostVersion_sku_status_idx'`)).rowCount).toBe(1)

    const next = (id: string, over: Record<string, unknown>) => insertRow(client, 'CostVersion', { id, sku: 'S2', versionNo: 1, unitProductCost: 1, ...base, ...over })
    expect(await next('ok-1', { unitProductCost: null, unitDutyCost: 0.5 })).toMatchObject({ version: 1, status: expect.any(String) })
    await expect(next('bad-neg', { sku: 'S3', unitDutyCost: -1 })).rejects.toMatchObject({ code: '23514' })
    await expect(next('bad-none', { sku: 'S4', unitProductCost: null })).rejects.toMatchObject({ code: '23514' })
    await expect(next('bad-ver', { sku: 'S5', version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(next('bad-dup', { versionNo: 1 })).rejects.toMatchObject({ code: '23505' })

    await client.query(readFileSync(join(MIGRATIONS_DIR, TARGET, 'rollback.sql'), 'utf8'))
    expect(await columns()).not.toContain('unitDutyCost')
    expect((await client.query(`SELECT count(*)::int AS n FROM "CostVersion"`)).rows[0]).toEqual({ n: 2 })
    // 只有关税的版本回滚后没有任何成本（关税列已删）；再次升级前要处理掉，否则“至少一项成本”的约束加不上
    await client.query(`DELETE FROM "CostVersion" WHERE id = 'ok-1'`)
    await applyMigrations(client, { only: TARGET })
    expect(await columns()).toContain('unitDutyCost')
  })
})

describe('商品成本（真实数据库）', () => {
  let db: TestDatabase
  let h: DbTestApp
  let tenantId: string
  let writer: Member
  let reader: Member
  let scoped: Member
  let other: Member
  let secondSellerId: string

  const get = (member: Member, path: string) => h.call(member.token, 'GET', path, {})
  const send = (member: Member, method: string, path: string, body?: Record<string, unknown>) => h.call(member.token, method, path, { body })
  const rows = async <T>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const dayText = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + offset)).toISOString().slice(0, 10)
  const create = async (body: Record<string, unknown>) => {
    const res = await send(writer, 'POST', '/costs', { sku: 'SKU-A', currency: 'USD', effectiveFrom: dayText(-5), unitProductCost: 10, ...body })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    return res.json.data as { id: string; version: number; versionNo: number; status: string }
  }
  const activate = (items: Array<{ id: string; version: number }>) => send(writer, 'POST', '/costs/activate', { items })
  const statusOf = async (id: string) =>
    (await rows<{ status: string; version: number; replacedById: string | null }>(`SELECT status, version, "replacedById" FROM "CostVersion" WHERE id = $1`, [id]))[0]!
  const audits = async () =>
    (await rows<{ action: string }>(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND action LIKE 'COST_%' ORDER BY "createdAt", id`, [tenantId])).map(row => row.action)

  beforeAll(async () => {
    db = await startTestDatabase()
    h = await createDbTestApp({ database: 'costs', db })
    const a = await h.createTenant('cv-a')
    tenantId = a.tenantId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC' WHERE id = $1`, [tenantId])
    secondSellerId = (await insertRow(h.client, 'SellerAccount', { id: 'seller-cv-2', tenantId, legalEntityId: a.legalEntityId, sellerId: 'SELLER-CV-2', displayName: '欧洲店' })).id
    const b = await h.createTenant('cv-b')
    writer = await h.createMember(tenantId, 'cv-write', ['costs.read', 'costs.write', 'field.cost'])
    reader = await h.createMember(tenantId, 'cv-read', ['costs.read', 'field.cost'])
    scoped = await h.createMember(tenantId, 'cv-scoped', ['costs.read', 'costs.write', 'field.cost'], { scopes: [{ sellerAccountId: secondSellerId }] })
    other = await h.createMember(b.tenantId, 'cv-other', ['*'])
    await insertRow(h.client, 'FbaProduct', { id: 'fp-a', tenantId, sellerAccountId: a.sellerAccountId, sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品 A' })
    await insertRow(h.client, 'FbaProduct', { id: 'fp-b', tenantId, sellerAccountId: a.sellerAccountId, sellerSku: 'SKU-B', asin: 'B0B', title: '示例商品 B' })
    await insertRow(h.client, 'FbaProduct', { id: 'fp-eu', tenantId, sellerAccountId: secondSellerId, sellerSku: 'SKU-EU', asin: 'B0E', title: '欧洲商品' })
    await insertRow(h.client, 'FbaProduct', { id: 'fp-o', tenantId: b.tenantId, sellerAccountId: b.sellerAccountId, sellerSku: 'SKU-A', asin: 'B0A', title: '别人的商品' })
  })
  afterAll(async () => {
    await h?.close()
  })

  it('录入草稿 → 确认生效：草稿不参与覆盖；生效后列表显示当前成本、到岸成本与覆盖状态；审计齐全', async () => {
    const draft = await create({ unitFirstMileCost: 1.5, note: '第一批' })
    expect(draft).toMatchObject({ status: 'DRAFT', versionNo: 1, version: 1 })
    const before = (await get(writer, '/costs?q=SKU-A')).json.data
    expect(before.items[0]).toMatchObject({ sku: 'SKU-A', coverage: 'DRAFT_ONLY', draftCount: 1, activeCount: 0, landedUsd: null, landedState: 'NO_DATA' })
    expect(before.summary).toMatchObject({ DRAFT_ONLY: 1, MISSING: 2 })

    const done = await activate([{ id: draft.id, version: draft.version }])
    expect(done.status, JSON.stringify(done.json)).toBe(201)
    expect(done.json.data).toMatchObject({ activated: 1, replaced: 0 })
    expect(await statusOf(draft.id)).toMatchObject({ status: 'ACTIVE', version: 2 })
    const [stamp] = await rows<{ activatedBy: string; activatedAt: Date }>(`SELECT "activatedBy", "activatedAt" FROM "CostVersion" WHERE id = $1`, [draft.id])
    expect(stamp?.activatedBy).toBe(writer.userId)
    expect(stamp?.activatedAt).toBeTruthy()

    const after = (await get(reader, '/costs?q=SKU-A')).json.data
    expect(after).toMatchObject({ canWrite: false, summary: { COVERED: 1, MISSING: 2 } })
    expect(after.items[0]).toMatchObject({ coverage: 'COVERED', landedUsd: 11.5, landedState: 'OK', activeCount: 1, draftCount: 0 })
    expect(after.items[0].parts.firstMile).toMatchObject({ amount: '1.5', usd: 1.5, source: 'MANUAL' })
    expect(await audits()).toEqual(['COST_VERSION_CREATED', 'COST_VERSION_ACTIVATED'])
    expect(await get(reader, '/costs?coverage=MISSING')).toMatchObject({ status: 200 })
  })

  it('同一生效日再确认一个价格版本：旧版本被替换并记下被谁替换；详情时间线与对比反映变化', async () => {
    const first = (await rows<{ id: string }>(`SELECT id FROM "CostVersion" WHERE "tenantId" = $1 AND sku = 'SKU-A' AND "versionNo" = 1`, [tenantId]))[0]!
    // 新版本带着旧版本的头程分摊，否则会让头程失效而被拒绝
    const next = await create({ unitProductCost: 12, unitFirstMileCost: 1.5 })
    expect(next.versionNo).toBe(2)
    const res = await activate([{ id: next.id, version: next.version }])
    expect(res.json.data).toMatchObject({ activated: 1, replaced: 1, versions: [{ replacedVersionNos: [1] }] })
    expect(await statusOf(first.id)).toMatchObject({ status: 'REPLACED', replacedById: next.id })
    expect(await audits()).toContain('COST_VERSION_REPLACED')

    const detail = (await get(reader, '/costs/SKU-A')).json.data
    expect(detail.versions.map((item: { versionNo: number; status: string }) => `${item.versionNo}:${item.status}`)).toEqual(['2:ACTIVE', '1:REPLACED'])
    expect(detail.versions[1]).toMatchObject({ replacedByVersionNo: 2, activatedByName: expect.any(String) })
    expect(detail.row.parts.product).toMatchObject({ amount: '12', versionNo: 2 })
    expect(detail.composition).toMatchObject({ totalUsd: 13.5 })
    expect(detail.valuation).toMatchObject({ state: 'NO_STOCK_DATA' })
    const compare = (await get(reader, `/costs/SKU-A/compare?a=${first.id}&b=${next.id}`)).json.data
    expect(compare.rows[0]).toMatchObject({ component: 'product', a: '10', b: '12', delta: 2, deltaPct: 0.2 })
  })

  it('已关账期间：生效日落在期间里不能生效；重新开账后可以；乐观锁：旧版本号 409', async () => {
    const date = dayText(-40)
    await insertRow(h.client, 'AccountingPeriod', {
      id: 'ap-cv',
      tenantId,
      sellerAccountId: (await rows<{ id: string }>(`SELECT id FROM "SellerAccount" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [tenantId]))[0]!.id,
      periodStart: dayText(-60),
      periodEnd: dayText(-30),
      status: 'CLOSED',
      createdBy: 'u',
    })
    const draft = await create({ sku: 'SKU-B', effectiveFrom: date, unitProductCost: 7 })
    const refused = await activate([{ id: draft.id, version: draft.version }])
    expect(refused.status).toBe(409)
    expect(refused.json.error.message).toContain('已关账')
    expect(await statusOf(draft.id)).toMatchObject({ status: 'DRAFT', version: 1 })

    expect((await send(writer, 'PATCH', `/costs/versions/${draft.id}`, { version: 99, note: '旧' })).status).toBe(409)
    const edited = await send(writer, 'PATCH', `/costs/versions/${draft.id}`, { version: 1, effectiveFrom: dayText(-3), unitDutyCost: 0.4 })
    expect(edited.status, JSON.stringify(edited.json)).toBe(200)
    expect(edited.json.data).toMatchObject({ version: 2, status: 'DRAFT' })
    const done = await activate([{ id: draft.id, version: 2 }])
    expect(done.status, JSON.stringify(done.json)).toBe(201)
    expect(await statusOf(draft.id)).toMatchObject({ status: 'ACTIVE' })
  })

  it('批量生效全部成功或全部不生效；丢弃草稿后记录消失并写审计；已生效的不能丢弃', async () => {
    const good = await create({ sku: 'SKU-EU', effectiveFrom: dayText(-2), unitProductCost: 3 })
    const closed = await create({ sku: 'SKU-EU', effectiveFrom: dayText(-45), unitProductCost: 4 })
    const mixed = await activate([
      { id: good.id, version: good.version },
      { id: closed.id, version: closed.version },
    ])
    expect(mixed.status).toBe(409)
    expect(await statusOf(good.id)).toMatchObject({ status: 'DRAFT', version: 1 })

    expect((await send(writer, 'DELETE', `/costs/versions/${closed.id}?version=9`)).status).toBe(409)
    const gone = await send(writer, 'DELETE', `/costs/versions/${closed.id}?version=${closed.version}`)
    expect(gone.status, JSON.stringify(gone.json)).toBe(200)
    expect(await rows(`SELECT 1 FROM "CostVersion" WHERE id = $1`, [closed.id])).toHaveLength(0)
    expect(await audits()).toContain('COST_VERSION_DISCARDED')
    const active = (await rows<{ id: string }>(`SELECT id FROM "CostVersion" WHERE "tenantId" = $1 AND status = 'ACTIVE' LIMIT 1`, [tenantId]))[0]!
    expect((await send(writer, 'DELETE', `/costs/versions/${active.id}?version=2`)).status).toBe(409)
    expect((await activate([{ id: good.id, version: good.version }])).status).toBe(201)
  })

  it('文件导入：一行有错整份拒绝；通过后每行一个导入草稿，来源是文件导入、版本号接着往下排；确认后生效', async () => {
    const bad = await send(writer, 'POST', '/costs/import', { fileName: 'c.csv', content: 'SKU,生效日期,币种,采购单价\nSKU-B,2026-01-05,USD,1\nNOPE,2026-01-05,USD,2\n' })
    expect(bad.status).toBe(422)
    expect(bad.json.error.fieldErrors.content[0]).toContain('NOPE')
    expect(await rows(`SELECT 1 FROM "CostVersion" WHERE source = 'FILE_IMPORT'`)).toHaveLength(0)

    const csv = `SKU,生效日期,币种,采购单价,关税\nSKU-B,${dayText(-1)},CNY,71,3.55\nSKU-A,${dayText(-1)},USD,13,\n`
    const res = await send(writer, 'POST', '/costs/import', { fileName: 'c.csv', content: csv })
    expect(res.status, JSON.stringify(res.json)).toBe(201)
    expect(res.json.data).toMatchObject({ imported: 2, skus: 2 })
    const imported = await rows<{ sku: string; versionNo: number; status: string; sourceDocId: string }>(
      `SELECT sku, "versionNo", status, "sourceDocId" FROM "CostVersion" WHERE source = 'FILE_IMPORT' ORDER BY sku`,
    )
    expect(imported.map(row => [row.sku, row.status])).toEqual([
      ['SKU-A', 'DRAFT'],
      ['SKU-B', 'DRAFT'],
    ])
    expect(imported[0]?.versionNo).toBe(3)
    expect(imported[0]?.sourceDocId).toMatch(new RegExp(`^${res.json.data.batchId}:3$`))
    expect(await audits()).toContain('COST_VERSIONS_IMPORTED')

    const detail = (await get(writer, '/costs/SKU-B')).json.data
    const draft = detail.versions.find((item: { status: string; source: string }) => item.status === 'DRAFT' && item.source === 'FILE_IMPORT')
    expect(draft).toMatchObject({ sourceLabel: '文件导入', canDiscard: true, product: '71', duty: '3.55', blockedReason: null })
    expect((await activate([{ id: draft.id, version: draft.version }])).status).toBe(201)
    const converted = (await get(writer, '/costs/SKU-B')).json.data.row
    expect(converted.parts.product).toMatchObject({ amount: '71', currency: 'CNY' })
    expect(converted.landedState).toBe(converted.parts.product.usd === null ? 'NO_FX' : 'OK')
  })

  it('采购收货批次压过价格版本：详情标出被压过的价格版本、来源单号与批次件数；库存成本按先进先出估算', async () => {
    const supplier = await insertRow(h.client, 'Supplier', { id: 'sup-cv', tenantId, code: 'SUP-CV', name: '供应商' })
    const order = await insertRow(h.client, 'PurchaseOrder', { id: 'po-cv', tenantId, supplierId: supplier.id, number: 'PO-CV-1' })
    await insertRow(h.client, 'PurchaseOrderLine', { id: 'pol-cv', purchaseOrderId: order.id, sellerSku: 'SKU-A', quantity: 100, receivedQuantity: 40 })
    await insertRow(h.client, 'CostVersion', {
      id: 'cv-batch',
      tenantId,
      sku: 'SKU-A',
      versionNo: 90,
      effectiveFrom: dayText(-4),
      currency: 'USD',
      unitProductCost: 9,
      source: 'PURCHASE_RECEIPT',
      status: 'ACTIVE',
      sourceDocId: order.id,
    })
    const store = (await rows<{ id: string }>(`SELECT id FROM "SellerAccount" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [tenantId]))[0]!
    await insertRow(h.client, 'InventoryPlanningSnapshot', { id: 'ips-cv', tenantId, sellerAccountId: store.id, snapshotDate: dayText(-1), sku: 'SKU-A', available: 50 })

    const detail = (await get(reader, '/costs/SKU-A')).json.data
    const batch = detail.versions.find((item: { id: string }) => item.id === 'cv-batch')
    expect(batch).toMatchObject({ source: 'PURCHASE_RECEIPT', sourceLabel: '采购收货', sourceDocNo: 'PO-CV-1', quantity: 40, ignoredComponents: [] })
    expect(detail.pricing.product).toBe('BATCH')
    const ignored = detail.versions.filter((item: { ignoredComponents: string[] }) => item.ignoredComponents.includes('product'))
    expect(ignored.length).toBeGreaterThan(0)
    // 库存 50 件：批次 40 件（9 美元）全算，其余 10 件没有批次成本，不拿价格版本顶替；头程 1.5 来自价格版本
    expect(detail.valuation).toMatchObject({ state: 'OK', onHandUnits: 50, uncoveredUnits: 10, method: 'FIFO' })
    expect(detail.valuation.valueUsd).toBeCloseTo(40 * 9 + 50 * 1.5, 5)
  })

  it('数据范围与企业隔离：受限成员看不到范围外的 SKU 也不能写；别的企业看不到、改不了', async () => {
    const list = (await get(scoped, '/costs')).json.data
    expect(list.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-EU'])
    expect(list.canWrite).toBe(false)
    expect((await get(scoped, '/costs/SKU-A')).status).toBe(404)
    const blocked = await send(scoped, 'POST', '/costs', { sku: 'SKU-EU', currency: 'USD', effectiveFrom: dayText(-1), unitProductCost: 1 })
    expect(blocked.status).toBe(403)
    expect(blocked.json.error.code).toBe('SCOPE_TENANT_LEVEL_ONLY')

    const mine = (await rows<{ id: string }>(`SELECT id FROM "CostVersion" WHERE "tenantId" = $1 LIMIT 1`, [tenantId]))[0]!
    const foreign = (await get(other, '/costs')).json.data
    expect(foreign.items.map((item: { sku: string }) => item.sku)).toEqual(['SKU-A'])
    expect(foreign.items[0]).toMatchObject({ coverage: 'MISSING', title: '别人的商品' })
    expect((await get(other, `/costs/SKU-A/compare?a=${mine.id}&b=${mine.id}`)).status).toBe(404)
    expect((await send(other, 'PATCH', `/costs/versions/${mine.id}`, { version: 1, note: 'x' })).status).toBe(404)
    expect((await send(other, 'DELETE', `/costs/versions/${mine.id}?version=1`)).status).toBe(404)
    expect((await send(other, 'POST', '/costs/activate', { items: [{ id: mine.id, version: 1 }] })).status).toBe(409)
  })
})
