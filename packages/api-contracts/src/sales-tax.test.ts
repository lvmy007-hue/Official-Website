import { describe, expect, it } from 'vitest'
import { freshnessErrorMessage, freshnessSourceOfJobType, freshnessStatusForFailure } from './freshness.js'
import {
  SALES_TAX_RECON_HINT,
  SALES_TAX_RECON_LABEL,
  SALES_TAX_RECON_STATES,
  SALES_TAX_SOURCES,
  SALES_TAX_SOURCE_LABEL,
  SALES_TAX_SYNC_JOB,
  SALES_TAX_FRESHNESS_KEY,
  TAX_NOT_GENERATED,
  TAX_ROLE_PENDING,
  taxKindLabel,
} from './sales-tax.js'
import { normalizeJurisdiction, normalizeTaxKind, normalizeTaxState, reconcileTax, taxTolerance, taxWindowsOf } from './sales-tax-math.js'

describe('常量与标签', () => {
  it('三类来源、四种对账结果都有中文名与说明；税种只给销售税配中文，其余原样', () => {
    expect(SALES_TAX_SOURCES.map(source => SALES_TAX_SOURCE_LABEL[source])).toEqual(['税务文档库报告', '订单接口', '发货报告'])
    for (const state of SALES_TAX_RECON_STATES) {
      expect(SALES_TAX_RECON_LABEL[state]).toBeTruthy()
      expect(SALES_TAX_RECON_HINT[state]).toBeTruthy()
    }
    expect(taxKindLabel('SALES_TAX')).toBe('销售税')
    expect(taxKindLabel('USE_TAX')).toBe('USE_TAX')
  })

  it('同步任务登记了新鲜度来源；报告没生成是“等待依赖”而不是故障，受限角色没批是“未授权”，两者都有说明', () => {
    expect(freshnessSourceOfJobType(SALES_TAX_SYNC_JOB)).toMatchObject({ key: SALES_TAX_FRESHNESS_KEY, intervalMinutes: 24 * 60 })
    expect(freshnessStatusForFailure(TAX_NOT_GENERATED)).toBe('WAITING_DEPENDENCY')
    expect(freshnessStatusForFailure(TAX_ROLE_PENDING)).toBe('UNAUTHORIZED')
    expect(freshnessErrorMessage(TAX_NOT_GENERATED)).toContain('税务文档库')
    expect(freshnessErrorMessage(TAX_ROLE_PENDING)).toContain('税务汇缴')
  })
})

describe('按月切时间窗', () => {
  it('跨月：首尾月只取范围内的部分，中间月取整月', () => {
    expect(taxWindowsOf('2026-08-20', '2026-10-05')).toEqual({
      windows: [
        { month: '2026-08', from: '2026-08-20', to: '2026-08-31' },
        { month: '2026-09', from: '2026-09-01', to: '2026-09-30' },
        { month: '2026-10', from: '2026-10-01', to: '2026-10-05' },
      ],
      clamped: false,
    })
  })

  it('同一个月、跨年、闰年二月都按真实日历', () => {
    expect(taxWindowsOf('2026-10-03', '2026-10-09').windows).toEqual([{ month: '2026-10', from: '2026-10-03', to: '2026-10-09' }])
    expect(taxWindowsOf('2027-12-30', '2028-02-29').windows.map(window => [window.month, window.from, window.to])).toEqual([
      ['2027-12', '2027-12-30', '2027-12-31'],
      ['2028-01', '2028-01-01', '2028-01-31'],
      ['2028-02', '2028-02-01', '2028-02-29'],
    ])
  })

  it('超过上限只保留最近的几个月并标记收窄；起止颠倒返回空', () => {
    const result = taxWindowsOf('2026-01-10', '2026-06-20', 3)
    expect(result.clamped).toBe(true)
    expect(result.windows.map(window => window.month)).toEqual(['2026-04', '2026-05', '2026-06'])
    expect(result.windows[0]).toEqual({ month: '2026-04', from: '2026-04-01', to: '2026-04-30' })
    expect(taxWindowsOf('2026-10-09', '2026-10-01')).toEqual({ windows: [], clamped: false })
  })
})

describe('报告对订单接口', () => {
  it('容差取 0.05 与千分之一的较大者', () => {
    expect(taxTolerance(10, 10)).toBe(0.05)
    expect(taxTolerance(10_000, 9_990)).toBeCloseTo(10, 6)
  })

  it('两边都有：容差内一致，超出有差异，差额是报告减订单', () => {
    expect(reconcileTax(1000, 1000.03)).toEqual({ state: 'MATCHED', diff: -0.03 })
    expect(reconcileTax(1000, 999.5)).toEqual({ state: 'MATCHED', diff: 0.5 }) // 0.1% × 1000 = 1，0.5 在容差内
    expect(reconcileTax(1000, 980)).toEqual({ state: 'DIFFERENT', diff: 20 })
    expect(reconcileTax(50, 80)).toEqual({ state: 'DIFFERENT', diff: -30 })
  })

  it('只有一边有记录：写明哪边没有，不当 0 算；两边都没有不列；0 与没有记录是两回事', () => {
    expect(reconcileTax(null, 200)).toEqual({ state: 'NO_REPORT', diff: null })
    expect(reconcileTax(200, null)).toEqual({ state: 'NO_ORDERS', diff: null })
    expect(reconcileTax(null, null)).toBeNull()
    expect(reconcileTax(0, 0)).toEqual({ state: 'MATCHED', diff: 0 })
    expect(reconcileTax(0, 12)).toEqual({ state: 'DIFFERENT', diff: -12 })
  })

  it('差额不会出现 -0', () => {
    expect(Object.is(reconcileTax(10, 10.001)?.diff, -0)).toBe(false)
  })
})

describe('报告文字整理', () => {
  it('州去空白转大写、空值没法归州；税种转大写下划线、没给就是销售税；辖区转大写、没给是州一级', () => {
    expect(normalizeTaxState('  wa ')).toBe('WA')
    expect(normalizeTaxState('New  York')).toBe('NEW YORK')
    expect(normalizeTaxState('   ')).toBeNull()
    expect(normalizeTaxState(undefined)).toBeNull()
    expect(normalizeTaxKind('State Sales Tax')).toBe('STATE_SALES_TAX')
    expect(normalizeTaxKind(undefined)).toBe('SALES_TAX')
    expect(normalizeTaxKind(' -- ')).toBe('SALES_TAX')
    expect(normalizeJurisdiction(' king  county ')).toBe('KING COUNTY')
    expect(normalizeJurisdiction(undefined)).toBe('')
  })
})
