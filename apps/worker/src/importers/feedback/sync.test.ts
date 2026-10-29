import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REVIEWS_LIMITS } from '@nova/api-contracts'
import { NonRetryableError } from '@nova/workflow'
import type { PrismaClient } from '@prisma/client'
import type { Logger } from 'pino'
import { describe, expect, it, vi } from 'vitest'
import type { FeedbackApi } from '../../connectors/feedback-api'
import { UpstreamHttpError } from '../../connectors/http-error'
import type { ImportContext } from '../../types'
import { pickAsins, syncFeedback } from './sync'

// 客户反馈同步器（P4-13，I-15）：用内存替身与假接口覆盖——没有目录不适用、距上次快照不足天数跳过、同一天重跑先删后写、类目趋势整体替换且按店铺隔离、
// 403 以不可重试失败码结束、单个商品 400/404 不影响其余、429 向上抛且重试能接着做、同一个节点一次运行只取一次。真实库的写入由 API 侧的 db 测试覆盖。

const FIXTURES = join(__dirname, '../../../fixtures/feedback')
const fixture = (name: string): Record<string, unknown> => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'))
const TODAY = new Date('2026-10-24T00:00:00.000Z')
const NOW = new Date('2026-10-24T08:00:00.000Z')
const scope = { tenantId: 't1', sellerAccountId: 'sa1' }
const daysAgo = (days: number) => new Date(TODAY.getTime() - days * 86_400_000)
const upstream = (status: number) => new UpstreamHttpError(`SP_API_${status}_x`, status, undefined, 'api')

type Row = Record<string, ReturnType<typeof JSON.parse>>
const same = (a: unknown, b: unknown) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b)

function table(unique: string[]) {
  const rows: Row[] = []
  return {
    rows,
    deleteMany: vi.fn(async ({ where }: { where: Row }) => {
      const keep = rows.filter(row => !Object.entries(where).every(([key, value]) => same(row[key], value)))
      const count = rows.length - keep.length
      rows.splice(0, rows.length, ...keep)
      return { count }
    }),
    createMany: vi.fn(async ({ data }: { data: Row[] }) => {
      let count = 0
      for (const item of data) {
        if (rows.some(row => unique.every(key => same(row[key], item[key])))) continue
        rows.push({ ...item })
        count += 1
      }
      return { count }
    }),
  }
}

const topicRow = (asin: string, date: Date, topicKey = 'Old topic', sellerAccountId = 'sa1'): Row => ({
  tenantId: 't1',
  sellerAccountId,
  asin,
  topicKey,
  sentiment: 'POSITIVE',
  rank: 1,
  snapshotDate: date,
})

function setup(products: string[], seed: { topics?: Row[]; reviewTrends?: Row[]; returnTrends?: Row[]; hideSnapshots?: boolean } = {}) {
  const topics = table(['sellerAccountId', 'asin', 'topicKey', 'snapshotDate'])
  const reviewTrends = table(['sellerAccountId', 'browseNodeId', 'scope', 'month', 'topicKey'])
  const returnTrends = table(['sellerAccountId', 'browseNodeId', 'scope', 'month', 'returnTopicKey'])
  topics.rows.push(...(seed.topics ?? []))
  reviewTrends.rows.push(...(seed.reviewTrends ?? []))
  returnTrends.rows.push(...(seed.returnTrends ?? []))
  const prisma: PrismaClient = {
    fbaProduct: { findMany: vi.fn(async () => products.map(asin => ({ asin }))) },
    reviewTopic: {
      deleteMany: topics.deleteMany,
      createMany: topics.createMany,
      groupBy: vi.fn(async () => {
        const latest = new Map<string, Date>()
        for (const row of topics.rows)
          if (!seed.hideSnapshots && row.sellerAccountId === 'sa1' && (!latest.has(row.asin) || latest.get(row.asin)! < row.snapshotDate)) latest.set(row.asin, row.snapshotDate)
        return [...latest.entries()].map(([asin, date]) => ({ asin, _max: { snapshotDate: date } }))
      }),
    },
    browseNodeReviewTrend: { deleteMany: reviewTrends.deleteMany, createMany: reviewTrends.createMany },
    browseNodeReturnTrend: { deleteMany: returnTrends.deleteMany, createMany: returnTrends.createMany },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  } as unknown as PrismaClient
  const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn() } as unknown as Logger
  const ctx: ImportContext = { prisma, logger }
  return { ctx, topics, reviewTrends, returnTrends }
}

type Call = (arg: string) => Promise<Record<string, unknown>>
const impl = (override: Call | undefined, name: string): Call => override ?? (async () => fixture(name))

function fakeApi(overrides: Partial<Record<'getItemBrowseNode' | 'getItemReviewTopics' | 'getBrowseNodeReviewTrends' | 'getBrowseNodeReturnTrends', Call>> = {}) {
  const api = {
    getItemBrowseNode: vi.fn(impl(overrides.getItemBrowseNode, 'browse-node.json')),
    getItemReviewTopics: vi.fn(impl(overrides.getItemReviewTopics, 'item-topics.json')),
    getBrowseNodeReviewTrends: vi.fn(impl(overrides.getBrowseNodeReviewTrends, 'review-trends.json')),
    getBrowseNodeReturnTrends: vi.fn(impl(overrides.getBrowseNodeReturnTrends, 'return-trends.json')),
  }
  return { api, asApi: api as unknown as FeedbackApi }
}
const run = (setupResult: ReturnType<typeof setup>, asApi: FeedbackApi, options = {}) => syncFeedback(setupResult.ctx, asApi, scope, { now: NOW, today: TODAY, ...options })

describe('没有商品目录', () => {
  it('以“不适用”结束，不调用亚马逊也不写库', async () => {
    const db = setup([])
    const { api, asApi } = fakeApi()
    expect(await run(db, asApi)).toEqual({ notApplicable: true, reason: 'NO_CATALOG', imported: 0 })
    expect(api.getItemBrowseNode).not.toHaveBeenCalled()
    expect(db.topics.rows).toHaveLength(0)
  })

  it('目录里不合法的 ASIN 被忽略；全部不合法也按没有目录处理', async () => {
    const { asApi } = fakeApi()
    expect(await run(setup(['', 'short', 'B0OWN!!!!!']), asApi)).toMatchObject({ notApplicable: true })
  })
})

describe('写入', () => {
  it('写主题（带名次、区间原样、类目信息、当天日期）与类目趋势；imported 是写入的总行数', async () => {
    const db = setup(['b0ownasin1'])
    const { asApi } = fakeApi()
    const result = await run(db, asApi)
    expect(result).toMatchObject({ notApplicable: false, imported: 5 + 14 + 4, topicRows: 5, trendRows: 18, nodes: 1, processed: 1, asinsWithoutData: 0, outOfRange: 1, incomplete: false })
    expect(db.topics.rows).toHaveLength(5)
    expect(db.topics.rows[0]).toMatchObject({
      tenantId: 't1',
      sellerAccountId: 'sa1',
      asin: 'B0OWNASIN1',
      browseNodeId: '2975312011',
      browseNodeName: 'Suitcases',
      topicKey: 'Sturdy build',
      sentiment: 'POSITIVE',
      rank: 1,
      mentionRange: '100-250',
      reviewCountBucket: '1000+',
    })
    expect(db.topics.rows[0].snapshotDate.getTime()).toBe(TODAY.getTime())
    expect(db.topics.rows.find(row => row.topicKey === 'Good value')).toMatchObject({ mentionRange: null, reviewCountBucket: null })
    expect(db.reviewTrends.rows).toHaveLength(14)
    expect(db.reviewTrends.rows[0]).toMatchObject({ tenantId: 't1', sellerAccountId: 'sa1', browseNodeId: '2975312011', browseNodeName: 'Suitcases' })
    expect(db.returnTrends.rows).toHaveLength(4)
    expect(db.returnTrends.rows.map(row => row.returnTopicKey).sort()).toEqual(['Damaged on arrival', 'Too small', 'Too small', 'Too small'])
  })

  it('幂等：同一天再跑一次，商品已有今天的快照而被跳过，不再调用亚马逊，行数不变', async () => {
    const db = setup(['B0OWNASIN1'])
    const first = fakeApi()
    await run(db, first.asApi)
    const second = fakeApi()
    const again = await run(db, second.asApi)
    expect(again).toMatchObject({ imported: 0, processed: 0, skippedFresh: 1, candidates: 0 })
    expect(second.api.getItemBrowseNode).not.toHaveBeenCalled()
    expect(db.topics.rows).toHaveLength(5)
    expect(db.reviewTrends.rows).toHaveLength(14)
  })

  it('同一天重跑（读快照后别的进程刚写过）先删后写，旧主题不残留；接口这次没给主题就不动已有数据', async () => {
    const db = setup(['B0OWNASIN1'], { topics: [topicRow('B0OWNASIN1', TODAY, 'Old topic'), topicRow('B0OTHER001', TODAY, 'Other asin topic')], hideSnapshots: true })
    const { asApi } = fakeApi()
    await run(db, asApi)
    const own = db.topics.rows.filter(row => row.asin === 'B0OWNASIN1').map(row => row.topicKey)
    expect(own).not.toContain('Old topic')
    expect(own).toHaveLength(5)
    expect(db.topics.rows.some(row => row.topicKey === 'Other asin topic')).toBe(true)
    const empty = fakeApi({ getItemReviewTopics: async () => ({}) })
    const result = await run(db, empty.asApi)
    expect(result).toMatchObject({ asinsWithoutData: 1, topicRows: 0 })
    expect(db.topics.rows.filter(row => row.asin === 'B0OWNASIN1')).toHaveLength(5)
  })

  it('类目趋势整体替换这个店铺该节点的旧数据；别的店铺、别的节点不受影响', async () => {
    const base = { tenantId: 't1', browseNodeId: '2975312011', scope: 'ALL', month: new Date('2020-01-01T00:00:00Z'), sentiment: 'POSITIVE', rate: 0.5 }
    const db = setup(['B0OWNASIN1'], {
      reviewTrends: [
        { ...base, sellerAccountId: 'sa1', topicKey: 'Stale topic' },
        { ...base, sellerAccountId: 'sa2', topicKey: 'Other store' },
        { ...base, sellerAccountId: 'sa1', browseNodeId: '999', topicKey: 'Other node' },
      ],
    })
    const { asApi } = fakeApi()
    await run(db, asApi)
    const keys = db.reviewTrends.rows.map(row => row.topicKey)
    expect(keys).not.toContain('Stale topic')
    expect(keys).toEqual(expect.arrayContaining(['Other store', 'Other node', 'Sturdy build']))
  })

  it('某一种趋势这次没给数据，就不动那一种的旧数据', async () => {
    const old = { tenantId: 't1', sellerAccountId: 'sa1', browseNodeId: '2975312011', scope: 'ALL', month: new Date('2026-09-01T00:00:00Z'), returnTopicKey: 'Kept', rate: 0.1 }
    const db = setup(['B0OWNASIN1'], { returnTrends: [old] })
    const { asApi } = fakeApi({ getBrowseNodeReturnTrends: async () => ({ returnTopics: [] }) })
    await run(db, asApi)
    expect(db.returnTrends.rows).toHaveLength(1)
    expect(db.reviewTrends.rows).toHaveLength(14)
  })

  it('两个商品在同一个类目：这个节点的趋势一次运行只取一次', async () => {
    const db = setup(['B0OWNASIN1', 'B0OWNASIN2'])
    const { api, asApi } = fakeApi()
    const result = await run(db, asApi)
    expect(result).toMatchObject({ processed: 2, nodes: 1, topicRows: 10 })
    expect(api.getBrowseNodeReviewTrends).toHaveBeenCalledTimes(1)
    expect(api.getBrowseNodeReturnTrends).toHaveBeenCalledTimes(1)
  })
})

describe('挑选商品', () => {
  it('距上次快照不足天数的跳过；最旧的先做；没有快照的也先做', async () => {
    const seed = [topicRow('B0FRESH001', daysAgo(REVIEWS_LIMITS.syncSkipFreshDays - 1)), topicRow('B0OLD00001', daysAgo(30)), topicRow('B0OLD00002', daysAgo(10))]
    const db = setup(['B0FRESH001', 'B0OLD00001', 'B0OLD00002', 'B0NEW00001'], { topics: seed })
    const { api, asApi } = fakeApi()
    const result = await run(db, asApi)
    expect(result).toMatchObject({ skippedFresh: 1, candidates: 3, processed: 3 })
    expect(api.getItemBrowseNode.mock.calls.map(call => call[0]).sort()).toEqual(['B0NEW00001', 'B0OLD00001', 'B0OLD00002'])
  })

  it('超过单次上限时只处理上限个并标记未做完', async () => {
    const db = setup(['B0ASIN0001', 'B0ASIN0002', 'B0ASIN0003'])
    const { api, asApi } = fakeApi()
    const result = await run(db, asApi, { maxAsins: 2 })
    expect(result).toMatchObject({ processed: 2, candidates: 3, incomplete: true })
    expect(api.getItemReviewTopics).toHaveBeenCalledTimes(2)
  })

  it('没有快照的商品最多占一半名额，另一半给快照最旧的；没有旧快照时全部名额给没有快照的', () => {
    const fresh = Array.from({ length: 100 }, (_, index) => ({ asin: `N${String(index).padStart(3, '0')}`, last: null }))
    const stale = Array.from({ length: 100 }, (_, index) => ({ asin: `S${String(index).padStart(3, '0')}`, last: daysAgo(100 - index) }))
    const mixed = pickAsins([...fresh, ...stale], NOW, TODAY, 40)
    expect(mixed.chosen.filter(asin => asin.startsWith('N'))).toHaveLength(20)
    expect(mixed.chosen.filter(asin => asin.startsWith('S'))).toEqual(stale.slice(0, 20).map(item => item.asin))
    expect(pickAsins(fresh, NOW, TODAY, 40).chosen).toHaveLength(40)
    expect(pickAsins([...fresh.slice(0, 3), ...stale.slice(0, 50)], NOW, TODAY, 40).chosen.filter(asin => asin.startsWith('N'))).toHaveLength(3)
  })

  it('没有快照的商品按日期槽轮转，连续几天刚好首尾相接、不重复不遗漏', () => {
    const fresh = Array.from({ length: 80 }, (_, index) => ({ asin: `N${String(index).padStart(3, '0')}`, last: null }))
    const stale = Array.from({ length: 100 }, (_, index) => ({ asin: `S${String(index).padStart(3, '0')}`, last: daysAgo(100 - index) }))
    const seen: string[] = []
    for (let day = 0; day < 4; day += 1) seen.push(...pickAsins([...fresh, ...stale], new Date(NOW.getTime() + day * 86_400_000), TODAY, 40).chosen.filter(asin => asin.startsWith('N')))
    expect(new Set(seen).size).toBe(80)
    expect(seen).toHaveLength(80)
  })
})

describe('失败处理', () => {
  it('403（没有品牌分析权限）以不可重试的失败码结束，不写任何数据', async () => {
    const db = setup(['B0OWNASIN1'])
    const { asApi } = fakeApi({ getItemReviewTopics: async () => Promise.reject(upstream(403)) })
    await expect(run(db, asApi)).rejects.toMatchObject({ code: 'FBK_NO_BRAND_ACCESS' })
    await expect(run(db, asApi)).rejects.toBeInstanceOf(NonRetryableError)
    const early = fakeApi({ getItemBrowseNode: async () => Promise.reject(upstream(403)) })
    await expect(run(db, early.asApi)).rejects.toMatchObject({ code: 'FBK_NO_BRAND_ACCESS' })
    expect(db.topics.rows).toHaveLength(0)
  })

  it('单个商品 400 / 404 只跳过并计数，其余商品照常写入', async () => {
    const db = setup(['B0BAD00001', 'B0BAD00002', 'B0GOOD0001'])
    const { asApi } = fakeApi({
      getItemReviewTopics: async asin => {
        if (asin === 'B0BAD00001') throw upstream(404)
        if (asin === 'B0BAD00002') throw upstream(400)
        return fixture('item-topics.json')
      },
    })
    const result = await run(db, asApi)
    expect(result).toMatchObject({ processed: 3, asinsWithoutData: 2, topicRows: 5 })
    expect([...new Set(db.topics.rows.map(row => row.asin))]).toEqual(['B0GOOD0001'])
  })

  it('浏览节点 404：主题照常写（没有类目信息），不取类目趋势；节点趋势 404 只记一次“没有数据”', async () => {
    const noNode = setup(['B0OWNASIN1'])
    const first = fakeApi({ getItemBrowseNode: async () => Promise.reject(upstream(404)) })
    expect(await run(noNode, first.asApi)).toMatchObject({ topicRows: 5, nodes: 0, trendRows: 0 })
    expect(noNode.topics.rows[0]).toMatchObject({ browseNodeId: null, browseNodeName: null })
    expect(first.api.getBrowseNodeReviewTrends).not.toHaveBeenCalled()
    const noTrends = setup(['B0OWNASIN1'])
    const second = fakeApi({ getBrowseNodeReviewTrends: async () => Promise.reject(upstream(404)), getBrowseNodeReturnTrends: async () => Promise.reject(upstream(400)) })
    expect(await run(noTrends, second.asApi)).toMatchObject({ topicRows: 5, nodes: 1, nodesWithoutData: 1, trendRows: 0 })
  })

  it('429 与 5xx 向上抛让任务重试；已写的商品保留，重试时只做还没有今天快照的商品', async () => {
    const db = setup(['B0ASIN0001', 'B0ASIN0002'])
    const limited = fakeApi({
      getItemReviewTopics: async asin => {
        if (asin === 'B0ASIN0002') throw upstream(429)
        return fixture('item-topics.json')
      },
    })
    await expect(run(db, limited.asApi)).rejects.toMatchObject({ status: 429 })
    expect([...new Set(db.topics.rows.map(row => row.asin))]).toEqual(['B0ASIN0001'])
    const retry = fakeApi()
    expect(await run(db, retry.asApi)).toMatchObject({ processed: 1, skippedFresh: 1 })
    expect(retry.api.getItemBrowseNode.mock.calls.map(call => call[0])).toEqual(['B0ASIN0002'])
    expect([...new Set(db.topics.rows.map(row => row.asin))].sort()).toEqual(['B0ASIN0001', 'B0ASIN0002'])
    const down = fakeApi({ getBrowseNodeReturnTrends: async () => Promise.reject(upstream(503)) })
    await expect(run(setup(['B0ASIN0003']), down.asApi)).rejects.toMatchObject({ status: 503 })
  })

  it('趋势取数被限速时商品的主题还没写，重试会接着做这个商品', async () => {
    const db = setup(['B0OWNASIN1'])
    const { asApi } = fakeApi({ getBrowseNodeReturnTrends: async () => Promise.reject(upstream(429)) })
    await expect(run(db, asApi)).rejects.toMatchObject({ status: 429 })
    expect(db.topics.rows).toHaveLength(0)
    expect(await run(db, fakeApi().asApi)).toMatchObject({ processed: 1, topicRows: 5 })
  })
})
