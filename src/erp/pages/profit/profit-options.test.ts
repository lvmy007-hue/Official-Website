import { describe, expect, it } from 'vitest'
import { bridge } from './profit-fixtures.test-helper'
import { bridgeSteps, buildBridgeOption, buildTrendOption } from './profit-options'

// 利润桥瀑布图与趋势图配置：画出来的柱子与数据一致，跨过 0 的柱子正负半轴拆开，没有数据的项目不画，净利润算不出时不画终点。

describe('利润桥瀑布', () => {
  it('收入加、花费减，终点是净利润；没有数据与尚未接入的项目不画', () => {
    const steps = bridgeSteps(bridge({ REVENUE: 100, COMMISSION: 15, PRODUCT_COST: 30 }, 55))
    expect(steps.map(step => [step.label, step.kind, step.amount])).toEqual([
      ['销售额', 'up', 100],
      ['佣金', 'down', -15],
      ['采购成本', 'down', -30],
      ['净利润', 'total', 55],
    ])
    expect(steps[1]).toMatchObject({ lo: 85, hi: 100 })
    expect(steps[2]).toMatchObject({ lo: 55, hi: 85 })
    expect(steps.some(step => step.label === '关税')).toBe(false)
  })

  it('净利润算不出时没有终点柱，也不补平衡柱', () => {
    const steps = bridgeSteps(bridge({ REVENUE: 100, COMMISSION: 15 }, null))
    expect(steps.map(step => step.label)).toEqual(['销售额', '佣金'])
  })

  it('画出的项目加总与净利润对不上（有项目没画，如无权限的成本）时补“未列入图中的项目”柱', () => {
    const view = bridge({ REVENUE: 100, COMMISSION: 15 }, 50)
    const steps = bridgeSteps(view)
    expect(steps.map(step => step.label)).toEqual(['销售额', '佣金', '未列入图中的项目', '净利润'])
    expect(steps[2]).toMatchObject({ kind: 'rest', amount: -35, lo: 50, hi: 85 })
  })

  it('亏损：柱子跨过 0 时拆成正半轴与负半轴两段，两段合起来等于金额', () => {
    const steps = bridgeSteps(bridge({ REVENUE: 100, COMMISSION: 150 }, -50))
    expect(steps[1]).toMatchObject({ lo: -50, hi: 100 })
    const option = buildBridgeOption(bridge({ REVENUE: 100, COMMISSION: 150 }, -50))
    const series = option.series as Array<{ name: string; data: Array<number | { value: number }> }>
    const num = (item: number | { value: number } | undefined) => (typeof item === 'number' ? item : (item?.value ?? 0))
    const byName = (name: string) => series.find(item => item.name === name)!.data
    expect(num(byName('金额（正）')[1])).toBe(100)
    expect(num(byName('金额（负）')[1])).toBe(-50)
    expect(num(byName('基线（正）')[1])).toBe(0)
    expect(num(byName('金额（负）')[2])).toBe(-50)
    expect(num(byName('基线（负）')[2])).toBe(0)
  })
})

describe('趋势', () => {
  it('当天净利润算不出时净利润线断开，只用虚线画部分利润', () => {
    const option = buildTrendOption([
      { date: '2026-10-01', revenue: 280, profit: null, coveredProfit: 50 },
      { date: '2026-10-02', revenue: 100, profit: 30, coveredProfit: 30 },
    ])
    const series = option.series as Array<{ name: string; data: Array<number | null> }>
    expect(series.find(item => item.name === '净利润')!.data).toEqual([null, 30])
    expect(series.find(item => item.name.startsWith('部分利润'))!.data).toEqual([50, null])
    expect(series.find(item => item.name === '销售额')!.data).toEqual([280, 100])
  })
})
