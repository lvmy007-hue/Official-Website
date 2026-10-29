import { describe, expect, it } from 'vitest'
import {
  ADS_METRIC_COLUMNS,
  ADS_METRIC_ENTITY_LABEL,
  ADS_METRIC_ENTITY_TYPES,
  ADS_NEGATIVE_LEVELS,
  ADS_NEGATIVE_LEVEL_LABEL,
  ADS_TARGETING_TYPES,
  ADS_TARGETING_TYPE_LABEL,
  ADS_TARGET_KINDS,
  ADS_TARGET_KIND_LABEL,
  adsAccountRefState,
} from './ads-model.js'

describe('广告数据模型取值', () => {
  it('每个取值都有中文标签，且没有多余的标签', () => {
    const pairs: Array<[readonly string[], Record<string, string>]> = [
      [ADS_METRIC_ENTITY_TYPES, ADS_METRIC_ENTITY_LABEL],
      [ADS_TARGET_KINDS, ADS_TARGET_KIND_LABEL],
      [ADS_NEGATIVE_LEVELS, ADS_NEGATIVE_LEVEL_LABEL],
      [ADS_TARGETING_TYPES, ADS_TARGETING_TYPE_LABEL],
    ]
    for (const [values, labels] of pairs) {
      expect(Object.keys(labels).sort()).toEqual([...values].sort())
      for (const value of values) expect(labels[value].length).toBeGreaterThan(0)
    }
  })

  it('金额与订单数的列名对照：旧表沿用 cost 与 purchases，新表是 spend 与 orders', () => {
    expect(ADS_METRIC_COLUMNS.AdsMetric).toEqual({ spend: 'cost', orders: 'purchases' })
    expect(ADS_METRIC_COLUMNS.AdsTermMetric).toEqual({ spend: 'cost', orders: 'purchases' })
    for (const table of ['AdsPlacementMetric', 'AdsAdvertisedProductMetric', 'AdsPerformanceHourly'] as const) expect(ADS_METRIC_COLUMNS[table]).toEqual({ spend: 'spend', orders: 'orders' })
  })

  it('广告账户编号为空（或只有空白）时写“未发现广告账户”，不显示成空串', () => {
    expect(adsAccountRefState({ adsAccountId: 'amzn1.ads-account.g.x' })).toEqual({ discovered: true, adsAccountId: 'amzn1.ads-account.g.x' })
    for (const empty of [null, undefined, '', '  ']) {
      const state = adsAccountRefState({ adsAccountId: empty })
      expect(state.discovered).toBe(false)
      expect('label' in state && state.label).toContain('未发现广告账户')
    }
  })
})
