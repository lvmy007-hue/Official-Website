import { describe, expect, it } from 'vitest'
import { evalMetricExpr, metricCycle, parseMetricExpr, type MetricName } from './metric-expr'

const known: MetricName[] = [
  { id: 'M-001', name: '销售额（订购口径）' },
  { id: 'M-002', name: '订购件数' },
  { id: 'M-005', name: '净利润' },
  { id: 'M-007', name: '广告花费' },
  { id: 'C-ADS', name: '广告后销售额' },
]

const parse = (text: string, extra: MetricName[] = []) => parseMetricExpr(text, [...known, ...extra])

describe('自定义指标公式', () => {
  it('乘除优先于加减，括号改变顺序', () => {
    const parsed = parse('(M-001 - M-007) / M-002')
    expect(parsed.issues).toEqual([])
    expect(evalMetricExpr(parsed.ast, { 'M-001': 100, 'M-007': 40, 'M-002': 4 })).toBe(15)
    expect(evalMetricExpr(parse('M-001 - M-007 / M-002').ast, { 'M-001': 100, 'M-007': 40, 'M-002': 4 })).toBe(90)
  })

  it('一元负号、全角括号与中文全名', () => {
    const parsed = parse('−M-007 × 2')
    expect(parsed.issues).toEqual([])
    expect(evalMetricExpr(parsed.ast, { 'M-007': 3 })).toBe(-6)
    expect(parse('（M-001 - M-007） / M-002').issues).toEqual([])
    expect(parse('销售额（订购口径） - 广告花费').refs).toEqual(['M-001', 'M-007'])
  })

  it('除以常数 0（含能折成 0 的除数）在保存时拒绝；运行时除以指标的 0 得到空', () => {
    expect(parse('M-001 / 0').issues).toContain('不能除以常数 0')
    expect(parse('M-001 / (2 - 2)').issues).toContain('不能除以常数 0')
    const runtime = parse('M-001 / M-002')
    expect(runtime.issues).toEqual([])
    expect(evalMetricExpr(runtime.ast, { 'M-001': 10, 'M-002': 0 })).toBeNull()
  })

  it('引用不存在的指标、名称不唯一、缺值不当 0', () => {
    expect(parse('M-999 + 1').issues.join('')).toContain('不存在的指标')
    const ambiguous = parseMetricExpr('销售额', [
      { id: 'M-001', name: '销售额' },
      { id: 'M-100', name: '销售额' },
    ])
    expect(ambiguous.issues.join('')).toContain('多个指标')
    expect(parse('销售额（订购口径）').refs).toEqual(['M-001'])
    expect(evalMetricExpr(parse('M-001 + M-002').ast, { 'M-001': 3, 'M-002': null })).toBeNull()
  })

  it('循环引用', () => {
    const edges = new Map<string, string[]>([
      ['C-A', ['C-B']],
      ['C-B', ['M-001', 'C-A']],
    ])
    expect(metricCycle('C-A', edges)).toBe(true)
    expect(metricCycle('C-ADS', new Map([['C-ADS', ['M-001']]]))).toBe(false)
    expect(metricCycle('C-ADS', new Map([['C-ADS', ['C-ADS']]]))).toBe(true)
  })
})
