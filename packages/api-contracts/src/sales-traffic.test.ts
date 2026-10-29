import { describe, expect, it } from 'vitest'
import {
  SALES_TRAFFIC_ASIN_BACKFILL_DAYS,
  SALES_TRAFFIC_ASIN_REFRESH_DAYS,
  SALES_TRAFFIC_MAX_WINDOW_DAYS,
  percentToFraction,
  preferKiosk,
  salesTrafficAsinDays,
  salesTrafficDiffs,
  salesTrafficWindow,
  salesTrafficWindowIssue,
} from './sales-traffic'

// 2026-10-24 是周六。
const TODAY = '2026-10-24'

describe('销售与流量的查询窗口', () => {
  it('日粒度：有数据重拉最近 7 天，第一次回补 90 天，结束日都是昨天', () => {
    expect(salesTrafficWindow('DAY', TODAY, true)).toEqual({ startDate: '2026-10-17', endDate: '2026-10-23' })
    expect(salesTrafficWindow('DAY', TODAY, false)).toEqual({ startDate: '2026-07-26', endDate: '2026-10-23' })
  })

  it('周粒度：最近 5 个完整周（周日到周六）；周六当天这一周还没结束', () => {
    expect(salesTrafficWindow('WEEK', TODAY, true)).toEqual({ startDate: '2026-09-13', endDate: '2026-10-17' })
    expect(salesTrafficWindow('WEEK', '2026-10-25', true)).toEqual({ startDate: '2026-09-20', endDate: '2026-10-24' }) // 周日：昨天周六刚结束
    expect(salesTrafficWindow('WEEK', '2026-10-21', true).endDate).toBe('2026-10-17') // 周三：取上周六
    // 起点一定是周日
    expect(new Date(`${salesTrafficWindow('WEEK', TODAY, false).startDate}T00:00:00Z`).getUTCDay()).toBe(0)
  })

  it('月粒度：最近 3 个完整月；跨年', () => {
    expect(salesTrafficWindow('MONTH', TODAY, true)).toEqual({ startDate: '2026-07-01', endDate: '2026-09-30' })
    expect(salesTrafficWindow('MONTH', '2027-01-05', true)).toEqual({ startDate: '2026-10-01', endDate: '2026-12-31' })
  })

  it('所有粒度的窗口都在一次查询的跨度上限内', () => {
    for (const granularity of ['DAY', 'WEEK', 'MONTH'] as const) for (const hasData of [true, false]) expect(salesTrafficWindowIssue(salesTrafficWindow(granularity, TODAY, hasData), TODAY)).toBeNull()
  })

  it('ASIN 粒度：每次一天，有数据查最近 3 天，第一次回补 7 天，不含今天', () => {
    expect(SALES_TRAFFIC_ASIN_REFRESH_DAYS).toBe(3)
    expect(SALES_TRAFFIC_ASIN_BACKFILL_DAYS).toBe(7)
    expect(salesTrafficAsinDays(TODAY, true)).toEqual(['2026-10-23', '2026-10-22', '2026-10-21'])
    expect(salesTrafficAsinDays(TODAY, false)).toHaveLength(7)
    expect(salesTrafficAsinDays(TODAY, false).at(-1)).toBe('2026-10-17')
  })
})

describe('销售与流量的窗口校验', () => {
  it('格式、先后、跨度与保留期', () => {
    expect(salesTrafficWindowIssue({ startDate: '2026-10-01', endDate: '2026-10-07' })).toBeNull()
    expect(salesTrafficWindowIssue({ startDate: '2026/10/01', endDate: '2026-10-07' })).toBe('日期格式不对')
    expect(salesTrafficWindowIssue({ startDate: '2026-02-30', endDate: '2026-10-07' })).toBe('日期格式不对')
    expect(salesTrafficWindowIssue({ startDate: '2026-10-08', endDate: '2026-10-07' })).toBe('结束日早于开始日')
    expect(SALES_TRAFFIC_MAX_WINDOW_DAYS).toBe(92)
    expect(salesTrafficWindowIssue({ startDate: '2026-07-01', endDate: '2026-10-01' })).toContain('最多 92 天') // 93 天
    expect(salesTrafficWindowIssue({ startDate: '2026-07-02', endDate: '2026-10-01' })).toBeNull() // 92 天
    expect(salesTrafficWindowIssue({ startDate: '2024-01-01', endDate: '2024-01-07' }, TODAY)).toContain('只保留')
    expect(salesTrafficWindowIssue({ startDate: '2024-01-01', endDate: '2024-01-07' })).toBeNull() // 没给今天不查保留期
  })
})

describe('官方百分数换算', () => {
  it('百分数 → 0 到 1 的小数；没给、不是数字、超出范围都是 null，不补 0', () => {
    expect(percentToFraction(95.5)).toBe(0.955)
    expect(percentToFraction('12')).toBe(0.12)
    expect(percentToFraction(0)).toBe(0)
    expect(percentToFraction(100)).toBe(1)
    for (const bad of [null, undefined, '', 'abc', NaN, -1, 100.01, 250]) expect(percentToFraction(bad)).toBeNull()
  })
})

describe('来源核对', () => {
  const kiosk = { orderedSales: 100, unitsOrdered: 10, sessions: 50, pageViews: 200 }

  it('差异在容差内（绝对不超过 1，或相对不超过 2%）不记录', () => {
    expect(salesTrafficDiffs(kiosk, { ...kiosk, orderedSales: 101 })).toEqual([])
    expect(salesTrafficDiffs({ ...kiosk, pageViews: 1000 }, { ...kiosk, pageViews: 1020 })).toEqual([]) // 恰好 2%
  })

  it('超过容差的指标逐个记录，带差额与相对差异', () => {
    const diffs = salesTrafficDiffs(kiosk, { orderedSales: 110, unitsOrdered: 10, sessions: 40, pageViews: 200 })
    expect(diffs).toEqual([
      { metric: 'orderedSales', kioskValue: 100, reportValue: 110, delta: 10, relative: 0.1 },
      { metric: 'sessions', kioskValue: 50, reportValue: 40, delta: -10, relative: 0.2 },
    ])
  })

  it('只有一边有值的指标不比较（不是差异）；数据中心为 0 时相对差异为 null', () => {
    expect(salesTrafficDiffs(kiosk, { orderedSales: null, unitsOrdered: null, sessions: null, pageViews: null })).toEqual([])
    expect(salesTrafficDiffs({ ...kiosk, sessions: 0 }, { ...kiosk, sessions: 5 })).toEqual([{ metric: 'sessions', kioskValue: 0, reportValue: 5, delta: 5, relative: null }])
  })

  it('同键两个来源：数据中心优先，没有才用报告', () => {
    const rows = [
      { source: 'REPORT', id: 1 },
      { source: 'DATA_KIOSK', id: 2 },
    ]
    expect(preferKiosk(rows)?.id).toBe(2)
    expect(preferKiosk([rows[0]])?.id).toBe(1)
    expect(preferKiosk([])).toBeNull()
  })
})
