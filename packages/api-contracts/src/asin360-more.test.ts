import { describe, expect, it } from 'vitest'
import { ASIN360_ACTION_RULES, ASIN360_PANEL_TABS, ASIN360_PENDING_SECTIONS, ASIN360_TABS, Asin360PeriodQuerySchema, asin360ActionRuleViews, visibleAsin360Tabs } from './index.js'

describe('ASIN 360 剩余页签上线', () => {
  it('12 个页签全部上线，权限与 05 章一致', () => {
    expect(ASIN360_TABS.every(tab => tab.live)).toBe(true)
    const need = (key: string) => ASIN360_TABS.find(tab => tab.key === key)!.permissions
    expect(need('traffic')).toEqual(['products.read'])
    expect(need('listing')).toEqual(['products.read', 'listing.read'])
    expect(need('reviews')).toEqual(['products.read', 'reviews.read'])
    expect(need('pricing')).toEqual(['products.read', 'pricing.read'])
    expect(need('competitors')).toEqual(['products.read', 'competitors.read'])
    expect(need('content')).toEqual(['products.read', 'aplus.read'])
  })

  it('只有 products.read 的成员能看到经营表现、流量转化、变更与审计', () => {
    expect(visibleAsin360Tabs(permission => permission === 'products.read').map(tab => tab.key)).toEqual(['overview', 'traffic', 'changes'])
  })
})

describe('尚未接入的区块', () => {
  it('每个页签都有说明；有工作包的写明工作包，永远不会有的来源 workPackage 为 null', () => {
    for (const tab of ['traffic', ...ASIN360_PANEL_TABS] as const) {
      const sections = ASIN360_PENDING_SECTIONS[tab]
      if (tab !== 'competitors') expect(sections.length, tab).toBeGreaterThan(0)
      expect(new Set(sections.map(section => section.key)).size, tab).toBe(sections.length)
      for (const section of sections) {
        expect(section.state).toBe('NOT_CONNECTED')
        expect(section.note.length, `${tab}.${section.key}`).toBeGreaterThan(5)
      }
    }
    expect(ASIN360_PENDING_SECTIONS.reviews.every(section => section.workPackage === 'P4-13')).toBe(true)
    expect(ASIN360_PENDING_SECTIONS.traffic.every(section => section.workPackage === null)).toBe(true)
  })
})

describe('建议动作区的 6 条规则', () => {
  it('规则与 05 章一一对应', () => {
    expect(ASIN360_ACTION_RULES.map(rule => rule.key)).toEqual(['PRICE_ABOVE_WIN', 'LOW_COVER', 'LISTING_ERROR', 'NEGATIVE_REVIEW', 'AGING_FEE', 'CONTENT_CHANGED'])
  })

  it('库存类按建议编号判断；没有数据来源的规则永远是“尚未接入”，不会被当作“没触发”', () => {
    const state = (views: ReturnType<typeof asin360ActionRuleViews>) => Object.fromEntries(views.map(view => [view.key, view.state]))
    expect(state(asin360ActionRuleViews({ inventory: 'OK', suggestionIds: ['replenish'] }))).toEqual({
      PRICE_ABOVE_WIN: 'NOT_CONNECTED',
      LOW_COVER: 'TRIGGERED',
      LISTING_ERROR: 'NOT_CONNECTED',
      NEGATIVE_REVIEW: 'NOT_CONNECTED',
      AGING_FEE: 'CLEAR',
      CONTENT_CHANGED: 'NOT_CONNECTED',
    })
    expect(state(asin360ActionRuleViews({ inventory: 'OK', suggestionIds: ['aging', 'excess'] }))).toMatchObject({ LOW_COVER: 'CLEAR', AGING_FEE: 'TRIGGERED' })
    expect(state(asin360ActionRuleViews({ inventory: 'NO_DATA', suggestionIds: [] }))).toMatchObject({ LOW_COVER: 'NO_DATA', AGING_FEE: 'NO_DATA', LISTING_ERROR: 'NOT_CONNECTED' })
    expect(state(asin360ActionRuleViews({ inventory: 'RESTRICTED', suggestionIds: [] }))).toMatchObject({ LOW_COVER: 'RESTRICTED', AGING_FEE: 'RESTRICTED', CONTENT_CHANGED: 'NOT_CONNECTED' })
  })
})

describe('周期参数', () => {
  it('默认按周；起始日必须与周期种类对齐', () => {
    expect(Asin360PeriodQuerySchema.parse({})).toEqual({ period: 'WEEK' })
    expect(Asin360PeriodQuerySchema.parse({ period: 'MONTH', periodStart: '2026-09-01' })).toEqual({ period: 'MONTH', periodStart: '2026-09-01' })
    expect(Asin360PeriodQuerySchema.safeParse({ period: 'MONTH', periodStart: '2026-09-02' }).success).toBe(false)
    expect(Asin360PeriodQuerySchema.safeParse({ period: 'WEEK', periodStart: '2026-09-02' }).success).toBe(false)
    expect(Asin360PeriodQuerySchema.safeParse({ period: 'DAY' }).success).toBe(false)
    expect(Asin360PeriodQuerySchema.safeParse({ periodStart: 'bad' }).success).toBe(false)
  })
})
