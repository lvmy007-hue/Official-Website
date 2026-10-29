import { describe, expect, it } from 'vitest'
import {
  FEE_AUDIT_FRESHNESS_KEYS,
  FeeAuditQuerySchema,
  feeAuditOpportunityKey,
  feeAuditStatusOf,
  lengthToCm,
  maxSideDelta,
  overchargeOf,
  sizeTierChanged,
  sortedSides,
  volumeCubicFeet,
  volumeRatio,
  weightToKg,
} from './fee-audit.js'
import { FRESHNESS_SOURCES, REPORT_FRESHNESS_SOURCES } from './freshness.js'
import { CONNECTED_RULES } from './reimbursements.js'
import { EVIDENCE_KINDS } from './receiving.js'

describe('overchargeOf：容差内不算多收', () => {
  it('超过容差才算，少收与容差内返回 0', () => {
    expect(overchargeOf(6, 9)).toBe(3)
    expect(overchargeOf(6, 6.1)).toBe(0) // 差 0.1，容差 max(0.05, 0.12)=0.12
    expect(overchargeOf(6, 6.13)).toBe(0.13)
    expect(overchargeOf(6, 5)).toBe(0)
    expect(overchargeOf(0, 0.04)).toBe(0)
    expect(overchargeOf(0, 0.06)).toBe(0.06)
  })
  it('非法输入不当作多收', () => {
    expect(overchargeOf(Number.NaN, 5)).toBe(0)
    expect(overchargeOf(-1, 5)).toBe(0)
    expect(overchargeOf(5, Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('单位换算', () => {
  it('长度：缺单位按英寸，认不出返回 null', () => {
    expect(lengthToCm(10, 'inches')).toBe(25.4)
    expect(lengthToCm(10, null)).toBe(25.4)
    expect(lengthToCm(100, 'MM')).toBe(10)
    expect(lengthToCm(10, 'furlongs')).toBeNull()
    expect(lengthToCm(null, 'cm')).toBeNull()
    expect(lengthToCm(-1, 'cm')).toBeNull()
  })
  it('重量：缺单位按磅，认不出返回 null', () => {
    expect(weightToKg(2, 'pounds')).toBe(0.9072)
    expect(weightToKg(1000, 'g')).toBe(1)
    expect(weightToKg(16, 'oz')).toBe(0.4536)
    expect(weightToKg(1, 'stone')).toBeNull()
  })
})

describe('尺寸与体积', () => {
  it('三条边从长到短排序，缺一条返回 null', () => {
    expect(sortedSides(10, 30, 20)).toEqual({ longestCm: 30, medianCm: 20, shortestCm: 10 })
    expect(sortedSides(10, null, 20)).toBeNull()
    expect(sortedSides(10, 0, 20)).toBeNull()
  })
  it('体积比与单边相对差', () => {
    const ours = sortedSides(10, 10, 10)!
    const amazon = sortedSides(20, 10, 10)!
    expect(volumeRatio(amazon, ours)).toBe(2)
    expect(volumeRatio(null, ours)).toBeNull()
    expect(maxSideDelta(amazon, ours)).toBe(1)
    expect(maxSideDelta(ours, ours)).toBe(0)
    expect(maxSideDelta(ours, null)).toBeNull()
    expect(volumeCubicFeet({ longestCm: 30.48, medianCm: 30.48, shortestCm: 30.48 })).toBeCloseTo(1, 4)
  })
})

describe('尺寸分段变化', () => {
  it('忽略大小写与标点；任一边没有值不算变化', () => {
    expect(sizeTierChanged('Small Standard', 'large standard')).toBe(true)
    expect(sizeTierChanged('Small-Standard', 'small standard')).toBe(false)
    expect(sizeTierChanged(null, 'Large Standard')).toBe(false)
    expect(sizeTierChanged('Large Standard', '')).toBe(false)
  })
})

describe('状态与去重键', () => {
  it('没有多收为正常；有多收按是否已转机会', () => {
    expect(feeAuditStatusOf(0, true)).toBe('NORMAL')
    expect(feeAuditStatusOf(2, false)).toBe('SUSPECTED')
    expect(feeAuditStatusOf(2, true)).toBe('APPEALED')
  })
  it('去重键不含核查日，且不超过 200 字', () => {
    expect(feeAuditOpportunityKey('FULFILLMENT', 'SKU-1')).toBe('fee-audit:FULFILLMENT:SKU-1')
    expect(feeAuditOpportunityKey('STORAGE', 'x'.repeat(500)).length).toBe(200)
  })
})

describe('查询参数', () => {
  it('默认按累计差额从大到小；类别与状态必须是已知值；排序字段限定', () => {
    expect(FeeAuditQuerySchema.parse({}).sort).toEqual({ field: 'overchargeAmount', dir: 'desc' })
    expect(FeeAuditQuerySchema.parse({ kind: 'COMMISSION', status: 'SUSPECTED' })).toMatchObject({ kind: 'COMMISSION', status: 'SUSPECTED' })
    expect(() => FeeAuditQuerySchema.parse({ kind: 'NOPE' })).toThrow()
    expect(() => FeeAuditQuerySchema.parse({ status: 'NOPE' })).toThrow()
    expect(() => FeeAuditQuerySchema.parse({ sort: 'sku:asc' })).toThrow()
    expect(FeeAuditQuerySchema.parse({ sort: 'occurrences:desc' }).sort.field).toBe('occurrences')
  })
})

describe('与其它契约的对应', () => {
  it('新鲜度键都在已登记的来源里', () => {
    const known = new Set([...FRESHNESS_SOURCES, ...REPORT_FRESHNESS_SOURCES].map(source => source.key))
    for (const key of FEE_AUDIT_FRESHNESS_KEYS) expect(known.has(key), key).toBe(true)
  })
  it('费用多收已接入赔付中心，证据类别含费用核查', () => {
    expect(CONNECTED_RULES).toContain('FEE_OVERCHARGE')
    expect(EVIDENCE_KINDS).toContain('FEE_AUDIT')
  })
})
