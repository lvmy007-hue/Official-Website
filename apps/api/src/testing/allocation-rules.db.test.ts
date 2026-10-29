import { STORE_LEVEL_SKU } from '@nova/api-contracts'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 费用分摊规则（P6-19，真实数据库 + 后台任务代码）：新建与修改（版本号冲突、重复、不可分摊的费用项、权限、跨企业隔离）、数据库约束、
// 预览不落库且总额对得上、利润日表派生按规则把店铺级费用分摊到 SKU（分摊之和等于原始费用、店铺合计不变）、已关账月份不能改规则。

type Json = ReturnType<typeof JSON.parse>
type Refresh = (db: unknown, range: { tenantId: string; dateFrom: string; dateTo: string }, now?: Date) => Promise<number>
const loadRefresh = async () => (await import(/* @vite-ignore */ String('../../../worker/src/profit/run'))).refreshProfitDaily as Refresh

describe('费用分摊规则（真实数据库）', () => {
  let h: DbTestApp
  let tenantId: string
  let sellerId: string
  let otherTenantId: string
  let owner: { userId: string; token: string }
  let reader: { userId: string; token: string }
  let outsider: { userId: string; token: string }
  let scoped: PrismaClient
  let refresh: Refresh
  let storageItem: string
  let revenueItem: string
  let ruleId: string
  let seq = 0
  const NOW = new Date('2026-10-20T12:00:00Z')

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: { token: string }, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const post = (member: { token: string }, body: unknown) => h.call(member.token, 'POST', '/finance/allocation-rules', { body })
  const put = (member: { token: string }, body: unknown) => h.call(member.token, 'PUT', '/finance/allocation-rules', { body })
  const previewOf = (member: { token: string }, body: unknown) => h.call(member.token, 'POST', '/finance/allocation-rules/preview', { body })
  const refreshProfit = () => runWithTenant(tenantId, () => refresh(scoped, { tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-15' }, NOW))
  const profitRows = () =>
    rows<{ sku: string; d: string; fee: number; revenue: number }>(
      `SELECT "sku", to_char("profitDate", 'YYYY-MM-DD') AS d, "feeStorage"::float AS fee, "revenue"::float AS revenue FROM "ProfitDaily" WHERE "tenantId" = $1 AND "basis" = 'ORDERED' ORDER BY 1, 2`,
      [tenantId],
    )
  const feeOf = (list: Awaited<ReturnType<typeof profitRows>>, sku: string) => Math.round(list.filter(row => row.sku === sku).reduce((sum, row) => sum + row.fee, 0) * 1e6) / 1e6
  const feeTotal = (list: Awaited<ReturnType<typeof profitRows>>) => Math.round(list.reduce((sum, row) => sum + row.fee, 0) * 1e6) / 1e6

  const order = async (day: string, sku: string, asin: string, qty: number, price: number) => {
    const n = ++seq
    const purchaseDate = `${day}T18:00:00Z`
    const amazonOrderId = `111-${String(n).padStart(7, '0')}-0000001`
    await insertRow(h.client, 'Order', { id: `ao-${n}`, tenantId, sellerAccountId: sellerId, amazonOrderId, purchaseDate, status: 'Shipped', currency: 'USD', sourceUpdatedAt: purchaseDate })
    await insertRow(h.client, 'OrderItem', {
      id: `aoi-${n}`,
      tenantId,
      sellerAccountId: sellerId,
      orderId: `ao-${n}`,
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
  const storeFee = (amount: number, day = '2026-10-10') =>
    insertRow(h.client, 'FbaFeeEvent', {
      id: `sf-${++seq}`,
      tenantId,
      sellerAccountId: sellerId,
      sourceEventId: `sf-${seq}:0`,
      currency: 'USD',
      postedAt: `${day}T12:00:00Z`,
      feeCategory: 'STORAGE',
      feeSubtype: 'StorageFee',
      amount,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'allocation_rules' })
    const a = await h.createTenant('ar-a')
    const b = await h.createTenant('ar-b')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    otherTenantId = b.tenantId
    owner = await h.createMember(tenantId, 'ar-owner', ['finance.read', 'finance.policy.write', 'finance.profititem.manage'])
    reader = await h.createMember(tenantId, 'ar-reader', ['finance.read'])
    outsider = await h.createMember(otherTenantId, 'ar-outsider', ['finance.read', 'finance.policy.write'])
    // 10-05 两个 SKU 有销售：sku-1 销售额 60、2 件；sku-2 销售额 40、4 件；店铺级费用 10 美元（月度仓储费，没有 SKU）
    await order('2026-10-05', 'sku-1', 'B0001', 2, 60)
    await order('2026-10-05', 'sku-2', 'B0002', 4, 40)
    await storeFee(-10)
    // 第一次读取字典会生成第一版并把近 180 天出现过的交易类型映射到系统项目
    await get(owner, '/finance/profit-items')
    storageItem = (await rows<{ id: string }>(`SELECT id FROM "ProfitItem" WHERE "tenantId" = $1 AND "systemKey" = 'STORAGE'`, [tenantId]))[0]!.id
    revenueItem = (await rows<{ id: string }>(`SELECT id FROM "ProfitItem" WHERE "tenantId" = $1 AND "systemKey" = 'REVENUE'`, [tenantId]))[0]!.id
    const base = new PrismaClient({ datasourceUrl: h.db.urlFor('allocation_rules', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    refresh = await loadRefresh()
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有规则时店铺级费用留在店铺级行（分摊之前的基线）', async () => {
    await refreshProfit()
    const list = await profitRows()
    expect(feeTotal(list)).toBe(10)
    expect(feeOf(list, STORE_LEVEL_SKU)).toBe(10)
    expect(feeOf(list, 'sku-1')).toBe(0)
  })

  it('列表：没有规则时为空，可选费用项不含销售额与代收代缴税，带近 90 天店铺级笔数', async () => {
    const data = await get(reader, '/finance/allocation-rules')
    expect(data).toMatchObject({ total: 0, rows: [] })
    const ids = (data.feeItems as Json[]).map(item => item.id)
    expect(ids).toContain(storageItem)
    expect(ids).not.toContain(revenueItem)
    expect((data.feeItems as Json[]).find(item => item.id === storageItem)?.storeLevelLines90d).toBe(1)
    expect((data.bases as Json[]).map(item => item.value)).toEqual(['SALES_AMOUNT', 'SALES_UNITS', 'SHIPMENT_RECEIVED_UNITS', 'REMOVAL_ORDER_SKU', 'MANUAL'])
  })

  it('预览：按销售额 60 : 40 分摊 10 美元，不落库；对比当前（没有规则）的差异；总额对得上', async () => {
    const res = await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SALES_AMOUNT' } })
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    const data = res.json.data as Json
    expect(data).toMatchObject({ month: '2026-10', totalAmount: -10, allocatedAmount: -10, unallocatedAmount: 0, currentBasis: null, locked: false, truncated: false })
    const byKey = Object.fromEntries((data.rows as Json[]).map(row => [row.sku, row]))
    expect(byKey['sku-1']).toMatchObject({ amount: -6, share: 0.6, currentAmount: 0, diff: -6 })
    expect(byKey['sku-2']).toMatchObject({ amount: -4, share: 0.4 })
    expect((await rows(`SELECT count(*)::int AS n FROM "AllocationRule" WHERE "tenantId" = $1`, [tenantId]))[0].n).toBe(0)
    expect(feeOf(await profitRows(), STORE_LEVEL_SKU)).toBe(10)
    // 按销量 2 : 4：尾差记到占比最大的 sku-2，两者之和仍是 -10
    const byUnits = (await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SALES_UNITS' } })).json.data as Json
    const amounts = (byUnits.rows as Json[]).map(row => row.amount as number)
    expect(Math.round(amounts.reduce((sum, value) => sum + value, 0) * 1e6) / 1e6).toBe(-10)
    // 手动比例：不看销售，比例里的 SKU 都能分到
    const manual = (await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'MANUAL', manualWeights: { 'sku-1': 1, 'sku-9': 1 } } })).json.data as Json
    expect((manual.rows as Json[]).map(row => [row.sku, row.amount])).toEqual([
      ['sku-1', -5],
      ['sku-9', -5],
    ])
    // 没有任何权重的依据（货件签收量没有数据）：整笔留在店铺级
    const noneRes = await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SHIPMENT_RECEIVED_UNITS' } })
    const none = noneRes.json.data as Json
    expect(none).toMatchObject({ totalAmount: -10, allocatedAmount: 0, unallocatedAmount: -10, rows: [] })
    // 销售额项目不能分摊；别的企业的费用项不存在
    expect((await previewOf(reader, { month: '2026-10', rule: { feeItemId: revenueItem, basis: 'SALES_AMOUNT' } })).status).toBe(422)
    expect((await previewOf(outsider, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SALES_AMOUNT' } })).status).toBe(422)
  })

  it('新建：需要 finance.policy.write；销售额项目不能分摊；同费用项同月重复 409；返回规则与重算提示', async () => {
    expect((await post(reader, { feeItemId: storageItem, basis: 'SALES_AMOUNT', effectiveMonth: '2026-10' })).status).toBe(403)
    expect((await post(owner, { feeItemId: revenueItem, basis: 'SALES_AMOUNT', effectiveMonth: '2026-10' })).status).toBe(422)
    expect((await post(owner, { feeItemId: 'no-such-item', basis: 'SALES_AMOUNT', effectiveMonth: '2026-10' })).status).toBe(422)
    const created = await post(owner, { feeItemId: storageItem, basis: 'SALES_AMOUNT', effectiveMonth: '2026-10' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    expect(created.json.data.rule).toMatchObject({ feeItemId: storageItem, basis: 'SALES_AMOUNT', effectiveMonth: '2026-10', version: 1, locked: false })
    expect(created.json.data.recomputeNote).toContain('重算')
    ruleId = created.json.data.rule.id
    expect((await post(owner, { feeItemId: storageItem, basis: 'SALES_UNITS', effectiveMonth: '2026-10' })).status).toBe(409)
    const audits = await rows(`SELECT action FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'ALLOCATION_RULE_CREATED'`, [tenantId])
    expect(audits.length).toBeGreaterThanOrEqual(1)
  })

  it('读取：规则带费用项路径与依据；别的企业看不到也改不了', async () => {
    const data = await get(reader, '/finance/allocation-rules')
    expect(data.total).toBe(1)
    expect(data.rows[0]).toMatchObject({ id: ruleId, basisLabel: '按销售额', effectiveMonth: '2026-10', locked: false })
    expect(data.rows[0].feeItemPath).toContain('仓储费')
    expect((await get(outsider, '/finance/allocation-rules')).total).toBe(0)
    expect((await put(outsider, { id: ruleId, version: 1, basis: 'SALES_UNITS' })).status).toBe(404)
  })

  it('利润日表按规则分摊：sku-1 分 6、sku-2 分 4，店铺级行不再留这笔；总额与基线一致；重复刷新幂等', async () => {
    await refreshProfit()
    const list = await profitRows()
    expect(feeOf(list, 'sku-1')).toBe(6)
    expect(feeOf(list, 'sku-2')).toBe(4)
    expect(feeOf(list, STORE_LEVEL_SKU)).toBe(0)
    expect(feeTotal(list)).toBe(10)
    await refreshProfit()
    expect(await profitRows()).toEqual(list)
  })

  it('修改：带版本号；过期版本 409；手动比例改依据后按比例分摊；缺手动比例 422', async () => {
    expect((await put(reader, { id: ruleId, version: 1, basis: 'SALES_UNITS' })).status).toBe(403)
    expect((await put(owner, { id: ruleId, version: 1, basis: 'MANUAL' })).status).toBe(422)
    const updated = await put(owner, { id: ruleId, version: 1, basis: 'MANUAL', manualWeights: { 'sku-1': 1, 'sku-2': 4 } })
    expect(updated.status, JSON.stringify(updated.json)).toBe(200)
    expect(updated.json.data.rule).toMatchObject({ basis: 'MANUAL', version: 2, manualWeights: { 'sku-1': 1, 'sku-2': 4 } })
    expect((await put(owner, { id: ruleId, version: 1, basis: 'SALES_UNITS' })).status).toBe(409)
    await refreshProfit()
    const list = await profitRows()
    expect(feeOf(list, 'sku-1')).toBe(2)
    expect(feeOf(list, 'sku-2')).toBe(8)
    expect(feeTotal(list)).toBe(10)
    // 预览现在的“当前依据”是手动比例
    const preview = (await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SALES_AMOUNT' } })).json.data as Json
    expect(preview.currentBasis).toBe('MANUAL')
    expect((preview.rows as Json[]).find(row => row.sku === 'sku-1')).toMatchObject({ amount: -6, currentAmount: -2, diff: -4 })
  })

  it('规则按月切换：下个月的规则不影响当月；列表可按生效月排序', async () => {
    const next = await post(owner, { feeItemId: storageItem, basis: 'SALES_UNITS', effectiveMonth: '2026-11' })
    expect(next.status, JSON.stringify(next.json)).toBe(201)
    await refreshProfit()
    expect(feeOf(await profitRows(), 'sku-1')).toBe(2)
    const sorted = await get(reader, '/finance/allocation-rules?sort=effectiveMonth:asc')
    expect((sorted.rows as Json[]).map(row => row.effectiveMonth)).toEqual(['2026-10', '2026-11'])
  })

  it('已关账月份：新建与修改都被拒绝；列表与预览标明已关账；重开后可以改', async () => {
    await insertRow(h.client, 'AccountingPeriod', {
      id: 'ar-p1',
      tenantId,
      sellerAccountId: sellerId,
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
      status: 'CLOSED',
      closeCount: 1,
      createdBy: 'u',
    })
    const locked = await put(owner, { id: ruleId, version: 2, basis: 'SALES_AMOUNT' })
    expect(locked.status, JSON.stringify(locked.json)).toBeGreaterThanOrEqual(400)
    expect(JSON.stringify(locked.json)).toContain('已关账')
    expect((await post(owner, { feeItemId: storageItem, basis: 'SALES_UNITS', effectiveMonth: '2026-10' })).status).toBeGreaterThanOrEqual(400)
    const data = await get(reader, '/finance/allocation-rules')
    expect((data.rows as Json[]).find(row => row.effectiveMonth === '2026-10')?.locked).toBe(true)
    expect((data.rows as Json[]).find(row => row.effectiveMonth === '2026-11')?.locked).toBe(false)
    expect((await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SALES_UNITS' } })).json.data.locked).toBe(true)
    await h.client.query(`UPDATE "AccountingPeriod" SET status = 'REOPENED' WHERE id = 'ar-p1'`)
    expect((await put(owner, { id: ruleId, version: 2, basis: 'SALES_AMOUNT' })).status).toBe(200)
  })

  it('数据库约束：依据限定五种、生效月必须是当月第一天、手动比例只在 MANUAL 时有值、版本号从 1 起、同费用项同月唯一', async () => {
    const insert = (over: Record<string, unknown>) =>
      insertRow(h.client, 'AllocationRule', { id: `bad-${++seq}`, tenantId, feeItemId: storageItem, basis: 'SALES_AMOUNT', effectiveMonth: '2025-01-01', ...over })
    await expect(insert({ basis: 'BY_MOOD' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ effectiveMonth: '2025-01-15' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ manualWeights: JSON.stringify({ a: 1 }) })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ basis: 'MANUAL' })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ version: 0 })).rejects.toMatchObject({ code: '23514' })
    await expect(insert({ effectiveMonth: '2026-11-01' })).rejects.toMatchObject({ code: '23505' })
  })

  it('货件签收量与移除订单依据：预览与利润日表都按当月签收件数、移除件数分摊', async () => {
    await insertRow(h.client, 'FbaInboundPlan', { id: 'ar-plan', tenantId, sellerAccountId: sellerId, name: '10 月补货', sourceAddress: '深圳' })
    await insertRow(h.client, 'ShipmentItem', { id: 'ar-si1', tenantId, planId: 'ar-plan', shipmentId: 'FBA1', sku: 'sku-1', shippedQty: 40, receivedQty: 30, updatedAt: '2026-10-08T00:00:00Z' })
    await insertRow(h.client, 'ShipmentItem', { id: 'ar-si2', tenantId, planId: 'ar-plan', shipmentId: 'FBA1', sku: 'sku-2', shippedQty: 10, receivedQty: 10, updatedAt: '2026-10-08T00:00:00Z' })
    // 没有签收的货件项（receivedQty 为空）不参与权重
    await insertRow(h.client, 'ShipmentItem', { id: 'ar-si3', tenantId, planId: 'ar-plan', shipmentId: 'FBA2', sku: 'sku-3', shippedQty: 99, updatedAt: '2026-10-08T00:00:00Z' })
    const shipment = (await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'SHIPMENT_RECEIVED_UNITS' } })).json.data as Json
    expect((shipment.rows as Json[]).map(row => [row.sku, row.amount])).toEqual([
      ['sku-1', -7.5],
      ['sku-2', -2.5],
    ])
    await insertRow(h.client, 'RemovalOrder', {
      id: 'ar-ro1',
      tenantId,
      sellerAccountId: sellerId,
      orderId: 'RO-1',
      requestDate: '2026-10-03',
      sku: 'sku-2',
      requestedQty: 5,
      sourceUpdatedAt: '2026-10-03T00:00:00Z',
    })
    const removal = (await previewOf(reader, { month: '2026-10', rule: { feeItemId: storageItem, basis: 'REMOVAL_ORDER_SKU' } })).json.data as Json
    expect((removal.rows as Json[]).filter(row => row.amount !== 0).map(row => [row.sku, row.amount])).toEqual([['sku-2', -10]])
    // 利润日表：把规则改成货件签收量（2026-11 的规则不影响当月）后重算，按 3 : 1 分摊
    const rule = (await rows<{ version: number }>(`SELECT version FROM "AllocationRule" WHERE id = $1`, [ruleId]))[0]!
    expect((await put(owner, { id: ruleId, version: rule.version, basis: 'SHIPMENT_RECEIVED_UNITS' })).status).toBe(200)
    await refreshProfit()
    const list = await profitRows()
    expect(feeOf(list, 'sku-1')).toBe(7.5)
    expect(feeOf(list, 'sku-2')).toBe(2.5)
    expect(feeTotal(list)).toBe(10)
  })

  it('行级安全：别的企业的租户上下文读不到规则', async () => {
    expect(await runWithTenant(otherTenantId, () => scoped.allocationRule.count())).toBe(0)
    expect(await runWithTenant(tenantId, () => scoped.allocationRule.count())).toBe(2)
  })
})
