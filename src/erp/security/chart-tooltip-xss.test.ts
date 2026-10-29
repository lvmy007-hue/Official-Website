import type { EChartsOption } from 'echarts'
import { describe, expect, it } from 'vitest'
import { escapeHtml } from '../components/chart/chart-utils'
import { buildTermQuadrantOption } from '../pages/advertising/ad-terms-options'
import { buildQuadrantOption as buildAdsQuadrantOption } from '../pages/advertising/ads-options'
import { buildQuadrantOption as buildBrandQuadrantOption } from '../pages/analytics/brand-options'
import { buildCompositionOption } from '../pages/costs/costs-ui'

// 图表提示框的自定义格式化函数返回的字符串会被 ECharts 当 HTML 渲染（P5-13）。
// 搜索词、活动名称由买家或卖家输入，必须转义；这里逐个构造恶意名称，直接调用各图表的格式化函数断言输出里没有可执行标签。

const PAYLOAD = `<img src=x onerror="alert(1)"><script>alert('x')</script>&`

function tooltipOf(option: EChartsOption): (params: unknown) => string {
  const tooltip = option.tooltip as { formatter?: (params: unknown) => string }
  expect(typeof tooltip.formatter).toBe('function')
  return tooltip.formatter as (params: unknown) => string
}

const expectEscaped = (html: string) => {
  expect(html).not.toMatch(/<img|<script|onerror="/i)
  expect(html).toContain('&#60;img')
  expect(html).toContain('&#38;')
}

describe('escapeHtml', () => {
  it('转义尖括号、引号、与号和反引号', () => {
    expect(escapeHtml(`<a href="x" title='y'>&\``)).toBe('&#60;a href=&#34;x&#34; title=&#39;y&#39;&#62;&#38;&#96;')
  })

  it('空值与非字符串不报错', () => {
    expect(escapeHtml(null)).toBe('')
    expect(escapeHtml(undefined)).toBe('')
    expect(escapeHtml(12)).toBe('12')
  })
})

describe('图表提示框不执行买家与卖家输入的文本', () => {
  it('词级四象限（搜索词、投放词）', () => {
    const option = buildTermQuadrantOption({ points: [], spendLine: null, acosLine: null })
    expectEscaped(tooltipOf(option)({ data: { name: PAYLOAD, value: [12.5, 0.3], quadrant: 'STAR' } }))
  })

  it('广告象限（活动名称）', () => {
    const option = buildAdsQuadrantOption({ points: [], spendLine: null, acosLine: null } as never)
    expectEscaped(tooltipOf(option)({ data: { name: PAYLOAD, value: [12.5, 0.3], quadrant: 'WASTE' } }))
  })

  it('品牌分析机会象限（搜索词）', () => {
    const option = buildBrandQuadrantOption({ points: [], medians: null } as never)
    expectEscaped(tooltipOf(option)({ data: { name: PAYLOAD, value: [100, 0.2] } }))
  })

  it('成本构成饼图', () => {
    const option = buildCompositionOption({ slices: [], totalUsd: null, note: null })
    expectEscaped(tooltipOf(option)({ name: PAYLOAD, value: 5, percent: 10 }))
  })
})
