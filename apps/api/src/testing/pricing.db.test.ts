import { createHash } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 定价与购物车（P4-11，真实数据库 + worker 的同步、规则评估与写入流程代码）：
// 定价同步（我方报价、预期价格、竞争摘要的写入与去重）、列表与详情、模拟器、护栏与规则的写入（乐观锁、范围）、
// 规则评估（建议、被护栏拦截、每日次数、忽略后不重复）、自动执行的开关降级、改价的校验预览与提交、写入流程回写、跨企业隔离。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const US = 'ATVPDKIKX0DER'
const HOUR = 3_600_000
const NOW = new Date()
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
const ALL = ['pricing.read', 'pricing.price.write', 'pricing.rule.write', 'profit.read', 'field.profit']

describe('定价与购物车（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let otherTenantId: string
  let owner: Member
  let reader: Member
  let writerNoProfit: Member
  let outsider: Member
  let syncPricing: (ctx: unknown, listings: unknown, pricing: unknown, scope: unknown, options?: unknown) => Promise<Json>
  let scan: (db: unknown, tenantId: string, now: Date, queues?: unknown) => Promise<Json>
  let dispatch: { processListingWrite: (...args: unknown[]) => Promise<Json>; markListingRunFailed: (db: unknown, tenantId: string, payload: unknown, code: string) => Promise<void> }
  let workflow: { createListingWriteWorkflow: (deps: unknown) => { steps: Array<{ run: (ctx: unknown) => Promise<Json> }> } }

  const run = <T>(fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const scope = () => ({ tenantId, sellerAccountId: storeId })
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const send = (member: Member, method: string, path: string, body: unknown) => h.call(member.token, method, path, { body })
  const setSwitch = (key: string, enabled: boolean) =>
    h.client.query(`INSERT INTO "IntegrationSwitch" (id, "tenantId", "switchKey", enabled, "updatedAt") VALUES ($1, $2, $3, $4, now()) ON CONFLICT (id) DO UPDATE SET enabled = $4`, [
      `sw-pr-${key}`,
      tenantId,
      key,
      enabled,
    ])

  // 假的亚马逊接口：刊登接口给我方报价，定价接口给预期价格与竞争摘要
  let own: Array<{ sku: string; asin: string; price: number }> = []
  let expected: Record<string, number | null> = {}
  let competitors: Record<string, number[]> = {}
  const listingsApi = {
    search: vi.fn(async () => ({
      items: own.map(item => ({
        sku: item.sku,
        summaries: [{ marketplaceId: US, asin: item.asin }],
        offers: [{ marketplaceId: US, offerType: 'B2C', price: { currencyCode: 'USD', amount: item.price } }],
      })),
    })),
  }
  const pricingApi = {
    featuredExpectedPrices: vi.fn(async (skus: string[]) => ({
      responses: skus.map(sku => ({
        status: { statusCode: 200 },
        body: {
          offerIdentifier: { sku, asin: own.find(item => item.sku === sku)?.asin },
          featuredOfferExpectedPriceResults: [
            { resultStatus: 'VALID_FOEP', ...(expected[sku] ? { featuredOfferExpectedPrice: { listingPrice: { amount: expected[sku], currencyCode: 'USD' } } } : {}) },
          ],
        },
      })),
    })),
    competitiveSummaries: vi.fn(async (asins: string[]) => ({
      responses: asins.map(asin => ({
        status: { statusCode: 200 },
        body: {
          asin,
          featuredBuyingOptions: [{ segmentedFeaturedOffers: [{ sellerId: 'OTHER-SELLER', listingPrice: { amount: 19, currencyCode: 'USD' }, fulfillmentType: 'AFN', condition: 'New' }] }],
          lowestPricedOffers: [
            { offers: (competitors[asin] ?? []).map((amount, index) => ({ sellerId: `S${index}`, listingPrice: { amount, currencyCode: 'USD' }, fulfillmentType: 'AFN', condition: 'New' })) },
          ],
        },
      })),
    })),
  }
  const doSync = (now: Date) => run(() => syncPricing({ prisma: tenantDb, logger }, listingsApi, pricingApi, scope(), { now, ownSellerId: 'SELLER-PR' }))
  const product = (sku: string, asin: string, values: Json = {}) =>
    insertRow(h.client, 'FbaProduct', {
      id: `fp-${sku}`,
      tenantId,
      sellerAccountId: storeId,
      asin,
      sellerSku: sku,
      title: `商品 ${sku}`,
      productType: 'LUGGAGE',
      sourceUpdatedAt: NOW.toISOString(),
      ...values,
    })

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'pricing' })
    const a = await h.createTenant('pr-a')
    const b = await h.createTenant('pr-b')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    otherTenantId = b.tenantId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-PR' WHERE id = $1`, [storeId])
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-pr', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: storeId, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('pricing', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    syncPricing = (await import(/* @vite-ignore */ String('../../../worker/src/importers/pricing/sync'))).syncPricing
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/pricing-rules/run'))).scanTenantPricing
    dispatch = await import(/* @vite-ignore */ String('../../../worker/src/connectors/listing-dispatch'))
    workflow = await import(/* @vite-ignore */ String('../../../worker/src/runtime/listing-write-workflow'))
    owner = await h.createMember(tenantId, 'owner', ALL)
    reader = await h.createMember(tenantId, 'reader', ['pricing.read'])
    writerNoProfit = await h.createMember(tenantId, 'noprofit', ['pricing.read', 'pricing.price.write', 'pricing.rule.write'])
    outsider = await h.createMember(otherTenantId, 'outsider', ALL)
    await product('P-1', 'B0P100000A')
    await product('P-2', 'B0P200000B')
    await product('P-3', 'B0P300000C')
    await product('P-4', 'B0P400000D', { productType: null })
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  describe('定价同步', () => {
    it('首次同步：写我方价格、预期价格、竞争摘要、竞争报价与购物车观察；我方 ID 只存哈希', async () => {
      own = [
        { sku: 'P-1', asin: 'B0P100000A', price: 20 },
        { sku: 'P-2', asin: 'B0P200000B', price: 10 },
        { sku: 'P-3', asin: 'B0P300000C', price: 15 },
        { sku: 'P-4', asin: 'B0P400000D', price: 30 },
      ]
      expected = { 'P-1': 18.5, 'P-2': 5, 'P-3': 15, 'P-4': null }
      competitors = { B0P100000A: [17.5, 22], B0P200000B: [9.5] }
      const result = await doSync(at(-60))
      expect(result).toMatchObject({ notApplicable: false, listings: 4, priceRows: 4, expectedRows: 4, summaryRows: 4, failedItems: 0, incomplete: false })
      expect(await rows(`SELECT 1 FROM "PriceSnapshot" WHERE source = 'LISTING_API'`)).toHaveLength(4)
      expect((await rows(`SELECT "expectedPrice" FROM "FeaturedOfferExpectedPrice" WHERE "sellerSku" = 'P-4'`))[0].expectedPrice).toBeNull()
      expect(await rows(`SELECT 1 FROM "CompetitiveOffer" WHERE "asin" = 'B0P100000A' AND NOT "isOwn"`)).toHaveLength(3)
      expect(JSON.stringify(await rows(`SELECT "offerKey" FROM "CompetitiveOffer"`))).not.toContain('OTHER-SELLER')
      expect(await rows(`SELECT 1 FROM "BuyBoxSnapshot" WHERE source = 'SYNC'`)).toHaveLength(4)
    })

    it('价格没变不再写快照；变化时写新行；超过 24 小时写心跳', async () => {
      const count = async () => (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "PriceSnapshot" WHERE "sellerSku" = 'P-1'`))[0]!.n
      await doSync(at(-59))
      expect(await count()).toBe(1)
      own[0]!.price = 19.5
      await doSync(at(-58))
      expect(await count()).toBe(2)
      await doSync(at(-57))
      expect(await count()).toBe(2)
      const day = await run(() => syncPricing({ prisma: tenantDb, logger }, listingsApi, pricingApi, scope(), { now: at(-30), ownSellerId: 'SELLER-PR' }))
      expect(day.notApplicable).toBe(false)
      expect(await count()).toBe(3)
    })

    it('没有卖家编号：不适用，不调用接口也不写数据', async () => {
      const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "PriceSnapshot"`))[0]!.n
      const result = await run(() => syncPricing({ prisma: tenantDb, logger }, null, pricingApi, scope(), { now: at(1) }))
      expect(result).toEqual({ notApplicable: true, reason: 'SELLER_ID_MISSING', imported: 0 })
      expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "PriceSnapshot"`))[0]!.n).toBe(before)
    })
  })

  describe('列表、详情与模拟器', () => {
    it('列表：价格、预期价格、差距与价格健康；没有预期价格的商品是空值，不是 0', async () => {
      const data = await get(owner, '/pricing?pageSize=50')
      const byStore = (sku: string) => data.items.find((item: Json) => item.sku === sku)
      expect(data.state).toBe('OK')
      expect(data.items).toHaveLength(4)
      expect(byStore('P-2')).toMatchObject({ price: 10, expectedPrice: 5, health: expect.any(String), asin: 'B0P200000B' })
      expect(byStore('P-2').gap).toBeCloseTo(5, 2)
      expect(byStore('P-4')).toMatchObject({ price: 30, expectedPrice: null, gap: null })
      expect(data.summary.total).toBe(4)
      expect(data.write.update).toMatchObject({ allowed: false, step: 'SWITCH' })
      expect(data.freshness).toBeDefined()
    })

    it('列表：排序白名单、健康状态筛选、读者只有读取权限时写入状态显示缺权限', async () => {
      expect((await h.call(owner.token, 'GET', '/pricing?sort=password:asc')).status).toBe(422)
      const filtered = await get(owner, '/pricing?health=ABOVE_EXPECTED')
      expect(filtered.items.every((item: Json) => item.health === 'ABOVE_EXPECTED')).toBe(true)
      const data = await get(reader, '/pricing')
      expect(data.write).toMatchObject({ validate: { allowed: false, step: 'PERMISSION' }, update: { allowed: false }, rule: { allowed: false, step: 'PERMISSION' } })
    })

    it('没有利润字段权限时利润率为 RESTRICTED，而不是 0', async () => {
      const data = await get(writerNoProfit, '/pricing')
      expect(data.items[0].margin.state).toBe('RESTRICTED')
      expect(data.items[0].margin.atCurrent).toBeNull()
    })

    it('详情：价格历史、竞争报价（我方与他人）、事件；店铺必填；别的企业 404', async () => {
      const detail = await get(owner, `/pricing/P-1?storeId=${storeId}`)
      expect(detail.row).toMatchObject({ sku: 'P-1', asin: 'B0P100000A' })
      expect(detail.history.state).toBe('OK')
      expect(detail.history.points.length).toBeGreaterThan(0)
      expect(detail.offers.rows.length).toBeGreaterThan(0)
      expect(detail.offers.rows.every((row: Json) => typeof row.offerKey === 'string' && row.offerKey.length === 16)).toBe(true)
      expect((await h.call(owner.token, 'GET', '/pricing/P-1')).status).toBe(422)
      expect((await h.call(owner.token, 'GET', `/pricing/NO-SUCH?storeId=${storeId}`)).status).toBe(404)
      expect((await h.call(outsider.token, 'GET', `/pricing/P-1?storeId=${storeId}`)).status).toBe(404)
    })

    it('模拟器：没有利润数据时利润不给（状态说明原因）、护栏结论照常；需要利润字段权限', async () => {
      const sim = await send(owner, 'POST', '/pricing/P-1/simulation', { storeId, price: 18 })
      expect(sim.status).toBe(200)
      expect(sim.json.data).toMatchObject({ price: 18, net: null, margin: null, projection: { state: 'UNAVAILABLE', unitsPerDay: null }, guardrail: { ok: true } })
      expect(sim.json.data.state).not.toBe('OK')
      expect((await send(writerNoProfit, 'POST', '/pricing/P-1/simulation', { storeId, price: 18 })).status).toBe(403)
      expect((await send(owner, 'POST', '/pricing/P-1/simulation', { storeId, price: 0 })).status).toBe(422)
    })
  })

  describe('价格护栏', () => {
    it('新建店铺级护栏、SKU 级护栏；已存在必须带版本号，版本过期 409，版本加一', async () => {
      const created = await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'SKU', scopeRef: 'P-2', minPrice: 9.5 })
      expect(created.status, JSON.stringify(created.json)).toBe(200)
      expect(created.json.data).toMatchObject({ scope: 'SKU', scopeRef: 'P-2', minPrice: 9.5, version: 1, enabled: true })
      const again = await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'SKU', scopeRef: 'P-2', minPrice: 9.6 })
      expect(again.status).toBe(409)
      const updated = await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'SKU', scopeRef: 'P-2', minPrice: 9.5, maxChangePct: 0.5, expectedVersion: 1 })
      expect(updated.json.data).toMatchObject({ version: 2, maxChangePct: 0.5 })
      expect((await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'SKU', scopeRef: 'P-2', minPrice: 9.5, expectedVersion: 1 })).status).toBe(409)
      const list = await get(owner, '/pricing/guardrails')
      expect(list.items.map((item: Json) => item.scopeRef)).toContain('P-2')
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'PRICE_GUARDRAIL_SAVED'`)).length).toBeGreaterThanOrEqual(2)
    })

    it('没有写权限 403；别的企业的店铺 403 或 404', async () => {
      expect((await send(reader, 'PUT', '/pricing/guardrails', { storeId, scope: 'STORE', minPrice: 1 })).status).toBe(403)
      expect([403, 404]).toContain((await send(outsider, 'PUT', '/pricing/guardrails', { storeId, scope: 'STORE', minPrice: 1 })).status)
      expect((await get(outsider, '/pricing/guardrails')).items).toEqual([])
    })
  })

  describe('定价规则与评估', () => {
    let ruleId: string
    const queues = { addSync: vi.fn().mockResolvedValue(undefined) }
    const runsOf = async (id = ruleId, query = '') => (await get(owner, `/pricing/rules/${id}/runs${query}`)).items as Json[]

    it('创建手动规则：默认暂停，改为启用后评估；同名冲突 409；自动规则可创建但页面说明开关未开', async () => {
      const body = { storeId, name: '跟随预期价', mode: 'MANUAL', strategy: 'FOLLOW_EXPECTED', params: {}, scope: { all: true }, maxChangePct: 0.1, dailyLimit: 1 }
      const created = await send(owner, 'POST', '/pricing/rules', body)
      expect(created.status, JSON.stringify(created.json)).toBe(201)
      ruleId = created.json.data.id
      expect(created.json.data).toMatchObject({ status: 'PAUSED', mode: 'MANUAL', version: 1, autoReady: false, autoNote: null, pendingSuggestions: 0 })
      expect((await send(owner, 'POST', '/pricing/rules', body)).status).toBe(409)
      const auto = await send(owner, 'POST', '/pricing/rules', { ...body, name: '自动', mode: 'AUTO' })
      expect(auto.json.data).toMatchObject({ mode: 'AUTO', autoReady: false })
      expect(auto.json.data.autoNote).toContain('sw.pricing')
      const enabled = await send(owner, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: 1, status: 'ACTIVE' })
      expect(enabled.json.data).toMatchObject({ status: 'ACTIVE', version: 2 })
      expect((await send(owner, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: 1, name: '过期版本' })).status).toBe(409)
      expect((await send(owner, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: 2, status: 'BREAKER' })).status).toBe(422)
      await h.client.query(`UPDATE "PricingRule" SET status = 'PAUSED' WHERE id <> $1`, [ruleId])
    })

    it('试运行：只读，按逐日与当前结果给出命中数；不生成建议', async () => {
      const dry = await send(owner, 'POST', `/pricing/rules/${ruleId}/dry-run`, { days: 3 })
      expect(dry.status, JSON.stringify(dry.json)).toBe(200)
      expect(dry.json.data).toMatchObject({ ruleId, days: 3 })
      expect(dry.json.data.daily).toHaveLength(3)
      expect(dry.json.data.current.length).toBeGreaterThan(0)
      expect(await rows(`SELECT 1 FROM "PricingRuleRun"`)).toHaveLength(0)
      expect((await send(reader, 'POST', `/pricing/rules/${ruleId}/dry-run`, {})).status).toBe(403)
    })

    it('评估：命中生成待确认建议，被护栏拦截的记为拦截，没有变化的不命中；重复评估不重复建议', async () => {
      const first = await run(() => scan(tenantDb, tenantId, at(1), queues))
      expect(first).toMatchObject({ rules: 1, suggested: 1, blocked: 1, errors: [] })
      const items = await runsOf()
      const byOutcome = (outcome: string) => items.filter(item => item.outcome === outcome)
      expect(byOutcome('SUGGESTED')).toHaveLength(1)
      expect(byOutcome('SUGGESTED')[0]).toMatchObject({ sku: 'P-1', suggestedPrice: 18.5, currentPrice: 19.5 })
      expect(byOutcome('BLOCKED')[0]).toMatchObject({ sku: 'P-2', guardrailResult: 'BLOCKED:BELOW_MIN' })
      const again = await run(() => scan(tenantDb, tenantId, at(2), queues))
      expect(again).toMatchObject({ suggested: 0, blocked: 0 })
      const list = await get(owner, '/pricing/rules')
      expect(list.items.find((item: Json) => item.id === ruleId)).toMatchObject({ pendingSuggestions: 1 })
      expect((await get(owner, `/pricing/P-1?storeId=${storeId}`)).pendingRuns).toHaveLength(1)
    })

    it('忽略建议：状态改为已忽略；之后同一价格不再重复建议；已处理的再忽略 409；没有改价权限 403', async () => {
      const [suggestion] = (await runsOf(ruleId, '?outcome=SUGGESTED')) as Json[]
      expect((await send(reader, 'POST', `/pricing/rule-runs/${suggestion.id}/dismiss`, {})).status).toBe(403)
      const dismissed = await send(owner, 'POST', `/pricing/rule-runs/${suggestion.id}/dismiss`, { reason: '价格先不动' })
      expect(dismissed.status, JSON.stringify(dismissed.json)).toBe(200)
      expect(dismissed.json.data).toMatchObject({ outcome: 'DISMISSED' })
      expect((await send(owner, 'POST', `/pricing/rule-runs/${suggestion.id}/dismiss`, {})).status).toBe(409)
      const after = await run(() => scan(tenantDb, tenantId, at(3), queues))
      expect(after).toMatchObject({ suggested: 0 })
      expect(await rows(`SELECT 1 FROM "PricingRuleRun" WHERE outcome = 'SUGGESTED'`)).toHaveLength(0)
    })

    it('自动规则：开关没开时降级为建议并写明原因；两个开关都开后提交改价记录（来源为规则自动）', async () => {
      const auto = await send(owner, 'POST', '/pricing/rules', {
        storeId,
        name: '自动跟随',
        mode: 'AUTO',
        strategy: 'MATCH_LOWEST',
        params: { offsetAmount: -0.5 },
        scope: { skus: ['P-1'], asins: [] },
        maxChangePct: 0.2,
        dailyLimit: 1,
        status: 'ACTIVE',
      })
      expect(auto.status, JSON.stringify(auto.json)).toBe(201)
      await h.client.query(`UPDATE "PricingRule" SET status = 'PAUSED' WHERE id = $1`, [ruleId])
      const off = await run(() => scan(tenantDb, tenantId, at(4), queues))
      expect(off).toMatchObject({ suggested: 1, queued: 0 })
      const [fallback] = await rows(`SELECT outcome, message, "suggestedPrice" FROM "PricingRuleRun" WHERE "ruleId" = $1`, [auto.json.data.id])
      expect(fallback).toMatchObject({ outcome: 'SUGGESTED' })
      expect(String(fallback.message)).toContain('自动规则未满足执行条件')
      expect(Number(fallback.suggestedPrice)).toBe(17)
      await h.client.query(`DELETE FROM "PricingRuleRun" WHERE "ruleId" = $1`, [auto.json.data.id])
      await setSwitch('sw.pricing.update', true)
      await setSwitch('sw.pricing.rule.auto', true)
      const on = await run(() => scan(tenantDb, tenantId, at(5), queues))
      expect(on).toMatchObject({ queued: 1, suggested: 0, errors: [] })
      const [price] = await rows(`SELECT kind, status, "requestJson", "sellerSku" FROM "ListingWriteRun" WHERE kind = 'PRICE_PATCH' AND "requestJson"->>'source' = 'RULE_AUTO'`)
      expect(price).toMatchObject({ status: 'PENDING', sellerSku: 'P-1' })
      expect(price.requestJson).toMatchObject({ price: 17, previousPrice: 19.5, currency: 'USD' })
      expect(queues.addSync).toHaveBeenCalledWith('LISTING_WRITE', expect.objectContaining({ listingRunId: expect.any(String) }), expect.anything())
      const [link] = await rows(`SELECT outcome, "writeRunId" FROM "PricingRuleRun" WHERE "ruleId" = $1`, [auto.json.data.id])
      expect(link.outcome).toBe('QUEUED')
      expect(link.writeRunId).not.toBeNull()
      const again = await run(() => scan(tenantDb, tenantId, at(6), queues))
      expect(again.queued).toBe(0)
      await h.client.query(`UPDATE "PricingRule" SET status = 'PAUSED' WHERE id = $1`, [auto.json.data.id])
    })

    it('熔断：连续失败达到阈值时规则暂停并写明原因；从熔断恢复需要明确改为启用', async () => {
      const rule = await send(owner, 'POST', '/pricing/rules', {
        storeId,
        name: '易失败',
        mode: 'AUTO',
        strategy: 'FOLLOW_EXPECTED',
        params: {},
        scope: { all: true },
        breaker: { failureStreak: 2, conversionDropPct: 0.3, minMarginPct: null },
        status: 'ACTIVE',
      })
      const id = rule.json.data.id
      for (const [index, sku] of ['P-1', 'P-3'].entries()) {
        await insertRow(h.client, 'PricingRuleRun', {
          id: `fail-${index}`,
          tenantId,
          sellerAccountId: storeId,
          ruleId: id,
          sku,
          asin: '',
          guardrailResult: 'PASS',
          outcome: 'FAILED',
          message: '改价失败',
          runAt: at(6.5 + index * 0.1).toISOString(),
        })
      }
      const result = await run(() => scan(tenantDb, tenantId, at(7), queues))
      expect(result.tripped).toBe(1)
      const [state] = await rows(`SELECT status, "breakerReason" FROM "PricingRule" WHERE id = $1`, [id])
      expect(state.status).toBe('BREAKER')
      expect(state.breakerReason).toContain('连续 2 次')
      const resumed = await send(owner, 'PATCH', `/pricing/rules/${id}`, { expectedVersion: 1, status: 'ACTIVE' })
      expect(resumed.json.data).toMatchObject({ status: 'ACTIVE', breakerReason: null })
      await h.client.query(`UPDATE "PricingRule" SET status = 'PAUSED' WHERE id = $1`, [id])
    })

    it('规则不在数据范围内或属于别的企业：404', async () => {
      expect((await send(outsider, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: 2, name: 'x' })).status).toBe(404)
      expect((await h.call(outsider.token, 'GET', `/pricing/rules/${ruleId}/runs`)).status).toBe(404)
      expect((await get(outsider, '/pricing/rules')).items).toEqual([])
    })
  })

  describe('改价：校验预览与提交', () => {
    let previewId: string
    const validate = (price: number, over: Json = {}) => send(owner, 'POST', '/pricing/P-3/validate', { storeId, price, ...over })
    const update = (price: number, over: Json = {}) => send(owner, 'PATCH', '/pricing/P-3', { storeId, price, previewRunId: previewId, ...over })
    const client = (status = 'VALID') => ({ request: vi.fn(async () => ({ status, submissionId: 'sub-1', issues: [] })) })
    const process = (runId: string, fake: unknown) =>
      run(() => dispatch.processListingWrite({ prisma: tenantDb }, fake, { tenantId, connection: { id: 'conn-pr' } }, storeId, { tenantId, listingRunId: runId }, {}))

    it('校验预览：建 PRICE_VALIDATE 记录并入队，不要写入开关；没有商品类型时要求填写；被护栏拦截 422', async () => {
      await setSwitch('sw.pricing.update', false)
      const res = await validate(14)
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ state: 'QUEUED', run: { kind: 'PRICE_VALIDATE', kindLabel: '价格校验预览', status: 'PENDING', sku: 'P-3' } })
      previewId = res.json.data.run.id
      expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ listingRunId: previewId }), expect.any(String), expect.objectContaining({ type: 'LISTING_WRITE' }))
      const noType = await send(owner, 'POST', '/pricing/P-4/validate', { storeId, price: 28 })
      expect(noType.status).toBe(422)
      expect(JSON.stringify(noType.json)).toContain('商品类型')
      await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'SKU', scopeRef: 'P-3', minPrice: 12, maxChangePct: 0.5 })
      const blocked = await validate(5)
      expect(blocked.status).toBe(422)
      expect(JSON.stringify(blocked.json)).toContain('最低价')
      expect((await send(reader, 'POST', '/pricing/P-3/validate', { storeId, price: 14 })).status).toBe(403)
      expect((await send(outsider, 'POST', '/pricing/P-3/validate', { storeId, price: 14 })).status).toBe(404)
    })

    it('校验结果由后台任务写回：通过后 30 分钟内可用；价格走的是亚马逊的商品报价属性，并使用校验预览模式', async () => {
      const fake = client()
      expect(await process(previewId, fake)).toEqual({ validation: 'VALID', issues: 0 })
      const options = (fake.request.mock.calls[0] as unknown as Json[])[0]
      expect(options).toMatchObject({ method: 'PATCH', query: { mode: 'VALIDATION_PREVIEW' }, body: { productType: 'LUGGAGE' } })
      expect(JSON.stringify(options.body)).toContain('purchasable_offer')
      expect(JSON.stringify(options.body)).toContain('14')
      const [after] = await rows(`SELECT status, validation, "expiresAt", "finishedAt" FROM "ListingWriteRun" WHERE id = $1`, [previewId])
      expect(after).toMatchObject({ status: 'SUCCEEDED', validation: 'VALID' })
    })

    it('提交：开关关闭 409；开关打开后需要预览编号、价格与校验过的完全一致、没有未完成的改价', async () => {
      const closed = await update(14)
      expect(closed.status).toBe(409)
      await setSwitch('sw.pricing.update', true)
      expect((await send(owner, 'PATCH', '/pricing/P-3', { storeId, price: 14, previewRunId: 'no-such' })).status).toBe(409)
      const mismatch = await update(14.5)
      expect(mismatch.status).toBe(409)
      expect(JSON.stringify(mismatch.json)).toContain('PREVIEW_MISMATCH')
      const ok = await update(14)
      expect(ok.status, JSON.stringify(ok.json)).toBe(200)
      expect(ok.json.data).toMatchObject({ state: 'QUEUED', run: { kind: 'PRICE_PATCH', kindLabel: '修改价格', status: 'PENDING', previewRunId: previewId } })
      const runId = ok.json.data.run.id
      const [record] = await rows(`SELECT "requestJson" FROM "ListingWriteRun" WHERE id = $1`, [runId])
      expect(record.requestJson).toMatchObject({ sku: 'P-3', price: 14, previousPrice: 15, source: 'MANUAL', currency: 'USD' })
      expect(h.queue.add).toHaveBeenCalledWith('sync', expect.objectContaining({ listingRunId: runId }), expect.any(String), expect.objectContaining({ type: 'LISTING_WRITE' }))
      const busy = await update(14)
      expect(busy.status).toBe(409)
      expect(JSON.stringify(busy.json)).toContain('LISTING_RUN_STALE')
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'PRICE_CHANGE_SUBMITTED'`)).length).toBeGreaterThanOrEqual(1)
      await h.client.query(`UPDATE "ListingWriteRun" SET status = 'FAILED' WHERE id = $1`, [runId])
    })

    it('预览过期或未通过：409；价格超出护栏：422（先于提交）', async () => {
      await h.client.query(`UPDATE "ListingWriteRun" SET "expiresAt" = now() - interval '1 minute' WHERE id = $1`, [previewId])
      const expired = await update(14)
      expect(expired.status).toBe(409)
      expect(JSON.stringify(expired.json)).toContain('PREVIEW_EXPIRED')
      await h.client.query(`UPDATE "ListingWriteRun" SET "expiresAt" = now() + interval '20 minutes', validation = 'INVALID' WHERE id = $1`, [previewId])
      expect((await update(14)).status).toBe(409)
      await h.client.query(`UPDATE "ListingWriteRun" SET validation = 'VALID' WHERE id = $1`, [previewId])
      await h.client.query(`UPDATE "ListingWriteRun" SET "requestHash" = $2 WHERE id = $1`, [
        previewId,
        createHash('sha256')
          .update(JSON.stringify({ sku: 'P-3', productType: 'LUGGAGE', price: 5, currency: 'USD' }))
          .digest('hex'),
      ])
      const blocked = await update(5)
      expect(blocked.status).toBe(422)
      expect(JSON.stringify(blocked.json)).toContain('GUARDRAIL_BLOCKED')
    })

    it('写入流程：开关关闭不调用亚马逊；回写时记一条“已提交”价格快照并把关联的规则记录标为已执行；重放只做一次', async () => {
      const definition = workflow.createListingWriteWorkflow({ prisma: tenantDb, guardFor: (() => undefined) as never, secrets: {} as never })
      const step = (index: number, runId: string, responses: Json = {}) =>
        run(() => definition.steps[index]!.run({ tenantId, intent: { tenantId, connectionId: 'conn-pr', listingRunId: runId }, request: {}, responseOf: (i: number) => responses[i] ?? {} } as never))
      await insertRow(h.client, 'PricingRule', { id: 'rule-wf', tenantId, sellerAccountId: storeId, name: '流程规则', mode: 'MANUAL', strategy: 'FOLLOW_EXPECTED', createdBy: owner.userId })
      await insertRow(h.client, 'PricingRuleRun', {
        id: 'rr-wf',
        tenantId,
        sellerAccountId: storeId,
        ruleId: 'rule-wf',
        sku: 'P-3',
        asin: 'B0P300000C',
        guardrailResult: 'PASS',
        outcome: 'QUEUED',
        runAt: at(8).toISOString(),
      })
      await insertRow(h.client, 'ListingWriteRun', {
        id: 'wr-price',
        tenantId,
        sellerAccountId: storeId,
        kind: 'PRICE_PATCH',
        sellerSku: 'P-3',
        productType: 'LUGGAGE',
        status: 'RUNNING',
        requestJson: JSON.stringify({ sku: 'P-3', asin: 'B0P300000C', price: 14, currency: 'USD', previousPrice: 15, source: 'RULE_CONFIRMED', ruleRunId: 'rr-wf' }),
      })
      await setSwitch('sw.pricing.update', false)
      await expect(step(0, 'wr-price')).rejects.toMatchObject({ code: 'SWITCH_DISABLED', retryable: false })
      await step(1, 'wr-price', { 0: { issues: [] } })
      expect((await rows(`SELECT status FROM "ListingWriteRun" WHERE id = 'wr-price'`))[0].status).toBe('SUCCEEDED')
      expect(await rows(`SELECT price FROM "PriceSnapshot" WHERE "sellerSku" = 'P-3' AND source = 'WRITE_SUBMITTED'`)).toHaveLength(1)
      expect((await rows(`SELECT outcome, executed FROM "PricingRuleRun" WHERE id = 'rr-wf'`))[0]).toEqual({ outcome: 'APPLIED', executed: true })
      await step(1, 'wr-price', { 0: { issues: [] } })
      expect(await rows(`SELECT 1 FROM "PriceSnapshot" WHERE "sellerSku" = 'P-3' AND source = 'WRITE_SUBMITTED'`)).toHaveLength(1)
      const detail = await get(owner, `/pricing/P-3?storeId=${storeId}`)
      expect(detail.adjustments[0]).toMatchObject({ runId: 'wr-price', source: 'RULE_CONFIRMED', from: 15, to: 14, status: 'SUCCEEDED' })
      expect(detail.events.some((event: Json) => event.kind === 'PRICE_WRITE')).toBe(true)
    })

    it('规则自动改价：自动执行开关关闭时流程在调用亚马逊前结束；永久失败把关联记录标为失败', async () => {
      const definition = workflow.createListingWriteWorkflow({ prisma: tenantDb, guardFor: (() => undefined) as never, secrets: {} as never })
      await insertRow(h.client, 'PricingRuleRun', {
        id: 'rr-auto',
        tenantId,
        sellerAccountId: storeId,
        ruleId: 'rule-wf',
        sku: 'P-1',
        asin: '',
        guardrailResult: 'PASS',
        outcome: 'QUEUED',
        runAt: at(9).toISOString(),
      })
      await insertRow(h.client, 'ListingWriteRun', {
        id: 'wr-auto',
        tenantId,
        sellerAccountId: storeId,
        kind: 'PRICE_PATCH',
        sellerSku: 'P-1',
        productType: 'LUGGAGE',
        status: 'PENDING',
        requestJson: JSON.stringify({ sku: 'P-1', price: 17, currency: 'USD', previousPrice: 20, source: 'RULE_AUTO', ruleRunId: 'rr-auto' }),
      })
      await setSwitch('sw.pricing.update', true)
      await setSwitch('sw.pricing.rule.auto', false)
      await expect(run(() => definition.steps[0]!.run({ tenantId, intent: { tenantId, connectionId: 'conn-pr', listingRunId: 'wr-auto' } } as never))).rejects.toMatchObject({
        code: 'SWITCH_DISABLED',
      })
      await run(() => dispatch.markListingRunFailed(tenantDb, tenantId, { listingRunId: 'wr-auto' }, 'SP_API_400_InvalidInput: secret'))
      expect((await rows(`SELECT status, "failureCode" FROM "ListingWriteRun" WHERE id = 'wr-auto'`))[0]).toEqual({ status: 'FAILED', failureCode: 'SP_API_400' })
      expect((await rows(`SELECT outcome FROM "PricingRuleRun" WHERE id = 'rr-auto'`))[0].outcome).toBe('FAILED')
    })

    it('刊登页的操作记录里看不到改价记录（它们在定价页）', async () => {
      const listingOwner = await h.createMember(tenantId, 'lister', ['listing.read'])
      const runs = await get(listingOwner, '/listings/runs')
      expect(runs.items.every((item: Json) => !String(item.kind).startsWith('PRICE_'))).toBe(true)
    })
  })

  describe('跨企业隔离', () => {
    it('别的企业读不到本企业的价格、规则与护栏，行级安全对应用角色生效', async () => {
      expect((await get(outsider, '/pricing')).items).toEqual([])
      const tables = ['PriceSnapshot', 'FeaturedOfferExpectedPrice', 'CompetitiveSummarySnapshot', 'CompetitiveOffer', 'BuyBoxSnapshot', 'PriceGuardrail', 'PricingRule', 'PricingRuleRun']
      for (const table of tables) {
        const visible = await runWithTenant(otherTenantId, () => (tenantDb as unknown as Record<string, { count: () => Promise<number> }>)[table.charAt(0).toLowerCase() + table.slice(1)]!.count())
        expect(visible, table).toBe(0)
      }
    })
  })
})
