import { describe, expect, it, vi } from 'vitest'
import { mentionLowOf, negativeTopicRisingEvaluator, risingTopics, type RiseKind, type TopicRow } from './review-topic-evaluator'

// 负面评论主题上升预警（P4-15）：区间下限读取、三种上升方式、最小提及量、窗口内至少两次快照、没有 SKU 对应的商品不判断。

const topic = (topicKey: string, rank: number, mentionRange: string | null = null): TopicRow => ({ topicKey, rank, mentionRange })
const all: RiseKind[] = ['NEW', 'MENTIONS_UP', 'RANK_UP']
const options = { kinds: all, minRankRise: 3, minMentionLow: 10 }

describe('mentionLowOf', () => {
  it('区间取开头的数字作下限；读不出数字的为 null', () => {
    expect(mentionLowOf('10-50')).toBe(10)
    expect(mentionLowOf(' 1,000+ ')).toBe(1000)
    expect(mentionLowOf('12')).toBe(12)
    expect(mentionLowOf('100 – 250')).toBe(100)
    expect(mentionLowOf('50 to 100')).toBe(50)
    expect(mentionLowOf('少于 10')).toBeNull()
    expect(mentionLowOf('Less than 10')).toBeNull()
    expect(mentionLowOf('')).toBeNull()
    expect(mentionLowOf(null)).toBeNull()
  })
})

describe('risingTopics', () => {
  it('新进入：上一次没有；提及量上升：下限变大；名次上升：名次数字变小不少于阈值；其余不报；按名次排序', () => {
    const out = risingTopics(
      [
        topic('Wheels loose', 6, '10-50'),
        topic('Zipper breaks', 1, '100-250'),
        topic('Smells bad', 4, '10-50'),
        topic('Too heavy', 2, '10-50'),
        topic('Stable', 3, '10-50'),
        topic('Slipped', 8, '10-50'),
      ],
      [topic('Zipper breaks', 2, '50-100'), topic('Smells bad', 8, '10-50'), topic('Too heavy', 2, '10-50'), topic('Stable', 3, '10-50'), topic('Slipped', 9, '10-50')],
      options,
    )
    expect(out.map(item => [item.topic, item.kind])).toEqual([
      ['Zipper breaks', 'MENTIONS_UP'],
      ['Smells bad', 'RANK_UP'],
      ['Wheels loose', 'NEW'],
    ])
    expect(out[1]).toMatchObject({ rank: 4, previousRank: 8 })
    expect(out[2]).toMatchObject({ previousRank: null, previousMentionRange: null })
  })

  it('提及量上升优先于名次上升；提及量下限已知且小于最小提及量的不算（没给区间的不排除）', () => {
    const rising = risingTopics([topic('A', 1, '100-250')], [topic('A', 6, '10-50')], options)
    expect(rising[0].kind).toBe('MENTIONS_UP')
    expect(risingTopics([topic('B', 1, '1-5'), topic('C', 2, null)], [], options).map(item => item.topic)).toEqual(['C'])
    expect(risingTopics([topic('B', 1, '1-5')], [], { ...options, minMentionLow: 0 }).map(item => item.topic)).toEqual(['B'])
  })

  it('两次提及量只要有一次读不出就不比较提及量，只看名次；kinds 里去掉的方式不报', () => {
    expect(risingTopics([topic('A', 5, '少于 10')], [topic('A', 6, '10-50')], options)).toEqual([])
    expect(risingTopics([topic('A', 2, null)], [topic('A', 6, '10-50')], options)[0].kind).toBe('RANK_UP')
    expect(risingTopics([topic('N', 1)], [], { ...options, kinds: ['RANK_UP'] })).toEqual([])
    expect(risingTopics([topic('A', 2, null)], [topic('A', 6, null)], { ...options, kinds: ['NEW'] })).toEqual([])
  })

  it('名次上升阈值：刚好等于算，差一名不算', () => {
    expect(risingTopics([topic('A', 3)], [topic('A', 6)], options)).toHaveLength(1)
    expect(risingTopics([topic('A', 4)], [topic('A', 6)], options)).toEqual([])
  })
})

describe('评估器', () => {
  const rule = (params: Record<string, unknown> = {}, scope: Record<string, unknown> = {}) => ({
    id: 'r',
    code: 'REV_NEGATIVE_TOPIC_RISING',
    domain: 'AFTER_SALES',
    name: '负面评论主题上升',
    severity: 'WARNING',
    cooldownMinutes: 10_080,
    currentVersion: 1,
    condition: { type: 'reviews.negative-topic-rising', params },
    scope,
  })
  const now = new Date('2026-10-25T08:00:00Z')
  const day = (text: string) => new Date(`${text}T00:00:00Z`)
  const snap = (asin: string, text: string, store = 's1') => ({ sellerAccountId: store, asin, snapshotDate: day(text) })
  const row = (asin: string, text: string, topicKey: string, rank: number, mentionRange: string | null = null, store = 's1') => ({
    sellerAccountId: store,
    asin,
    snapshotDate: day(text),
    topicKey,
    rank,
    mentionRange,
  })
  const makeDb = (over: Record<string, unknown> = {}) => ({
    reviewTopic: {
      groupBy: vi.fn(async (_args: { where: Record<string, unknown> }) => [
        snap('B0A', '2026-10-24'),
        snap('B0A', '2026-10-17'),
        snap('B0A', '2026-10-10'),
        snap('B0B', '2026-10-24'),
        snap('B0C', '2026-10-20'),
        snap('B0C', '2026-10-13'),
      ]),
      findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [
        row('B0A', '2026-10-24', 'Zipper breaks', 1, '100-250'),
        row('B0A', '2026-10-24', 'Wheels loose', 5, '10-50'),
        row('B0A', '2026-10-17', 'Zipper breaks', 2, '50-100'),
        row('B0A', '2026-10-10', 'Wheels loose', 1, '10-50'),
        row('B0C', '2026-10-20', 'Smells bad', 3, '10-50'),
        row('B0C', '2026-10-13', 'Smells bad', 3, '10-50'),
      ]),
    },
    fbaProduct: { findMany: vi.fn(async (_args: { where: Record<string, unknown> }) => [{ id: 'prod-A', sellerAccountId: 's1', sellerSku: 'SKU-A', asin: 'B0A', title: '示例商品' }]) },
    sellerAccount: { findMany: vi.fn(async () => [{ id: 's1', displayName: '一店' }]) },
    ...over,
  })

  it('命中：只比较最近两次快照（B0A 的 10-24 与 10-17，更早的 10-10 不参与）；B0B 只有一次快照不判断；B0C 没有变化不报', async () => {
    const db = makeDb()
    const hits = await negativeTopicRisingEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'ASIN', entityId: 'prod-A', sellerAccountId: 's1', entityLabel: 'B0A（一店）' })
    expect(hits[0].title).toBe('ASIN B0A 有 2 个负面评论主题上升：“Zipper breaks”、“Wheels loose”')
    expect(hits[0].evidence).toMatchObject({ asin: 'B0A', latestDate: '2026-10-24', previousDate: '2026-10-17', risingCount: 2, lookbackDays: 30, title: '示例商品' })
    expect(hits[0].evidence.topics).toMatchObject([
      { topic: 'Zipper breaks', kind: 'MENTIONS_UP', kindLabel: '提及量上升', previousMentionRange: '50-100' },
      { topic: 'Wheels loose', kind: 'NEW', kindLabel: '新进入前 10', previousRank: null },
    ])
    expect(hits[0].impact).toBeUndefined()
  })

  it('查询：窗口默认 30 天（含今天）、只取负面主题、只取这些 ASIN 的最近两个日期', async () => {
    const db = makeDb()
    await negativeTopicRisingEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule(), now })
    const dateWhere = db.reviewTopic.groupBy.mock.calls[0][0].where as { snapshotDate: { gte: Date; lte: Date } }
    expect(dateWhere.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-09-25')
    expect(dateWhere.snapshotDate.lte.toISOString().slice(0, 10)).toBe('2026-10-25')
    const topicWhere = db.reviewTopic.findMany.mock.calls[0][0].where as { sentiment: string; asin: { in: string[] }; snapshotDate: { in: Date[] } }
    expect(topicWhere.sentiment).toBe('NEGATIVE')
    expect(topicWhere.asin.in.sort()).toEqual(['B0A', 'B0C'])
    expect(topicWhere.snapshotDate.in.map(item => item.toISOString().slice(0, 10)).sort()).toEqual(['2026-10-13', '2026-10-17', '2026-10-20', '2026-10-24'])
  })

  it('阈值可改：只看名次上升且阈值 1 时 B0C 仍不报（名次没变）；回看天数夹在 7 到 90；没有商品记录按店铺|ASIN 登记', async () => {
    const db = makeDb({ fbaProduct: { findMany: vi.fn(async () => []) } })
    const hits = await negativeTopicRisingEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({ kinds: ['NEW', 'BOGUS'], lookbackDays: 1000 }), now })
    const dateWhere = db.reviewTopic.groupBy.mock.calls[0][0].where as { snapshotDate: { gte: Date } }
    expect(dateWhere.snapshotDate.gte.toISOString().slice(0, 10)).toBe('2026-07-27')
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ entityType: 'REVIEW_ASIN', entityId: 's1|B0A' })
    expect(hits[0].title).toBe('ASIN B0A 有 1 个负面评论主题上升：“Wheels loose”')
  })

  it('没有任何 ASIN 有两次快照时不再取主题；SKU 范围没有对应商品时不查快照', async () => {
    const one = makeDb({ reviewTopic: { groupBy: vi.fn(async () => [snap('B0A', '2026-10-24')]), findMany: vi.fn(async () => []) } })
    expect(await negativeTopicRisingEvaluator.evaluate({ db: one as never, tenantId: 't1', rule: rule(), now })).toEqual([])
    expect(one.reviewTopic.findMany).not.toHaveBeenCalled()
    const none = makeDb({ fbaProduct: { findMany: vi.fn(async () => []) } })
    expect(await negativeTopicRisingEvaluator.evaluate({ db: none as never, tenantId: 't1', rule: rule({}, { skus: ['NOPE'] }), now })).toEqual([])
    expect(none.reviewTopic.groupBy).not.toHaveBeenCalled()
  })

  it('店铺与 SKU 范围写进查询（SKU 换成对应 ASIN）', async () => {
    const db = makeDb()
    await negativeTopicRisingEvaluator.evaluate({ db: db as never, tenantId: 't1', rule: rule({}, { sellerAccountIds: ['s1'], skus: ['SKU-A'] }), now })
    expect(db.reviewTopic.groupBy.mock.calls[0][0].where).toMatchObject({ sellerAccountId: { in: ['s1'] }, asin: { in: ['B0A'] } })
  })
})
