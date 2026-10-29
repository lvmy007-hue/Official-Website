import { describe, expect, it } from 'vitest'
import type { AdsOverviewResponse } from '@nova/api-contracts'
import { buildBudgetOption, buildFunnelOption, buildMixOption, buildProductOption, buildQuadrantOption, buildTrendOption } from './ads-options'
import { dataOverview } from './ads-fixtures.test-helper'

// 广告控制台图表配置：没有数据的点保持为空，不补 0。

const data = dataOverview() as unknown as AdsOverviewResponse
type Series = Array<{ name?: string; type?: string; data?: unknown[]; markLine?: { data: unknown[] } }>
const seriesOf = (option: { series?: unknown }) => option.series as Series

describe('广告图表配置', () => {
  it('趋势：花费柱 + 广告销售线，缺失的点是 null 而不是 0', () => {
    const series = seriesOf(buildTrendOption(data.trend.points))
    expect(series.map(item => item.name)).toEqual(['花费', '广告销售额'])
    expect(series[1]!.data).toEqual([40, null, 42])
  })

  it('总销售拆分：堆叠柱 + 总销售线 + 右轴占比线', () => {
    const option = buildMixOption(data.mix.points)
    const series = seriesOf(option)
    expect(series.map(item => item.name)).toEqual(['广告销售额', '自然销售额', '总销售额', '广告占总销售比'])
    expect(series[3]).toMatchObject({ yAxisIndex: 1 })
    const sparse = seriesOf(buildMixOption([{ key: 'd', totalSales: null, adSales: 5, organicSales: null, adSpend: null, adsShare: null }]))
    expect(sparse[1]!.data).toEqual([null])
  })

  it('产品结构：只画有花费的类型', () => {
    const pie = seriesOf(buildProductOption(data.products))[0]!.data
    expect(pie).toEqual([{ name: '商品推广', value: 1234.5 }])
    expect(seriesOf(buildProductOption([]))[0]!.data).toEqual([])
  })

  it('漏斗：曝光、点击、订单三段按给定顺序', () => {
    expect(seriesOf(buildFunnelOption(data.funnel.value!))[0]!.data).toEqual([
      { name: '曝光', value: 10000 },
      { name: '点击', value: 200 },
      { name: '订单', value: 20 },
    ])
  })

  it('预算：有日预算合计才画参考线', () => {
    expect(seriesOf(buildBudgetOption(data.budget))[0]!.markLine!.data).toEqual([{ yAxis: 50, name: '当前日预算合计（估算）' }])
    expect(seriesOf(buildBudgetOption({ ...data.budget, dailyBudgetTotal: null }))[0]!.markLine).toBeUndefined()
  })

  it('四象限：每个点带象限，分界线按有无画出', () => {
    const series = seriesOf(buildQuadrantOption(data.quadrant))
    expect(series[0]!.data).toHaveLength(2)
    expect(series[0]!.markLine!.data).toEqual([{ xAxis: 50 }, { yAxis: 0.3 }])
    expect(seriesOf(buildQuadrantOption({ ...data.quadrant, spendLine: null, acosLine: null }))[0]!.markLine!.data).toEqual([])
  })
})
