import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { insertRow } from './db-fixtures'
import { createDbTestApp, type DbTestApp } from './db-harness'
import { DAY } from './reviews-fixtures'

// 评价与反馈（P4-13，真实数据库）：评分文件导入（整份拒绝、覆盖、权限与范围、审计）、评分概况（对比、排序、筛选、翻页）、
// 评论主题（类目对比与趋势、选中商品、尚未接入与不适用）、退货主题与改进清单（权限收窄）、数据范围与跨企业隔离。
// 请求评价（可请求订单、批量请求、覆盖率与增长）见 reviews-solicit.db.test.ts。

type Member = { userId: string; token: string }
type Json = ReturnType<typeof JSON.parse>

const NOW = new Date()
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString()
const day = (days: number) => ago(days).slice(0, 10)
const A1 = 'B0AAAAAAA1'
const A2 = 'B0AAAAAAA2'
const A3 = 'B0AAAAAAA3'
const MONTHS = ['2026-03-01', '2026-04-01', '2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01']
const HEAD = 'ASIN,采集日期,平均星级,评分数,1星,2星,3星,4星,5星'

describe('评价与反馈（真实数据库）：评分、主题、退货主题', () => {
  let h: DbTestApp
  let tenantId: string
  let store1: string
  let store2: string
  let otherStore: string
  let owner: Member
  let reader: Member
  let store2Only: Member
  let outsider: Member

  const rows = async <T = Json>(sql: string, params: unknown[] = []) => (await h.client.query(sql, params)).rows as T[]
  const get = async (member: Member, path: string, expected = 200) => {
    const res = await h.call(member.token, 'GET', path)
    expect(res.status, JSON.stringify(res.json)).toBe(expected)
    return res.json?.data as Json
  }
  const importFile = (member: Member, storeId: string, fileName: string, content: string) => h.call(member.token, 'POST', '/reviews/ratings-import', { body: { storeId, fileName, content } })
  const audits = (action: string, result: string) => rows(`SELECT * FROM "AuditEvent" WHERE "tenantId" = $1 AND action = $2 AND result = $3`, [tenantId, action, result])

  beforeAll(async () => {
    h = await createDbTestApp({ database: 'reviews' })
    const a = await h.createTenant('rv-a')
    const b = await h.createTenant('rv-b')
    tenantId = a.tenantId
    store1 = a.sellerAccountId
    otherStore = b.sellerAccountId
    store2 = (await insertRow(h.client, 'SellerAccount', { id: 'seller-rv-a2', sellerId: 'SELLER-RV-2', tenantId, legalEntityId: a.legalEntityId })).id
    await h.client.query(`UPDATE "Tenant" SET "timezone" = 'UTC'`)
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE id = $1`, [store1, '店铺甲'])
    await h.client.query(`UPDATE "SellerAccount" SET "displayName" = $2 WHERE id = $1`, [store2, '店铺乙'])
    owner = await h.createMember(tenantId, 'rv-owner', ['reviews.read', 'reviews.solicit', 'data.import', 'returns.read'])
    reader = await h.createMember(tenantId, 'rv-reader', ['reviews.read'])
    store2Only = await h.createMember(tenantId, 'rv-store2', ['reviews.read', 'data.import'], { scopes: [{ sellerAccountId: store2 }] })
    outsider = await h.createMember(b.tenantId, 'rv-outsider', ['reviews.read', 'data.import', 'returns.read'])
    const product = (id: string, store: string, asin: string, title: string) =>
      insertRow(h.client, 'FbaProduct', { id, tenantId, sellerAccountId: store, asin, sellerSku: `SKU-${id}`, title, sourceUpdatedAt: NOW.toISOString() })
    await product('fp-1', store1, A1, '拉杆箱 A1')
    await product('fp-2', store1, A2, '背包 A2')
    await product('fp-3', store1, A3, '腰包 A3')
    await product('fp-4', store2, A1, '拉杆箱 A1 乙')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  }, 240_000)

  afterAll(async () => {
    vi.useRealTimers()
    await h?.close()
  })

  describe('评分文件导入', () => {
    it('没有 data.import、店铺不在范围内、别的企业的店铺：都不写入（403 / 403 / 404），被拒绝的也写 DENIED 审计', async () => {
      const content = `${HEAD}\n${A1},${day(10)},4.4,100,,,,,\n`
      expect((await importFile(reader, store1, 'a.csv', content)).status).toBe(403)
      const scoped = await importFile(store2Only, store1, 'a.csv', content)
      expect(scoped.status).toBe(403)
      expect(scoped.json.error.code).toBe('SCOPE_STORE_FORBIDDEN')
      expect((await importFile(owner, otherStore, 'a.csv', content)).status).toBe(404)
      expect(await rows(`SELECT 1 FROM "ReviewMetricSnapshot"`)).toHaveLength(0)
      expect((await audits('REVIEW_RATINGS_IMPORTED', 'DENIED')).length).toBeGreaterThanOrEqual(2)
    })

    it('一行有错整份拒绝（422）：星级超范围、日期晚于今天、ASIN 不合法、同日重复，逐行列出，什么都不写', async () => {
      const bad = `${HEAD}\n${A1},${day(10)},4.4,100,,,,,\n${A2},${day(10)},6,40,,,,,\nBAD,${day(10)},4,1,,,,,\n${A3},${day(-3)},4,1,,,,,\n${A1},${day(10)},4.1,90,,,,,\n`
      const res = await importFile(owner, store1, 'bad.csv', bad)
      expect(res.status).toBe(422)
      const lines: string[] = res.json.error.fieldErrors.content
      expect(lines).toEqual(
        expect.arrayContaining([
          expect.stringContaining('第 3 行（平均星级）'),
          expect.stringContaining('第 4 行（ASIN）'),
          expect.stringContaining('第 5 行（采集日期）'),
          expect.stringContaining('与第 2 行重复'),
        ]),
      )
      expect(await rows(`SELECT 1 FROM "ReviewMetricSnapshot"`)).toHaveLength(0)
    })

    it('导入成功（201）：来源标注为文件导入，带批次、文件名、导入人；星级分布可空；审计只记行数与文件名，不记文件内容', async () => {
      const content = `${HEAD}\n${A1},${day(10)},4.4,100,2,3,5,30,60\n${A2},${day(10)},3.8,40,,,,,\n${A3},${day(10)},,25,,,,,\n`
      const res = await importFile(owner, store1, 'ratings-1.csv', content)
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ imported: 3, replaced: 0, fileName: 'ratings-1.csv', errors: [] })
      const saved = await rows(`SELECT * FROM "ReviewMetricSnapshot" WHERE "tenantId" = $1 ORDER BY asin`, [tenantId])
      expect(saved).toHaveLength(3)
      expect(saved[0]).toMatchObject({ asin: A1, sourceKind: 'FILE_IMPORT', sourceFileName: 'ratings-1.csv', sourceFileId: res.json.data.batchId, importedBy: owner.userId, ratingCount: 100 })
      expect(Number(saved[0].avgRating)).toBe(4.4)
      expect(saved[0].distributionJson).toEqual({ '1': 2, '2': 3, '3': 5, '4': 30, '5': 60 })
      expect(saved[2]).toMatchObject({ asin: A3, avgRating: null, ratingCount: 25, distributionJson: null })
      const [audit] = await audits('REVIEW_RATINGS_IMPORTED', 'SUCCEEDED')
      expect(audit).toMatchObject({ resourceType: 'ReviewMetricSnapshot', actorId: owner.userId })
      expect(audit.afterJson).toMatchObject({ storeId: store1, fileName: 'ratings-1.csv', rows: 3, replaced: 0 })
      expect(JSON.stringify(audit)).not.toContain(A1)
    })

    it('同一店铺、ASIN、采集日期再导入是覆盖（replaced 计数），其余行新增；覆盖后分布与来源文件一起更新', async () => {
      const content = `${HEAD}\n${A1},${day(10)},4.5,105,,,,,\n${A1},${day(1)},4.2,130,,,,,\n${A2},${day(1)},3.9,45,,,,,\n`
      const res = await importFile(owner, store1, 'ratings-2.csv', content)
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect(res.json.data).toMatchObject({ imported: 3, replaced: 1 })
      const overwritten = (await rows(`SELECT * FROM "ReviewMetricSnapshot" WHERE asin = $1 AND "captureDate" = $2::date`, [A1, day(10)]))[0]
      expect(overwritten).toMatchObject({ ratingCount: 105, sourceFileName: 'ratings-2.csv', distributionJson: null })
      expect(await rows(`SELECT 1 FROM "ReviewMetricSnapshot" WHERE "tenantId" = $1`, [tenantId])).toHaveLength(5)
    })
  })

  describe('评分概况', () => {
    it('每个店铺 × ASIN 一行最新评分：与上一次采集对比、最近采集点、来源与导入人；没有评分的商品不凭空造行', async () => {
      const data = await get(owner, '/reviews')
      expect(data.state).toBe('OK')
      expect(data.items.map((item: Json) => item.asin)).toEqual([A1, A2, A3])
      expect(data.items[0]).toMatchObject({ storeName: '店铺甲', title: '拉杆箱 A1', avgRating: 4.2, ratingCount: 130, captureDate: day(1), ratingDelta: -0.3, countDelta: 25, previousDate: day(10) })
      expect(data.items[0]).toMatchObject({ sourceLabel: '文件导入', sourceFileName: 'ratings-2.csv', distribution: null })
      const [user] = await rows(`SELECT "displayName", email FROM "User" WHERE id = $1`, [owner.userId])
      expect(data.items[0].importedBy).toBe(user.displayName || user.email)
      expect(data.items[0].trend.map((point: Json) => [point.date, point.ratingCount])).toEqual([
        [day(10), 105],
        [day(1), 130],
      ])
      expect(data.items[2]).toMatchObject({ asin: A3, avgRating: null, ratingCount: 25, ratingDelta: null, countDelta: null, previousDate: null })
      expect(data.items[2].trend).toHaveLength(1)
      expect(data.summary).toEqual({ catalogAsins: 4, withRating: 3, latestCapture: day(1), lowestRating: 3.9, below4: 1 })
      expect(data.truncated).toBe(false)
    })

    it('排序（空值永远在最后）、星级上限、按 ASIN 或标题搜索、游标翻页与条件绑定', async () => {
      const order = async (sort: string) => (await get(owner, `/reviews?sort=${sort}`)).items.map((item: Json) => item.asin)
      expect(await order('avgRating:asc')).toEqual([A2, A1, A3])
      expect(await order('avgRating:desc')).toEqual([A1, A2, A3])
      expect(await order('delta:asc')).toEqual([A1, A2, A3])
      expect(await order('ratingCount:desc')).toEqual([A1, A2, A3])
      expect((await get(owner, '/reviews?ratingBelow=4')).items.map((item: Json) => item.asin)).toEqual([A2])
      expect((await get(owner, `/reviews?q=${encodeURIComponent('拉杆箱')}`)).items.map((item: Json) => item.asin)).toEqual([A1])
      expect((await get(owner, '/reviews?q=a3')).items.map((item: Json) => item.asin)).toEqual([A3])
      const first = await get(owner, '/reviews?pageSize=2')
      expect(first.items).toHaveLength(2)
      expect(first.pageInfo).toMatchObject({ hasMore: true, approxTotal: 3 })
      const second = await get(owner, `/reviews?pageSize=2&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)
      expect(second.items.map((item: Json) => item.asin)).toEqual([A3])
      expect((await h.call(owner.token, 'GET', `/reviews?pageSize=2&sort=asin:desc&cursor=${encodeURIComponent(first.pageInfo.nextCursor)}`)).status).toBe(400)
    })

    it('数据范围与企业隔离：只看一个店铺的成员只看到这个店铺（也不能点名别的店铺）；别的企业看不到；没有评分记录是 NO_DATA', async () => {
      const scoped = await get(store2Only, '/reviews')
      expect(scoped).toMatchObject({ state: 'NO_DATA', note: '尚无记录，请先导入评分文件', items: [], stores: [{ id: store2, name: '店铺乙' }] })
      expect(scoped.summary).toMatchObject({ catalogAsins: 1, withRating: 0, latestCapture: null, lowestRating: null, below4: null })
      expect((await h.call(store2Only.token, 'GET', `/reviews?storeId=${store1}`)).status).toBe(403)
      const other = await get(outsider, '/reviews')
      expect(other).toMatchObject({ state: 'NO_DATA', items: [], stores: [{ id: otherStore }] })
      expect(other.summary.catalogAsins).toBe(0)
      // 范围内的成员导入自己店铺的评分后，管理者按店铺筛选可以分开看
      const res = await importFile(store2Only, store2, 'b.csv', `${HEAD}\n${A1},${day(2)},4,60,,,,,\n`)
      expect(res.status, JSON.stringify(res.json)).toBe(201)
      expect((await get(owner, '/reviews')).items).toHaveLength(4)
      expect((await get(owner, `/reviews?storeId=${store2}`)).items.map((item: Json) => [item.storeName, item.avgRating])).toEqual([['店铺乙', 4]])
      expect((await get(reader, '/reviews')).items).toHaveLength(4)
    })
  })

  describe('评论主题', () => {
    const topic = (id: string, store: string, asin: string, key: string, sentiment: string, rank: number, snapshot: string) =>
      insertRow(h.client, 'ReviewTopic', {
        id,
        tenantId,
        sellerAccountId: store,
        asin,
        browseNodeId: '1001',
        browseNodeName: '行李箱类目',
        topicKey: key,
        sentiment,
        rank,
        mentionRange: '100-500',
        reviewCountBucket: '50-100',
        snapshotDate: snapshot,
      })
    const trend = (table: string, topicColumn: string, key: string, sentiment: string | null, scope: string, rateOf: (index: number) => number) =>
      Promise.all(
        MONTHS.map((month, index) =>
          insertRow(h.client, table, {
            id: `${table}-${key}-${scope}-${month}`,
            tenantId,
            sellerAccountId: store1,
            browseNodeId: '1001',
            browseNodeName: '行李箱类目',
            scope,
            month,
            [topicColumn]: key,
            ...(sentiment ? { sentiment } : {}),
            rate: rateOf(index),
          }),
        ),
      )

    it('没有同步过是“尚未接入”并写明前提；店铺的新鲜度失败码是 FBK_NO_BRAND_ACCESS 时是“不适用”', async () => {
      const none = await get(owner, '/reviews?tab=topics')
      expect(none).toMatchObject({ tab: 'topics', state: 'NOT_CONNECTED', options: [], selected: null })
      expect(none.note).toContain('品牌分析')
      await insertRow(h.client, 'DataFreshness', {
        id: 'df-rv-2',
        tenantId,
        sellerAccountId: store2,
        sourceKey: 'feedback.api',
        lastAttemptAt: ago(1),
        status: 'UNAUTHORIZED',
        lastErrorCode: 'FBK_NO_BRAND_ACCESS',
      })
      expect((await get(store2Only, '/reviews?tab=topics')).state).toBe('NOT_APPLICABLE')
      expect((await get(owner, '/reviews?tab=topics')).state).toBe('NOT_CONNECTED')
    })

    it('默认选最近一次快照的商品：前 10 正面与负面主题按名次、与类目最近一个月对比、近 6 个月趋势只含该商品出现过的主题', async () => {
      await topic('t-1', store1, A1, 'sturdy', 'POSITIVE', 1, day(3))
      await topic('t-2', store1, A1, 'lightweight', 'POSITIVE', 2, day(3))
      await topic('t-3', store1, A1, 'zipper breaks', 'NEGATIVE', 1, day(3))
      await topic('t-4', store1, A1, 'bad smell', 'NEGATIVE', 2, day(3))
      await topic('t-5', store1, A1, 'old topic', 'NEGATIVE', 1, day(10))
      await topic('t-6', store1, A2, 'Defective zipper', 'NEGATIVE', 1, day(10))
      await trend('BrowseNodeReviewTrend', 'topicKey', 'sturdy', 'POSITIVE', 'ALL', index => 0.3 + index * 0.01)
      await trend('BrowseNodeReviewTrend', 'topicKey', 'sturdy', 'POSITIVE', 'TOP25', index => 0.4 + index * 0.01)
      await trend('BrowseNodeReviewTrend', 'topicKey', 'zipper breaks', 'NEGATIVE', 'ALL', () => 0.08)
      const data = await get(owner, '/reviews?tab=topics')
      expect(data.state).toBe('OK')
      expect(data.options.map((item: Json) => [item.asin, item.snapshotDate])).toEqual([
        [A1, day(3)],
        [A2, day(10)],
      ])
      expect(data.selected).toMatchObject({ storeName: '店铺甲', asin: A1, title: '拉杆箱 A1', snapshotDate: day(3), browseNodeId: '1001', browseNodeName: '行李箱类目', categoryNote: null })
      expect(data.selected.positive.map((item: Json) => item.topic)).toEqual(['sturdy', 'lightweight'])
      expect(data.selected.positive[0]).toMatchObject({ rank: 1, mentionRange: '100-500', reviewCountBucket: '50-100', categoryAll: 0.37, categoryTop: 0.47 })
      expect(data.selected.positive[1]).toMatchObject({ categoryAll: null, categoryTop: null })
      expect(data.selected.negative.map((item: Json) => item.topic)).toEqual(['zipper breaks', 'bad smell'])
      expect(data.selected.negative[0]).toMatchObject({ categoryAll: 0.08, categoryTop: null })
      expect(data.selected.trendMonths).toEqual(MONTHS.slice(2))
      expect(data.selected.trend.map((item: Json) => [item.topic, item.scope, item.points.length])).toEqual([
        ['sturdy', 'ALL', 6],
        ['sturdy', 'TOP25', 6],
        ['zipper breaks', 'ALL', 6],
      ])
      expect(data.selected.trend[0].points[5]).toEqual({ month: '2026-10-01', rate: 0.37 })
      expect(data.freshness).toBeTruthy()
    })

    it('按店铺与 ASIN 选中其他商品；没有类目趋势的写明原因；不存在的商品是 NO_DATA；范围外 403；别的企业什么都没有', async () => {
      const other = await get(owner, `/reviews?tab=topics&storeId=${store1}&asin=${A2.toLowerCase()}`)
      expect(other.selected).toMatchObject({ asin: A2, snapshotDate: day(10), trend: [] })
      expect(other.selected.negative.map((item: Json) => item.topic)).toEqual(['Defective zipper'])
      expect(other.selected.categoryNote).toContain('类目的主题趋势')
      const missing = await get(owner, `/reviews?tab=topics&storeId=${store1}&asin=B0NOTHING1`)
      expect(missing).toMatchObject({ state: 'NO_DATA', selected: null })
      expect(missing.options).toHaveLength(2)
      expect((await h.call(store2Only.token, 'GET', `/reviews?tab=topics&storeId=${store1}&asin=${A1}`)).status).toBe(403)
      expect((await get(outsider, '/reviews?tab=topics')).state).toBe('NOT_CONNECTED')
    })
  })

  describe('退货主题与改进清单', () => {
    const returns = (id: string, store: string, asin: string, reason: string, quantity: number, daysAgo: number) =>
      insertRow(h.client, 'FbaReturnCase', { id, tenantId, sellerAccountId: store, amazonOrderId: `111-${id}`, asin, sellerSku: `SKU-${asin}`, quantity, reason, returnDate: ago(daysAgo) })
    const returnTrend = (key: string, scope: string, rateOf: (index: number) => number) =>
      Promise.all(
        MONTHS.map((month, index) =>
          insertRow(h.client, 'BrowseNodeReturnTrend', {
            id: `bnr-${key}-${scope}-${month}`,
            tenantId,
            sellerAccountId: store1,
            browseNodeId: '1001',
            browseNodeName: '行李箱类目',
            scope,
            month,
            returnTopicKey: key,
            rate: rateOf(index),
          }),
        ),
      )

    it('类目退货主题：类目的 ASIN 数、最近 6 个月、按最近占比排序；没有“前 25%”数据的主题该档为空', async () => {
      await returnTrend('Defective', 'ALL', index => 0.2 + index * 0.01)
      await returnTrend('Defective', 'TOP25', () => 0.15)
      await returnTrend('Too small', 'ALL', () => 0.3)
      const data = await get(owner, '/reviews?tab=returns')
      expect(data).toMatchObject({ tab: 'returns', state: 'OK', nodes: [{ storeId: store1, browseNodeId: '1001', browseNodeName: '行李箱类目', asinCount: 2 }] })
      expect(data.selectedNode).toMatchObject({ storeName: '店铺甲', browseNodeId: '1001', months: MONTHS.slice(2) })
      expect(data.selectedNode.topics.map((item: Json) => [item.topic, item.rateAll, item.rateTop, item.latestMonth])).toEqual([
        ['Too small', 0.3, null, '2026-10-01'],
        ['Defective', 0.27, 0.15, '2026-10-01'],
      ])
      expect(data.selectedNode.topics[1].series).toHaveLength(6)
      expect((await get(owner, `/reviews?tab=returns&storeId=${store1}&nodeId=9999`)).selectedNode).toBeNull()
    })

    it('改进清单：只列有最新负面主题且近 90 天有退货的商品，按退货件数降序；文字有重合才标可能相关；老退货与别的商品不计入', async () => {
      await returns('rc-1', store1, A1, 'SWITCHEROO', 3, 5)
      await returns('rc-2', store1, A1, 'DEFECTIVE', 1, 20)
      await returns('rc-3', store1, A2, 'DEFECTIVE', 2, 10)
      await returns('rc-4', store1, A2, 'DEFECTIVE', 50, 100)
      await returns('rc-5', store1, A3, 'DEFECTIVE', 40, 3)
      await returns('rc-6', store2, A1, 'DEFECTIVE', 99, 3)
      const { improvements } = await get(owner, '/reviews?tab=returns')
      expect(improvements).toMatchObject({ state: 'OK', days: 90 })
      expect(improvements.rows.map((row: Json) => [row.asin, row.returnUnits, row.possiblyRelated])).toEqual([
        [A1, 4, false],
        [A2, 2, true],
      ])
      expect(improvements.rows[0].returnReasons.map((item: Json) => [item.code, item.units, item.share])).toEqual([
        ['SWITCHEROO', 3, 0.75],
        ['DEFECTIVE', 1, 0.25],
      ])
      expect(improvements.rows[0].negativeTopics.map((item: Json) => item.topic)).toEqual(['zipper breaks', 'bad smell'])
      expect(improvements.rows[0]).toMatchObject({ storeName: '店铺甲', title: '拉杆箱 A1', snapshotDate: day(3) })
      expect(improvements.rows[0].suggestion).toContain('zipper breaks')
      expect(improvements.rows[1].suggestion).toContain('文字有重合')
    })

    it('没有 returns.read 时改进清单是“无权限”（页面仍是 200）；范围与企业隔离', async () => {
      expect((await get(reader, '/reviews?tab=returns')).improvements).toMatchObject({ state: 'RESTRICTED', rows: [] })
      const scoped = await get(store2Only, '/reviews?tab=returns')
      expect(scoped).toMatchObject({ state: 'NOT_APPLICABLE', nodes: [], selectedNode: null })
      expect(scoped.improvements.state).toBe('RESTRICTED')
      const other = await get(outsider, '/reviews?tab=returns')
      expect(other).toMatchObject({ state: 'NOT_CONNECTED', nodes: [] })
      expect(other.improvements).toMatchObject({ state: 'NOT_CONNECTED', rows: [] })
    })
  })
})
