import { describe, expect, it } from 'vitest'
import type { AmazonReplenishment } from '@nova/api-contracts'
import { diffReasons, ourAction, ourDisposition, suggestionsFor } from './inventory-advice'
import { assessment, demand, policy, TODAY } from './inventory-fixtures.test-helper'

const idle = { strandedQty: null, strandedReason: null, agingAtRisk: null, unsellable: 0, researching: 0 }

describe('我方建议动作', () => {
  it('按优先级：高风险立即补货 > 中风险补货 > 滞留 > 高龄 > 冗余 > 不可售；都没有则无动作', () => {
    expect(ourAction({ ...idle, risk: 'HIGH', strandedQty: 3 })).toBe('REPLENISH_URGENT')
    expect(ourAction({ ...idle, risk: 'MEDIUM' })).toBe('REPLENISH')
    expect(ourAction({ ...idle, risk: 'NORMAL', strandedReason: '缺少标签' })).toBe('FIX_STRANDED')
    expect(ourAction({ ...idle, risk: 'NORMAL', agingAtRisk: true })).toBe('CLEAR_AGED')
    expect(ourAction({ ...idle, risk: 'EXCESS' })).toBe('REDUCE_EXCESS')
    expect(ourAction({ ...idle, risk: null, unsellable: 2 })).toBe('CHECK_UNSELLABLE')
    expect(ourAction({ ...idle, risk: 'NORMAL' })).toBeNull()
  })
})

describe('与亚马逊建议的差异原因', () => {
  const amazon = (over: Partial<AmazonReplenishment> = {}): AmazonReplenishment => ({
    state: 'OK',
    note: null,
    recommendedQty: 500,
    recommendedShipDate: null,
    alertReason: null,
    recommendedAction: null,
    source: 'RESTOCK_REPORT',
    snapshotDate: TODAY,
    ...over,
  })
  const base = { oursQty: 300, amazon: amazon(), amazonUnits30: 300, demand: demand(), policy: policy(), inbound: { working: 0, shipped: 0, receiving: 0 } }

  it('没有亚马逊建议：不编造差异原因', () => {
    expect(diffReasons({ ...base, amazon: amazon({ state: 'NO_DATA', recommendedQty: null }) })).toEqual(['亚马逊尚无补货建议，无法对比'])
    expect(diffReasons({ ...base, policy: null })).toEqual([])
  })

  it('数量一致不列原因', () => {
    expect(diffReasons({ ...base, oursQty: 500 })).toEqual([])
  })

  it('日销差异超过 10% 才列；不计入的在途类别按数量列出；目标天数永远说明', () => {
    const reasons = diffReasons({ ...base, amazonUnits30: 450, policy: policy({ inboundCounted: ['SHIPPED'] }), inbound: { working: 40, shipped: 10, receiving: 0 } })
    expect(reasons.some(item => item.startsWith('预测日销不同'))).toBe(true)
    expect(reasons.some(item => item.includes('处理中 40 件'))).toBe(true)
    expect(reasons.some(item => item.includes('已发货'))).toBe(false)
    expect(reasons.at(-1)).toContain('目标天数不同')
    expect(diffReasons(base).some(item => item.startsWith('预测日销不同'))).toBe(false)
  })
})

describe('处置建议', () => {
  const input = {
    policy: policy(),
    assessment: assessment({ risk: 'EXCESS' }),
    agingAtRisk: false,
    agedQty: null,
    demandMid: 5,
    sellable: 1000,
    inboundCounted: 0,
    nextMonthStorage: 50,
    ageSurcharge: 50,
  }

  it('没有策略：尚未配置', () => {
    expect(ourDisposition({ ...input, policy: null })).toMatchObject({ state: 'NOT_CONNECTED', action: null })
  })

  it('冗余：可移除量 = 超出目标覆盖的部分且不超过可售；节省 = 数量 × 每件（仓储 + 附加费）', () => {
    const result = ourDisposition(input)
    // 目标 5 × 60 = 300，可移除 700；每件 (50+50)/1000 = 0.1 → 70
    expect(result).toMatchObject({ state: 'OK', action: 'REDUCE_EXCESS', excessQty: 700, estimatedSavings: 70 })
    expect(result.formula).toContain('700 件')
  })

  it('没有费用数据时不估算节省', () => {
    expect(ourDisposition({ ...input, nextMonthStorage: null, ageSurcharge: null })).toMatchObject({ excessQty: 700, estimatedSavings: null, formula: null })
  })

  it('高龄风险：清理量取高龄数量，节省取亚马逊的附加费预估；否则无需处置', () => {
    expect(ourDisposition({ ...input, assessment: assessment({ risk: 'NORMAL' }), agingAtRisk: true, agedQty: 30 })).toMatchObject({ action: 'CLEAR_AGED', excessQty: 30, estimatedSavings: 50 })
    expect(ourDisposition({ ...input, assessment: assessment({ risk: 'NORMAL' }) })).toMatchObject({ state: 'OK', action: null, excessQty: null })
  })
})

describe('详情页建议卡', () => {
  const base = {
    assessment: assessment({ risk: 'HIGH', daysOfCover: 20, stockoutDate: '2026-11-11' }),
    demand: demand(),
    sellable: 200,
    inboundCounted: 0,
    policy: policy(),
    action: 'REPLENISH_URGENT' as const,
    strandedReason: null,
    agedQty: null,
    ageSurcharge: null,
    today: TODAY,
  }

  it('高风险给出规则、证据（含规则版本）、影响区间与风险', () => {
    const list = suggestionsFor(base)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: 'replenish', action: 'REPLENISH_URGENT' })
    expect(list[0].evidence).toContain('规则版本 3')
    expect(list[0].impact).toContain('断货日在')
  })

  it('没有策略不给补货建议；滞留与高龄各自成卡', () => {
    expect(suggestionsFor({ ...base, policy: null })).toEqual([])
    const ids = suggestionsFor({ ...base, assessment: assessment({ risk: 'NORMAL' }), strandedReason: '缺少标签', agedQty: 10, ageSurcharge: 8 }).map(item => item.id)
    expect(ids).toEqual(['aging', 'stranded'])
  })
})
