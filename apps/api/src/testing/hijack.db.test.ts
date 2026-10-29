import { createHash } from 'node:crypto'
import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 跟卖监控、促销叠加与定价情形矩阵（P6-17，真实数据库 + worker 的同步、预警评估与规则评估代码）：
// 跟卖：其他报价方出现、不重复写、消失、重新出现（首次出现时间重置）、我方报价不记成跟卖、卖家只存哈希；白名单增删与列表筛选、重复 409、权限、跨企业隔离；预警评估器随出现/消失/白名单自动成立与恢复；
// 促销叠加：重叠、首尾相接不算、1 毫秒重叠算、折扣深度逐层叠乘、阈值边界、已结束不计、跨企业隔离、快捷筛选；
// 情形矩阵：护栏之内的格子建议改价、护栏之外的格子记为被拦截并写明原因、不调价的格子不生成记录、矩阵校验与取消。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const US = 'ATVPDKIKX0DER'
const HOUR = 3_600_000
const DAY = 24 * HOUR
const NOW = new Date()
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
const keyOf = (sellerId: string) => createHash('sha256').update(sellerId).digest('hex').slice(0, 16)

interface Offer {
  id: string
  amount: number
  fba?: boolean
  featured?: boolean
}

describe('跟卖监控、促销叠加与定价情形矩阵（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let otherTenantId: string
  let otherStoreId: string
  let owner: Member
  let reader: Member
  let noTools: Member
  let outsider: Member
  let syncPricing: (ctx: unknown, listings: unknown, pricing: unknown, scope: unknown, options?: unknown) => Promise<Json>
  let scan: (db: unknown, tenantId: string, now: Date, queues?: unknown) => Promise<Json>
  let hijackEvaluator: { evaluate: (input: unknown) => Promise<Json[]> }
  let stackingEvaluator: { evaluate: (input: unknown) => Promise<Json[]> }

  const run = <T>(fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const scope = () => ({ tenantId, sellerAccountId: storeId })
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const send = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, { body })

  // 假的亚马逊接口：刊登接口给我方报价，定价接口给竞争摘要（卖家与报价可控）
  let own: Array<{ sku: string; asin: string; price: number }> = []
  let offersOf: Record<string, Offer[]> = {}
  const listingsApi = {
    search: vi.fn(async () => ({
      items: own.map(item => ({
        sku: item.sku,
        summaries: [{ marketplaceId: US, asin: item.asin }],
        offers: [{ marketplaceId: US, offerType: 'B2C', price: { currencyCode: 'USD', amount: item.price } }],
      })),
    })),
  }
  const offerBody = (offer: Offer) => ({ sellerId: offer.id, listingPrice: { amount: offer.amount, currencyCode: 'USD' }, fulfillmentType: offer.fba === false ? 'MFN' : 'AFN', condition: 'New' })
  const pricingApi = {
    featuredExpectedPrices: vi.fn(async (skus: string[]) => ({
      responses: skus.map(sku => ({
        status: { statusCode: 200 },
        body: { offerIdentifier: { sku, asin: own.find(item => item.sku === sku)?.asin }, featuredOfferExpectedPriceResults: [{ resultStatus: 'VALID_FOEP' }] },
      })),
    })),
    competitiveSummaries: vi.fn(async (asins: string[]) => ({
      responses: asins.map(asin => ({
        status: { statusCode: 200 },
        body: {
          asin,
          featuredBuyingOptions: [{ segmentedFeaturedOffers: (offersOf[asin] ?? []).filter(offer => offer.featured).map(offerBody) }],
          lowestPricedOffers: [{ offers: (offersOf[asin] ?? []).filter(offer => !offer.featured).map(offerBody) }],
        },
      })),
    })),
  }
  const doSync = (now: Date) => run(() => syncPricing({ prisma: tenantDb, logger }, listingsApi, pricingApi, scope(), { now, ownSellerId: 'SELLER-HJ' }))
  const product = (sku: string, asin: string) =>
    insertRow(h.client, 'FbaProduct', { id: `fp-${sku}`, tenantId, sellerAccountId: storeId, asin, sellerSku: sku, title: `商品 ${sku}`, productType: 'LUGGAGE', sourceUpdatedAt: NOW.toISOString() })
  // 裸 SQL 读 timestamp 列会按本机时区解释（东八区差 8 小时），时间点断言一律取库里的 UTC 毫秒数
  const epochMs = async (column: string, id: string) => Number((await rows(`SELECT (extract(epoch from "${column}") * 1000)::bigint AS v FROM "OfferCompetitor" WHERE id = $1`, [id]))[0]!.v)
  const competitorRows = (sku: string) => rows(`SELECT * FROM "OfferCompetitor" WHERE "sellerAccountId" = $1 AND sku = $2 ORDER BY "sellerId"`, [storeId, sku])

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'hijack' })
    const a = await h.createTenant('hj-a')
    const b = await h.createTenant('hj-b')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    otherTenantId = b.tenantId
    otherStoreId = b.sellerAccountId
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await h.client.query(`UPDATE "SellerAccount" SET "sellerId" = 'SELLER-HJ' WHERE id = $1`, [storeId])
    await insertRow(h.client, 'PlatformConnection', { id: 'conn-hj', tenantId, provider: 'AMAZON_SP_API', sellerAccountId: storeId, state: 'AUTHORIZED', encryptedRefreshToken: 'cipher' })
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('hijack', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    syncPricing = (await import(/* @vite-ignore */ String('../../../worker/src/importers/pricing/sync'))).syncPricing
    scan = (await import(/* @vite-ignore */ String('../../../worker/src/pricing-rules/run'))).scanTenantPricing
    hijackEvaluator = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/hijack-evaluator'))).hijackOfferEvaluator
    stackingEvaluator = (await import(/* @vite-ignore */ String('../../../worker/src/alerts/promo-stacking-evaluator'))).promoStackingEvaluator
    const all = ['tools.read', 'tools.manage', 'analytics.read', 'pricing.read', 'pricing.price.write', 'pricing.rule.write']
    owner = await h.createMember(tenantId, 'owner', all)
    reader = await h.createMember(tenantId, 'reader', ['tools.read', 'analytics.read'])
    noTools = await h.createMember(tenantId, 'notools', ['analytics.read'])
    outsider = await h.createMember(otherTenantId, 'outsider', all)
    for (const [sku, asin] of [
      ['H-1', 'B0H100000A'],
      ['H-2', 'B0H200000B'],
      ['H-3', 'B0H300000C'],
      ['M-1', 'B0M100000A'],
      ['M-2', 'B0M200000B'],
    ] as const)
      await product(sku, asin)
    own = [
      { sku: 'H-1', asin: 'B0H100000A', price: 20 },
      { sku: 'H-2', asin: 'B0H200000B', price: 10 },
      { sku: 'H-3', asin: 'B0H300000C', price: 20 },
      { sku: 'M-1', asin: 'B0M100000A', price: 12 },
      { sku: 'M-2', asin: 'B0M200000B', price: 12 },
    ]
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  describe('跟卖观察的同步：出现、消失、重新出现', () => {
    it('首次出现：只记其他卖家，我方报价不记；卖家编号只存哈希；FBA 与购物车标记来自摘要', async () => {
      offersOf = {
        B0H100000A: [
          { id: 'FEATSELLR1', amount: 19, fba: true, featured: true },
          { id: 'OFFERSELLR1', amount: 17.5, fba: false },
          { id: 'SELLER-HJ', amount: 20, fba: true },
        ],
        B0H200000B: [{ id: 'OFFERSELLR2', amount: 9.5, fba: true }],
        B0H300000C: [],
        B0M100000A: [{ id: 'MATRIXSEL1', amount: 11, fba: true }],
        B0M200000B: [{ id: 'MATRIXSEL2', amount: 7, fba: true }],
      }
      const result = await doSync(at(-100))
      expect(result).toMatchObject({ notApplicable: false, listings: 5, failedItems: 0, incomplete: false })
      expect(result.competitorRows).toBe(5)
      const h1 = await competitorRows('H-1')
      expect(h1.map(row => row.sellerId).sort()).toEqual([keyOf('FEATSELLR1'), keyOf('OFFERSELLR1')].sort())
      expect(JSON.stringify(h1)).not.toContain('FEATSELLR1')
      expect(JSON.stringify(h1)).not.toContain('SELLER-HJ')
      const feat = h1.find(row => row.sellerId === keyOf('FEATSELLR1'))
      expect(feat).toMatchObject({ isFba: true, hasBuybox: true, goneAt: null, asin: 'B0H100000A' })
      expect(Number(feat.price)).toBe(19)
      expect(h1.find(row => row.sellerId === keyOf('OFFERSELLR1'))).toMatchObject({ isFba: false, hasBuybox: false })
      expect(await competitorRows('H-3')).toHaveLength(0)
    })

    it('再次同步：没有变化不重复写、首次出现时间不变；价格变化只刷新价格', async () => {
      const before = await competitorRows('H-1')
      const same = await doSync(at(-98))
      expect(same.competitorRows).toBe(0)
      const after = await competitorRows('H-1')
      expect(after.map(row => row.id).sort()).toEqual(before.map(row => row.id).sort())
      expect(after.map(row => new Date(row.firstSeenAt).getTime()).sort()).toEqual(before.map(row => new Date(row.firstSeenAt).getTime()).sort())
      offersOf.B0H100000A![1] = { id: 'OFFERSELLR1', amount: 16, fba: false }
      const changed = await doSync(at(-97))
      expect(changed.competitorRows).toBe(1)
      const row = (await competitorRows('H-1')).find(item => item.sellerId === keyOf('OFFERSELLR1'))
      expect(Number(row.price)).toBe(16)
      expect(new Date(row.firstSeenAt).getTime()).toBe(new Date(before.find(item => item.sellerId === keyOf('OFFERSELLR1')).firstSeenAt).getTime())
    })

    it('消失：摘要里没有了就标记消失时间；默认列表不再显示，“已消失”里能看到', async () => {
      const first = offersOf.B0H100000A!
      offersOf.B0H100000A = first.filter(offer => offer.id !== 'OFFERSELLR1')
      const result = await doSync(at(-96))
      expect(result.competitorRows).toBe(1)
      const gone = (await competitorRows('H-1')).find(row => row.sellerId === keyOf('OFFERSELLR1'))
      expect(await epochMs('goneAt', gone.id)).toBe(at(-96).getTime())
      const active = await get(owner, '/tools/hijack?sort=firstSeenAt:asc')
      expect(active.items.map((item: Json) => item.sellerKey)).not.toContain(keyOf('OFFERSELLR1'))
      expect(active.summary).toMatchObject({ active: 4, gone: 1 })
      const goneList = await get(owner, '/tools/hijack?status=gone')
      expect(goneList.items).toHaveLength(1)
      expect(goneList.items[0]).toMatchObject({ sku: 'H-1', status: 'gone', sellerRef: `卖家 ${keyOf('OFFERSELLR1').slice(0, 6)}` })
      expect((await get(owner, '/tools/hijack?status=all')).items).toHaveLength(5)
    })

    it('重新出现：算新的一次出现，首次出现时间重置、消失标记清空', async () => {
      offersOf.B0H100000A = [...offersOf.B0H100000A!, { id: 'OFFERSELLR1', amount: 15, fba: false }]
      await doSync(at(-90))
      const row = (await competitorRows('H-1')).find(item => item.sellerId === keyOf('OFFERSELLR1'))
      expect(row.goneAt).toBeNull()
      expect(await epochMs('firstSeenAt', row.id)).toBe(at(-90).getTime())
      expect(Number(row.price)).toBe(15)
    })

    it('没有我方卖家编号时不写跟卖观察（分不出我方与对方）', async () => {
      const before = (await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "OfferCompetitor"`))[0]!.n
      const result = await run(() => syncPricing({ prisma: tenantDb, logger }, listingsApi, pricingApi, scope(), { now: at(-80) }))
      expect(result.notApplicable).toBe(false)
      expect(result.competitorRows).toBe(0)
      expect((await rows<{ n: number }>(`SELECT count(*)::int AS n FROM "OfferCompetitor"`))[0]!.n).toBe(before)
    })
  })

  describe('跟卖列表与白名单接口', () => {
    it('列表：延迟说明写明最长延迟；筛选、排序、分页与权限', async () => {
      const data = await get(owner, '/tools/hijack')
      expect(data.state).toBe('OK')
      expect(data.maxDelayHours).toBe(2)
      expect(data.delayNote).toContain('最长延迟 2 小时')
      expect(data.delayNote).toContain('不抓前台页面')
      expect(data.items.map((item: Json) => item.sku).sort()).toEqual(['H-1', 'H-1', 'H-2', 'M-1', 'M-2'])
      expect(data.canManage).toBe(true)
      const byPrice = await get(owner, '/tools/hijack?sort=price:asc&pageSize=2')
      expect(byPrice.items.map((item: Json) => item.price)).toEqual([7, 9.5])
      expect(byPrice.pageInfo.hasMore).toBe(true)
      const next = await get(owner, `/tools/hijack?sort=price:asc&pageSize=2&cursor=${encodeURIComponent(byPrice.pageInfo.nextCursor)}`)
      expect(next.items.map((item: Json) => item.price)).toEqual([11, 15])
      // 游标绑定查询条件：换条件再用旧游标被拒
      expect((await h.call(owner.token, 'GET', `/tools/hijack?sort=price:desc&pageSize=2&cursor=${encodeURIComponent(byPrice.pageInfo.nextCursor)}`)).status).toBe(400)
      expect((await get(owner, '/tools/hijack?q=h-2')).items).toHaveLength(1)
      expect((await h.call(owner.token, 'GET', '/tools/hijack?sort=password:asc')).status).toBe(422)
      expect((await get(reader, '/tools/hijack')).canManage).toBe(false)
      expect((await h.call(noTools.token, 'GET', '/tools/hijack')).status).toBe(403)
      expect((await get(outsider, '/tools/hijack')).items).toEqual([])
    })

    it('白名单：新增只存哈希与提示；重复 409；格式不对 422；没有管理权限 403；审计留痕', async () => {
      expect((await send(reader, 'POST', '/tools/hijack/whitelist', { sellerId: 'OFFERSELLR2' })).status).toBe(403)
      expect((await send(owner, 'POST', '/tools/hijack/whitelist', { sellerId: 'bad id' })).status).toBe(422)
      const added = await send(owner, 'POST', '/tools/hijack/whitelist', { sellerId: ' offersellr2 ', note: '自己的欧洲店' })
      expect(added.status, JSON.stringify(added.json)).toBe(201)
      expect(added.json.data).toMatchObject({ sellerKey: keyOf('OFFERSELLR2'), sellerHint: 'OF…R2', note: '自己的欧洲店', activeSkus: 0 })
      expect(JSON.stringify(await rows(`SELECT * FROM "HijackWhitelist"`))).not.toContain('OFFERSELLR2')
      expect((await send(owner, 'POST', '/tools/hijack/whitelist', { sellerId: 'OFFERSELLR2' })).status).toBe(409)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'HIJACK_WHITELIST_ADDED'`)).length).toBeGreaterThanOrEqual(1)
      const list = await get(reader, '/tools/hijack/whitelist')
      expect(list).toMatchObject({ total: 1, page: 1, canManage: false })
      expect(list.items[0]).toMatchObject({ sellerHint: 'OF…R2', activeSkus: 1 })
      expect((await get(outsider, '/tools/hijack/whitelist')).total).toBe(0)
    })

    it('白名单筛选：默认不含白名单，“只看白名单”“全部”按预期；汇总里白名单单独计数', async () => {
      const exclude = await get(owner, '/tools/hijack')
      expect(exclude.items.some((item: Json) => item.sellerKey === keyOf('OFFERSELLR2'))).toBe(false)
      expect(exclude.summary).toMatchObject({ active: 5, whitelisted: 1, activeNotWhitelisted: 4 })
      const only = await get(owner, '/tools/hijack?whitelist=only')
      expect(only.items).toHaveLength(1)
      expect(only.items[0]).toMatchObject({ whitelisted: true, sellerKey: keyOf('OFFERSELLR2') })
      expect((await get(owner, '/tools/hijack?whitelist=all')).items).toHaveLength(exclude.items.length + 1)
    })

    it('预警评估：新出现的其他报价方命中，白名单里的不算，消失后自动恢复', async () => {
      const rule = { condition: { params: { lookbackDays: 7, minOffers: 1 } }, scope: {} }
      const hits = await run(() => hijackEvaluator.evaluate({ db: tenantDb, tenantId, rule, now: at(0) }))
      const labels = hits.map(hit => hit.entityLabel).sort()
      expect(labels.some(label => label.startsWith('H-1'))).toBe(true)
      expect(labels.some(label => label.startsWith('H-2'))).toBe(false)
      const h1 = hits.find(hit => hit.entityLabel.startsWith('H-1'))
      expect(h1.title).toContain('2 个其他报价方')
      expect(JSON.stringify(h1.evidence)).not.toContain('FEATSELLR1')
      expect(h1.evidence.note).toContain('不抓前台页面')
      // 数量下限提高到 3：H-1 只有 2 个，不再命中
      expect(await run(() => hijackEvaluator.evaluate({ db: tenantDb, tenantId, rule: { ...rule, condition: { params: { lookbackDays: 7, minOffers: 3 } } }, now: at(0) }))).toEqual([])
      // 回看天数缩到 1 天：首次出现在 90 小时前，不再算“新出现”
      expect(await run(() => hijackEvaluator.evaluate({ db: tenantDb, tenantId, rule: { ...rule, condition: { params: { lookbackDays: 1, minOffers: 1 } } }, now: at(0) }))).toEqual([])
      // 报价方消失后自动恢复
      offersOf.B0H100000A = []
      await doSync(at(-1))
      const after = await run(() => hijackEvaluator.evaluate({ db: tenantDb, tenantId, rule, now: at(0) }))
      expect(after.some(hit => hit.entityLabel.startsWith('H-1'))).toBe(false)
      offersOf.B0H100000A = [{ id: 'FEATSELLR1', amount: 19, fba: true, featured: true }]
      await doSync(at(-0.5))
    })

    it('删除白名单：该卖家若仍在报价重新进入列表；不存在或别的企业 404；没有权限 403', async () => {
      const [entry] = (await get(owner, '/tools/hijack/whitelist')).items
      expect((await send(reader, 'DELETE', `/tools/hijack/whitelist/${entry.id}`)).status).toBe(403)
      expect((await send(outsider, 'DELETE', `/tools/hijack/whitelist/${entry.id}`)).status).toBe(404)
      expect((await send(owner, 'DELETE', '/tools/hijack/whitelist/nope')).status).toBe(404)
      const removed = await send(owner, 'DELETE', `/tools/hijack/whitelist/${entry.id}`)
      expect(removed.status, JSON.stringify(removed.json)).toBe(200)
      expect((await get(owner, '/tools/hijack')).items.some((item: Json) => item.sellerKey === keyOf('OFFERSELLR2'))).toBe(true)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'HIJACK_WHITELIST_REMOVED'`)).length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('促销叠加', () => {
    const iso = (days: number, extraMs = 0) => new Date(NOW.getTime() + days * DAY + extraMs).toISOString()
    const promotion = (id: string, status: string, start: string, end: string | null, extra: Json = {}, store = storeId, tenant = tenantId) =>
      insertRow(h.client, 'Promotion', {
        id: `pm-${id}`,
        tenantId: tenant,
        sellerAccountId: store,
        promotionId: `PM-${id}`,
        promotionType: 'PRICE_DISCOUNT',
        title: `促销 ${id}`,
        status,
        startAt: start,
        endAt: end,
        amazonUpdatedAt: iso(-1),
        ...extra,
      })
    const item = (promo: string, asin: string, values: Json = {}, store = storeId, tenant = tenantId) =>
      insertRow(h.client, 'PromotionItem', {
        id: `pi-${promo}-${asin}`,
        tenantId: tenant,
        sellerAccountId: store,
        promotionRowId: `pm-${promo}`,
        asin,
        sku: `sku-${asin}`,
        benefitType: 'PERCENT_OFF',
        discountType: 'PERCENTAGE_OFF',
        ...values,
      })

    beforeAll(async () => {
      await promotion('P1', 'RUNNING', iso(-1), iso(10))
      await promotion('P2', 'UPCOMING', iso(5), iso(15))
      await promotion('P3', 'UPCOMING', iso(10), iso(20)) // 开始时刻恰好等于 P1 的结束时刻
      await promotion('P4', 'UPCOMING', iso(10, -1), iso(20)) // 比 P1 早 1 毫秒开始
      await promotion('P5', 'ENDED', iso(-10), iso(-2))
      await promotion('P6', 'RUNNING', iso(-1), null, { selectionType: 'CATALOG' })
      await promotion('PX', 'RUNNING', iso(-1), iso(10), {}, otherStoreId, otherTenantId)
      // B0H100000A：P1 20% + P2 30% 重叠 5 天，叠加 44%
      await item('P1', 'B0H100000A', { percentOff: 20 })
      await item('P2', 'B0H100000A', { percentOff: 30 })
      // B0H200000B：只有 P1，立减 4 美元（价格 10 → 40%）
      await item('P1', 'B0H200000B', { benefitType: 'AMOUNT_OFF', discountType: 'AMOUNT_OFF', amountOff: 4 })
      // B0H300000C：P1 与 P3 首尾相接，不叠加
      await item('P1', 'B0H300000C', { percentOff: 10 })
      await item('P3', 'B0H300000C', { percentOff: 10 })
      // B0M100000A：P1 与 P4 重叠 1 毫秒，叠加
      await item('P1', 'B0M100000A', { percentOff: 10 })
      await item('P4', 'B0M100000A', { percentOff: 10 })
      // B0M200000B：已结束的 P5 不计
      await item('P1', 'B0M200000B', { percentOff: 5 })
      await item('P5', 'B0M200000B', { percentOff: 50 })
      await item('PX', 'B0X000000X', { percentOff: 90 }, otherStoreId, otherTenantId)
    })

    it('叠加列表：重叠与深度逐层叠乘；首尾相接不算、1 毫秒重叠算；已结束与整个目录的促销不计', async () => {
      const data = await get(owner, '/promotions/stacking')
      expect(data.state).toBe('OK')
      const row = (asin: string) => data.items.find((item: Json) => item.asin === asin)
      expect(row('B0H100000A')).toMatchObject({ peakCount: 2, promotionCount: 2, stacked: true, deep: true })
      expect(row('B0H100000A').depth).toBeCloseTo(1 - 0.8 * 0.7, 6)
      expect(row('B0H200000B')).toMatchObject({ peakCount: 1, stacked: false })
      expect(row('B0H200000B').depth).toBeCloseTo(0.4, 6)
      expect(row('B0H300000C')).toMatchObject({ peakCount: 1, promotionCount: 2, stacked: false })
      expect(row('B0M100000A')).toMatchObject({ peakCount: 2, stacked: true })
      expect(row('B0M200000B')).toMatchObject({ peakCount: 1 })
      expect(row('B0X000000X')).toBeUndefined()
      expect(data.items[0].asin).toBe('B0H100000A')
      expect(data.summary).toMatchObject({ asins: 5, stacked: 2, minStack: 2, minDepthPct: 0.3 })
      expect(data.catalogNote).toContain('整个目录')
      expect(data.basis).toContain('不算叠加')
    })

    it('快捷筛选与阈值边界：叠加数下限、深度下限（恰好等于算命中）；游标与权限', async () => {
      expect((await get(owner, '/promotions/stacking?flag=stacked')).items.map((item: Json) => item.asin).sort()).toEqual(['B0H100000A', 'B0M100000A'])
      expect((await get(owner, '/promotions/stacking?flag=stacked&minStack=3')).items).toEqual([])
      const deep = await get(owner, '/promotions/stacking?flag=deep')
      expect(deep.items.map((item: Json) => item.asin).sort()).toEqual(['B0H100000A', 'B0H200000B'])
      // 深度恰好 0.4 与下限 0.4 相等：算命中；稍高的下限不命中
      expect((await get(owner, '/promotions/stacking?flag=deep&minDepth=0.4')).items.map((item: Json) => item.asin).sort()).toEqual(['B0H100000A', 'B0H200000B'])
      expect((await get(owner, '/promotions/stacking?flag=deep&minDepth=0.45')).items).toEqual([])
      expect((await get(owner, '/promotions/stacking?flag=any')).summary.any).toBe(3)
      const page = await get(owner, '/promotions/stacking?pageSize=2')
      expect(page.items).toHaveLength(2)
      expect(page.pageInfo.hasMore).toBe(true)
      const second = await get(owner, `/promotions/stacking?pageSize=2&cursor=${encodeURIComponent(page.pageInfo.nextCursor)}`)
      expect(second.items.every((item: Json) => !page.items.some((seen: Json) => seen.id === item.id))).toBe(true)
      expect((await h.call(noTools.token, 'GET', '/promotions/stacking')).status).toBe(200)
      expect((await h.call(owner.token, 'GET', '/promotions/stacking?flag=bad')).status).toBe(422)
      expect((await get(outsider, '/promotions/stacking')).items.map((item: Json) => item.asin)).toEqual(['B0X000000X'])
    })

    it('叠加预警评估器：与列表同一份计算；阈值调高后不命中', async () => {
      const rule = { condition: { params: { minStack: 2, minDepthPct: 0.3 } }, scope: {} }
      const hits = await run(() => stackingEvaluator.evaluate({ db: tenantDb, tenantId, rule, now: NOW }))
      expect(hits.map(hit => hit.entityLabel.split('（')[0]).sort()).toEqual(['B0H100000A', 'B0H200000B', 'B0M100000A'])
      const strict = { condition: { params: { minStack: 3, minDepthPct: 0.5 } }, scope: {} }
      expect(await run(() => stackingEvaluator.evaluate({ db: tenantDb, tenantId, rule: strict, now: NOW }))).toEqual([])
    })
  })

  describe('定价情形矩阵', () => {
    let ruleId: string
    const queues = { addSync: vi.fn().mockResolvedValue(undefined) }
    const matrix = { cells: { OTHER_BETWEEN: { action: 'FOLLOW_OTHER', offset: -0.5 }, OTHER_BELOW_MIN: { action: 'FOLLOW_OTHER', offset: -1 } }, basePrice: null }
    const runsOf = async () => (await get(owner, `/pricing/rules/${ruleId}/runs`)).items as Json[]

    it('矩阵校验：全是不调价、加减额超范围都拒绝；创建后规则视图带矩阵与文字说明', async () => {
      const body = { storeId, name: '情形矩阵', mode: 'MANUAL', strategy: 'FOLLOW_EXPECTED', params: {}, scope: { all: false, skus: ['M-1', 'M-2'], asins: [] }, maxChangePct: 0.5, dailyLimit: 1 }
      expect((await send(owner, 'POST', '/pricing/rules', { ...body, scenarioMatrix: { cells: { OTHER_BETWEEN: { action: 'NONE' } } } })).status).toBe(422)
      expect((await send(owner, 'POST', '/pricing/rules', { ...body, scenarioMatrix: { cells: { OTHER_BETWEEN: { action: 'FOLLOW_OTHER', offset: 99 } } } })).status).toBe(422)
      const created = await send(owner, 'POST', '/pricing/rules', { ...body, scenarioMatrix: matrix, status: 'ACTIVE' })
      expect(created.status, JSON.stringify(created.json)).toBe(201)
      ruleId = created.json.data.id
      expect(created.json.data.scenarioMatrix.cells.OTHER_BETWEEN).toMatchObject({ action: 'FOLLOW_OTHER', offset: -0.5 })
      expect(created.json.data.scenarioText).toContain('对方介于我的最低价和最高价之间')
      expect((await send(owner, 'PUT', '/pricing/guardrails', { storeId, scope: 'STORE', minPrice: 8, maxPrice: 18 })).status).toBeLessThan(300)
    })

    it('评估：护栏之内的格子生成建议；护栏之外的格子记为被拦截并写明原因；不调价的格子不留记录', async () => {
      const result = await run(() => scan(tenantDb, tenantId, at(1), queues))
      expect(result).toMatchObject({ errors: [] })
      const items = await runsOf()
      const m1 = items.find(item => item.sku === 'M-1')
      const m2 = items.find(item => item.sku === 'M-2')
      // M-1：对方 11，介于最低价 8 与最高价 18 之间，跟随对方减 0.5 → 10.5
      expect(m1).toMatchObject({ outcome: 'SUGGESTED', suggestedPrice: 10.5, currentPrice: 12 })
      expect(m1.guardrailResult).not.toContain('BLOCKED')
      // M-2：对方 7，低于我的最低价 8，跟随对方减 1 → 6，低于最低价：不执行
      expect(m2).toMatchObject({ outcome: 'BLOCKED', guardrailResult: 'BLOCKED:BELOW_MIN', suggestedPrice: 6 })
      expect(m2.reason ?? m2.note ?? JSON.stringify(m2)).toContain('最低价')
      // 范围外的商品没有记录；同一价格重复评估不重复建议
      expect(items.filter(item => !['M-1', 'M-2'].includes(item.sku))).toEqual([])
      const again = await run(() => scan(tenantDb, tenantId, at(2), queues))
      expect(again).toMatchObject({ suggested: 0, blocked: 0 })
      const list = await get(owner, '/pricing/rules')
      expect(list.items.find((rule: Json) => rule.id === ruleId)).toMatchObject({ pendingSuggestions: 1 })
    })

    it('这一格选“不调价”：该商品没有记录；取消矩阵后改回按策略求价', async () => {
      const current = (await get(owner, '/pricing/rules')).items.find((rule: Json) => rule.id === ruleId)
      const changed = await send(owner, 'PATCH', `/pricing/rules/${ruleId}`, {
        expectedVersion: current.version,
        scenarioMatrix: { cells: { OTHER_BETWEEN: { action: 'NONE' }, OTHER_BELOW_MIN: { action: 'TO_MIN' } } },
      })
      expect(changed.status, JSON.stringify(changed.json)).toBe(200)
      expect(changed.json.data.scenarioText).toContain('对方低于我的最低价时')
      const cleared = await send(owner, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: changed.json.data.version, scenarioMatrix: null })
      expect(cleared.status).toBe(200)
      expect(cleared.json.data).toMatchObject({ scenarioMatrix: null, scenarioText: null })
      expect((await send(reader, 'PATCH', `/pricing/rules/${ruleId}`, { expectedVersion: cleared.json.data.version, scenarioMatrix: matrix })).status).toBe(403)
    })
  })
})
