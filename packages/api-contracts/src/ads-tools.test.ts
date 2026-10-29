import { describe, expect, it } from 'vitest'
import {
  ADS_ATTRIBUTION_WINDOWS,
  ADS_BULK_ADD_LIMIT,
  attributionWindows,
  averageOverBudgetHours,
  budgetTimelineDay,
  groupDuplicateKeywords,
  keywordKey,
  normalizeKeywordText,
  splitBulkItems,
  type BudgetHourInput,
} from './ads-tools'
import { adsConflicts, conflictCounts, type ConflictObjectInput, type ConflictRuleInput, type ConflictStrategyInput } from './ads-conflicts'
import { AdsToolListQuerySchema, BulkKeywordBodySchema } from './ads-tools-query'

const hours = (entries: Record<number, Partial<BudgetHourInput>>) => new Map(Object.entries(entries).map(([hour, row]) => [Number(hour), { spend: null, impressions: 0, clicks: 0, ...row }]))

describe('超预算时间条', () => {
  it('累计花费超过日预算的第一个小时起算超预算，之前的活跃小时才算预算内活跃', () => {
    const day = budgetTimelineDay('2026-10-20', 10, hours({ 8: { spend: 4, impressions: 100 }, 9: { spend: 4, impressions: 90 }, 10: { spend: 3, impressions: 80 }, 11: { spend: 0, impressions: 5 } }))
    expect(day.spend).toBe(11)
    expect(day.exceededAtHour).toBe(10)
    expect(day.overBudgetHours).toBe(14)
    expect(day.activeHours).toBe(4)
    expect(day.activeHoursWithinBudget).toBe(2)
    expect(day.hours[9]).toMatchObject({ cumulative: 8, over: false, active: true })
    expect(day.hours[10]).toMatchObject({ cumulative: 11, over: true })
    expect(day.hours[7]).toMatchObject({ spend: null, cumulative: null, active: false, over: false })
    expect(day.hours[20]).toMatchObject({ spend: null, cumulative: 11, over: true })
  })

  it('刚好用完预算不算超；没有超过时超预算时长为 0', () => {
    const day = budgetTimelineDay('2026-10-20', 10, hours({ 5: { spend: 10, impressions: 1 } }))
    expect(day).toMatchObject({ exceededAtHour: null, overBudgetHours: 0, activeHoursWithinBudget: 1 })
  })

  it('预算未知（空、0）只给花费，不判断超预算，也不当 0', () => {
    for (const budget of [null, 0]) {
      const day = budgetTimelineDay('2026-10-20', budget, hours({ 5: { spend: 50, impressions: 1 } }))
      expect(day).toMatchObject({ spend: 50, exceededAtHour: null, overBudgetHours: null, activeHoursWithinBudget: null })
      expect(day.hours.every(hour => !hour.over)).toBe(true)
    }
  })

  it('一天都没有记录：花费为空，不是 0', () => {
    expect(budgetTimelineDay('2026-10-20', 10, new Map())).toMatchObject({ spend: null, hoursRecorded: 0, activeHours: 0, exceededAtHour: null, overBudgetHours: 0 })
  })

  it('平均超预算时长只统计有记录且预算已知的日子', () => {
    const over = budgetTimelineDay('d1', 1, hours({ 20: { spend: 2, impressions: 1 } }))
    const within = budgetTimelineDay('d2', 100, hours({ 3: { spend: 2, impressions: 1 } }))
    const empty = budgetTimelineDay('d3', 1, new Map())
    const unknown = budgetTimelineDay('d4', null, hours({ 3: { spend: 2, impressions: 1 } }))
    expect(averageOverBudgetHours([over, within, empty, unknown])).toBe(2)
    expect(averageOverBudgetHours([empty, unknown])).toBeNull()
  })
})

describe('归因窗口', () => {
  const rows = (...raws: Array<Record<string, unknown> | null>) => raws.map((raw, index) => ({ date: `2026-10-0${index + 1}`, raw }))

  it('每一天都带列的窗口可用，其余置灰并写明覆盖几天', () => {
    const views = attributionWindows(
      rows({ sales7d: 10, purchases7d: 1, sales14d: '20.5', purchases14d: '2' }, { sales7d: 5, purchases7d: 1, sales1d: 3, purchases1d: 1, sales14d: 1, purchases14d: 1 }),
    )
    expect(views.map(view => view.window)).toEqual([...ADS_ATTRIBUTION_WINDOWS])
    expect(views.find(view => view.window === 7)).toMatchObject({ available: true, sales: 15, orders: 2, coveredDays: 2, totalDays: 2 })
    expect(views.find(view => view.window === 14)).toMatchObject({ available: true, sales: 21.5, orders: 3 })
    const one = views.find(view => view.window === 1)!
    expect(one).toMatchObject({ available: false, sales: null, orders: null, coveredDays: 1, totalDays: 2 })
    expect(one.reason).toContain('1/2')
    expect(views.find(view => view.window === 30)).toMatchObject({ available: false, coveredDays: 0 })
  })

  it('也认下划线写法；没有报告行时全部置灰', () => {
    expect(attributionWindows(rows({ sales_30d: 7, purchases_30d: 2 })).find(view => view.window === 30)).toMatchObject({ available: true, sales: 7, orders: 2 })
    const none = attributionWindows([])
    expect(none.every(view => !view.available && view.reason?.includes('没有广告报告行'))).toBe(true)
  })

  it('raw 为空或不是对象的行当作没有这个列', () => {
    const views = attributionWindows(rows(null, { sales7d: 1 }))
    expect(views.find(view => view.window === 7)).toMatchObject({ available: false, coveredDays: 1, totalDays: 2 })
  })
})

describe('批量加词', () => {
  it('词的比较不分大小写、合并空白；匹配方式是键的一部分', () => {
    expect(normalizeKeywordText('  Yoga   MAT ')).toBe('yoga mat')
    expect(keywordKey('Yoga Mat', 'exact')).toBe('yoga mat|EXACT')
    expect(keywordKey('yoga mat', 'PHRASE')).not.toBe(keywordKey('yoga mat', 'EXACT'))
  })

  it('已存在的词和批内重复的词不再提交，并说明原因；其余按原顺序保留下标', () => {
    const existing = new Set([keywordKey('yoga mat', 'EXACT')])
    const { pending, skipped } = splitBulkItems(
      [
        { text: 'Yoga  Mat', matchType: 'EXACT' },
        { text: 'pilates', matchType: 'PHRASE', amount: 0.5 },
        { text: 'PILATES', matchType: 'PHRASE' },
        { text: 'pilates', matchType: 'BROAD' },
      ],
      existing,
    )
    expect(pending.map(item => [item.index, item.text, item.matchType])).toEqual([
      [1, 'pilates', 'PHRASE'],
      [3, 'pilates', 'BROAD'],
    ])
    expect(pending[0]!.amount).toBe(0.5)
    expect(skipped.map(item => [item.index, item.reason.includes('已经有') ? 'exists' : 'dup'])).toEqual([
      [0, 'exists'],
      [2, 'dup'],
    ])
  })

  it('请求体：数量上限、否定要给层级、关键词不能给层级', () => {
    const items = (count: number) => Array.from({ length: count }, (_, index) => ({ text: `w${index}`, matchType: 'EXACT' }))
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: 'g1', items: items(ADS_BULK_ADD_LIMIT) }).success).toBe(true)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: 'g1', items: items(ADS_BULK_ADD_LIMIT + 1) }).success).toBe(false)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: 'g1', items: [] }).success).toBe(false)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'NEGATIVE', entityId: 'g1', items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] }).success).toBe(false)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'NEGATIVE', entityId: 'g1', level: 'CAMPAIGN', items: [{ text: 'x', matchType: 'NEGATIVE_EXACT' }] }).success).toBe(true)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: 'g1', level: 'AD_GROUP', items: items(1) }).success).toBe(false)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: '%%', items: items(1) }).success).toBe(false)
    expect(BulkKeywordBodySchema.safeParse({ mode: 'KEYWORD', entityId: 'g1', items: items(1), extra: 1 }).success).toBe(false)
    expect(BulkKeywordBodySchema.parse({ mode: 'KEYWORD', entityId: 'g1', items: [{ text: '  yoga ', matchType: 'EXACT' }] }).items[0]!.text).toBe('yoga')
    expect(BulkKeywordBodySchema.parse({ mode: 'KEYWORD', entityId: 'g1', items: items(1) }).source).toBe('MANUAL')
  })

  it('列表查询：翻页大小 1 至 200，允许范围参数共存', () => {
    expect(AdsToolListQuerySchema.parse({}).pageSize).toBe(50)
    expect(AdsToolListQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false)
    expect(AdsToolListQuerySchema.safeParse({ pageSize: '201' }).success).toBe(false)
    expect(AdsToolListQuerySchema.safeParse({ from: '2026-10-01', kind: 'NOPE' }).success).toBe(false)
    expect(AdsToolListQuerySchema.safeParse({ from: '2026-10-01', kind: 'RULE_OVERLAP' }).success).toBe(true)
  })
})

const campaigns: ConflictObjectInput[] = [
  { id: 'c1', name: '活动一', adsProfileId: 'p1' },
  { id: 'c2', name: '活动二', adsProfileId: 'p1' },
  { id: 'c9', name: '别的账户', adsProfileId: 'p2' },
]
const adGroups: ConflictObjectInput[] = [{ id: 'g1', name: '广告组一', adsProfileId: 'p1' }]

const grid = (fill: number, overrides: Record<number, number> = {}) => Array.from({ length: 168 }, (_, cell) => overrides[cell] ?? fill)
const strategy = (over: Partial<ConflictStrategyInput> & Pick<ConflictStrategyInput, 'id'>): ConflictStrategyInput => ({
  name: `策略${over.id}`,
  adsProfileId: 'p1',
  status: 'ACTIVE',
  kind: 'ON_OFF',
  level: 'CAMPAIGN',
  grid: grid(1),
  targetIds: ['c1'],
  ...over,
})
const rule = (over: Partial<ConflictRuleInput> & Pick<ConflictRuleInput, 'id'>): ConflictRuleInput => ({
  name: `规则${over.id}`,
  adsProfileId: 'p1',
  status: 'ACTIVE',
  mode: 'AUTO',
  level: 'CAMPAIGN',
  actionType: 'PAUSE',
  campaignIds: [],
  ...over,
})
const find = (strategies: ConflictStrategyInput[], rules: ConflictRuleInput[]) => adsConflicts({ strategies, rules, campaigns, adGroups })

describe('冲突检查', () => {
  it('两个启停策略时段取值不同才算冲突，编号大的在冲突小时里生效', () => {
    const [conflict, ...rest] = find([strategy({ id: 's1', grid: grid(1, { 10: 0, 11: 0 }) }), strategy({ id: 's2', grid: grid(1, { 10: 1, 11: 0, 12: 0 }) })], [])
    expect(rest).toEqual([])
    expect(conflict).toMatchObject({ kind: 'DAYPARTING_OVERLAP', objectLevel: 'CAMPAIGN', objectId: 'c1', objectName: '活动一', field: 'state', overlapHours: 2 })
    // 冲突格是第 10 与第 12 格（第 11 格两个都是 0，取值相同不算冲突）
    expect(conflict!.parties.map(party => [party.id, party.effective, party.effectiveHours])).toEqual([
      ['s1', false, 0],
      ['s2', true, 2],
    ])
  })

  it('两个启停策略取值完全相同、或作用对象不重叠，没有冲突', () => {
    expect(find([strategy({ id: 's1', grid: grid(0) }), strategy({ id: 's2', grid: grid(0) })], [])).toEqual([])
    expect(find([strategy({ id: 's1', grid: grid(0) }), strategy({ id: 's2', grid: grid(1), targetIds: ['c2'] })], [])).toEqual([])
  })

  it('竞价系数策略只有系数不等于 1 的格子才会动手；系数不重叠就没有冲突', () => {
    const bid = (id: string, overrides: Record<number, number>) => strategy({ id, kind: 'BID_MULTIPLIER', level: 'AD_GROUP', targetIds: ['g1'], grid: grid(1, overrides) })
    expect(find([bid('b1', { 5: 1.5 }), bid('b2', { 6: 0.5 })], [])).toEqual([])
    const [conflict] = find([bid('b1', { 5: 1.5, 7: 2 }), bid('b2', { 5: 0.5, 7: 2 })], [])
    expect(conflict).toMatchObject({ objectLevel: 'AD_GROUP', objectId: 'g1', field: 'bid', overlapHours: 1 })
  })

  it('活动级的竞价系数策略执行器不会写，不参与冲突', () => {
    const campaignBid = (id: string) => strategy({ id, kind: 'BID_MULTIPLIER', level: 'CAMPAIGN', grid: grid(2) })
    expect(find([campaignBid('s1'), campaignBid('s2')], [])).toEqual([])
  })

  it('已暂停的策略与规则、建议模式的规则、不会写的规则动作、范围里找不到的对象都不参与', () => {
    expect(find([strategy({ id: 's1', grid: grid(0) }), strategy({ id: 's2', status: 'PAUSED', grid: grid(1) })], [])).toEqual([])
    expect(
      find([strategy({ id: 's1' })], [rule({ id: 'r1', status: 'PAUSED' }), rule({ id: 'r2', mode: 'SUGGEST' }), rule({ id: 'r3', level: 'TARGET' }), rule({ id: 'r4', actionType: 'NEGATE' })]),
    ).toEqual([])
    expect(find([strategy({ id: 's1', targetIds: ['gone'] }), strategy({ id: 's2', targetIds: ['gone'], grid: grid(0) })], [])).toEqual([])
  })

  it('自动规则与分时策略作用同一活动状态：分时策略生效，规则被忽略；范围为空的规则覆盖本账户全部活动，不碰别的账户', () => {
    const conflicts = find([strategy({ id: 's1', targetIds: ['c1', 'c9'] })], [rule({ id: 'r1' })])
    expect(conflicts.map(item => item.objectId)).toEqual(['c1'])
    expect(conflicts[0]).toMatchObject({ kind: 'RULE_VS_DAYPARTING', overlapHours: null })
    expect(conflicts[0]!.parties.map(party => [party.type, party.id, party.effective])).toEqual([
      ['DAYPARTING', 's1', true],
      ['RULE', 'r1', false],
    ])
  })

  it('规则只管指定的活动时，只在这些活动上冲突', () => {
    expect(find([strategy({ id: 's1', targetIds: ['c1', 'c2'] })], [rule({ id: 'r1', campaignIds: ['c2'] })]).map(item => item.objectId)).toEqual(['c2'])
  })

  it('两条规则改同一活动的同一字段：编号大的生效；改的字段不同不冲突', () => {
    const conflicts = find([], [rule({ id: 'r1' }), rule({ id: 'r2', actionType: 'ENABLE' }), rule({ id: 'r3', actionType: 'ADJUST_BUDGET' })])
    const state = conflicts.filter(item => item.field === 'state')
    expect(state.map(item => item.objectId)).toEqual(['c1', 'c2'])
    expect(state[0]).toMatchObject({ kind: 'RULE_OVERLAP', fieldLabel: '启停状态' })
    expect(state[0]!.parties.map(party => [party.id, party.effective])).toEqual([
      ['r1', false],
      ['r2', true],
    ])
    expect(conflicts.filter(item => item.field === 'budget')).toEqual([])
  })

  it('结果按对象与字段排序；冲突计数把每个策略和规则牵涉的数量汇总', () => {
    const conflicts = find([strategy({ id: 's1', targetIds: ['c1', 'c2'] })], [rule({ id: 'r1' })])
    expect(conflicts.map(item => item.key)).toEqual(['CAMPAIGN|c1|state', 'CAMPAIGN|c2|state'])
    expect(conflictCounts(conflicts)).toEqual({ s1: 2, r1: 2 })
  })
})

describe('重复关键词', () => {
  const record = (id: string, adGroupId: string, over: Record<string, unknown> = {}) => ({
    id,
    adsProfileId: 'p1',
    campaignId: 'cx1',
    adGroupId,
    text: 'Yoga Mat',
    matchType: 'EXACT',
    bid: 1,
    state: 'ENABLED',
    ...over,
  })

  it('同账户同词同匹配方式出现在两个及以上广告组才算；词不分大小写；匹配方式不同不算', () => {
    const groups = groupDuplicateKeywords([
      record('k1', 'ag1'),
      record('k2', 'ag2', { text: ' yoga  mat ' }),
      record('k3', 'ag3', { matchType: 'PHRASE' }),
      record('k4', 'ag4', { adsProfileId: 'p2' }),
      record('k5', 'ag1', { text: 'solo' }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ adsProfileId: 'p1', text: 'yoga mat', matchType: 'EXACT' })
    expect(groups[0]!.records.map(item => item.id)).toEqual(['k1', 'k2'])
  })

  it('已归档的不算；同一广告组里的重复不算；不同活动下同名广告组外部编号相同按活动区分', () => {
    expect(groupDuplicateKeywords([record('k1', 'ag1'), record('k2', 'ag2', { state: 'ARCHIVED' })])).toEqual([])
    expect(groupDuplicateKeywords([record('k1', 'ag1'), record('k2', 'ag1')])).toEqual([])
    expect(groupDuplicateKeywords([record('k1', 'ag1'), record('k2', 'ag1', { campaignId: 'cx2' })])).toHaveLength(1)
  })
})
