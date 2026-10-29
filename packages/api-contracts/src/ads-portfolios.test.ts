import { describe, expect, it } from 'vitest'
import { ADS_PORTFOLIO_SORTS, ADS_PORTFOLIO_WRITE_PENDING, type AdsPortfolioPace, type AdsPortfolioRow } from './ads-portfolios'
import {
  addDaysToText,
  adviceOf,
  budgetWindowOf,
  comparePortfolios,
  curveOf,
  describeRuleParams,
  idealCumulative,
  periodDays,
  paceOf,
  portfolioMatches,
  summarizePortfolios,
  weekdayWeights,
} from './ads-portfolios-math'
import { AdsPortfolioListQuerySchema } from './ads-portfolios-query'

const TODAY = '2026-10-11'
const month = budgetWindowOf({ budgetPeriod: 'MONTHLY', budgetStart: null, budgetEnd: null }, TODAY)

const okPace = (patch: Partial<AdsPortfolioPace> = {}): AdsPortfolioPace => ({
  state: 'OK',
  note: null,
  verdict: 'AHEAD',
  elapsedDays: 10,
  totalDays: 31,
  idealSpent: 1000,
  spent: 1500,
  ratio: 1.5,
  shape: 'LINEAR',
  capReached: false,
  ...patch,
})

const row = (patch: Partial<AdsPortfolioRow> = {}): AdsPortfolioRow => ({
  id: 'p1',
  portfolioId: 'PF1',
  name: '主力组合',
  status: 'ENABLED',
  adsProfileId: 'ap1',
  accountName: 'US',
  storeName: '店铺一',
  currency: 'USD',
  budget: { cap: 3100, kind: 'MONTHLY', from: '2026-10-01', to: '2026-10-31', issue: null },
  spent: 1500,
  spentSource: 'REPORTS',
  reportedSpent: 1400,
  pace: okPace(),
  campaigns: { total: 3, enabled: 2 },
  totals: { impressions: 1000, clicks: 100, spend: 200, sales: 800, orders: 20 },
  ratios: { acos: 0.25, roas: 4, ctr: 0.1, cpc: 2, cvr: 0.2 },
  syncedAt: '2026-10-10T00:00:00.000Z',
  ...patch,
})

describe('预算周期窗口', () => {
  it('按月循环取“今天”所在的自然月（含闰年二月）', () => {
    expect(month).toEqual({ kind: 'MONTHLY', from: '2026-10-01', to: '2026-10-31', totalDays: 31, issue: null })
    expect(budgetWindowOf({ budgetPeriod: 'monthly', budgetStart: null, budgetEnd: null }, '2028-02-10')).toMatchObject({ from: '2028-02-01', to: '2028-02-29', totalDays: 29 })
  })

  it('指定日期范围用起止日；缺起止日、起日晚于止日、超过 400 天都算认不出，并写明原因', () => {
    expect(budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2026-11-20', budgetEnd: '2026-11-30' }, TODAY)).toEqual({
      kind: 'DATE_RANGE',
      from: '2026-11-20',
      to: '2026-11-30',
      totalDays: 11,
      issue: null,
    })
    expect(budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: null, budgetEnd: null }, TODAY)).toMatchObject({ kind: 'UNKNOWN', issue: expect.stringContaining('起止日') })
    expect(budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2026-12-01', budgetEnd: '2026-11-01' }, TODAY).kind).toBe('UNKNOWN')
    expect(budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2025-01-01', budgetEnd: '2026-12-31' }, TODAY).issue).toContain('上限 400 天')
  })

  it('没有周期文字但有起止日按指定日期范围；其他取值与没有周期不猜', () => {
    expect(budgetWindowOf({ budgetPeriod: null, budgetStart: '2026-10-05', budgetEnd: '2026-10-09' }, TODAY).kind).toBe('DATE_RANGE')
    expect(budgetWindowOf({ budgetPeriod: 'DAILY', budgetStart: null, budgetEnd: null }, TODAY)).toMatchObject({ kind: 'UNKNOWN', issue: expect.stringContaining('DAILY') })
    expect(budgetWindowOf({ budgetPeriod: null, budgetStart: null, budgetEnd: null }, TODAY).issue).toContain('没有同步到预算周期')
  })
})

describe('日期小工具', () => {
  it('含首尾的天数与跨月加减', () => {
    expect(periodDays('2026-10-01', '2026-10-31')).toBe(31)
    expect(periodDays('2026-10-05', '2026-10-04')).toBe(0)
    expect(addDaysToText('2026-10-31', 1)).toBe('2026-11-01')
    expect(addDaysToText('2026-03-01', -1)).toBe('2026-02-28')
  })
})

describe('历史节奏与理想曲线', () => {
  // 2026-09-14 是周一；连续 28 天，周六周日花得多
  const history = Array.from({ length: 28 }, (_item, index) => {
    const date = addDaysToText('2026-09-14', index)
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay()
    return { date, spend: weekday === 0 || weekday === 6 ? 200 : 100 }
  })

  it('星期权重围绕 1：周末高、平日低，加权平均为 1', () => {
    const weights = weekdayWeights(history)!
    expect(weights).toHaveLength(7)
    expect(weights[0]).toBeGreaterThan(1)
    expect(weights[6]).toBeGreaterThan(1)
    expect(weights[1]).toBeLessThan(1)
    expect(weights.reduce((sum, weight) => sum + weight, 0) / 7).toBeCloseTo(1, 6)
  })

  it('历史跨度不足、没有花费、没有数据都返回 null（退回按天均摊）', () => {
    expect(weekdayWeights([])).toBeNull()
    expect(weekdayWeights(history.slice(0, 10))).toBeNull()
    expect(weekdayWeights(history.map(item => ({ ...item, spend: 0 })))).toBeNull()
  })

  it('缺的天按 0 算，从最早有数据的那天起算', () => {
    const sparse = [history[0], history[27]]
    const weights = weekdayWeights(sparse)
    expect(weights).not.toBeNull()
    expect(weights![1]).toBeGreaterThan(0)
  })

  it('理想累计：最后一天等于预算上限；没有权重按天均摊；有权重时周末涨得更快', () => {
    const linear = idealCumulative('2026-10-01', '2026-10-31', 3100, null)
    expect(linear).toHaveLength(31)
    expect(linear[0].ideal).toBeCloseTo(100, 6)
    expect(linear[9].ideal).toBeCloseTo(1000, 6)
    expect(linear[30].ideal).toBeCloseTo(3100, 6)
    const weights = weekdayWeights(history)!
    const shaped = idealCumulative('2026-10-01', '2026-10-31', 3100, weights)
    expect(shaped[30].ideal).toBeCloseTo(3100, 4)
    // 2026-10-03 是周六：当天增量大于平日 2026-10-02 的增量
    expect(shaped[2].ideal - shaped[1].ideal).toBeGreaterThan(shaped[1].ideal - shaped[0].ideal)
  })
})

describe('节奏判断', () => {
  const input = { window: month, cap: 3100, currency: 'USD', spent: 1000, today: TODAY, weights: null }

  it('周期内第 11 天：已过 10 天，理想累计 1000，花 1000 是基本匹配', () => {
    const pace = paceOf(input)
    expect(pace).toMatchObject({ state: 'OK', verdict: 'ON_TRACK', elapsedDays: 10, totalDays: 31, shape: 'LINEAR', capReached: false })
    expect(pace.idealSpent).toBeCloseTo(1000, 6)
    expect(pace.ratio).toBeCloseTo(1, 6)
    expect(pace.note).toContain('按天均摊')
  })

  it('偏差不超过 10% 算正常，超过才算偏快或偏慢（边界值不算偏）', () => {
    expect(paceOf({ ...input, spent: 1100 }).verdict).toBe('ON_TRACK')
    expect(paceOf({ ...input, spent: 1101 }).verdict).toBe('AHEAD')
    expect(paceOf({ ...input, spent: 900 }).verdict).toBe('ON_TRACK')
    expect(paceOf({ ...input, spent: 899 }).verdict).toBe('BEHIND')
  })

  it('有历史权重时形状标 HISTORY 且不带“按天均摊”提示', () => {
    const pace = paceOf({ ...input, weights: [1, 1, 1, 1, 1, 1, 1] })
    expect(pace.shape).toBe('HISTORY')
    expect(pace.note).toBeNull()
  })

  it('算不出的原因：没有预算上限、周期不认识、非美元、没有花费来源，各有各的说明，不给判断', () => {
    expect(paceOf({ ...input, cap: null })).toMatchObject({ state: 'NO_BUDGET', verdict: null, ratio: null })
    expect(paceOf({ ...input, window: budgetWindowOf({ budgetPeriod: 'DAILY', budgetStart: null, budgetEnd: null }, TODAY) })).toMatchObject({ state: 'UNKNOWN_PERIOD', verdict: null })
    expect(paceOf({ ...input, currency: 'CAD' })).toMatchObject({ state: 'OTHER_CURRENCY' })
    expect(paceOf({ ...input, spent: null })).toMatchObject({ state: 'NO_SPEND_DATA', spent: null })
  })

  it('周期还没开始或今天是第一天：不比较；预算为 0 时不会除以 0', () => {
    expect(paceOf({ ...input, today: '2026-10-01' })).toMatchObject({ state: 'NOT_STARTED', verdict: null, elapsedDays: 0 })
    const future = budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2026-11-20', budgetEnd: '2026-11-30' }, TODAY)
    expect(paceOf({ ...input, window: future }).note).toContain('2026-11-20')
    expect(paceOf({ ...input, cap: 0, spent: 0 })).toMatchObject({ state: 'OK', ratio: null, verdict: null })
  })

  it('周期已结束：理想累计等于预算上限，超支算偏快、没用完算偏慢', () => {
    const ended = budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2026-10-01', budgetEnd: '2026-10-05' }, TODAY)
    expect(paceOf({ ...input, window: ended, cap: 500, spent: 600 })).toMatchObject({ elapsedDays: 5, idealSpent: 500, verdict: 'AHEAD' })
    expect(paceOf({ ...input, window: ended, cap: 500, spent: 300 }).verdict).toBe('BEHIND')
  })

  it('已用达到预算上限标记 capReached', () => {
    expect(paceOf({ ...input, spent: 3100 }).capReached).toBe(true)
    expect(paceOf({ ...input, spent: 3099.99 }).capReached).toBe(false)
  })
})

describe('逐日曲线', () => {
  it('今天及以后不画实际；实际累计缺的天不增加；没有预算上限时理想为空', () => {
    const daily = new Map([
      ['2026-10-01', 100],
      ['2026-10-03', 50],
    ])
    const points = curveOf(month, 3100, null, daily, '2026-10-04')
    expect(points).toHaveLength(31)
    expect(points[0]).toMatchObject({ date: '2026-10-01', actual: 100, daily: 100 })
    expect(points[1]).toMatchObject({ actual: 100, daily: null })
    expect(points[2]).toMatchObject({ actual: 150, daily: 50 })
    expect(points[3]).toMatchObject({ date: '2026-10-04', actual: null, daily: null })
    expect(points[30].ideal).toBeCloseTo(3100, 6)
    expect(curveOf(month, null, null, daily, '2026-10-04')[0].ideal).toBeNull()
    expect(curveOf(budgetWindowOf({ budgetPeriod: 'DAILY', budgetStart: null, budgetEnd: null }, TODAY), 100, null, daily, TODAY)).toEqual([])
  })

  it('没有任何逐日花费时实际线整条为空，不画成 0', () => {
    const points = curveOf(month, 3100, null, new Map(), '2026-10-04')
    expect(points.every(item => item.actual === null)).toBe(true)
    expect(points[0].ideal).not.toBeNull()
  })
})

describe('调整建议', () => {
  const base = { window: month, cap: 3100, today: TODAY, currentDailyBudget: 120, recentDaily: 200 }

  it('偏快且按最近速度会提前花完：给出预计用尽日与剩余每天最多可花', () => {
    const { advice } = adviceOf({ ...base, pace: okPace({ spent: 1500, verdict: 'AHEAD', ratio: 1.5 }) })
    expect(advice).toMatchObject({ kind: 'EXHAUST_EARLY', remainingDays: 21, remainingBudget: 1600, exhaustDate: '2026-10-19' })
    expect(advice?.sustainableDaily).toBeCloseTo(76.190476, 5)
    expect(advice?.text).toContain('2026-10-19')
    expect(advice?.text).toContain('50%')
  })

  it('偏快但周期内用得完：只提醒平稳节奏', () => {
    const { advice } = adviceOf({ ...base, recentDaily: 60, pace: okPace({ spent: 1200, verdict: 'AHEAD', ratio: 1.2 }) })
    expect(advice).toMatchObject({ kind: 'LOWER_DAILY', exhaustDate: null })
  })

  it('偏慢：日预算合计低于每天可花的钱建议提高；已经够用说明不是预算限制；没有日预算数据不判断', () => {
    const slow = okPace({ spent: 500, verdict: 'BEHIND', ratio: 0.5 })
    expect(adviceOf({ ...base, pace: slow, currentDailyBudget: 50 }).advice?.kind).toBe('RAISE_DAILY')
    expect(adviceOf({ ...base, pace: slow, currentDailyBudget: 500 }).advice?.kind).toBe('NOT_LIMITED_BY_BUDGET')
    expect(adviceOf({ ...base, pace: slow, currentDailyBudget: null }).advice?.kind).toBe('BEHIND')
  })

  it('节奏正常、周期已结束、算不出节奏时没有建议并写明原因', () => {
    expect(adviceOf({ ...base, pace: okPace({ verdict: 'ON_TRACK' }) })).toEqual({ advice: null, note: '节奏正常，没有调整建议' })
    const ended = budgetWindowOf({ budgetPeriod: 'DATE_RANGE', budgetStart: '2026-10-01', budgetEnd: '2026-10-05' }, TODAY)
    expect(adviceOf({ ...base, window: ended, pace: okPace() }).note).toContain('已经结束')
    expect(adviceOf({ ...base, pace: okPace({ state: 'NO_BUDGET', note: '没有预算' }) })).toEqual({ advice: null, note: '没有预算' })
  })

  it('已用达到上限：提示可能已被暂停投放，优先于偏快偏慢的建议', () => {
    expect(adviceOf({ ...base, pace: okPace({ spent: 3100, capReached: true }) }).advice?.kind).toBe('CAP_REACHED')
  })
})

describe('列表排序、筛选、汇总', () => {
  it('名称搜索不分大小写', () => {
    expect(portfolioMatches(row({ name: 'Summer Sale' }), 'summer')).toBe(true)
    expect(portfolioMatches(row(), undefined)).toBe(true)
    expect(portfolioMatches(row(), '不存在')).toBe(false)
  })

  it('空值永远排最后（升降序都一样），并列按名称再按编号', () => {
    const rows = [row({ id: 'a', name: 'A', spent: null }), row({ id: 'b', name: 'B', spent: 10 }), row({ id: 'c', name: 'C', spent: 30 }), row({ id: 'd', name: 'A2', spent: 10 })]
    expect(rows.sort((x, y) => comparePortfolios(x, y, 'spent', 'desc')).map(item => item.id)).toEqual(['c', 'd', 'b', 'a'])
    expect(rows.sort((x, y) => comparePortfolios(x, y, 'spent', 'asc')).map(item => item.id)).toEqual(['d', 'b', 'c', 'a'])
  })

  it('指标列的空值（没有汇总行）排后面，不论升降序；每个白名单排序字段都能比较', () => {
    const withMetrics = row({ id: 'm' })
    const without = row({ id: 'n', totals: null, ratios: null })
    for (const field of ['spend', 'sales', 'acos', 'roas'] as const) {
      expect(comparePortfolios(withMetrics, without, field, 'desc')).toBe(-1)
      expect(comparePortfolios(withMetrics, without, field, 'asc')).toBe(-1)
    }
    for (const field of ADS_PORTFOLIO_SORTS) expect(Number.isFinite(comparePortfolios(withMetrics, without, field, 'desc'))).toBe(true)
  })

  it('汇总：节奏个数分开数；预算上限与已用只合计已算出节奏的组合，一个都没有是 null', () => {
    const rows = [
      row({ id: '1' }),
      row({ id: '2', pace: okPace({ verdict: 'BEHIND' }), spent: 500, budget: { cap: 1000, kind: 'MONTHLY', from: '2026-10-01', to: '2026-10-31', issue: null } }),
      row({ id: '3', pace: okPace({ state: 'NO_BUDGET', verdict: null }), budget: { cap: null, kind: 'MONTHLY', from: null, to: null, issue: null } }),
    ]
    expect(summarizePortfolios(rows)).toEqual({ portfolios: 3, withBudget: 2, ahead: 1, onTrack: 0, behind: 1, cap: 4100, spent: 2000 })
    expect(summarizePortfolios([rows[2]])).toMatchObject({ cap: null, spent: null })
  })
})

describe('预算规则参数摘要', () => {
  it('只展开第一层；嵌套压成一行；过长截断；最多 12 项；空与非对象不报错', () => {
    expect(describeRuleParams({ multiplier: 1.5, window: { from: '11-01', to: '11-30' }, note: 'x'.repeat(200) })).toEqual([
      { key: 'multiplier', value: '1.5' },
      { key: 'window', value: '{"from":"11-01","to":"11-30"}' },
      { key: 'note', value: `${'x'.repeat(117)}...` },
    ])
    expect(describeRuleParams(Object.fromEntries(Array.from({ length: 20 }, (_item, index) => [`k${index}`, index])))).toHaveLength(12)
    expect(describeRuleParams(null)).toEqual([])
    expect(describeRuleParams([1, 2])).toEqual([{ key: 'params', value: '[1,2]' }])
  })
})

describe('请求校验与写入占位', () => {
  it('默认按花费从高到低；排序字段与节奏筛选走白名单；未知参数拒绝', () => {
    expect(AdsPortfolioListQuerySchema.parse({}).sort).toEqual({ field: 'spend', dir: 'desc' })
    expect(AdsPortfolioListQuerySchema.parse({ sort: 'paceRatio:asc', pace: 'AHEAD', q: '大促' })).toMatchObject({ sort: { field: 'paceRatio', dir: 'asc' }, pace: 'AHEAD', q: '大促' })
    expect(AdsPortfolioListQuerySchema.safeParse({ sort: 'profit:desc' }).success).toBe(false)
    expect(AdsPortfolioListQuerySchema.safeParse({ pace: 'FAST' }).success).toBe(false)
    expect(AdsPortfolioListQuerySchema.safeParse({ unknown: '1' }).success).toBe(false)
  })

  it('组合写入暂未提供入口：说明写明范围与去向', () => {
    expect(ADS_PORTFOLIO_WRITE_PENDING.state).toBe('NOT_CONNECTED')
    expect(ADS_PORTFOLIO_WRITE_PENDING.note).toContain('暂未提供写入入口')
    expect(ADS_PORTFOLIO_WRITE_PENDING.note).not.toContain('P3-17')
  })
})
