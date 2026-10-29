import { describe, expect, it } from 'vitest'
import { cells, hashOf, int, intColumns, isOtherCountry, monthStartOf, num, parseDay, parseTime, requireColumns, text, textColumns } from './columns'

describe('库存类报告的列读取', () => {
  it('表头统一成小写短横线：大小写、空格、下划线写法都能按同一个别名取到', () => {
    const c = cells({ 'Merchant SKU': ' A-1 ', reserved_qty: '3', 'Afn-Fulfillable-Quantity': '7' })
    expect(text(c, ['merchant-sku'])).toBe('A-1')
    expect(int(c, ['reserved-qty'])).toBe(3)
    expect(int(c, ['afn-fulfillable-quantity'])).toBe(7)
    expect(text(c, ['missing', 'merchant-sku'])).toBe('A-1') // 别名按顺序取第一个有值的
  })

  it('空白、--、N/A 视为“没有给”，不是 0；金额里的货币符号与千分位会被去掉', () => {
    const c = cells({ a: '', b: '--', c: 'N/A', d: '$1,234.50', e: '12%', f: 'abc', g: '0' })
    expect(num(c, ['a'])).toBeUndefined()
    expect(num(c, ['b'])).toBeUndefined()
    expect(num(c, ['c'])).toBeUndefined()
    expect(num(c, ['d'])).toBe(1234.5)
    expect(num(c, ['e'])).toBe(12)
    expect(num(c, ['f'])).toBeUndefined()
    expect(num(c, ['g'])).toBe(0) // 真实的 0 保留
    expect(int(cells({ x: '2.6' }), ['x'])).toBe(3)
  })

  it('日期：ISO、带时间、美式、年月、紧凑写法都转成 UTC 零点；非法日期返回空', () => {
    const iso = (value: string | undefined) => parseDay(value)?.toISOString().slice(0, 10)
    expect(iso('2026-09-30')).toBe('2026-09-30')
    expect(iso('2026-09-30T10:00:00Z')).toBe('2026-09-30')
    expect(iso('09/30/2026')).toBe('2026-09-30')
    expect(iso('2026-09')).toBe('2026-09-01')
    expect(iso('20260930')).toBe('2026-09-30')
    expect(iso('2026-02-31')).toBeUndefined()
    expect(iso('13/40/2026')).toBeUndefined()
    expect(iso('hello')).toBeUndefined()
    expect(iso(undefined)).toBeUndefined()
    expect(parseTime('not a time')).toBeUndefined()
    expect(parseTime('2026-09-30T10:00:00Z')?.toISOString()).toBe('2026-09-30T10:00:00.000Z')
    expect(monthStartOf(new Date('2026-09-30T10:00:00Z')).toISOString()).toBe('2026-09-01T00:00:00.000Z')
  })

  it('只取美国站：有国家列且不是 US 的行属于范围之外；没有国家列的行保留', () => {
    expect(isOtherCountry(cells({ country: 'DE' }))).toBe(true)
    expect(isOtherCountry(cells({ Country: 'us' }))).toBe(false)
    expect(isOtherCountry(cells({ sku: 'A' }))).toBe(false)
  })

  it('关键列整体缺失抛 PARSE_HEADER；多出的未知列不算错误', () => {
    expect(() => requireColumns(cells({ sku: 'A', whatever: '1' }), [['sku']], 'R')).not.toThrow()
    expect(() => requireColumns(cells({ other: 'A' }), [['sku', 'merchant-sku']], 'GET_X')).toThrow(/GET_X 缺少关键列 sku \/ merchant-sku/)
    try {
      requireColumns(cells({ other: 'A' }), [['sku']], 'GET_X')
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PARSE_HEADER')
    }
  })

  it('按字段映射批量取值：没有给的列不出现在结果里（写库时不覆盖旧值）', () => {
    const c = cells({ a: '1', b: '', c: 'x' })
    expect(intColumns(c, { one: ['a'], two: ['b'] })).toEqual({ one: 1 })
    expect(textColumns(c, { word: ['c'], none: ['b'] })).toEqual({ word: 'x' })
  })

  it('行哈希稳定且对内容敏感', () => {
    expect(hashOf('a', 1, undefined)).toBe(hashOf('a', 1, undefined))
    expect(hashOf('a', 1)).not.toBe(hashOf('a', 2))
    expect(hashOf('ab', 'c')).not.toBe(hashOf('a', 'bc'))
  })
})
