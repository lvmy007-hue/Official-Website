import { Prisma, PrismaClient } from '@prisma/client'
import { catalogFromDatamodel, createTenantScopedClient, runWithTenant } from '@nova/tenancy'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'

// 竞品监控（P4-12，真实数据库 + worker 的同步流程代码）：
// 关注与取消（校验、重复、上限、范围、审计、取消后清快照）、搜索词推荐（点击份额下限、排除我方与已关注）、
// 竞品同步（写入、没变化不写、变化才写、心跳、两个接口各自缺失时沿用旧值、角色缺失）、列表与详情、跨企业隔离。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const HOUR = 3_600_000
const NOW = new Date()
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR)
const TODAY = NOW.toISOString().slice(0, 10)
const WEEK_OLD = '2026-05-04'
const WEEK_NEW = '2026-05-11'
const US = 'ATVPDKIKX0DER'
const OWN1 = 'B0OWN00001'
const OWN2 = 'B0OWN00002'
const C1 = 'B0COMPET01'
const C2 = 'B0COMPET02'
const C3 = 'B0COMPET03'

describe('竞品监控（真实数据库）', () => {
  let h: DbTestApp
  let base: PrismaClient
  let tenantDb: PrismaClient
  let tenantId: string
  let storeId: string
  let store2: string
  let store3: string
  let otherTenantId: string
  let owner: Member
  let reader: Member
  let store2Only: Member
  let outsider: Member
  let syncCompetitors: (ctx: unknown, catalog: unknown, pricing: unknown, scope: unknown, options?: unknown) => Promise<Json>
  let UpstreamHttpError: new (message: string, status: number, headers: Headers | undefined, source: 'api') => Error

  const run = <T>(fn: () => Promise<T>) => runWithTenant(tenantId, fn)
  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const send = (member: Member, method: string, path: string, body?: unknown) => h.call(member.token, method, path, { body })

  // 假的亚马逊接口：商品目录给标题与排名，定价接口给竞争摘要
  let catalogData: Record<string, Json> = {}
  let priceData: Record<string, { featured?: number; lowest?: number }> = {}
  let catalogFails: Error | null = null
  const catalogEntry = (asin: string, title: string, rank: number, images = 3) => ({
    asin,
    summaries: [{ marketplaceId: US, brand: 'Acme', itemName: title }],
    images: [{ marketplaceId: US, images: Array.from({ length: images }, (_, index) => ({ variant: index === 0 ? 'MAIN' : `PT0${index}`, link: `https://x/${asin}/${index}.jpg` })) }],
    salesRanks: [{ marketplaceId: US, classificationRanks: [{ classificationId: 'c1', title: '行李箱', rank }] }],
  })
  const catalogApi = {
    getItems: vi.fn(async (asins: string[]) => {
      if (catalogFails) throw catalogFails
      return { items: asins.filter(asin => catalogData[asin]).map(asin => catalogData[asin]) }
    }),
  }
  const pricingApi = {
    competitiveSummaries: vi.fn(async (asins: string[]) => ({
      responses: asins
        .filter(asin => priceData[asin])
        .map(asin => ({
          status: { statusCode: 200 },
          body: {
            asin,
            ...(priceData[asin]!.featured
              ? {
                  featuredBuyingOptions: [
                    { segmentedFeaturedOffers: [{ sellerId: 'OTHER', listingPrice: { amount: priceData[asin]!.featured, currencyCode: 'USD' }, fulfillmentType: 'AFN', condition: 'New' }] },
                  ],
                }
              : {}),
            ...(priceData[asin]!.lowest
              ? { lowestPricedOffers: [{ offers: [{ sellerId: 'S9', listingPrice: { amount: priceData[asin]!.lowest, currencyCode: 'USD' }, fulfillmentType: 'MFN', condition: 'New' }] }] }
              : {}),
          },
        })),
    })),
  }
  const doSync = (now: Date, storeScope = storeId) => run(() => syncCompetitors({ prisma: tenantDb, logger }, catalogApi, pricingApi, { tenantId, sellerAccountId: storeScope }, { now }))
  const snapshots = (asin: string) => rows(`SELECT * FROM "CompetitorSnapshot" WHERE asin = $1 AND "tenantId" = $2 ORDER BY "observedAt"`, [asin, tenantId])
  const add = (member: Member, body: Json) => send(member, 'POST', '/competitors', body)

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'competitors' })
    const a = await h.createTenant('cp-a')
    const b = await h.createTenant('cp-b')
    tenantId = a.tenantId
    storeId = a.sellerAccountId
    otherTenantId = b.tenantId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-cp-a2', sellerId: 'SELLER-CP-2', tenantId, legalEntityId: a.legalEntityId })).id
    store3 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-cp-a3', sellerId: 'SELLER-CP-3', tenantId, legalEntityId: a.legalEntityId })).id
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    base = new PrismaClient({ datasourceUrl: h.db.urlFor('competitors', 'app') })
    tenantDb = createTenantScopedClient(base, { catalog: catalogFromDatamodel(Prisma.dmmf.datamodel) }) as unknown as PrismaClient
    syncCompetitors = (await import(/* @vite-ignore */ String('../../../worker/src/importers/competitors/sync'))).syncCompetitors
    UpstreamHttpError = (await import(/* @vite-ignore */ String('../../../worker/src/connectors/http-error'))).UpstreamHttpError
    owner = await h.createMember(tenantId, 'owner', ['competitors.read', 'competitors.write'])
    reader = await h.createMember(tenantId, 'reader', ['competitors.read'])
    store2Only = await h.createMember(tenantId, 'store2', ['competitors.read', 'competitors.write'], { scopes: [{ sellerAccountId: store2 }] })
    outsider = await h.createMember(otherTenantId, 'outsider', ['competitors.read', 'competitors.write'])

    // 我方商品、价格、排名
    for (const [sku, asin] of [
      ['P-1', OWN1],
      ['P-2', OWN2],
    ] as const)
      await insertRow(h.client, 'FbaProduct', {
        id: `fp-${sku}`,
        tenantId,
        sellerAccountId: storeId,
        asin,
        sellerSku: sku,
        title: `我方 ${sku}`,
        brand: 'Mine',
        fulfillmentChannel: 'AFN',
        sourceUpdatedAt: NOW.toISOString(),
      })
    await insertRow(h.client, 'PriceSnapshot', { id: 'ps-1', tenantId, sellerAccountId: storeId, sellerSku: 'P-1', asin: OWN1, price: 22, source: 'LISTING_API', observedAt: at(-30).toISOString() })
    await insertRow(h.client, 'PriceSnapshot', { id: 'ps-2', tenantId, sellerAccountId: storeId, sellerSku: 'P-1', asin: OWN1, price: 20, source: 'LISTING_API', observedAt: at(-1).toISOString() })
    await insertRow(h.client, 'SalesRankSnapshot', { id: 'sr-1', tenantId, sellerAccountId: storeId, asin: OWN1, classificationId: 'c1', classificationName: '行李箱', rank: 100, snapshotDate: TODAY })
    // 搜索查询表现（核心词）与热门搜索词（点击前三）
    const sqp = (term: string, volume: number | null, period = WEEK_NEW) =>
      insertRow(h.client, 'BrandSearchQueryPerformance', {
        id: `q-${term}-${period}`,
        tenantId,
        sellerAccountId: storeId,
        reportPeriod: 'WEEK',
        periodStart: period,
        periodEnd: period,
        asin: OWN1,
        searchQuery: term,
        searchVolume: volume,
      })
    await sqp('luggage', 900)
    await sqp('suitcase', 100)
    await sqp('carry on', 50)
    await sqp('no volume', null)
    const hot = (term: string, period: string, slots: Array<[string, number | null]>) =>
      insertRow(h.client, 'BrandSearchTerm', {
        id: `t-${term}-${period}`,
        tenantId,
        sellerAccountId: storeId,
        reportPeriod: 'WEEK',
        periodStart: period,
        periodEnd: period,
        department: '',
        searchTerm: term,
        searchFrequencyRank: 10,
        ...Object.fromEntries(
          slots.flatMap(([asin, share], index) => [
            [`clickedAsin${index + 1}`, asin],
            [`clickedTitle${index + 1}`, `标题 ${asin}`],
            [`clickShare${index + 1}`, share],
            [`conversionShare${index + 1}`, 0.1],
          ]),
        ),
      })
    await hot('luggage', WEEK_NEW, [
      [C1, 0.5],
      [OWN1, 0.3],
      [OWN2, 0.05],
    ])
    await hot('suitcase', WEEK_NEW, [
      [OWN1, 0.4],
      [C2, 0.2],
      [C1, 0.1],
    ])
    await hot('carry on', WEEK_NEW, [[C3, 0.6]])
    await hot('luggage', WEEK_OLD, [[C1, 0.2]])
  })
  afterAll(async () => {
    await base?.$disconnect()
    await h?.close()
  })

  describe('搜索词推荐', () => {
    it('取最近一个两份报告都有的周；按在我方核心词中的点击份额（按搜索量加权的下限）排序；我方商品不是候选', async () => {
      const data = await get(owner, '/competitors/candidates')
      expect(data).toMatchObject({ state: 'OK', period: { kind: 'WEEK', start: WEEK_NEW }, truncated: false })
      // 核心词搜索量合计 1050（没有搜索量的词不参与）：C1 = (0.5×900 + 0.1×100)/1050，C3 = 0.6×50/1050，C2 = 0.2×100/1050
      expect(data.items.map((item: Json) => item.asin)).toEqual([C1, C3, C2])
      expect(data.items[0]).toMatchObject({ ownAsin: OWN1, ownTitle: '我方 P-1', clickShare: 0.438095, clickShareTerms: { hit: 2, total: 3 }, termCount: 2 })
      expect(data.items[0].terms[0]).toMatchObject({ term: 'luggage', slot: 1, clickShare: 0.5, volume: 900 })
      expect(data.items.some((item: Json) => [OWN1, OWN2].includes(item.asin))).toBe(false)
      expect(data.basis).toContain('下限')
    })

    it('没有 competitors.read 403；没有品牌分析数据的店铺范围给“尚无记录”的说明；别的企业看不到', async () => {
      expect((await h.call(null, 'GET', '/competitors/candidates')).status).toBe(401)
      const other = await get(outsider, '/competitors/candidates')
      expect(other).toMatchObject({ state: 'NO_DATA', items: [], period: null })
      const empty = await get(store2Only, '/competitors/candidates')
      expect(empty).toMatchObject({ state: 'NO_DATA', items: [], period: null })
      expect(empty.note).toContain('品牌分析')
    })
  })

  describe('关注与取消', () => {
    it('添加：写入关注、返回等待首次同步的说明，审计留痕；店铺、ASIN 已规整', async () => {
      const res = await add(owner, { storeId, asin: ` ${C1.toLowerCase()} `, ownAsin: OWN1, reason: 'SEARCH_TERM', note: 'luggage' })
      expect([200, 201], JSON.stringify(res.json)).toContain(res.status)
      expect(res.json.data).toMatchObject({ asin: C1, ownAsin: OWN1, storeId, reason: 'SEARCH_TERM' })
      expect(res.json.data.note).toContain('下一次同步')
      expect(await rows(`SELECT 1 FROM "WatchedAsin" WHERE asin = $1 AND "ownAsin" = $2 AND reason = 'SEARCH_TERM' AND note = 'luggage'`, [C1, OWN1])).toHaveLength(1)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'COMPETITOR_WATCH_ADDED' AND "tenantId" = $1`, [tenantId])).length).toBeGreaterThanOrEqual(1)
    })

    it('同一个竞品对不同我方商品是不同的关注；完全重复 409；已关注的不再出现在推荐里', async () => {
      expect([200, 201]).toContain((await add(owner, { storeId, asin: C1, ownAsin: OWN2 })).status)
      expect((await add(owner, { storeId, asin: C1, ownAsin: OWN1 })).status).toBe(409)
      const data = await get(owner, '/competitors/candidates')
      expect(data.items.map((item: Json) => item.asin)).toEqual([C3, C2])
    })

    it('不能把我方商品当竞品；我方对应 ASIN 必须在店铺目录里；店铺必须在可见范围', async () => {
      const own = await add(owner, { storeId, asin: OWN2 })
      expect(own.status).toBe(409)
      expect(own.json.error.message).toContain('自己的商品')
      expect((await add(owner, { storeId, asin: C2, ownAsin: 'B0NOTOWN01' })).status).toBe(409)
      expect((await add(store2Only, { storeId, asin: C2 })).status).toBe(403)
      expect([403, 404]).toContain((await add(outsider, { storeId, asin: C2 })).status)
      expect((await add(reader, { storeId, asin: C2 })).status).toBe(403)
    })

    it('每个店铺最多关注 200 条；其他店铺不受影响', async () => {
      await h.client.query(
        `INSERT INTO "WatchedAsin" (id, "tenantId", "sellerAccountId", asin, reason) SELECT 'bulk-' || i, $1, $2, 'X' || lpad(i::text, 9, '0'), 'MANUAL' FROM generate_series(1, 200) AS i`,
        [tenantId, store3],
      )
      const full = await add(owner, { storeId: store3, asin: C2 })
      expect(full.status).toBe(409)
      expect(full.json.error.message).toContain('200')
      expect([200, 201]).toContain((await add(owner, { storeId: store2, asin: C2 })).status)
      await h.client.query(`DELETE FROM "WatchedAsin" WHERE "sellerAccountId" = $1`, [store3])
    })
  })

  describe('竞品同步', () => {
    it('没有关注时不适用；有关注时写入价格、推荐报价、配送方式与目录属性（来源只有官方接口）', async () => {
      expect(await doSync(at(-48), store3)).toMatchObject({ notApplicable: true, reason: 'NO_WATCHED' })
      expect(catalogApi.getItems).not.toHaveBeenCalled()
      catalogData = { [C1]: catalogEntry(C1, 'Acme 24 inch', 80, 4) }
      priceData = { [C1]: { featured: 24.5, lowest: 24.5 } }
      const result = await doSync(at(-48))
      expect(result).toMatchObject({ notApplicable: false, watched: 1, processed: 1, stored: 1, catalogMissing: 0, summaryMissing: 0, incomplete: false })
      const [row] = await snapshots(C1)
      expect(row).toMatchObject({ title: 'Acme 24 inch', brand: 'Acme', imageCount: 4, featuredStatus: 'HAS_FEATURED', fulfillment: 'FBA', rank: 80, rankClassificationId: 'c1', currency: 'USD' })
      expect(Number(row.price)).toBe(24.5)
    })

    it('重复同步同样的数据：没变化且不到 24 小时不写；价格变化才写；满 24 小时写心跳', async () => {
      expect((await doSync(at(-47))).stored).toBe(0)
      priceData = { [C1]: { featured: 23, lowest: 23 } }
      expect((await doSync(at(-46))).stored).toBe(1)
      expect((await doSync(at(-45))).stored).toBe(0)
      expect((await doSync(at(-21))).stored).toBe(1) // 距上一条已超过 24 小时
      expect(await snapshots(C1)).toHaveLength(3)
    })

    it('两个接口各自缺失：沿用上一条的值，不用空值覆盖；只有目录或只有定价也能写', async () => {
      priceData = {}
      catalogData = { [C1]: catalogEntry(C1, 'Acme 24 inch NEW', 70, 4) }
      const result = await doSync(at(-10))
      expect(result).toMatchObject({ stored: 1, summaryMissing: 1 })
      const latest = (await snapshots(C1)).at(-1)
      expect(latest).toMatchObject({ title: 'Acme 24 inch NEW', rank: 70, featuredStatus: 'HAS_FEATURED' })
      expect(Number(latest.price)).toBe(23)
    })

    it('两个接口都没有这个竞品且没有历史：不写（不当 0）', async () => {
      await h.client.query(`INSERT INTO "WatchedAsin" (id, "tenantId", "sellerAccountId", asin, reason) VALUES ('w-ghost', $1, $2, 'B0GHOST001', 'MANUAL')`, [tenantId, storeId])
      priceData = {}
      catalogData = {}
      const result = await doSync(at(-9))
      expect(result).toMatchObject({ catalogMissing: 2, summaryMissing: 2 })
      expect(await snapshots('B0GHOST001')).toHaveLength(0)
    })

    it('缺少商品目录或定价角色（403）：以不可重试的 ROLE_MISSING 结束；其他错误向上抛出等重试', async () => {
      catalogFails = new UpstreamHttpError('forbidden', 403, undefined, 'api')
      await expect(doSync(at(-8))).rejects.toMatchObject({ code: 'ROLE_MISSING', retryable: false })
      catalogFails = new UpstreamHttpError('boom', 500, undefined, 'api')
      await expect(doSync(at(-8))).rejects.toThrow('boom')
      catalogFails = null
    })

    it('准备数据：把第二个竞品与幽灵 ASIN 换成可同步的竞品，写入多条快照用于列表与详情', async () => {
      await h.client.query(`DELETE FROM "WatchedAsin" WHERE id = 'w-ghost'`)
      await h.client.query(`INSERT INTO "WatchedAsin" (id, "tenantId", "sellerAccountId", asin, "ownAsin", reason) VALUES ('w-c3', $1, $2, $3, '', 'MANUAL')`, [tenantId, storeId, C3])
      catalogData = { [C1]: catalogEntry(C1, 'Acme 24 inch NEW', 70, 4), [C3]: catalogEntry(C3, 'Other brand', 50, 2) }
      priceData = { [C1]: { featured: 23 }, [C3]: { lowest: 18 } }
      expect((await doSync(at(-2))).stored).toBe(1) // C1 没变化，只有 C3 是第一条
      expect(await snapshots(C3)).toHaveLength(1)
    })
  })

  describe('列表', () => {
    it('每条关注一行：价格差与名次差按我方最近价格与同分类排名算；没有对应商品的行没有差值；排序没值的排最后', async () => {
      const data = await get(owner, '/competitors?sort=priceGap:asc&pageSize=50')
      expect(data.summary).toEqual({ watched: 4, withSnapshot: 3, waiting: 1 }) // 第四条是第二个店铺里还没同步的关注
      const byKey = Object.fromEntries(data.items.map((item: Json) => [`${item.asin}|${item.ownAsin}`, item]))
      expect(byKey[`${C1}|${OWN1}`]).toMatchObject({
        price: 23,
        ownPrice: 20,
        priceGap: 3,
        priceGapPct: 0.15,
        rank: 70,
        ownRank: 100,
        rankGap: -30,
        rankNote: null,
        featured: 'HAS_FEATURED',
        fulfillment: 'FBA',
      })
      expect(byKey[`${C1}|${OWN1}`].clickShare).toBe(0.438095)
      expect(byKey[`${C1}|${OWN2}`]).toMatchObject({ ownPrice: null, priceGap: null, rankGap: null, clickShare: null })
      expect(byKey[`${C3}|null`]).toMatchObject({ price: 18, priceGap: null, rankGap: null, ownAsin: null, rankNote: '没有指定我方对应商品' })
      expect(data.items[0].priceGap).toBe(3)
      expect(data.items.slice(1).every((item: Json) => item.priceGap === null)).toBe(true)
      expect(data.freshness).toBeDefined()
    })

    it('筛选、关键字、翻页：游标绑定查询条件，换条件后旧游标无效', async () => {
      expect((await get(owner, '/competitors?reason=SEARCH_TERM')).items).toHaveLength(1)
      expect((await get(owner, '/competitors?q=other%20brand')).items.map((item: Json) => item.asin)).toEqual([C3])
      const first = await get(owner, '/competitors?pageSize=2&sort=asin:asc')
      expect(first.items).toHaveLength(2)
      expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 4 })
      const second = await get(owner, `/competitors?pageSize=2&sort=asin:asc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(second.items).toHaveLength(2)
      expect(second.pageInfo.hasMore).toBe(false)
      expect((await h.call(owner.token, 'GET', `/competitors?pageSize=2&sort=asin:desc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    })

    it('数据范围：只能看到自己可见店铺里的关注；别的企业什么都看不到；新关注在首次同步前显示“尚无记录”', async () => {
      const scoped = await get(store2Only, '/competitors')
      expect(scoped.items.map((item: Json) => item.storeId)).toEqual([store2])
      expect(scoped.items[0]).toMatchObject({ asin: C2, price: null, observedAt: null })
      expect(scoped.summary).toEqual({ watched: 1, withSnapshot: 0, waiting: 1 })
      expect(await get(outsider, '/competitors')).toMatchObject({ state: 'NO_DATA', items: [], summary: { watched: 0 } })
    })
  })

  describe('详情', () => {
    it('最新属性、价格与名次趋势（我方价格与同分类排名并入）、目录变化、核心词点击份额趋势、并排对照、评分无官方来源', async () => {
      const data = await get(owner, `/competitors/${C1}?storeId=${storeId}&ownAsin=${OWN1}`)
      expect(data).toMatchObject({ asin: C1, ownAsin: OWN1, ownTitle: '我方 P-1', latest: { title: 'Acme 24 inch NEW', price: 23, rank: 70 } })
      expect(data.watches).toHaveLength(2)
      expect(data.trend.state).toBe('OK')
      expect(data.trend.points.some((point: Json) => point.ownPrice === 20 && point.price === 23)).toBe(true)
      expect(data.trend.points.at(-1)).toMatchObject({ price: 23, rank: 70, ownPrice: 20, ownRank: 100 })
      expect(data.changes.items).toEqual([expect.objectContaining({ field: 'title', before: 'Acme 24 inch', after: 'Acme 24 inch NEW' })])
      expect(data.shareTrend).toMatchObject({ state: 'OK', coreTerms: 3 })
      expect(data.shareTrend.points).toEqual([
        { periodStart: WEEK_OLD, share: 0.171429, hit: 1, total: 3 },
        { periodStart: WEEK_NEW, share: 0.438095, hit: 2, total: 3 },
      ])
      const row = (key: string) => data.compare.rows.find((item: Json) => item.key === key)
      expect(row('price')).toMatchObject({ own: '20.00 USD', competitor: '23.00 USD' })
      expect(row('fulfillment')).toMatchObject({ own: 'FBA', competitor: 'FBA' })
      expect(data.rating).toMatchObject({ state: 'NO_OFFICIAL_SOURCE' })
      expect(data.rating.note).toContain('不抓取亚马逊前台页面')
      expect(data.otherOffers).toMatchObject({ state: 'NO_DATA', items: [] })
    })

    it('没有指定我方对应商品：对照、份额、其他报价都是“不适用”；快照尚未同步给“尚无记录”', async () => {
      const none = await get(owner, `/competitors/${C3}?storeId=${storeId}`)
      expect(none).toMatchObject({ ownAsin: null, compare: { state: 'NOT_APPLICABLE' }, shareTrend: { state: 'NOT_APPLICABLE' }, otherOffers: { state: 'NOT_APPLICABLE' } })
      const waiting = await get(store2Only, `/competitors/${C2}?storeId=${store2}`)
      expect(waiting).toMatchObject({ latest: null, trend: { state: 'NO_DATA', points: [] }, changes: { state: 'NO_DATA' } })
    })

    it('没关注、不在可见店铺、别的企业、ASIN 不合法、对应商品不在关注里：都是 404；没有权限 403', async () => {
      for (const path of [
        `/competitors/B0UNKNOWN1?storeId=${storeId}`,
        `/competitors/${C1}?storeId=${store2}`,
        `/competitors/bad?storeId=${storeId}`,
        `/competitors/${C1}?storeId=${storeId}&ownAsin=B0OWN99999`,
      ])
        expect((await send(owner, 'GET', path)).status, path).toBe(404)
      expect((await send(store2Only, 'GET', `/competitors/${C1}?storeId=${storeId}`)).status).toBe(404)
      expect((await send(outsider, 'GET', `/competitors/${C1}?storeId=${storeId}`)).status).toBe(404)
      const noPermission = await h.createMember(tenantId, 'nopermission', ['products.read'])
      expect((await send(noPermission, 'GET', `/competitors/${C1}?storeId=${storeId}`)).status).toBe(403)
    })
  })

  describe('取消关注', () => {
    it('取消一条：只删这一条，还有别的关注时保留快照；取消最后一条时一并删除这个竞品的快照；审计留痕', async () => {
      expect((await send(owner, 'DELETE', `/competitors/${C1}?storeId=${storeId}&ownAsin=${OWN2}`)).status).toBe(200)
      expect(await rows(`SELECT 1 FROM "WatchedAsin" WHERE asin = $1 AND "tenantId" = $2`, [C1, tenantId])).toHaveLength(1)
      expect((await snapshots(C1)).length).toBeGreaterThan(0)
      expect((await send(owner, 'DELETE', `/competitors/${C1}?storeId=${storeId}&ownAsin=${OWN1}`)).status).toBe(200)
      expect(await rows(`SELECT 1 FROM "WatchedAsin" WHERE asin = $1 AND "tenantId" = $2`, [C1, tenantId])).toHaveLength(0)
      expect(await snapshots(C1)).toHaveLength(0)
      expect((await snapshots(C3)).length).toBe(1)
      expect((await rows(`SELECT 1 FROM "AuditEvent" WHERE action = 'COMPETITOR_WATCH_REMOVED' AND "tenantId" = $1`, [tenantId])).length).toBeGreaterThanOrEqual(1)
    })

    it('不存在 404；没有写权限或不在范围内 403；别的企业不能取消', async () => {
      expect((await send(owner, 'DELETE', `/competitors/${C1}?storeId=${storeId}`)).status).toBe(404)
      expect((await send(reader, 'DELETE', `/competitors/${C3}?storeId=${storeId}`)).status).toBe(403)
      expect((await send(store2Only, 'DELETE', `/competitors/${C3}?storeId=${storeId}`)).status).toBe(403)
      expect([403, 404]).toContain((await send(outsider, 'DELETE', `/competitors/${C3}?storeId=${storeId}`)).status)
      expect(await rows(`SELECT 1 FROM "WatchedAsin" WHERE asin = $1 AND "tenantId" = $2`, [C3, tenantId])).toHaveLength(1)
    })
  })

  describe('跨企业隔离', () => {
    it('别的企业的接口连接看不到本企业的关注与快照（行级安全）', async () => {
      const own = await runWithTenant(tenantId, () => tenantDb.watchedAsin.count())
      const foreign = await runWithTenant(otherTenantId, () => tenantDb.watchedAsin.count())
      const snaps = await runWithTenant(otherTenantId, () => tenantDb.competitorSnapshot.count())
      expect(own).toBeGreaterThan(0)
      expect(foreign).toBe(0)
      expect(snaps).toBe(0)
    })
  })
})
