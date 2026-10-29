import { describe, expect, it } from 'vitest'
import { bucketBounds, bucketKey, eachDay, monthEnd, previousBucket, previousPeriod, resolvePeriods, todayIn, validZone, weekStart, yoyPeriod, zonedDayStart } from './period'

describe('经营控制台日期口径', () => {
  it('没有选择时间范围：默认近 30 天（含今天），并对比上一期', () => {
    const result = resolvePeriods({}, '2026-10-22')
    expect(result.period).toEqual({ from: '2026-09-23', to: '2026-10-22', days: 30 })
    expect(result.defaulted).toBe(true)
    expect(result.compare).toMatchObject({ mode: 'previous', from: '2026-08-24', to: '2026-09-22', days: 30 })
  })

  it('显式选择范围时按所选对比方式：不对比、上一期、去年同期、自定义', () => {
    const base = { from: '2026-10-01', to: '2026-10-07' }
    expect(resolvePeriods({ ...base, compare: 'none' }, '2026-10-22').compare).toBeNull()
    expect(resolvePeriods({ ...base, compare: 'previous' }, '2026-10-22').compare).toMatchObject({ from: '2026-09-24', to: '2026-09-30' })
    expect(resolvePeriods({ ...base, compare: 'yoy' }, '2026-10-22').compare).toMatchObject({ mode: 'yoy', from: '2025-10-01', to: '2025-10-07' })
    expect(resolvePeriods({ ...base, compare: 'custom', compareFrom: '2026-08-01', compareTo: '2026-08-03' }, '2026-10-22').compare).toMatchObject({ mode: 'custom', days: 3 })
    expect(resolvePeriods({ ...base, compare: 'none' }, '2026-10-22').defaulted).toBe(false)
  })

  it('去年同期遇到 2 月 29 日收回到 2 月 28 日', () => {
    expect(yoyPeriod({ from: '2028-02-29', to: '2028-03-02', days: 3 })).toMatchObject({ from: '2027-02-28', to: '2027-03-02' })
    expect(previousPeriod({ from: '2026-03-01', to: '2026-03-31', days: 31 })).toMatchObject({ from: '2026-01-29', to: '2026-02-28', days: 31 })
  })

  it('周以周一开始，月按自然月，包括闰月', () => {
    expect(weekStart('2026-10-22')).toBe('2026-10-19')
    expect(weekStart('2026-10-25')).toBe('2026-10-19')
    expect(weekStart('2026-10-26')).toBe('2026-10-26')
    expect(monthEnd('2028-02-10')).toBe('2028-02-29')
    expect(bucketKey('2026-10-22', 'month')).toBe('2026-10-01')
    expect(bucketKey('2026-10-22', 'day')).toBe('2026-10-22')
    expect(bucketBounds('2026-10-22', 'week')).toEqual({ from: '2026-10-19', to: '2026-10-25' })
    expect(previousBucket('2026-10-22', 'week')).toEqual({ from: '2026-10-12', to: '2026-10-18' })
    expect(previousBucket('2026-03-05', 'month')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    expect(previousBucket('2026-10-22', 'day')).toEqual({ from: '2026-10-21', to: '2026-10-21' })
  })

  it('逐日展开含首尾；时区换算：太平洋时区的“今天”与零点时刻', () => {
    expect(eachDay('2026-10-30', '2026-11-02')).toEqual(['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02'])
    // UTC 2026-10-22 03:00 在太平洋夏令时仍是 10-21
    expect(todayIn('America/Los_Angeles', new Date('2026-10-22T03:00:00Z'))).toBe('2026-10-21')
    expect(zonedDayStart('2026-10-22', 'America/Los_Angeles').toISOString()).toBe('2026-10-22T07:00:00.000Z')
    // 冬令时（11 月 2 日起）UTC-8
    expect(zonedDayStart('2026-11-05', 'America/Los_Angeles').toISOString()).toBe('2026-11-05T08:00:00.000Z')
    expect(zonedDayStart('2026-10-22', 'Asia/Shanghai').toISOString()).toBe('2026-10-21T16:00:00.000Z')
  })

  it('无效时区回退到美国太平洋时区', () => {
    expect(validZone('Not/AZone')).toBe('America/Los_Angeles')
    expect(validZone(null)).toBe('America/Los_Angeles')
    expect(validZone('Asia/Shanghai')).toBe('Asia/Shanghai')
  })
})
