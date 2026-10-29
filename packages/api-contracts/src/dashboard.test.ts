import { describe, expect, it } from 'vitest'
import { EXPORT_KINDS } from './exports'
import {
  AsinRankQuerySchema,
  AttributionQuerySchema,
  KPI_KEYS,
  OVERVIEW_REPORT_KIND,
  OVERVIEW_SECTIONS,
  OVERVIEW_TEMPLATE_SPECS,
  OverviewLayoutSchema,
  overviewTemplateOf,
  reportRange,
  TrendQuerySchema,
} from './dashboard'

describe('经营控制台契约', () => {
  it('趋势、归因、排名参数：有默认值，非法值被拒绝，日期必须真实存在', () => {
    expect(TrendQuerySchema.parse({})).toEqual({ granularity: 'day', metric: 'sales' })
    expect(TrendQuerySchema.safeParse({ metric: 'nope' }).success).toBe(false)
    expect(AsinRankQuerySchema.parse({})).toEqual({ rankBy: 'sales' })
    expect(AttributionQuerySchema.parse({ date: '2026-10-01' }).granularity).toBe('day')
    expect(AttributionQuerySchema.safeParse({ date: '2026-02-30' }).success).toBe(false)
    expect(AttributionQuerySchema.safeParse({ date: '10/01/2026' }).success).toBe(false)
  })

  it('4 种模板：区域与指标卡都在目录内，没有重复，第一个区域是指标卡', () => {
    expect(OVERVIEW_TEMPLATE_SPECS.map(spec => spec.key)).toEqual(['owner', 'operation', 'finance', 'supply'])
    for (const spec of OVERVIEW_TEMPLATE_SPECS) {
      expect(new Set(spec.sections).size).toBe(spec.sections.length)
      expect(new Set(spec.cards).size).toBe(spec.cards.length)
      expect(spec.sections.every(section => OVERVIEW_SECTIONS.includes(section))).toBe(true)
      expect(spec.cards.every(card => KPI_KEYS.includes(card))).toBe(true)
      expect(spec.sections[0]).toBe('kpis')
    }
    expect(overviewTemplateOf('nope').key).toBe('owner')
    expect(overviewTemplateOf(undefined).key).toBe('owner')
  })

  it('个人布局：模板与隐藏项必须是目录内的值', () => {
    expect(OverviewLayoutSchema.safeParse({ template: 'finance', hiddenSections: ['cash'], hiddenCards: ['profit'] }).success).toBe(true)
    expect(OverviewLayoutSchema.safeParse({ template: 'finance', hiddenSections: ['nope'], hiddenCards: [] }).success).toBe(false)
    expect(OverviewLayoutSchema.safeParse({ template: 'x', hiddenSections: [], hiddenCards: [] }).success).toBe(false)
  })

  it('报表范围：日报当天、周报含截止日往前 7 天、月报截止日所在自然月', () => {
    expect(reportRange('daily', '2026-10-10')).toEqual({ from: '2026-10-10', to: '2026-10-10' })
    expect(reportRange('weekly', '2026-10-10')).toEqual({ from: '2026-10-04', to: '2026-10-10' })
    expect(reportRange('weekly', '2026-03-03')).toEqual({ from: '2026-02-25', to: '2026-03-03' })
    expect(reportRange('monthly', '2026-10-10')).toEqual({ from: '2026-10-01', to: '2026-10-10' })
  })

  it('报表导出已登记，只含已接入的列，没有敏感列', () => {
    const spec = EXPORT_KINDS.find(item => item.kind === OVERVIEW_REPORT_KIND)
    expect(spec?.permission).toBe('overview.read')
    expect(spec?.filterKeys).toEqual(['storeIds', 'from', 'to', 'template'])
    expect(spec?.columns.some(column => column.sensitive)).toBe(false)
    expect(spec?.columns.map(column => column.key)).not.toEqual(expect.arrayContaining(['profit', 'adsSpend', 'sessions']))
  })
})
