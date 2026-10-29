import { describe, expect, it } from 'vitest'
import type { AdsEntityRecord } from '../connectors/ads-v1-parse'
import { dateOf, planEntity, planPortfolio } from './map'

// 广告实体字段映射（P5-12A）：纯函数。字段名是按统一接口命名约定写的假设（CR-104），这里固定“取不到不覆盖、对不上不乱写”的行为。

const rec = (patch: Partial<AdsEntityRecord> & Pick<AdsEntityRecord, 'entityType' | 'entityId'>): AdsEntityRecord => ({ raw: {}, ...patch })

describe('活动', () => {
  it('取预算、预算类型、竞价策略、投放状态；行键是“编号|广告产品”', () => {
    const planned = planEntity(
      rec({
        entityType: 'CAMPAIGN',
        entityId: 'C1',
        name: '品牌词',
        state: 'enabled',
        raw: {
          adProduct: 'sponsored_products',
          budgets: [{ recurrenceTimePeriod: 'daily', budgetValue: { monetaryBudgetValue: { monetaryBudget: { value: 50, currencyCode: 'usd' } } } }],
          optimizations: { bidSettings: { bidStrategy: 'LEGACY_FOR_SALES' } },
          servingStatus: 'CAMPAIGN_OUT_OF_BUDGET',
          targetingType: 'auto',
          startDateTime: '2026-10-01T00:00:00Z',
          portfolioId: 12345,
        },
      }),
    )
    expect(planned).toMatchObject({
      table: 'campaigns',
      key: 'C1|SPONSORED_PRODUCTS',
      values: {
        externalCampaignId: 'C1',
        adProduct: 'SPONSORED_PRODUCTS',
        name: '品牌词',
        state: 'ENABLED',
        budget: 50,
        currency: 'USD',
        budgetType: 'DAILY',
        bidStrategy: 'LEGACY_FOR_SALES',
        servingStatus: 'CAMPAIGN_OUT_OF_BUDGET',
        targetingType: 'AUTO',
        portfolioId: '12345',
      },
    })
    expect((planned as { values: { startDate: Date } }).values.startDate.toISOString()).toBe('2026-10-01T00:00:00.000Z')
  })

  it('没有给的字段是 undefined（写库时保持原值），旧格式的预算也认', () => {
    const planned = planEntity(rec({ entityType: 'CAMPAIGN', entityId: 'C2', raw: { product: 'SPONSORED_BRANDS', budget: { budget: 20, budgetType: 'daily' } } }))
    expect(planned).toMatchObject({ key: 'C2|SPONSORED_BRANDS', values: { budget: 20, budgetType: 'DAILY' } })
    const values = (planned as { values: Record<string, unknown> }).values
    expect(values.servingStatus).toBeUndefined()
    expect(values.bidStrategy).toBeUndefined()
    expect(values.state).toBeUndefined()
  })

  it('没有可识别的广告产品：跳过并说明原因，不猜', () => {
    expect(planEntity(rec({ entityType: 'CAMPAIGN', entityId: 'C3' }))).toEqual({ skipped: 'NO_PRODUCT' })
    expect(planEntity(rec({ entityType: 'CAMPAIGN', entityId: 'C3', raw: { adProduct: 'SPONSORED_WHATEVER' } }))).toEqual({ skipped: 'NO_PRODUCT' })
  })
})

describe('广告组与广告', () => {
  it('广告组、广告必须有上级编号', () => {
    expect(planEntity(rec({ entityType: 'AD_GROUP', entityId: 'G1' }))).toEqual({ skipped: 'NO_PARENT' })
    expect(planEntity(rec({ entityType: 'AD', entityId: 'A1' }))).toEqual({ skipped: 'NO_PARENT' })
    expect(planEntity(rec({ entityType: 'AD_GROUP', entityId: 'G1', parentId: 'C1', name: '组', state: 'paused', raw: { defaultBid: '1.25' } }))).toMatchObject({
      table: 'adGroups',
      key: 'G1',
      values: { adGroupId: 'G1', campaignId: 'C1', state: 'PAUSED', defaultBid: 1.25 },
    })
    expect(planEntity(rec({ entityType: 'AD', entityId: 'A1', parentId: 'G1', raw: { product: { asin: 'B0AAA', sku: 'S1' } } }))).toMatchObject({
      table: 'ads',
      values: { adId: 'A1', adGroupId: 'G1', asin: 'B0AAA', sku: 'S1' },
    })
  })
})

describe('投放对象：关键词、商品/类目/受众投放、否定投放分流', () => {
  it('非否定的关键词进关键词表，带广告组编号供反查活动', () => {
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'K1', parentId: 'G1', state: 'enabled', raw: { keywordText: 'yoga mat', matchType: 'exact', bid: 0.8 } }))).toMatchObject({
      table: 'keywords',
      groupId: 'G1',
      values: { keywordId: 'K1', adGroupId: 'G1', text: 'yoga mat', matchType: 'EXACT', bid: 0.8, state: 'ENABLED' },
    })
  })
  it('商品投放、类目投放进投放对象表', () => {
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'T1', parentId: 'G1', raw: { asin: 'B0BBB' } }))).toMatchObject({
      table: 'targets',
      values: { targetId: 'T1', kind: 'PRODUCT', expression: 'B0BBB' },
    })
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'T2', parentId: 'G1', raw: { categoryId: '77' } }))).toMatchObject({ table: 'targets', values: { kind: 'CATEGORY', expression: '77' } })
  })
  it('否定投放：有广告组是广告组级，只有活动编号是活动级；已归档的标记为删除；没有任何上级的跳过', () => {
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'N1', parentId: 'G1', raw: { negative: true, keywordText: 'free', matchType: 'negative_phrase' } }))).toMatchObject({
      table: 'negatives',
      remove: false,
      values: { negativeId: 'N1', level: 'AD_GROUP', adGroupId: 'G1', expression: 'free', matchType: 'NEGATIVE_PHRASE' },
    })
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'N2', raw: { isNegative: true, keywordText: 'cheap', campaignId: 'C1' } }))).toMatchObject({
      table: 'negatives',
      values: { level: 'CAMPAIGN', campaignId: 'C1', expression: 'cheap' },
    })
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'N3', parentId: 'G1', state: 'archived', raw: { negative: true, keywordText: 'x' } }))).toMatchObject({ remove: true })
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'N4', raw: { negative: true, keywordText: 'x' } }))).toEqual({ skipped: 'NO_PARENT' })
  })
  it('没有表达式、没有广告组的投放对象跳过，不写空内容', () => {
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'T9', parentId: 'G1' }))).toEqual({ skipped: 'NO_EXPRESSION' })
    expect(planEntity(rec({ entityType: 'TARGET', entityId: 'T9', raw: { keywordText: 'a' } }))).toEqual({ skipped: 'NO_PARENT' })
  })
})

describe('广告组合与日期', () => {
  it('组合按编号取预算上限与状态；没有编号返回 null', () => {
    expect(planPortfolio({ name: '无编号' })).toBeNull()
    expect(planPortfolio({ portfolioId: 77, name: '旺季', state: 'enabled', budget: { amount: 900, policy: 'monthly', currencyCode: 'usd', startDate: '20261001' } })).toMatchObject({
      key: '77',
      values: { portfolioId: '77', name: '旺季', status: 'ENABLED', budgetCap: 900, budgetPeriod: 'MONTHLY', currency: 'USD' },
    })
  })
  it('日期支持 8 位数字与 ISO 文本，取不出是 undefined', () => {
    expect(dateOf('20261101')?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(dateOf('not a date')).toBeUndefined()
    expect(dateOf(undefined)).toBeUndefined()
  })
})
