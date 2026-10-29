import { describe, expect, it } from 'vitest'
import { buildDefectTrendOption, buildRatingTrendOption } from './account-health-options'

// 账户健康图表配置（纯函数）：横轴是快照日期，没有快照的日子留空不补 0；比率按百分比显示。

type Series = { name: string; data: Array<number | null> }

describe('订单缺陷率趋势', () => {
  const series = [
    {
      key: 'orderDefectRate.afn',
      label: '亚马逊配送',
      unit: 'RATIO',
      points: [
        { date: '2026-10-22', value: 0.004 },
        { date: '2026-10-24', value: 0.012 },
      ],
    },
    { key: 'orderDefectRate.mfn', label: '卖家自配送', unit: 'RATIO', points: [{ date: '2026-10-23', value: 0.02 }] },
  ]
  const option = buildDefectTrendOption(series)

  it('日期取各条曲线的并集并排序；某条曲线在某天没有快照就是空，不是 0', () => {
    expect((option.xAxis as { data: string[] }).data).toEqual(['2026-10-22', '2026-10-23', '2026-10-24'])
    const lines = option.series as Series[]
    expect(lines[0]?.data).toEqual([0.004, null, 0.012])
    expect(lines[1]?.data).toEqual([null, 0.02, null])
  })

  it('提示与纵轴按百分比，没有值写“尚无记录”', () => {
    const tooltip = option.tooltip as { valueFormatter: (value: unknown) => string }
    expect(tooltip.valueFormatter(0.012)).toBe('1.2%')
    expect(tooltip.valueFormatter(null)).toBe('尚无记录')
    expect((option.yAxis as { axisLabel: { formatter: (value: number) => string } }).axisLabel.formatter(0.01)).toBe('1%')
  })
})

describe('评级趋势', () => {
  it('按快照日期画点，数值原样', () => {
    const option = buildRatingTrendOption([
      { date: '2026-10-23', value: 280 },
      { date: '2026-10-24', value: 312 },
    ])
    expect((option.xAxis as { data: string[] }).data).toEqual(['2026-10-23', '2026-10-24'])
    expect((option.series as Series[])[0]?.data).toEqual([280, 312])
  })
})
