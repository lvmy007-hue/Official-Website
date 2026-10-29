import { describe, expect, it } from 'vitest'
import type { AdsTotals } from '@nova/api-contracts'
import { aggregateTerms, campaignKey, searchRowOf, sortTermRows, targetKeyOf, targetPartsOf, targetRowOf, type Targeting, type TargetGroup, type TermGroup } from './ad-terms-rows'

const totals = (patch: Partial<AdsTotals> = {}): AdsTotals => ({ impressions: 1000, clicks: 30, spend: 25, sales: 0, orders: 0, ...patch })
const group = (adsProfileId: string, campaignId: string, term: string, patch: Partial<AdsTotals> = {}): TermGroup => ({ adsProfileId, campaignId, term, totals: totals(patch) })
const targeting = (targeted: Record<string, string[]> = {}, negated: Record<string, string[]> = {}): Targeting => ({
  targeted: new Map(Object.entries(targeted).map(([key, terms]) => [key, new Set(terms)])),
  negated: new Map(Object.entries(negated).map(([key, terms]) => [key, new Set(terms)])),
})

describe('词级行装配', () => {
  it('同一个词的不同写法与多个活动合并成一行：合计相加、显示花费最高的写法、店铺去重', () => {
    const rows = aggregateTerms(
      [group('p1', 'c1', 'Yoga Mat', { spend: 10, clicks: 5 }), group('p1', 'c2', 'yoga  mat', { spend: 4, clicks: 2 }), group('p2', 'c9', 'YOGA MAT', { spend: 1, clicks: 1 })],
      targeting(),
      id => (id === 'p1' ? 's1' : null),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ key: 'yoga mat', term: 'Yoga Mat', stores: 1, totals: { spend: 15, clicks: 8 }, campaigns: { total: 3, targeted: 0, negated: 0 }, status: 'UNTARGETED' })
  })

  it('状态按活动判断：所有活动都否定才是已否定；任一活动已投放是已投放；否定优先于投放', () => {
    const t = targeting({ [campaignKey('p1', 'c1')]: ['yoga mat'], [campaignKey('p1', 'c2')]: ['yoga mat'] }, { [campaignKey('p1', 'c2')]: ['yoga mat'] })
    const [mixed] = aggregateTerms([group('p1', 'c1', 'yoga mat'), group('p1', 'c2', 'yoga mat')], t, () => null)
    expect(mixed).toMatchObject({ status: 'TARGETED', campaigns: { total: 2, targeted: 1, negated: 1 } })
    const [allNegated] = aggregateTerms([group('p1', 'c2', 'yoga mat')], t, () => null)
    expect(allNegated).toMatchObject({ status: 'NEGATED', campaigns: { total: 1, targeted: 0, negated: 1 } })
    const [partial] = aggregateTerms([group('p1', 'c2', 'yoga mat'), group('p1', 'c3', 'yoga mat')], t, () => null)
    expect(partial?.status).toBe('UNTARGETED')
  })

  it('空白词被跳过；搜索词行带比率与异常分组（没投放且点击多没订单是否定候选）', () => {
    expect(aggregateTerms([group('p1', 'c1', '   ')], targeting(), () => null)).toEqual([])
    const [aggregate] = aggregateTerms([group('p1', 'c1', 'bad term', { clicks: 12, spend: 6 })], targeting(), () => null)
    const row = searchRowOf(aggregate!)
    expect(row.anomalies).toEqual(['NEGATIVE_CANDIDATE'])
    expect(row.ratios.cpc).toBeCloseTo(0.5)
    expect(row.ratios.acos).toBeNull()
  })

  it('排序不改动输入，空值在最后', () => {
    const rows = [
      { id: 'a', totals: totals({ spend: null }), ratios: searchRowOf(aggregateTerms([group('p', 'c', 'a', { spend: null })], targeting(), () => null)[0]!).ratios },
      { id: 'b', totals: totals({ spend: 5 }), ratios: searchRowOf(aggregateTerms([group('p', 'c', 'b', { spend: 5 })], targeting(), () => null)[0]!).ratios },
    ]
    const sorted = sortTermRows(
      rows,
      row => row.id,
      row => row.id,
      'spend',
      'desc',
    )
    expect(sorted.map(row => row.id)).toEqual(['b', 'a'])
    expect(rows.map(row => row.id)).toEqual(['a', 'b'])
  })
})

describe('投放对象行', () => {
  const target = (patch: Partial<TargetGroup> = {}): TargetGroup => ({
    adsProfileId: 'p1',
    campaignId: 'c1',
    adGroupId: 'g1',
    targetId: 'k1',
    expression: 'Yoga Mat',
    matchType: 'EXACT',
    campaignName: '活动一',
    adGroupName: '组一',
    totals: totals({ spend: 30, clicks: 25, orders: 3, sales: 90 }),
    ...patch,
  })

  it('行键区分档案、活动、广告组、投放编号、写法与匹配方式；写法不分大小写', () => {
    expect(targetKeyOf(target())).toBe('p1|c1|g1|k1|yoga mat|EXACT')
    expect(targetKeyOf(target({ matchType: 'PHRASE' }))).not.toBe(targetKeyOf(target()))
    expect(targetKeyOf(target({ expression: 'YOGA MAT' }))).toBe(targetKeyOf(target()))
    expect(targetKeyOf(target({ adGroupId: null, targetId: null, matchType: null }))).toBe('p1|c1|||yoga mat|')
  })

  it('异常分组与行：已同步的竞价与状态由调用方补，没有就是空；名称优先用实体表，其次用报表里的名称', () => {
    const parts = targetPartsOf(target({ totals: totals({ spend: 30, clicks: 25, orders: 0, sales: 0 }) }))
    expect(parts.anomalies).toEqual(['HIGH_SPEND_NO_ORDER'])
    const row = targetRowOf(parts, { campaignName: null, adGroupName: '实体组', storeName: '店铺一', bid: null, state: null })
    expect(row).toMatchObject({
      campaignName: '活动一',
      adGroupName: '实体组',
      storeName: '店铺一',
      bid: null,
      state: null,
      expression: 'Yoga Mat',
      matchType: 'EXACT',
      anomalies: ['HIGH_SPEND_NO_ORDER'],
    })
    expect(row.ratios.acos).toBeNull()
  })
})
