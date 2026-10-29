import { describe, expect, it } from 'vitest'
import { COMPETITOR_LIMITS, type CompetitorFeatured } from './competitors'
import {
  catalogChanges,
  competitorWindowStart,
  isAsin,
  memberEligibleOf,
  mergeSnapshot,
  normalizeAsin,
  pickRank,
  priceGapOf,
  rankGapOf,
  rotateWatched,
  sameClassificationRank,
  shouldStoreSnapshot,
  weightedClickShare,
  type SnapshotFields,
} from './competitors-math'
import { CompetitorAddBodySchema, CompetitorDetailQuerySchema, CompetitorListQuerySchema, CompetitorRemoveQuerySchema } from './competitors-query'

// 竞品监控的纯计算与请求校验（P4-12）：ASIN、价格差与名次差、点击份额（下限）、快照留存与合并、目录变化、轮转。

const base: SnapshotFields = { title: 'A', brand: 'B', imageCount: 7, price: 19.99, featured: 'HAS_FEATURED', fulfillment: 'AMAZON', memberEligible: true, rank: 100, rankClassificationId: 'c1' }
const HOUR = 3_600_000

describe('ASIN', () => {
  it('统一成大写去空格；只接受 10 位字母或数字', () => {
    expect(normalizeAsin(' b0abcde123 ')).toBe('B0ABCDE123')
    expect(isAsin('B0ABCDE123')).toBe(true)
    for (const bad of ['', 'B0ABCDE12', 'B0ABCDE1234', 'b0abcde123', 'B0ABCDE12!']) expect(isAsin(bad), bad).toBe(false)
  })
})

describe('价格差与名次差', () => {
  it('价格差 = 竞品 − 我方，并给占我方价格的比例；任一边没有价格或我方价格不是正数就没有结果，不当 0', () => {
    expect(priceGapOf(20, 25)).toEqual({ gap: 5, pct: 0.25 })
    expect(priceGapOf(20, 15)).toEqual({ gap: -5, pct: -0.25 })
    expect(priceGapOf(20, 20)).toEqual({ gap: 0, pct: 0 })
    expect(priceGapOf(null, 20)).toEqual({ gap: null, pct: null })
    expect(priceGapOf(20, null)).toEqual({ gap: null, pct: null })
    expect(priceGapOf(0, 20)).toEqual({ gap: null, pct: null })
  })

  it('名次差只在同一个分类里比较；缺任何一边给出原因', () => {
    expect(rankGapOf({ rank: 100, classificationId: 'c1' }, { rank: 80, classificationId: 'c1' })).toEqual({ gap: -20, note: null })
    expect(rankGapOf({ rank: 100, classificationId: 'c1' }, { rank: 80, classificationId: 'c2' }).gap).toBeNull()
    expect(rankGapOf({ rank: 100, classificationId: 'c1' }, { rank: 80, classificationId: 'c2' }).note).toContain('分类不同')
    expect(rankGapOf(null, { rank: 80, classificationId: 'c1' }).note).toContain('我方')
    expect(rankGapOf({ rank: 1, classificationId: 'c1' }, null).note).toContain('竞品')
  })

  it('主排名优先取展示组（大类）排名；同分类的我方排名按分类编号找', () => {
    const ranks = [
      { classificationId: 'c9', name: '小类', rank: 5 },
      { classificationId: 'display:home', name: '家居', rank: 900 },
    ]
    expect(pickRank(ranks)?.classificationId).toBe('display:home')
    expect(pickRank([ranks[0]!])?.classificationId).toBe('c9')
    expect(pickRank([])).toBeNull()
    expect(sameClassificationRank(ranks, 'c9')?.rank).toBe(5)
    expect(sameClassificationRank(ranks, 'zz')).toBeNull()
    expect(sameClassificationRank(ranks, null)).toBeNull()
  })
})

describe('在我方核心词中的点击份额（下限）', () => {
  it('按搜索量加权，没进前三的词按 0 计；不对份额取平均', () => {
    // 搜索量 900 的词份额 0.5，搜索量 100 的词没进前三：加权 = 450/1000 = 0.45（平均会得到 0.25）
    expect(
      weightedClickShare([
        { volume: 900, share: 0.5 },
        { volume: 100, share: null },
      ]),
    ).toEqual({ share: 0.45, hit: 1, total: 2 })
  })

  it('没有搜索量的词不参与；一个可加权的词都没有就没有结果，不当 0', () => {
    expect(
      weightedClickShare([
        { volume: null, share: 0.9 },
        { volume: 0, share: 0.9 },
      ]),
    ).toEqual({ share: null, hit: 0, total: 0 })
    expect(weightedClickShare([])).toEqual({ share: null, hit: 0, total: 0 })
    expect(
      weightedClickShare([
        { volume: 10, share: 0.3 },
        { volume: null, share: 0.9 },
      ]).total,
    ).toBe(1)
  })

  it('份额不会超过 1', () => {
    expect(weightedClickShare([{ volume: 10, share: 1.7 }]).share).toBe(1)
  })
})

describe('快照留存与合并', () => {
  const last = { ...base, observedAt: new Date(Date.UTC(2026, 0, 1, 0, 0)) }
  const soon = new Date(last.observedAt.getTime() + 6 * HOUR)

  it('没有上一条一定写；没变化且不到 24 小时不写；任何可见属性变化就写；满 24 小时写心跳', () => {
    expect(shouldStoreSnapshot(null, base, soon)).toBe(true)
    expect(shouldStoreSnapshot(last, base, soon)).toBe(false)
    expect(shouldStoreSnapshot(last, { ...base, price: 19.991 }, soon)).toBe(false)
    expect(shouldStoreSnapshot(last, { ...base, price: 18.5 }, soon)).toBe(true)
    for (const change of [
      { title: 'C' },
      { brand: 'X' },
      { imageCount: 8 },
      { featured: 'NONE' as CompetitorFeatured },
      { fulfillment: 'MERCHANT' },
      { memberEligible: false },
      { rank: 99 },
      { rankClassificationId: 'c2' },
    ])
      expect(shouldStoreSnapshot(last, { ...base, ...change }, soon), JSON.stringify(change)).toBe(true)
    expect(shouldStoreSnapshot(last, base, new Date(last.observedAt.getTime() + 24 * HOUR))).toBe(true)
  })

  it('合并：这次没取到的字段沿用上一条，取到了就用新值；排名没取到时分类也沿用', () => {
    const empty: SnapshotFields = { title: null, brand: null, imageCount: null, price: null, featured: null, fulfillment: null, memberEligible: null, rank: null, rankClassificationId: null }
    expect(mergeSnapshot(base, empty)).toEqual(base)
    expect(mergeSnapshot(null, empty)).toEqual(empty)
    expect(mergeSnapshot(base, { ...empty, price: 10, rank: 5, rankClassificationId: 'c2' })).toMatchObject({ price: 10, rank: 5, rankClassificationId: 'c2', title: 'A' })
  })

  it('会员资格：有推荐报价时看会员权重是否大于 0，没有推荐报价没有结论', () => {
    expect(memberEligibleOf(true, 0.4)).toBe(true)
    expect(memberEligibleOf(true, 0)).toBe(false)
    expect(memberEligibleOf(true, null)).toBe(false)
    expect(memberEligibleOf(false, 0.4)).toBeNull()
  })
})

describe('目录属性变化', () => {
  const row = (at: string, title: string | null, brand: string | null, imageCount: number | null) => ({ at, title, brand, imageCount })

  it('只有两边都有值且不同才算变化；没取到的快照既不算变化也不覆盖已知值；结果从新到旧', () => {
    const { items } = catalogChanges([row('1', 'T1', 'B', 5), row('2', null, null, null), row('3', 'T1', 'B', 6), row('4', 'T2', 'B', 6)])
    expect(items.map(item => [item.at, item.field, item.before, item.after])).toEqual([
      ['4', 'title', 'T1', 'T2'],
      ['3', 'imageCount', '5', '6'],
    ])
    expect(catalogChanges([row('1', 'T1', null, null)]).items).toEqual([])
  })

  it('超过上限时截断并标记', () => {
    const rows = Array.from({ length: 6 }, (_, index) => row(String(index), `T${index}`, null, null))
    expect(catalogChanges(rows, 3)).toMatchObject({ truncated: true, items: [{ at: '5' }, { at: '4' }, { at: '3' }] })
  })
})

describe('窗口与轮转', () => {
  it('最近一次快照的有效窗口是 3 天', () => {
    const now = new Date(Date.UTC(2026, 5, 10))
    expect(now.getTime() - competitorWindowStart(now).getTime()).toBe(COMPETITOR_LIMITS.freshWindowMs)
  })

  it('容量够用时全量；超出时同一时间槽选同一段，下一个槽接着往后，长期覆盖全部', () => {
    const items = Array.from({ length: 10 }, (_, index) => index)
    const slot = COMPETITOR_LIMITS.syncSlotMs
    expect(rotateWatched(items, 10, new Date(0))).toEqual(items)
    expect(rotateWatched(items, 4, new Date(0))).toEqual([0, 1, 2, 3])
    expect(rotateWatched(items, 4, new Date(slot - 1))).toEqual([0, 1, 2, 3])
    expect(rotateWatched(items, 4, new Date(slot))).toEqual([4, 5, 6, 7])
    const seen = new Set<number>()
    for (let index = 0; index < 5; index += 1) for (const item of rotateWatched(items, 4, new Date(index * slot))) seen.add(item)
    expect(seen.size).toBe(10)
  })
})

describe('请求校验', () => {
  it('添加：店铺与竞品 ASIN 必填并规整；我方对应 ASIN 选填；竞品不能等于我方对应；多余字段与超长备注被拒', () => {
    expect(CompetitorAddBodySchema.parse({ storeId: 's1', asin: ' b0abcde123 ' })).toMatchObject({ asin: 'B0ABCDE123', reason: 'MANUAL' })
    expect(CompetitorAddBodySchema.parse({ storeId: 's1', asin: 'B0ABCDE123', ownAsin: 'b0zzzzz999', reason: 'SEARCH_TERM', note: ' 行李箱 ' })).toMatchObject({
      ownAsin: 'B0ZZZZZ999',
      note: '行李箱',
    })
    for (const body of [
      {},
      { storeId: 's1' },
      { storeId: 's1', asin: 'short' },
      { storeId: 's1', asin: 'B0ABCDE123', ownAsin: 'B0ABCDE123' },
      { storeId: 's1', asin: 'B0ABCDE123', ownAsin: 'bad' },
      { storeId: 's1', asin: 'B0ABCDE123', reason: 'OTHER' },
      { storeId: 's1', asin: 'B0ABCDE123', extra: 1 },
      { storeId: 's1', asin: 'B0ABCDE123', note: 'x'.repeat(COMPETITOR_LIMITS.noteMax + 1) },
    ])
      expect(CompetitorAddBodySchema.safeParse(body).success, JSON.stringify(body)).toBe(false)
  })

  it('详情与取消：店铺必填；回看天数 7 到 180；列表排序字段在白名单内', () => {
    expect(CompetitorDetailQuerySchema.parse({ storeId: 's1' }).days).toBe(COMPETITOR_LIMITS.trendDays)
    expect(CompetitorDetailQuerySchema.parse({ storeId: 's1', days: '30', ownAsin: 'b0abcde123' })).toMatchObject({ days: 30, ownAsin: 'B0ABCDE123' })
    for (const query of [{}, { storeId: 's1', days: 6 }, { storeId: 's1', days: 181 }, { storeId: 's1', x: 1 }])
      expect(CompetitorDetailQuerySchema.safeParse(query).success, JSON.stringify(query)).toBe(false)
    expect(CompetitorRemoveQuerySchema.safeParse({}).success).toBe(false)
    expect(CompetitorRemoveQuerySchema.parse({ storeId: 's1' })).toEqual({ storeId: 's1' })
    expect(CompetitorListQuerySchema.safeParse({ sort: 'password:asc' }).success).toBe(false)
    expect(CompetitorListQuerySchema.safeParse({ sort: 'clickShare:desc', reason: 'SEARCH_TERM' }).success).toBe(true)
    expect(CompetitorListQuerySchema.safeParse({ reason: 'BAD' }).success).toBe(false)
  })
})
