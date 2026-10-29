import { describe, expect, it } from 'vitest'
import type { TrendResponse, WaterfallResponse } from '@nova/api-contracts'
import { healthLight } from './SourceHealthSection'
import { buildTrendOption } from './trend-option'
import { defaultLayout, visibleParts } from './use-layout'
import { buildWaterfallOption, waterfallSteps } from './waterfall-option'
import { trend, waterfall } from './overview-fixtures.test-helper'

// 经营控制台里的纯函数：图表配置、瀑布步骤、健康灯、布局取舍。

type Series = Array<{ name: string; data: unknown[]; yAxisIndex?: number }>
const seriesOf = (option: ReturnType<typeof buildTrendOption>) => option.series as unknown as Series

describe('趋势图配置', () => {
  const base = trend() as unknown as TrendResponse
  const withLines = {
    ...base,
    previous: [
      { key: '2026-10-01', value: 80 },
      { key: '2026-10-02', value: 70 },
    ],
    yoy: [
      { key: '2026-10-01', value: 50 },
      { key: '2026-10-02', value: null },
    ],
  } as TrendResponse

  it('没有数据的点保持为空，不补成 0', () => {
    expect(seriesOf(buildTrendOption(base, { previous: true, yoy: true }))[0]!.data).toEqual([100, null])
  })

  it('环比线、同比线按开关出现；没有对应数据时不画', () => {
    expect(seriesOf(buildTrendOption(withLines, { previous: false, yoy: false })).map(item => item.name)).toEqual(['销售额'])
    expect(seriesOf(buildTrendOption(withLines, { previous: true, yoy: true })).map(item => item.name)).toEqual(['销售额', '上一期', '去年同期'])
    expect(seriesOf(buildTrendOption(base, { previous: true, yoy: true })).map(item => item.name)).toEqual(['销售额'])
  })

  it('净利润有数据时用第二个纵轴；没有时只有一个纵轴', () => {
    const profit = {
      ...base,
      profit: {
        state: 'OK',
        note: null,
        points: [
          { key: '2026-10-01', value: 20 },
          { key: '2026-10-02', value: null },
        ],
      },
    } as TrendResponse
    const option = buildTrendOption(profit, { previous: false, yoy: false })
    expect(seriesOf(option).find(item => item.name === '净利润')).toMatchObject({ yAxisIndex: 1, data: [20, null] })
    expect(option.yAxis).toHaveLength(2)
    expect(buildTrendOption(base, { previous: false, yoy: false }).yAxis).toHaveLength(1)
  })

  it('周、月粒度用柱，日粒度用线', () => {
    const type = (granularity: string) => (buildTrendOption({ ...base, granularity } as TrendResponse, { previous: false, yoy: false }).series as unknown as Array<{ type: string }>)[0]!.type
    expect([type('day'), type('week'), type('month')]).toEqual(['line', 'bar', 'bar'])
  })
})

describe('增长瀑布', () => {
  const data = waterfall as unknown as WaterfallResponse

  it('从对比期出发，逐项累加到本期；未接入的项（金额为空）不画', () => {
    const steps = waterfallSteps(data)
    expect(steps.map(step => step.label)).toEqual(['对比期', 'B0AAAAAAA1', '未归属 ASIN', '本期'])
    expect(steps.map(step => step.base)).toEqual([0, 600, 900, 0])
    expect(steps.map(step => step.value)).toEqual([600, 300, 100, 1000])
    expect(steps[steps.length - 1]!.amount).toBe(data.current)
  })

  it('下降的项从高处往下画：基线取较小的一端', () => {
    const down = { ...data, base: 1000, current: 700, byDriver: [{ key: 'a', label: 'A', amount: -300, kind: 'asin' }] } as WaterfallResponse
    const steps = waterfallSteps(down)
    expect(steps[1]).toMatchObject({ base: 700, value: 300, kind: 'down' })
    expect(buildWaterfallOption(down).series).toHaveLength(2)
  })
})

describe('健康灯', () => {
  it('没有应同步的来源是灰；全部正常是绿；有需要关注的是黄；完整度不足一半是红', () => {
    expect(healthLight(undefined).color).toBe('default')
    expect(healthLight({ completeness: null, attention: 0 }).color).toBe('default')
    expect(healthLight({ completeness: 1, attention: 0 })).toMatchObject({ color: 'success', label: '数据源正常' })
    expect(healthLight({ completeness: 0.8, attention: 2 })).toMatchObject({ color: 'warning', label: '2 个数据源需要关注' })
    expect(healthLight({ completeness: 0.4, attention: 3 }).color).toBe('error')
  })
})

describe('布局取舍', () => {
  it('默认是经营者模板，全部区域与指标卡', () => {
    const parts = visibleParts(defaultLayout())
    expect(parts.sections).toHaveLength(11)
    expect(parts.cards).toHaveLength(7)
  })

  it('隐藏项只在当前模板的范围内生效，顺序跟随模板', () => {
    const parts = visibleParts({ template: 'finance', hiddenSections: ['trend', 'asinRank'], hiddenCards: ['adsSpend', 'stockRisk'] })
    expect(parts.sections).toEqual(['kpis', 'cash', 'storeCompare', 'waterfall', 'queue', 'sourceHealth'])
    expect(parts.cards).toEqual(['sales', 'profit', 'margin', 'anomalies'])
  })
})
