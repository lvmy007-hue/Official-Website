import { describe, expect, it } from 'vitest'
import { buildAttribution, buildCards, buildProfit, buildSplit, buildTable, sumProductDays, type ProductDay } from './product-overview-math'

const day = (over: Partial<ProductDay> = {}): ProductDay => ({ units: 10, sales: 200, sessions: null, adsSpend: null, adsSales: null, profit: null, ...over })
const find = (cards: ReturnType<typeof buildCards>, key: string) => cards.find(card => card.key === key)!

describe('ASIN 360 经营表现计算', () => {
  it('合计：可空列整段都没有时为 null，有一天有值就求和', () => {
    expect(sumProductDays([day(), day({ units: 5, sales: 50 })])).toEqual({ units: 15, sales: 250, sessions: null, adsSpend: null, adsSales: null, profit: null })
    expect(sumProductDays([day({ profit: 3 }), day()]).profit).toBe(3)
  })

  it('卡片：销售额随对比期变化；没有对比期不给变化', () => {
    const cards = buildCards({ current: day({ sales: 300 }), hasCurrent: true, compare: day({ sales: 200 }), hasCompare: true, canSeeProfit: true })
    expect(find(cards, 'sales')).toMatchObject({ state: 'OK', value: 300, compareValue: 200, change: 0.5 })
    const alone = buildCards({ current: day(), hasCurrent: true, compare: null, hasCompare: false, canSeeProfit: true })
    expect(find(alone, 'sales')).toMatchObject({ change: null, compareValue: null })
  })

  it('卡片：对比期没有记录给出原因而不是把变化算成 100%', () => {
    const cards = buildCards({ current: day(), hasCurrent: true, compare: day({ units: 0, sales: 0 }), hasCompare: false, canSeeProfit: true })
    expect(find(cards, 'sales')).toMatchObject({ change: null })
    expect(find(cards, 'sales').note).toContain('对比期')
  })

  it('卡片：没有记录 = 无数据；利润无权限 = 受限；没接入 = 尚未接入', () => {
    const none = buildCards({ current: day({ units: 0, sales: 0 }), hasCurrent: false, compare: null, hasCompare: false, canSeeProfit: false })
    expect(find(none, 'sales')).toMatchObject({ state: 'NO_DATA', value: null })
    expect(find(none, 'profit')).toMatchObject({ state: 'RESTRICTED' })
    expect(find(none, 'margin')).toMatchObject({ state: 'RESTRICTED' })
    expect(find(none, 'conversion')).toMatchObject({ state: 'NOT_CONNECTED' })
    expect(find(none, 'adsShare')).toMatchObject({ state: 'NOT_CONNECTED' })
  })

  it('卡片：有利润、会话、广告时算利润率、转化率、广告占比（百分点差）', () => {
    const current = day({ sales: 200, profit: 40, sessions: 100, units: 10, adsSpend: 20 })
    const compare = day({ sales: 100, profit: 10, sessions: 100, units: 5, adsSpend: 20 })
    const cards = buildCards({ current, hasCurrent: true, compare, hasCompare: true, canSeeProfit: true })
    expect(find(cards, 'margin')).toMatchObject({ state: 'OK', value: 0.2, compareValue: 0.1 })
    expect(find(cards, 'margin').change).toBeCloseTo(0.1)
    expect(find(cards, 'conversion')).toMatchObject({ value: 0.1, compareValue: 0.05, changeKind: 'points' })
    expect(find(cards, 'adsShare')).toMatchObject({ value: 0.1, compareValue: 0.2 })
  })

  it('同比环比表：没有记录的时段是 null；对比期为 0 时没有变化比率', () => {
    const rows = buildTable({ value: day({ units: 10, sales: 200 }), has: true }, { value: day({ units: 5, sales: 100 }), has: true }, { value: day({ units: 0, sales: 0 }), has: false })
    expect(rows[0]).toMatchObject({ key: 'sales', current: 200, previous: 100, yoy: null, momChange: 1, yoyChange: null })
    expect(rows[2]).toMatchObject({ key: 'unitPrice', current: 20, previous: 20, momChange: 0 })
    const zero = buildTable({ value: day(), has: true }, { value: day({ units: 0, sales: 0 }), has: true }, { value: day(), has: true })
    expect(zero[0].momChange).toBeNull()
    expect(zero[2].previous).toBeNull()
  })

  it('自然销售与广告销售拆分', () => {
    expect(buildSplit(day(), true)).toMatchObject({ state: 'NOT_CONNECTED', adsSales: null })
    expect(buildSplit(day({ adsSales: 50 }), true)).toMatchObject({ state: 'OK', adsSales: 50, organicSales: 150, adsShare: 0.25 })
    const over = buildSplit(day({ adsSales: 500 }), true)
    expect(over.organicSales).toBeNull()
    expect(over.note).toContain('口径')
    expect(buildSplit(day({ adsSales: 5 }), false).state).toBe('NO_DATA')
  })

  it('利润状态：无权限、没接入、有数据', () => {
    const point = (profit: number | null) => ({ date: '2026-10-20', units: 1, sales: 1, profit, adsSales: null, sessions: null })
    expect(buildProfit([point(null)], false).state).toBe('RESTRICTED')
    expect(buildProfit([point(null)], true).state).toBe('NOT_CONNECTED')
    expect(buildProfit([point(null), point(3)], true).state).toBe('OK')
  })

  it('归因：没有对比期或任一期没有记录为 null；会话缺失走两因子', () => {
    expect(buildAttribution(day(), null, true)).toBeNull()
    expect(buildAttribution(day(), day(), false)).toBeNull()
    const result = buildAttribution(day({ units: 20, sales: 400 }), day({ units: 10, sales: 200 }), true)!
    expect(result.mode).toBe('TWO_FACTOR')
    expect(result.factors.map(factor => factor.key)).toEqual(['units', 'unitPrice'])
  })
})
