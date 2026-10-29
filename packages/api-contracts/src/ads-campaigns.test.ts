import { describe, expect, it } from 'vitest'
import { ADS_CAMPAIGN_TABS, ADS_CAMPAIGN_TAG_LIMITS, adsCampaignTabsFor, type AdsCampaignRow } from './ads-campaigns'
import {
  applyTagChange,
  buildHourlyCells,
  campaignBudgetUtilization,
  compareCampaignRows,
  flattenFields,
  hourlyMetricValue,
  isWastedTarget,
  normalizeTags,
  payloadNumber,
  payloadSummary,
  sameTags,
  stockOf,
  tagProblem,
  termKey,
  termStatus,
  weekdayHourOf,
} from './ads-campaigns-math'
import { AdsCampaignListQuerySchema, AdsCampaignMetaBodySchema, AdsCampaignTabQuerySchema, AdsRecommendationDismissBodySchema } from './ads-campaigns-query'

const totals = (spend: number | null, sales: number | null) => ({ impressions: 1000, clicks: 100, spend, sales, orders: 5 })
const row = (id: string, name: string, spend: number | null): AdsCampaignRow =>
  ({ id, name, budget: null, syncedAt: '2026-10-01', totals: spend === null ? null : totals(spend, 100), ratios: null }) as unknown as AdsCampaignRow

describe('广告活动页签目录', () => {
  it('共 12 个页签；创意只有品牌推广与展示型推广，受众只有展示型推广', () => {
    expect(ADS_CAMPAIGN_TABS).toHaveLength(12)
    const keys = (product: string) => adsCampaignTabsFor(product).map(tab => tab.key)
    expect(keys('SPONSORED_PRODUCTS')).not.toContain('creatives')
    expect(keys('SPONSORED_PRODUCTS')).not.toContain('audiences')
    expect(keys('SPONSORED_BRANDS')).toContain('creatives')
    expect(keys('SPONSORED_BRANDS')).not.toContain('audiences')
    expect(keys('SPONSORED_DISPLAY')).toEqual(expect.arrayContaining(['creatives', 'audiences']))
    expect(keys('SPONSORED_PRODUCTS')).toHaveLength(10)
  })
})

describe('标签', () => {
  it('规整：合并空白、去空标签、不分大小写去重并保留先出现的写法', () => {
    expect(normalizeTags(['  清仓  ', '清仓', 'New  Item', 'new item', ' '])).toEqual(['清仓', 'New Item'])
  })

  it('追加、移除、整体替换；整体替换为空列表就是清空', () => {
    expect(applyTagChange(['a'], 'ADD', ['b', 'A'])).toEqual(['a', 'b'])
    expect(applyTagChange(['a', 'b'], 'REMOVE', ['B'])).toEqual(['a'])
    expect(applyTagChange(['a', 'b'], 'SET', ['c'])).toEqual(['c'])
    expect(applyTagChange(['a'], 'SET', [])).toEqual([])
  })

  it('sameTags 不分顺序与大小写', () => {
    expect(sameTags(['a', 'B'], ['b', 'A'])).toBe(true)
    expect(sameTags(['a'], ['a', 'b'])).toBe(false)
  })

  it('tagProblem：条数、长度、逗号与不可见字符', () => {
    expect(tagProblem(['正常'])).toBeNull()
    expect(tagProblem(Array.from({ length: ADS_CAMPAIGN_TAG_LIMITS.MAX_TAGS + 1 }, (_, i) => `t${i}`))).toContain('最多')
    expect(tagProblem(['x'.repeat(ADS_CAMPAIGN_TAG_LIMITS.MAX_LENGTH + 1)])).toContain('超过')
    expect(tagProblem(['a,b'])).toContain('逗号')
    expect(tagProblem(['a\nb'])).toContain('不可见')
  })
})

describe('预算利用率与浪费判定', () => {
  const base = { state: 'ENABLED', budget: 10, budgetType: 'DAILY', startDate: null, endDate: null }

  it('只算启用中的日预算活动；缺任何一项为 null，不是 0', () => {
    expect(campaignBudgetUtilization(base, 50, '2026-10-01', '2026-10-05')).toBeCloseTo(1, 6)
    expect(campaignBudgetUtilization({ ...base, state: 'PAUSED' }, 50, '2026-10-01', '2026-10-05')).toBeNull()
    expect(campaignBudgetUtilization({ ...base, budgetType: 'LIFETIME' }, 50, '2026-10-01', '2026-10-05')).toBeNull()
    expect(campaignBudgetUtilization({ ...base, budget: null }, 50, '2026-10-01', '2026-10-05')).toBeNull()
    expect(campaignBudgetUtilization(base, null, '2026-10-01', '2026-10-05')).toBeNull()
  })

  it('isWastedTarget：花费与点击都达到下限且没有订单', () => {
    const rules = { minSpend: 20, minClicks: 20 }
    expect(isWastedTarget({ spend: 25, clicks: 30, orders: 0 }, rules)).toBe(true)
    expect(isWastedTarget({ spend: 25, clicks: 30, orders: 1 }, rules)).toBe(false)
    expect(isWastedTarget({ spend: 10, clicks: 30, orders: 0 }, rules)).toBe(false)
    expect(isWastedTarget({ spend: null, clicks: 30, orders: 0 }, rules)).toBe(false)
  })
})

describe('搜索词状态', () => {
  it('完全相同才算已投放或已否定（不分大小写与多余空格）；否定优先', () => {
    expect(termKey('  Yoga   Mat ')).toBe('yoga mat')
    const targeted = new Set(['yoga mat'])
    const negated = new Set(['cheap mat'])
    expect(termStatus('YOGA  mat', targeted, negated)).toBe('TARGETED')
    expect(termStatus('cheap mat', targeted, negated)).toBe('NEGATED')
    expect(termStatus('yoga mat pro', targeted, negated)).toBe('UNTARGETED')
    expect(termStatus('yoga mat', targeted, new Set(['yoga mat']))).toBe('NEGATED')
  })
})

describe('分时格子', () => {
  it('按企业时区归到“星期 × 小时”：周一为 0', () => {
    // 2026-10-26 是周一；UTC 23:00 在上海是周二 07:00
    expect(weekdayHourOf(new Date('2026-10-26T10:00:00Z'), 'UTC')).toEqual({ weekday: 0, hour: 10 })
    expect(weekdayHourOf(new Date('2026-10-26T23:00:00Z'), 'Asia/Shanghai')).toEqual({ weekday: 1, hour: 7 })
  })

  it('同一格子累加；花费与销售额全是空的格子保持空，不当 0', () => {
    const cells = buildHourlyCells(
      [
        { hourStart: new Date('2026-10-26T10:00:00Z'), clicks: 10, orders: 1, spend: 5, sales: 20 },
        { hourStart: new Date('2026-11-02T10:00:00Z'), clicks: 10, orders: 0, spend: 3, sales: null },
        { hourStart: new Date('2026-10-26T11:00:00Z'), clicks: 4, orders: 0, spend: null, sales: null },
      ],
      'UTC',
    )
    expect(cells).toHaveLength(2)
    expect(cells[0]).toMatchObject({ weekday: 0, hour: 10, clicks: 20, orders: 1, spend: 8, sales: 20, samples: 2 })
    expect(cells[1]).toMatchObject({ hour: 11, spend: null, sales: null, samples: 1 })
  })

  it('指标取值：分母为 0 或缺失返回 null', () => {
    const cell = { weekday: 0, hour: 1, spend: 10, clicks: 20, orders: 2, sales: 50, samples: 1 }
    expect(hourlyMetricValue(cell, 'spend')).toBe(10)
    expect(hourlyMetricValue(cell, 'orders')).toBe(2)
    expect(hourlyMetricValue(cell, 'acos')).toBeCloseTo(0.2, 6)
    expect(hourlyMetricValue(cell, 'cpc')).toBeCloseTo(0.5, 6)
    expect(hourlyMetricValue({ ...cell, sales: 0 }, 'acos')).toBeNull()
    expect(hourlyMetricValue({ ...cell, clicks: 0 }, 'cpc')).toBeNull()
    expect(hourlyMetricValue({ ...cell, spend: null }, 'acos')).toBeNull()
  })
})

describe('库存与排序', () => {
  it('可售没给是 UNKNOWN，不当 0', () => {
    expect(stockOf(null)).toBe('UNKNOWN')
    expect(stockOf(0)).toBe('OUT_OF_STOCK')
    expect(stockOf(3)).toBe('IN_STOCK')
  })

  it('排序：空值永远在最后（升降序都是）；并列按名称再按编号', () => {
    const rows = [row('3', 'b', null), row('2', 'a', 5), row('1', 'c', 9), row('4', 'a', 5)]
    const sorted = (dir: 'asc' | 'desc') => [...rows].sort((a, b) => compareCampaignRows(a, b, 'spend', dir)).map(item => item.id)
    expect(sorted('desc')).toEqual(['1', '2', '4', '3'])
    expect(sorted('asc')).toEqual(['2', '4', '1', '3'])
  })
})

describe('推荐与预测原文的保守读取', () => {
  it('payloadNumber：顶层或下一层第一个能读成数字的字段', () => {
    expect(payloadNumber({ suggestedBudget: 30 }, ['suggestedBudget'])).toBe(30)
    expect(payloadNumber({ detail: { suggestedBid: '1.25' } }, ['suggestedBid'])).toBe(1.25)
    expect(payloadNumber({ suggestedBid: 'abc' }, ['suggestedBid'])).toBeNull()
    expect(payloadNumber(null, ['x'])).toBeNull()
  })

  it('payloadSummary：取第一个非空文字并截到 200 字', () => {
    expect(payloadSummary({ title: ' ', description: '提高预算' })).toBe('提高预算')
    expect(payloadSummary({ message: 'x'.repeat(300) })).toHaveLength(200)
    expect(payloadSummary({ other: 1 })).toBeNull()
  })

  it('flattenFields：只留数值与短文字，限制数量与深度', () => {
    const fields = flattenFields({ a: 1, b: { c: 'ok', d: 'x'.repeat(41) }, list: [1, 2] })
    expect(fields).toEqual([
      { path: 'a', value: '1' },
      { path: 'b.c', value: 'ok' },
      { path: 'list[0]', value: '1' },
      { path: 'list[1]', value: '2' },
    ])
    expect(flattenFields({ a: 1, b: 2, c: 3 }, 2)).toHaveLength(2)
  })
})

describe('请求校验', () => {
  it('列表：默认按花费降序；排序字段与筛选值有白名单', () => {
    const ok = AdsCampaignListQuerySchema.parse({})
    expect(ok.sort).toEqual({ field: 'spend', dir: 'desc' })
    expect(AdsCampaignListQuerySchema.safeParse({ sort: 'password' }).success).toBe(false)
    expect(AdsCampaignListQuerySchema.safeParse({ adProduct: 'SPONSORED_PRODUCTS', anomaly: 'NOPE' }).success).toBe(false)
  })

  it('页签：每页 1–200，状态白名单，允许范围参数共存', () => {
    expect(AdsCampaignTabQuerySchema.parse({}).pageSize).toBe(50)
    expect(AdsCampaignTabQuerySchema.safeParse({ pageSize: 500 }).success).toBe(false)
    expect(AdsCampaignTabQuerySchema.safeParse({ status: 'OTHER' }).success).toBe(false)
    expect(AdsCampaignTabQuerySchema.safeParse({ from: '2026-10-01', storeIds: 's1' }).success).toBe(true)
  })

  it('批量标签与负责人：至少改一项、版本号必填、模式白名单、不允许多余字段', () => {
    const item = { id: 'c1', version: 1 }
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [item], tags: { mode: 'ADD', values: ['a'] } }).success).toBe(true)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [item], ownerId: null }).success).toBe(true)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [item] }).success).toBe(false)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [], ownerId: 'u1' }).success).toBe(false)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [{ id: 'c1' }], ownerId: 'u1' }).success).toBe(false)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [item], tags: { mode: 'DROP', values: [] } }).success).toBe(false)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [item], ownerId: 'u1', extra: 1 }).success).toBe(false)
    expect(AdsCampaignMetaBodySchema.safeParse({ items: [{ id: 'a b', version: 1 }], ownerId: 'u1' }).success).toBe(false)
  })

  it('忽略官方推荐必须写原因', () => {
    expect(AdsRecommendationDismissBodySchema.safeParse({}).success).toBe(false)
    expect(AdsRecommendationDismissBodySchema.safeParse({ reason: '短' }).success).toBe(false)
    expect(AdsRecommendationDismissBodySchema.safeParse({ reason: '不适用于本活动' }).success).toBe(true)
  })
})
