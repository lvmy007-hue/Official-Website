import { Prisma, PrismaClient } from '@prisma/client'
import { SHARE_TREND_DISCLAIMER } from '@nova/api-contracts'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 新品定价试算与关键词份额趋势（P6-29，真实数据库）：24 小时复用、每分钟 10 次、没有费用预估权限的提示、
// 保存只看自己、跨企业隔离；份额不把多店的市场总量相加。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const baseBody = {
  purchaseCost: 5,
  firstMile: { method: 'NONE', unitPrice: 0 },
  lengthCm: 20,
  widthCm: 15,
  heightCm: 2,
  weightG: 200,
  category: 'STANDARD',
  prices: [20, 25],
}

describe('新品定价试算与份额趋势（真实数据库）', () => {
  let h: DbTestApp
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let legalEntityId: string
  let otherTenantId: string
  let owner: Member
  let noTools: Member
  let reader: Member
  let brand: Member
  let outsider: Member
  let runFees: (db: unknown, api: unknown, input: unknown) => Promise<Json>

  const ymd = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'p629' })
    const a = await h.createTenant('p629-a')
    const b = await h.createTenant('p629-b')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    legalEntityId = a.legalEntityId
    otherTenantId = b.tenantId
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-p629', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: storeId, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    const base = new PrismaClient({ datasourceUrl: h.db.urlFor('p629', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    runFees = (await import(/* @vite-ignore */ String('../../../worker/src/connectors/product-fees-run'))).runProductFeeEstimate
    owner = await h.createMember(tenantId, 'p629-owner', ['tools.read', 'analytics.read', 'analytics.brand.read'])
    reader = await h.createMember(tenantId, 'p629-reader', ['analytics.read'])
    brand = await h.createMember(tenantId, 'p629-brand', ['analytics.read', 'analytics.brand.read'])
    noTools = await h.createMember(tenantId, 'p629-no', ['analytics.read'])
    outsider = await h.createMember(otherTenantId, 'p629-out', ['tools.read', 'analytics.read', 'analytics.brand.read'])
  })

  afterAll(async () => {
    await tenantDb.$disconnect()
    await h.close()
  })

  const send = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, { body })

  it('未登录 401；没有 tools.read 时 403', async () => {
    expect((await h.call('', 'POST', '/tools/pricing-calculator/estimate', { body: baseBody })).status).toBe(401)
    expect((await send(noTools, 'POST', '/tools/pricing-calculator/estimate', baseBody)).status).toBe(403)
  })

  it('费率表给出利润；同样参数 24 小时内复用；超过每分钟 10 个新参数返回 429', async () => {
    const first = await send(owner, 'POST', '/tools/pricing-calculator/estimate', baseBody)
    expect(first.status).toBe(200)
    expect(first.json.data.reused).toBe(false)
    expect(first.json.data.result.scenarios[0].profit).toBe(7.92)
    expect(first.json.data.result.amazon.message).toContain('未选择店铺')
    const again = await send(owner, 'POST', '/tools/pricing-calculator/estimate', baseBody)
    expect(again.status).toBe(200)
    expect(again.json.data.reused).toBe(true)
    expect(again.json.data.id).toBe(first.json.data.id)
    await h.client.query(`UPDATE "PricingCalcRecord" SET "estimatedAt" = now() - interval '2 days'`)
    for (let index = 0; index < 10; index += 1) {
      const res = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [30 + index] })
      expect(res.status, JSON.stringify(res.json)).toBe(200)
    }
    const limited = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [80] })
    expect(limited.status).toBe(429)
    expect(limited.json.error.code).toBe('RATE_LIMITED')
  })

  it('已授权店铺提交参考 ASIN 会入队；费用预估回写后再次试算看到接口结果；403 后写明没有费用预估权限', async () => {
    await h.client.query(`UPDATE "PricingCalcRecord" SET "estimatedAt" = now() - interval '2 days'`)
    h.queue.add.mockClear()
    const queued = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [20], referenceAsin: 'B0FEE00001', storeId })
    expect(queued.status).toBe(200)
    expect(queued.json.data.result.amazon.state).toBe('QUEUED')
    expect(h.queue.add).toHaveBeenCalledTimes(1)
    const recordId = queued.json.data.id as string
    const fee = (type: string, amount: number) => ({ FeeType: type, FeeAmount: { Amount: amount, CurrencyCode: 'USD' }, FinalFee: { Amount: amount, CurrencyCode: 'USD' } })
    const payload = { payload: { FeesEstimateResult: { Status: 'Success', FeesEstimate: { FeeDetailList: [fee('ReferralFee', 3), fee('FBAFees', 5)] } } } }
    await runWithTenant(tenantId, () => runFees(tenantDb, { estimate: async () => payload }, { tenantId, sellerAccountId: storeId, recordId, referenceAsin: 'B0FEE00001', price: 20 }))
    const reused = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [20], referenceAsin: 'B0FEE00001', storeId })
    expect(reused.json.data.reused).toBe(true)
    expect(reused.json.data.result.source).toBe('AMAZON')
    expect(reused.json.data.result.scenarios[0].fulfillmentFee).toBe(5)
    await h.client.query(`UPDATE "DataFreshness" SET status = 'UNAUTHORIZED', "lastErrorCode" = 'FEES_ROLE_PENDING' WHERE "sourceKey" = 'fees.estimate-v0'`)
    h.queue.add.mockClear()
    const blocked = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [21], referenceAsin: 'B0FEE00001', storeId })
    expect(blocked.status).toBe(200)
    expect(blocked.json.data.result.amazon.state).toBe('NO_PERMISSION')
    expect(blocked.json.data.result.amazon.message).toContain('没有费用预估权限')
    expect(h.queue.add).not.toHaveBeenCalled()
  })

  it('同企业别人算过同样参数：复用结果但给本人复制一行，可保存；失败结果不复用', async () => {
    const mate = await h.createMember(tenantId, 'p629-mate', ['tools.read'])
    const body = { ...baseBody, prices: [41] }
    const first = await send(owner, 'POST', '/tools/pricing-calculator/estimate', body)
    expect(first.status).toBe(200)
    const copy = await send(mate, 'POST', '/tools/pricing-calculator/estimate', body)
    expect(copy.json.data.reused).toBe(true)
    expect(copy.json.data.id).not.toBe(first.json.data.id)
    expect(copy.json.data.canSave).toBe(true)
    expect((await send(mate, 'POST', '/tools/pricing-calculator/records', { id: copy.json.data.id })).status).toBe(200)
    await h.client.query(`UPDATE "PricingCalcRecord" SET "resultJson" = jsonb_set("resultJson", '{amazon,state}', '"FAILED"') WHERE id = $1`, [first.json.data.id])
    await h.client.query(`UPDATE "PricingCalcRecord" SET "resultJson" = jsonb_set("resultJson", '{amazon,state}', '"FAILED"') WHERE id = $1`, [copy.json.data.id])
    const retry = await send(owner, 'POST', '/tools/pricing-calculator/estimate', body)
    expect(retry.json.data.reused).toBe(false)
  })

  it('保存的记录只看自己；别的企业看不到', async () => {
    const made = await send(owner, 'POST', '/tools/pricing-calculator/estimate', { ...baseBody, prices: [22] })
    expect(made.status).toBe(200)
    const saved = await send(owner, 'POST', '/tools/pricing-calculator/records', { id: made.json.data.id, name: '马克杯试算' })
    expect(saved.status).toBe(200)
    expect(saved.json.data.name).toBe('马克杯试算')
    const mine = await send(owner, 'GET', '/tools/pricing-calculator/records')
    expect(mine.json.data.items.map((row: Json) => row.id)).toContain(made.json.data.id)
    const theirs = await send(outsider, 'GET', '/tools/pricing-calculator/records')
    expect(theirs.json.data.items).toEqual([])
    expect((await send(outsider, 'POST', '/tools/pricing-calculator/records', { id: made.json.data.id })).status).toBe(404)
  })

  it('份额趋势：同一词两店不把市场总量相加，并写明这不是前台排名；没有品牌分析权限不报 403', async () => {
    const other = await insertRow(h.client, 'SellerAccount', { id: 'store-p629-b', tenantId, legalEntityId, displayName: '二店', sellerId: 'SELLER-P629-B', logicalRegion: 'NA2' })
    const row = {
      tenantId,
      reportPeriod: 'WEEK',
      periodStart: '2026-10-18',
      periodEnd: '2026-10-24',
      asin: 'B0SHARE001',
      searchQuery: 'mug',
      sourceUpdatedAt: '2026-10-25T00:00:00Z',
    }
    await insertRow(h.client, 'BrandSearchQueryPerformance', {
      ...row,
      id: 'sqp-1',
      sellerAccountId: storeId,
      impressionsOwn: 10,
      impressionsTotal: 100,
      clicksOwn: 1,
      clicksTotal: 10,
      searchVolume: 50,
    })
    await insertRow(h.client, 'BrandSearchQueryPerformance', {
      ...row,
      id: 'sqp-2',
      sellerAccountId: other.id,
      impressionsOwn: 40,
      impressionsTotal: 80,
      clicksOwn: 4,
      clicksTotal: 10,
      searchVolume: 50,
    })
    const stored = await h.client.query<{ periodStart: Date | string }>(`SELECT "periodStart" FROM "BrandSearchQueryPerformance" WHERE id = 'sqp-1'`)
    const rawDay = stored.rows[0]!.periodStart
    const periodStart = rawDay instanceof Date ? ymd(rawDay) : String(rawDay).slice(0, 10)
    const res = await send(brand, 'GET', '/analytics/brand/share-trend?asin=B0SHARE001')
    expect(res.status).toBe(200)
    expect(res.json.data.disclaimer).toBe(SHARE_TREND_DISCLAIMER)
    expect(res.json.data.points).toEqual([{ periodStart, impressionShare: 0.5, clickShare: 0.4, searchVolume: 50 }])
    const restricted = await send(reader, 'GET', '/analytics/brand/share-trend?asin=B0SHARE001')
    expect(restricted.status).toBe(200)
    expect(restricted.json.data.state).toBe('RESTRICTED')
    const hidden = await send(outsider, 'GET', '/analytics/brand/share-trend?asin=B0SHARE001')
    expect(hidden.json.data.state).toBe('NO_DATA')
  })
})
