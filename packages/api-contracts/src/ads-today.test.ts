import { describe, expect, it } from 'vitest'
import { ADS_TODAY_ANOMALY_KINDS, ADS_TODAY_ANOMALY_LABEL, ADS_TODAY_ANOMALY_RULES, ADS_TODAY_BAND_MIN_SAMPLES, ADS_TODAY_EXHAUST_LABEL, ADS_TODAY_EXHAUST_STATES } from './ads-today'
import { adsCpc, cpcSurge, exhaustProjection, hourBand, isOutOfBudgetStatus, spendWithoutConversion } from './ads-today-math'

const DAY_START = new Date('2026-10-23T00:00:00Z')
const DAY_END = new Date('2026-10-24T00:00:00Z')
const at = (hours: number) => new Date(DAY_START.getTime() + hours * 3_600_000)

describe('今日广告目录', () => {
  it('每种异常与每种耗尽状态都有中文标签', () => {
    for (const kind of ADS_TODAY_ANOMALY_KINDS) expect(ADS_TODAY_ANOMALY_LABEL[kind]).toBeTruthy()
    for (const state of ADS_TODAY_EXHAUST_STATES) expect(ADS_TODAY_EXHAUST_LABEL[state]).toBeTruthy()
  })
})

describe('adsCpc', () => {
  it('花费除以点击；没有点击、没有花费或花费为 0 返回 null，不是 0', () => {
    expect(adsCpc(30, 60)).toBe(0.5)
    expect(adsCpc(30, 0)).toBeNull()
    expect(adsCpc(null, 10)).toBeNull()
    expect(adsCpc(0, 10)).toBeNull()
  })
})

describe('hourBand', () => {
  it('样本不足不给区间带', () => {
    expect(hourBand([])).toBeNull()
    expect(hourBand(Array.from({ length: ADS_TODAY_BAND_MIN_SAMPLES - 1 }, () => ({ spend: 1, clicks: 1 })))).toBeNull()
  })

  it('取花费与点击的上下限；花费全是空时花费上下限为空', () => {
    expect(
      hourBand([
        { spend: 4, clicks: 10 },
        { spend: 10, clicks: 30 },
        { spend: null, clicks: 20 },
      ]),
    ).toEqual({ spendMin: 4, spendMax: 10, clicksMin: 10, clicksMax: 30, samples: 3 })
    expect(
      hourBand([
        { spend: null, clicks: 1 },
        { spend: null, clicks: 2 },
        { spend: null, clicks: 3 },
      ]),
    ).toMatchObject({ spendMin: null, spendMax: null, clicksMin: 1, clicksMax: 3 })
  })
})

describe('exhaustProjection', () => {
  const base = { dailyBudget: 100, dayStart: DAY_START, dayEndExclusive: DAY_END }

  it('已花完：不外推', () => {
    expect(exhaustProjection({ ...base, spend: 100, now: at(6) })).toEqual({ state: 'EXHAUSTED', at: null })
    expect(exhaustProjection({ ...base, spend: 130, now: at(6) }).state).toBe('EXHAUSTED')
  })

  it('刚过零点不到 1 小时：太早，不外推；没有花费：不外推', () => {
    expect(exhaustProjection({ ...base, spend: 5, now: new Date(DAY_START.getTime() + 30 * 60_000) })).toEqual({ state: 'TOO_EARLY', at: null })
    expect(exhaustProjection({ ...base, spend: 0, now: at(6) })).toEqual({ state: 'NO_SPEND', at: null })
    expect(exhaustProjection({ ...base, spend: null, now: at(6) })).toEqual({ state: 'NO_SPEND', at: null })
  })

  it('照平均速度外推：6 小时花了 50，再 6 小时耗尽；速度太慢今天耗不完', () => {
    const projected = exhaustProjection({ ...base, spend: 50, now: at(6) })
    expect(projected.state).toBe('PROJECTED')
    expect(projected.at?.toISOString()).toBe('2026-10-23T12:00:00.000Z')
    expect(exhaustProjection({ ...base, spend: 10, now: at(6) })).toEqual({ state: 'NOT_TODAY', at: null })
  })
})

describe('cpcSurge', () => {
  it('今日单次点击成本达到基线的 1.5 倍才算突增', () => {
    expect(cpcSurge({ spend: 30, clicks: 30 }, { spend: 400, clicks: 800 })).toMatchObject({ todayCpc: 1, baselineCpc: 0.5, ratio: 2 })
    expect(cpcSurge({ spend: 22.5, clicks: 30 }, { spend: 400, clicks: 800 })).not.toBeNull()
    expect(cpcSurge({ spend: 20, clicks: 30 }, { spend: 400, clicks: 800 })).toBeNull()
  })

  it('点击样本不够、没有花费都不判断', () => {
    expect(cpcSurge({ spend: 30, clicks: ADS_TODAY_ANOMALY_RULES.CPC_MIN_CLICKS - 1 }, { spend: 400, clicks: 800 })).toBeNull()
    expect(cpcSurge({ spend: 30, clicks: 30 }, { spend: 40, clicks: ADS_TODAY_ANOMALY_RULES.BASELINE_MIN_CLICKS - 1 })).toBeNull()
    expect(cpcSurge({ spend: null, clicks: 30 }, { spend: 400, clicks: 800 })).toBeNull()
    expect(cpcSurge({ spend: 30, clicks: 30 }, { spend: null, clicks: 800 })).toBeNull()
  })
})

describe('spendWithoutConversion', () => {
  it('花费与点击都到门槛且没有订单才算', () => {
    expect(spendWithoutConversion({ spend: 25, clicks: 30, orders: 0 })).toBe(true)
    expect(spendWithoutConversion({ spend: 25, clicks: 30, orders: 1 })).toBe(false)
    expect(spendWithoutConversion({ spend: 19.99, clicks: 30, orders: 0 })).toBe(false)
    expect(spendWithoutConversion({ spend: 25, clicks: 19, orders: 0 })).toBe(false)
    expect(spendWithoutConversion({ spend: null, clicks: 30, orders: 0 })).toBe(false)
  })
})

describe('isOutOfBudgetStatus', () => {
  it('投放状态带 OUT_OF_BUDGET 才算预算用完（不区分大小写），没同步的状态不算', () => {
    expect(isOutOfBudgetStatus('CAMPAIGN_OUT_OF_BUDGET')).toBe(true)
    expect(isOutOfBudgetStatus('campaign_out_of_budget')).toBe(true)
    expect(isOutOfBudgetStatus('CAMPAIGN_STATUS_ENABLED')).toBe(false)
    expect(isOutOfBudgetStatus(null)).toBe(false)
    expect(isOutOfBudgetStatus(undefined)).toBe(false)
  })
})
