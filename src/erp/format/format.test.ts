import { describe, expect, it } from 'vitest'
import { EMPTY_VALUE, formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, toneClassName, toneOf } from './index'

describe('formatMoney', () => {
  it('美元带 $ 符号与两位小数', () => {
    expect(formatMoney(1234.5)).toBe('$1,234.50')
    expect(formatMoney('-98.765')).toBe('-$98.77')
  })
  it('非美元显示币种代码', () => {
    expect(formatMoney(1234.5, 'CNY')).toBe('CNY 1,234.50')
  })
  it('支持正号与紧凑显示', () => {
    expect(formatMoney(12, 'USD', { sign: true })).toBe('+$12.00')
    expect(formatMoney(1250000, 'USD', { compact: true, digits: 1 })).toBe('$1.3M')
  })
  it('空值显示占位符而不是 0', () => {
    expect(formatMoney(null)).toBe(EMPTY_VALUE)
    expect(formatMoney('abc')).toBe(EMPTY_VALUE)
  })
})

describe('formatNumber 与 formatPercent', () => {
  it('千分位与小数位', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(1.236, { digits: 2 })).toBe('1.24')
  })
  it('百分比入参是比率', () => {
    expect(formatPercent(0.1234)).toBe('12.3%')
    expect(formatPercent(-0.05, { digits: 0 })).toBe('-5%')
    expect(formatPercent(0.021, { sign: true })).toBe('+2.1%')
  })
})

describe('日期时间', () => {
  it('时间必带时区，夏令时与标准时间分别显示', () => {
    expect(formatDateTime('2026-10-21T20:45:00Z')).toBe('2026-10-21 13:45 PDT')
    expect(formatDateTime('2026-12-01T20:45:00Z')).toBe('2026-12-01 12:45 PST')
  })
  it('可指定时区与秒', () => {
    expect(formatDateTime('2026-10-21T20:45:30Z', { timeZone: 'Asia/Shanghai', seconds: true })).toBe('2026-10-22 04:45:30 GMT+8')
  })
  it('业务日期不被时区平移', () => {
    expect(formatDate('2026-10-21')).toBe('2026-10-21')
    expect(formatDate('2026-10-21T02:00:00Z')).toBe('2026-10-20')
  })
  it('无效时间显示占位符', () => {
    expect(formatDateTime('not-a-date')).toBe(EMPTY_VALUE)
  })
})

describe('正负色语义', () => {
  it('默认上升为好，成本类下降为好', () => {
    expect(toneOf(5)).toBe('positive')
    expect(toneOf(-5)).toBe('negative')
    expect(toneOf(5, 'down')).toBe('negative')
    expect(toneOf(-5, 'down')).toBe('positive')
  })
  it('零与空值为中性', () => {
    expect(toneOf(0)).toBe('neutral')
    expect(toneOf(null)).toBe('neutral')
    expect(toneClassName('positive')).toBe('erp-tone-positive')
  })
})
