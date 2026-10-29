import { describe, expect, it } from 'vitest'
import { compareRangeOf, previousRange, rangePresets, todayInMarketplace, yearOverYearRange } from './dates'

// 统一日期组件的区间计算（P6-04）：预设范围、环比 / 同比 / 自定义对比，跨月、跨年、闰年都要对；今天按站点时区（美国西部）算。

const preset = (today: string, key: string) => rangePresets(today).find(item => item.key === key)!.range

describe('站点时区的今天', () => {
  it('UTC 已经是第二天凌晨时，站点（美国西部）还在前一天', () => {
    expect(todayInMarketplace(new Date('2026-10-27T05:00:00Z'))).toBe('2026-10-26')
    expect(todayInMarketplace(new Date('2026-01-01T03:00:00Z'))).toBe('2025-12-31')
  })
})

describe('预设范围', () => {
  it('今天、昨天、近 7/14/30 天都含今天，天数正确', () => {
    expect(preset('2026-10-26', 'today')).toEqual({ from: '2026-10-26', to: '2026-10-26' })
    expect(preset('2026-10-26', 'yesterday')).toEqual({ from: '2026-10-25', to: '2026-10-25' })
    expect(preset('2026-10-26', 'last7')).toEqual({ from: '2026-10-20', to: '2026-10-26' })
    expect(preset('2026-10-26', 'last14')).toEqual({ from: '2026-10-13', to: '2026-10-26' })
    expect(preset('2026-10-26', 'last30')).toEqual({ from: '2026-09-27', to: '2026-10-26' })
  })

  it('跨月、跨年的昨天与近 7 天', () => {
    expect(preset('2026-03-01', 'yesterday')).toEqual({ from: '2026-02-28', to: '2026-02-28' })
    expect(preset('2028-03-01', 'yesterday')).toEqual({ from: '2028-02-29', to: '2028-02-29' })
    expect(preset('2026-01-03', 'last7')).toEqual({ from: '2025-12-28', to: '2026-01-03' })
  })

  it('本月、上月：1 月的上月是去年 12 月；闰年 3 月的上月是 29 天', () => {
    expect(preset('2026-10-26', 'month')).toEqual({ from: '2026-10-01', to: '2026-10-26' })
    expect(preset('2026-10-26', 'lastMonth')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    expect(preset('2026-01-15', 'lastMonth')).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(preset('2026-03-10', 'lastMonth')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(preset('2028-03-10', 'lastMonth')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
  })

  it('本季、本年：按自然季度与自然年，到今天为止', () => {
    expect(preset('2026-02-20', 'quarter')).toEqual({ from: '2026-01-01', to: '2026-02-20' })
    expect(preset('2026-05-01', 'quarter')).toEqual({ from: '2026-04-01', to: '2026-05-01' })
    expect(preset('2026-09-30', 'quarter')).toEqual({ from: '2026-07-01', to: '2026-09-30' })
    expect(preset('2026-12-31', 'quarter')).toEqual({ from: '2026-10-01', to: '2026-12-31' })
    expect(preset('2026-10-26', 'year')).toEqual({ from: '2026-01-01', to: '2026-10-26' })
  })

  it('预设里有验收要求的全部项', () => {
    const keys = rangePresets('2026-10-26').map(item => item.key)
    for (const key of ['today', 'yesterday', 'last7', 'last14', 'last30', 'month', 'lastMonth', 'quarter', 'year']) expect(keys).toContain(key)
  })
})

describe('环比（上一期）', () => {
  it('与当前范围等长、紧邻其前', () => {
    expect(previousRange({ from: '2026-10-20', to: '2026-10-26' })).toEqual({ from: '2026-10-13', to: '2026-10-19' })
    expect(previousRange({ from: '2026-10-26', to: '2026-10-26' })).toEqual({ from: '2026-10-25', to: '2026-10-25' })
  })

  it('跨月：3 月 1 日到 3 月 7 日的上一期是 2 月下旬（平年与闰年天数不同）', () => {
    expect(previousRange({ from: '2026-03-01', to: '2026-03-07' })).toEqual({ from: '2026-02-22', to: '2026-02-28' })
    expect(previousRange({ from: '2028-03-01', to: '2028-03-07' })).toEqual({ from: '2028-02-23', to: '2028-02-29' })
  })

  it('跨年：1 月的上一期落在去年 12 月；整月范围的上一期按天数而不是按“上个月”', () => {
    expect(previousRange({ from: '2026-01-01', to: '2026-01-31' })).toEqual({ from: '2025-12-01', to: '2025-12-31' })
    expect(previousRange({ from: '2026-03-01', to: '2026-03-31' })).toEqual({ from: '2026-01-29', to: '2026-02-28' })
  })
})

describe('同比（去年同期）', () => {
  it('整体回退一年', () => {
    expect(yearOverYearRange({ from: '2026-10-20', to: '2026-10-26' })).toEqual({ from: '2025-10-20', to: '2025-10-26' })
  })

  it('跨年范围：起止分别回退一年', () => {
    expect(yearOverYearRange({ from: '2025-12-28', to: '2026-01-03' })).toEqual({ from: '2024-12-28', to: '2025-01-03' })
  })

  it('闰日：今年 2 月 29 日回到去年 2 月 28 日；去年是闰年则 2 月 28 日仍是 28 日', () => {
    expect(yearOverYearRange({ from: '2028-02-29', to: '2028-03-02' })).toEqual({ from: '2027-02-28', to: '2027-03-02' })
    expect(yearOverYearRange({ from: '2029-02-28', to: '2029-03-01' })).toEqual({ from: '2028-02-28', to: '2028-03-01' })
  })
})

describe('compareRangeOf', () => {
  const range = { from: '2026-10-20', to: '2026-10-26' }
  it('按方式推出对比区间；不对比、没有范围、自定义没给区间都是 null', () => {
    expect(compareRangeOf(range, 'previous')).toEqual({ from: '2026-10-13', to: '2026-10-19' })
    expect(compareRangeOf(range, 'yoy')).toEqual({ from: '2025-10-20', to: '2025-10-26' })
    expect(compareRangeOf(range, 'custom', { from: '2026-01-01', to: '2026-01-07' })).toEqual({ from: '2026-01-01', to: '2026-01-07' })
    expect(compareRangeOf(range, 'custom')).toBeNull()
    expect(compareRangeOf(range, 'none')).toBeNull()
    expect(compareRangeOf(null, 'previous')).toBeNull()
  })
})
