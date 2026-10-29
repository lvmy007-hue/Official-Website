import { describe, expect, it } from 'vitest'
import { localDay, specOfRule } from './spec'

// 自动规则定时评估的小函数（P3-13）。评估、待办、去重、每日上限等行为用真实数据库验证，见 apps/api/src/testing/ads-rules.db.test.ts。

describe('企业时区的今天', () => {
  const moment = new Date('2026-10-24T03:30:00Z')
  it('按企业时区换算日期：同一时刻在东八区已是 24 日，在美西还是 23 日', () => {
    expect(localDay(moment, 'Asia/Shanghai')).toBe('2026-10-24')
    expect(localDay(moment, 'America/Los_Angeles')).toBe('2026-10-23')
    expect(localDay(moment, 'UTC')).toBe('2026-10-24')
  })
  it('时区为空或无效：按默认时区（美西）处理，不抛错', () => {
    expect(localDay(moment, null)).toBe('2026-10-23')
    expect(localDay(moment, '')).toBe('2026-10-23')
    expect(localDay(moment, 'Not/AZone')).toBe('2026-10-23')
  })
})

describe('库里的规则还原成规格', () => {
  it('四块 JSON 各归各位', () => {
    const spec = specOfRule({
      level: 'TARGET',
      scopeJson: { campaignIds: ['c1', 'c2'] },
      conditionJson: { conditions: [{ metric: 'acos', windowDays: 7, op: 'gt', value: 40 }], textFilters: [{ field: 'NAME', mode: 'CONTAINS', text: 'yoga' }] },
      actionJson: { type: 'ADJUST_BID', mode: 'PERCENT', value: -10 },
      guardrailJson: { minValue: 0.3, maxValue: null, maxChangePercent: 20, dailyLimit: 5 },
    })
    expect(spec.level).toBe('TARGET')
    expect(spec.campaignIds).toEqual(['c1', 'c2'])
    expect(spec.conditions).toHaveLength(1)
    expect(spec.textFilters[0]).toMatchObject({ text: 'yoga' })
    expect(spec.action).toMatchObject({ type: 'ADJUST_BID' })
    expect(spec.guardrails).toMatchObject({ dailyLimit: 5, maxChangePercent: 20 })
  })
  it('数据被绕过约束改坏时按保守值处理：层级不认识当活动，列表缺失当空，不抛错', () => {
    const spec = specOfRule({ level: 'WEIRD', scopeJson: [], conditionJson: 'x', actionJson: null, guardrailJson: undefined })
    expect(spec.level).toBe('CAMPAIGN')
    expect(spec.campaignIds).toEqual([])
    expect(spec.conditions).toEqual([])
    expect(spec.textFilters).toEqual([])
  })
})
