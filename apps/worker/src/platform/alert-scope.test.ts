import { describe, expect, it } from 'vitest'
import { isQuietNow, readQuietHours } from './alert-scope'

const at = (text: string) => new Date(`2026-10-22T${text}:00Z`)

describe('静默时段', () => {
  it('读取：格式不对、开始等于结束、不是对象都按“没有静默”处理', () => {
    expect(readQuietHours({ quiet: { start: '22:00', end: '08:00' } })).toEqual({ start: '22:00', end: '08:00' })
    expect(readQuietHours({ quiet: { start: '22:00', end: '22:00' } })).toBeNull()
    expect(readQuietHours({ quiet: { start: '25:00', end: '08:00' } })).toBeNull()
    expect(readQuietHours({ quiet: { start: '8:00', end: '09:00' } })).toBeNull()
    expect(readQuietHours({ quiet: 'x' })).toBeNull()
    expect(readQuietHours({})).toBeNull()
  })

  it('同一天内的时段：含开始、不含结束', () => {
    const quiet = { start: '12:00', end: '14:00' }
    expect(isQuietNow(at('11:59'), 'UTC', quiet)).toBe(false)
    expect(isQuietNow(at('12:00'), 'UTC', quiet)).toBe(true)
    expect(isQuietNow(at('13:59'), 'UTC', quiet)).toBe(true)
    expect(isQuietNow(at('14:00'), 'UTC', quiet)).toBe(false)
  })

  it('跨午夜的时段：晚上与清晨都在静默内', () => {
    const quiet = { start: '22:00', end: '08:00' }
    expect(isQuietNow(at('23:30'), 'UTC', quiet)).toBe(true)
    expect(isQuietNow(at('03:00'), 'UTC', quiet)).toBe(true)
    expect(isQuietNow(at('08:00'), 'UTC', quiet)).toBe(false)
    expect(isQuietNow(at('15:00'), 'UTC', quiet)).toBe(false)
  })

  it('按企业时区计时；时区无效回退到美国太平洋时区；没有静默配置永远不静默', () => {
    const quiet = { start: '22:00', end: '08:00' }
    // 2026-10-22 15:00 UTC = 上海 23:00（静默内），洛杉矶（夏令时）08:00（静默外）
    expect(isQuietNow(at('15:00'), 'Asia/Shanghai', quiet)).toBe(true)
    expect(isQuietNow(at('15:00'), 'America/Los_Angeles', quiet)).toBe(false)
    expect(isQuietNow(at('15:00'), 'Not/AZone', quiet)).toBe(false)
    expect(isQuietNow(at('15:00'), null, quiet)).toBe(false)
    expect(isQuietNow(at('15:00'), 'UTC', null)).toBe(false)
  })
})
