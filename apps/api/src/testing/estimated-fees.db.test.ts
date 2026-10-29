import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 预估与自定义费用与回款增强（P6-20，真实数据库 + 后台任务代码）：规则的新建、修改、删除、区间重叠 409、乐观锁、权限与跨企业隔离、数据库约束、
// 利润日表计入估算并标“含估算”、实际费用出账后自动冲销（撤销后又恢复）、整份校验的导入、回款漏斗（回款率、预留金、未接入）。

type Json = ReturnType<typeof JSON.parse>
type Refresh = (db: unknown, range: { tenantId: string; dateFrom: string; dateTo: string }, now?: Date) => Promise<number>
const loadRefresh = async () => (await import(/* @vite-ignore */ String('../../../worker/src/profit/run'))).refreshProfitDaily as Refresh

describe('预估与自定义费用（真实数据库）', () => {
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
  let storagePath: string
  let storeRule: Json
  let seq = 0
  const NOW = new Date('2026-10-20T12:00:00Z')
  const DAY = 24 * 3600 * 1000
  const real = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString()

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: { token: string }, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const post = (member: { token: string }, body: unknown) => h.call(member.token, 'POST', '/finance/estimated-fees', { body })
  const put = (member: { token: string }, body: unknown) => h.call(member.token, 'PUT', '/finance/estimated-fees', { body })
  const del = (member: { token: string }, id: string, version: number) => h.call(member.token, 'DELETE', `/finance/estimated-fees?id=${id}&version=${version}`)
  const importCsv = (member: { token: string }, content: string) => h.call(member.token, 'POST', '/finance/estimated-fees/import', { body: { fileName: 'est.csv', content } })
  const refreshProfit = () => runWithTenant(tenantId, () => refresh(scoped, { tenantId, dateFrom: '2026-10-01', dateTo: '2026-10-15' }, NOW))
  const profitRows = () =>
    rows<{ sku: string; d: string; fee: number; est: number | null; flags: string[] }>(
      `SELECT "sku", to_char("profitDate", 'YYYY-MM-DD') AS d, "feeStorage"::float AS fee, "estimatedFee"::float AS est, "flags" FROM "ProfitDaily" WHERE "tenantId" = $1 AND "basis" = 'ORDERED' ORDER BY 1, 2`,
      [tenantId],
    )
  const total = (list: Awaited<ReturnType<typeof profitRows>>, key: 'fee' | 'est') => Math.round(list.reduce((sum, row) => sum + (row[key] ?? 0), 0) * 1e6) / 1e6
  const count = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "EstimatedFee" WHERE "tenantId" = $1`, [tenantId]))[0]!.n

  const order = async (day: string, sku: string, asin: string, qty: number, price: number) => {
    const n = ++seq
    const purchaseDate = `${day}T18:00:00Z`
    const amazonOrderId = `111-${String(n).padStart(7, '0')}-0000001`
    await insertRow(h.client, 'Order', { id: `eo-${n}`, tenantId, sellerAccountId: sellerId, amazonOrderId, purchaseDate, status: 'Shipped', currency: 'USD', sourceUpdatedAt: purchaseDate })
    await insertRow(h.client, 'OrderItem', {
      id: `eoi-${n}`,
      tenantId,
      sellerAccountId: sellerId,
      orderId: `eo-${n}`,
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
  const storageFee = async (amount: number, day: string) => {
    const id = `ef-${++seq}`
    await insertRow(h.client, 'FbaFeeEvent', {
      id,
      tenantId,
      sellerAccountId: sellerId,
      sourceEventId: `${id}:0`,
      currency: 'USD',
      postedAt: `${day}T12:00:00Z`,
      feeCategory: 'STORAGE',
      feeSubtype: 'StorageFee',
      amount,
    })
    return id
  }

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'estimated_fees' })
    const a = await h.createTenant('ef-a')
    const b = await h.createTenant('ef-b')
    tenantId = a.tenantId
    sellerId = a.sellerAccountId
    otherTenantId = b.tenantId
    owner = await h.createMember(tenantId, 'ef-owner', ['finance.read', 'finance.estimatedfee.write', 'finance.profititem.manage'])
    reader = await h.createMember(tenantId, 'ef-reader', ['finance.read'])
    outsider = await h.createMember(otherTenantId, 'ef-outsider', ['finance.read', 'finance.estimatedfee.write'])
    await order('2026-10-05', 'sku-1', 'B0001', 2, 60)
    await order('2026-10-05', 'sku-2', 'B0002', 4, 40)
    await insertRow(h.client, 'FbaProduct', {
      id: 'ep-1',
      tenantId,
      sellerAccountId: sellerId,
      asin: 'B0001',
      sellerSku: 'sku-1',
      title: 'P1',
      productType: 'TOY',
      categoryPath: 'Toys/Games',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    await insertRow(h.client, 'FbaProduct', {
      id: 'ep-2',
      tenantId,
      sellerAccountId: sellerId,
      asin: 'B0002',
      sellerSku: 'sku-2',
      title: 'P2',
      productType: 'GAME',
      sourceUpdatedAt: '2026-10-01T00:00:00Z',
    })
    // 九月的一笔实际仓储费：让字典第一版把 StorageFee 映射到“仓储费”，它在刷新范围之外，不影响十月的数字
    await storageFee(-1, '2026-09-20')
    await get(owner, '/finance/profit-items')
    storageItem = (await rows<{ id: string }>(`SELECT id FROM "ProfitItem" WHERE "tenantId" = $1 AND "systemKey" = 'STORAGE'`, [tenantId]))[0]!.id
    revenueItem = (await rows<{ id: string }>(`SELECT id FROM "ProfitItem" WHERE "tenantId" = $1 AND "systemKey" = 'REVENUE'`, [tenantId]))[0]!.id
    const base = new PrismaClient({ datasourceUrl: h.db.urlFor('estimated_fees', 'app') })
    scoped = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    refresh = await loadRefresh()
  }, 180_000)
  afterAll(async () => {
    await h?.close()
  })

  it('没有规则时利润日表没有估算，列表为空；可选费用项不含销售额，带店铺', async () => {
    await refreshProfit()
    const list = await profitRows()
    expect(total(list, 'fee')).toBe(0)
    expect(list.every(row => !row.flags.includes('ESTIMATE_INCLUDED'))).toBe(true)
    const data = await get(reader, '/finance/estimated-fees')
    expect(data).toMatchObject({ total: 0, rows: [], canWrite: false })
    const ids = (data.items as Json[]).map(item => item.id)
    expect(ids).toContain(storageItem)
    expect(ids).not.toContain(revenueItem)
    storagePath = (data.items as Json[]).find(item => item.id === storageItem).path
    expect((data.stores as Json[]).map(store => store.id)).toEqual([sellerId])
    expect((await get(owner, '/finance/estimated-fees')).canWrite).toBe(true)
  })

  it('新建：没有写权限 403；销售额项目、不存在的店铺或 SKU 或品类 422；币种固定美元；成功 201 并带重算提示与审计', async () => {
    const base = { itemId: storageItem, scopeType: 'STORE', scopeId: sellerId, mode: 'FIXED', value: 62, period: 'MONTHLY', from: '2026-10-01' }
    expect((await post(reader, base)).status).toBe(403)
    expect((await post(owner, { ...base, itemId: revenueItem })).status).toBe(422)
    expect((await post(owner, { ...base, itemId: 'no-such' })).status).toBe(422)
    expect((await post(owner, { ...base, scopeId: 'no-such-store' })).status).toBe(422)
    expect((await post(owner, { ...base, scopeType: 'SKU', scopeId: 'sku-404' })).status).toBe(422)
    expect((await post(owner, { ...base, scopeType: 'CATEGORY', scopeId: 'NOPE' })).status).toBe(422)
    expect(await count()).toBe(0)
    const created = await post(owner, base)
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    storeRule = created.json.data.row
    expect(storeRule).toMatchObject({
      itemId: storageItem,
      scopeType: 'STORE',
      scopeName: expect.any(String),
      value: 62,
      currency: 'USD',
      period: 'MONTHLY',
      from: '2026-10-01',
      to: null,
      status: 'ACTIVE',
      version: 1,
    })
    expect(created.json.data.recomputeNote).toContain('重算')
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'ESTIMATED_FEE_CREATED'`, [tenantId])).length).toBeGreaterThanOrEqual(1)
  })

  it('区间重叠 409（共用一天也算），相邻、停用、不同范围、不同费用项都不冲突', async () => {
    const base = { itemId: storageItem, scopeType: 'STORE', scopeId: sellerId, mode: 'FIXED', value: 5, period: 'DAILY' }
    expect((await post(owner, { ...base, from: '2026-10-10', to: '2026-10-12' })).status).toBe(409)
    expect((await post(owner, { ...base, from: '2026-01-01', to: '2026-10-01' })).status).toBe(409)
    expect((await post(owner, { ...base, from: '2026-01-01', to: '2026-09-30' })).status).toBe(201)
    const inactive = await post(owner, { ...base, from: '2026-10-10', status: 'INACTIVE' })
    expect(inactive.status, JSON.stringify(inactive.json)).toBe(201)
    // 停用的不参与重叠，但把它改成生效会冲突
    const enable = await put(owner, { id: inactive.json.data.row.id, version: 1, ...base, from: '2026-10-10', status: 'ACTIVE' })
    expect(enable.status).toBe(409)
    expect(await count()).toBe(3)
  })

  it('修改：自己和自己不算重叠；过期版本 409；没有权限 403；别的企业 404；删除要带正确版本', async () => {
    const body = {
      id: storeRule.id,
      version: 1,
      itemId: storageItem,
      scopeType: 'STORE',
      scopeId: sellerId,
      mode: 'FIXED',
      value: 62,
      period: 'MONTHLY',
      from: '2026-10-01',
      to: '2026-12-31',
      status: 'ACTIVE',
    }
    expect((await put(reader, body)).status).toBe(403)
    expect((await put(outsider, body)).status).toBe(404)
    const updated = await put(owner, body)
    expect(updated.status, JSON.stringify(updated.json)).toBe(200)
    expect(updated.json.data.row).toMatchObject({ version: 2, to: '2026-12-31' })
    expect((await put(owner, body)).status).toBe(409)
    expect((await del(owner, storeRule.id, 1)).status).toBe(409)
    expect((await del(outsider, storeRule.id, 2)).status).toBe(404)
    expect(await count()).toBe(3)
    storeRule = updated.json.data.row
  })

  it('读取：按范围与方式筛选、搜索；别的企业看不到', async () => {
    const all = await get(reader, '/finance/estimated-fees')
    expect(all).toMatchObject({ total: 3, summary: { active: 2, inactive: 1 } })
    expect((await get(reader, '/finance/estimated-fees?status=INACTIVE')).total).toBe(1)
    expect((await get(reader, '/finance/estimated-fees?scopeType=SKU')).total).toBe(0)
    expect((await get(reader, `/finance/estimated-fees?q=${encodeURIComponent('仓储')}`)).total).toBe(3)
    expect((await get(outsider, '/finance/estimated-fees')).total).toBe(0)
  })

  it('利润日表：店铺级固定月费按当月天数平均计入、标“含估算”；估算只算到今天为止的日子', async () => {
    await refreshProfit()
    const list = await profitRows()
    // 10-01 到 10-15 共 15 天，每天 62 ÷ 31 = 2 美元
    expect(total(list, 'est')).toBe(30)
    expect(total(list, 'fee')).toBe(30)
    expect(list.filter(row => row.est).every(row => row.flags.includes('ESTIMATE_INCLUDED'))).toBe(true)
    await refreshProfit()
    expect(await profitRows()).toEqual(list)
  })

  it('SKU 比例规则：按当天销售额乘比例计入对应 SKU', async () => {
    const created = await post(owner, { itemId: storageItem, scopeType: 'SKU', scopeId: 'sku-1', mode: 'PERCENT_OF_SALES', value: 10, period: 'DAILY', from: '2026-10-01' })
    expect(created.status, JSON.stringify(created.json)).toBe(201)
    await refreshProfit()
    const list = await profitRows()
    const sku1 = list.filter(row => row.sku === 'sku-1')
    expect(total(sku1, 'est')).toBe(6)
    expect(total(list, 'est')).toBe(36)
  })

  it('冲销：本月已有实际费用出账，按月的店铺估算自动不再计入；撤销实际费用后重算又恢复', async () => {
    const eventId = await storageFee(-5, '2026-10-10')
    await refreshProfit()
    let list = await profitRows()
    // 店铺 62/月 的估算整月冲销；按日的比例规则只看当天（10-10 没有销售），不受影响
    expect(total(list, 'est')).toBe(6)
    expect(total(list, 'fee')).toBe(11)
    await rows(`DELETE FROM "FbaFeeEvent" WHERE id = $1`, [eventId])
    await refreshProfit()
    list = await profitRows()
    expect(total(list, 'est')).toBe(36)
  })

  it('数据库约束：金额不能为负、币种必须是三位大写字母、截止日不早于起始日、范围取值受限', async () => {
    const attempt = (override: Record<string, unknown>) =>
      insertRow(h.client, 'EstimatedFee', {
        id: `bad-${++seq}`,
        tenantId,
        itemId: storageItem,
        scopeType: 'STORE',
        scopeId: sellerId,
        mode: 'FIXED',
        value: 1,
        currency: 'USD',
        period: 'DAILY',
        from: '2027-01-01',
        status: 'INACTIVE',
        ...override,
      })
    for (const override of [{ value: -1 }, { currency: 'usd' }, { to: '2026-12-31' }, { scopeType: 'WAREHOUSE' }, { mode: 'MAGIC' }, { mode: 'PERCENT_OF_SALES', value: 101 }]) {
      await expect(attempt(override), JSON.stringify(override)).rejects.toThrow()
    }
  })

  it('导入：整份校验，任何一行有错整份不导入；重叠与不存在的对象都报行号；成功后写审计', async () => {
    const head = '费用项,范围,范围对象,方式,金额或比例,周期,起始日,截止日,状态,备注'
    const before = await count()
    const bad = await importCsv(
      owner,
      `${head}\r\n${storagePath},SKU,sku-2,销售额比例,3,按日,2026-10-01,,,\r\n${storagePath},SKU,sku-404,销售额比例,3,按日,2026-10-01,,,\r\n${storagePath},店铺,${sellerId},固定金额,1,按日,2026-10-20,,,\r\n`,
    )
    expect(bad.status).toBe(422)
    const lines: string[] = bad.json.error.fieldErrors.content
    expect(lines.some(line => line.startsWith('第 3 行'))).toBe(true)
    expect(lines.some(line => line.startsWith('第 4 行') && line.includes('重叠'))).toBe(true)
    expect(await count()).toBe(before)
    expect((await importCsv(reader, `${head}\r\n`)).status).toBe(403)
    const ok = await importCsv(owner, `${head}\r\n${storagePath},SKU,sku-2,销售额比例,3,按日,2026-10-01,,,批量\r\n${storagePath},品类,TOY,固定金额,1,按日,2026-10-01,2026-10-31,停用,\r\n`)
    expect(ok.status, JSON.stringify(ok.json)).toBe(200)
    expect(ok.json.data).toMatchObject({ total: 2, created: 2 })
    expect(await count()).toBe(before + 2)
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'ESTIMATED_FEE_IMPORTED'`, [tenantId])).length).toBe(1)
    expect((await importCsv(outsider, `${head}\r\n${storagePath},SKU,sku-2,销售额比例,3,按日,2026-10-01,,,\r\n`)).status).toBe(422)
  })

  it('删除：带正确版本删掉，写审计；删除后利润重算不再计入这条规则', async () => {
    const res = await del(owner, storeRule.id, storeRule.version)
    expect(res.status, JSON.stringify(res.json)).toBe(200)
    expect((await del(owner, storeRule.id, storeRule.version)).status).toBe(404)
    expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE "tenantId" = $1 AND action = 'ESTIMATED_FEE_DELETED'`, [tenantId])).length).toBe(1)
    await refreshProfit()
    expect(total(await profitRows(), 'est')).toBe(7.2)
  })

  it('回款漏斗：没有数据是 NO_DATA；有数据时给回款率、应收、未退还预留金；未接入的级别是 null 而不是 0', async () => {
    expect((await get(outsider, '/finance/cashflow/funnel')).state).toBe('NO_DATA')
    const tx = (type: string, status: string, amount: number, daysAgo: number) =>
      insertRow(h.client, 'FbaFinancialTransaction', {
        id: `ft-${++seq}`,
        tenantId,
        sellerAccountId: sellerId,
        externalTransactionId: `ft-${seq}`,
        transactionType: type,
        transactionStatus: status,
        amount,
        currency: 'USD',
        postedAt: real(daysAgo),
        sourceUpdatedAt: real(daysAgo),
      })
    const settlement = (id: string, endDaysAgo: number, depositDaysAgo: number, amount: number) =>
      insertRow(h.client, 'FbaSettlement', {
        id: `fs-${++seq}`,
        tenantId,
        sellerAccountId: sellerId,
        externalSettlementId: id,
        currency: 'USD',
        settlementEndDate: real(endDaysAgo),
        depositDate: real(depositDaysAgo),
        disbursementAmount: amount,
        sourceUpdatedAt: real(1),
      })
    // 只有结算单时：交易级别未接入（null），回款率照常给
    await settlement('S-1', 10, 8, 800)
    await settlement('S-2', 3, -2, 200)
    const onlySettlement = await get(reader, '/finance/cashflow/funnel')
    expect(onlySettlement.state).toBe('OK')
    expect(onlySettlement.stages.find((stage: Json) => stage.key === 'POSTED').amount).toBeNull()
    expect(onlySettlement.payoutRate).toMatchObject({ value: 0.8, paid: 800, announced: 1000 })
    expect(onlySettlement.reserve.state).toBe('NOT_CONNECTED')
    await tx('Order', 'DEFERRED_RELEASED', 500, 5)
    await tx('Order', 'DEFERRED', 300, 5)
    await tx('Transfer', 'RELEASED', -800, 4)
    const noReserve = await get(reader, '/finance/cashflow/funnel')
    expect(noReserve.reserve).toMatchObject({ state: 'NONE', unreturned: null })
    await tx('ReserveDebit', 'RELEASED', -100, 20)
    await tx('ReserveCredit', 'RELEASED', 30, 3)
    const data = await get(reader, '/finance/cashflow/funnel')
    const stage = (key: string) => data.stages.find((item: Json) => item.key === key)
    expect(stage('POSTED')).toMatchObject({ amount: 800, count: 2 })
    expect(stage('RELEASED').amount).toBe(500)
    expect(stage('DEFERRED').amount).toBe(300)
    expect(stage('ANNOUNCED').amount).toBe(1000)
    expect(stage('PAID').amount).toBe(800)
    expect(stage('UPCOMING').amount).toBe(200)
    expect(data.reserve).toMatchObject({ state: 'OK', held: 100, returned: 30, unreturned: 70 })
    expect(data.currencies).toContain('USD')
    // 别的企业看不到这些数据；其他币种没有数据时漏斗各级为空
    expect((await get(outsider, '/finance/cashflow/funnel')).state).toBe('NO_DATA')
    expect((await get(reader, '/finance/cashflow/funnel?currency=EUR')).stages.every((item: Json) => item.amount === null)).toBe(true)
  })
})
