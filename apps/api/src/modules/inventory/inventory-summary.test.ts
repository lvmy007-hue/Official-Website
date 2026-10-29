import { describe, expect, it } from 'vitest'
import { buildSummary, inTab, matchesText, sortRows } from './inventory-summary'
import { previousMonths } from './inventory-health.service'
import { assessment, row } from './inventory-fixtures.test-helper'

const ctx = { policyVersion: 3, truncated: false, stores: new Map([['s1', '店铺一']]), feeMonths: [] }
const noPolicy = () => assessment({ state: 'NOT_CONNECTED', reason: 'NO_POLICY', risk: null, daysOfCover: null, stockoutDate: null })

describe('页签筛选', () => {
  const high = row({ id: 'a', sku: 'A', risk: 'HIGH' })
  const excess = row({ id: 'b', sku: 'B', risk: 'EXCESS' })
  const lowFee = row({ id: 'c', sku: 'C', risk: 'NORMAL', fees: { ...row().fees, lowFeeAtRisk: true } })
  const aged = row({ id: 'd', sku: 'D', age: { granularity: 'COARSE', buckets: [], snapshotDate: '2026-10-20', surchargeEstimate: 3, atRisk: true } })
  const stranded = row({ id: 'e', sku: 'E', status: { amazonHealth: null, strandedReason: '缺少标签' } })
  const unsellable = row({ id: 'f', sku: 'F', quantity: { ...row().quantity, researching: 2 } })

  it('各页签口径', () => {
    expect(inTab(high, 'low')).toBe(true)
    expect(inTab(lowFee, 'low')).toBe(true)
    expect(inTab(excess, 'low')).toBe(false)
    expect(inTab(excess, 'excess')).toBe(true)
    expect(inTab(aged, 'aging')).toBe(true)
    expect(inTab(high, 'aging')).toBe(false)
    expect(inTab(stranded, 'stranded')).toBe(true)
    expect(inTab(unsellable, 'unsellable')).toBe(true)
    expect(inTab(high, 'inbound')).toBe(true)
    expect(inTab(row({ quantity: { ...row().quantity, inboundTotal: 0 } }), 'inbound')).toBe(false)
  })

  it('关键词匹配 SKU、ASIN、FNSKU、标题、品牌（不分大小写）', () => {
    expect(matchesText(high, 'sku-1')).toBe(false)
    expect(matchesText(row({ sku: 'ABC-1' }), 'abc')).toBe(true)
    expect(matchesText(row({ title: 'Garden Hose' }), 'garden')).toBe(true)
    expect(matchesText(high, undefined)).toBe(true)
  })
})

describe('排序', () => {
  it('风险升序：高、中、正常、冗余、未判定；空值永远在最后', () => {
    const rows = [row({ sku: 'U' }), row({ sku: 'E', risk: 'EXCESS' }), row({ sku: 'H', risk: 'HIGH' }), row({ sku: 'N', risk: 'NORMAL' }), row({ sku: 'M', risk: 'MEDIUM' })]
    rows[0].assessment = noPolicy()
    expect(sortRows(rows, { field: 'risk', dir: 'asc' }).map(item => item.sku)).toEqual(['H', 'M', 'N', 'E', 'U'])
  })

  it('可售天数降序时没有天数的行仍在最后', () => {
    const a = row({ sku: 'A' })
    a.assessment = assessment({ daysOfCover: 10 })
    const b = row({ sku: 'B' })
    b.assessment = assessment({ daysOfCover: 50 })
    const c = row({ sku: 'C' })
    c.assessment = assessment({ daysOfCover: null, noDemand: true })
    expect(sortRows([a, c, b], { field: 'daysOfCover', dir: 'desc' }).map(item => item.sku)).toEqual(['B', 'A', 'C'])
  })
})

describe('顶部汇总', () => {
  it('没有库存记录：数量类卡片“尚无记录”，不是 0', () => {
    const summary = buildSummary([], ctx)
    expect(summary.cards.sellableTotal).toMatchObject({ state: 'NO_DATA', value: null })
    expect(summary.cards.nextMonthStorageFee.value).toBeNull()
    expect(summary.charts.ageDistribution.granularity).toBeNull()
  })

  it('没有规则：低库存与冗余卡片是“未接入”并说明原因，数量类仍按记录汇总', () => {
    const rows = [row({ sku: 'A', sellable: 10 }), row({ sku: 'B', sellable: 5 })]
    rows.forEach(item => (item.assessment = noPolicy()))
    const summary = buildSummary(rows, { ...ctx, policyVersion: null })
    expect(summary.policyState).toBe('NOT_CONNECTED')
    expect(summary.cards.lowSkuCount).toMatchObject({ state: 'NOT_CONNECTED', value: null })
    expect(summary.cards.excessSkuCount.value).toBeNull()
    expect(summary.cards.sellableTotal.value).toBe(15)
    expect(summary.charts.coverDistribution.find(bin => bin.key === 'unknown')?.count).toBe(2)
  })

  it('有规则：低库存 = 高 + 中；费用只累加有预估的 SKU 并说明覆盖比例', () => {
    const a = row({ sku: 'A', risk: 'HIGH' })
    a.fees = { ...a.fees, nextMonthStorage: 10.234 }
    const b = row({ sku: 'B', risk: 'MEDIUM' })
    b.fees = { ...b.fees, nextMonthStorage: 5 }
    const c = row({ sku: 'C', risk: 'EXCESS' })
    const summary = buildSummary([a, b, c], ctx)
    expect(summary.cards.lowSkuCount.value).toBe(2)
    expect(summary.cards.excessSkuCount.value).toBe(1)
    expect(summary.cards.nextMonthStorageFee).toMatchObject({ value: 15.23, note: '2/3 个 SKU 有预估' })
    expect(summary.charts.feeTrend.projectedNextMonth).toBe(15.23)
  })

  it('没有销量记录的 SKU 单独说明，覆盖分布里“近期无销量”与“未判定”分开', () => {
    const noDemand = row({ sku: 'N' })
    noDemand.assessment = assessment({ risk: 'EXCESS', daysOfCover: null, noDemand: true })
    const unknown = row({ sku: 'U' })
    unknown.assessment = assessment({ state: 'NO_DATA', reason: 'NO_DEMAND_DATA', risk: null, daysOfCover: null })
    const summary = buildSummary([noDemand, unknown], ctx)
    expect(summary.cards.lowSkuCount.note).toContain('1 个 SKU 没有销量记录')
    expect(summary.charts.coverDistribution.find(bin => bin.key === 'noDemand')?.count).toBe(1)
    expect(summary.charts.coverDistribution.find(bin => bin.key === 'unknown')?.count).toBe(1)
  })

  it('库存结构按店铺汇总', () => {
    const summary = buildSummary([row({ sku: 'A', storeId: 's1', sellable: 10 }), row({ sku: 'B', storeId: 's1', sellable: 5 }), row({ sku: 'C', storeId: 's2', sellable: 1 })], ctx)
    expect(summary.charts.structure.find(item => item.storeId === 's1')).toMatchObject({ storeName: '店铺一', sellable: 15, inbound: 60 })
    expect(summary.charts.structure).toHaveLength(2)
  })
})

describe('仓储费趋势的月份', () => {
  it('当月之前的 N 个自然月，旧的在前，跨年正确', () => {
    expect(previousMonths('2026-10-22', 3)).toEqual(['2026-07-01', '2026-08-01', '2026-09-01'])
    expect(previousMonths('2026-02-10', 3)).toEqual(['2025-11-01', '2025-12-01', '2026-01-01'])
  })
})
