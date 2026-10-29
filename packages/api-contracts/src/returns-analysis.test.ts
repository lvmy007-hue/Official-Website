import { describe, expect, it } from 'vitest'
import { RETURN_REASON_LABEL } from './returns-reason-base.js'
import { RETURN_REASON_CATEGORIES, RETURN_REASON_PRESETS, UNCLASSIFIED_CATEGORY, UNSPECIFIED_REASON_KEY, reasonKey, resolveReason, type ReasonOverride } from './returns-reason.js'
import {
  cohortWindowOpen,
  cycleBucketIndex,
  cycleBucketsOf,
  cycleStats,
  latestMonths,
  monthLastDay,
  parseBounds,
  rankMovers,
  returnAddDays,
  returnDaysBetween,
  threePeriods,
  weightedMedian,
} from './returns-analysis-math.js'
import { ReturnBasisParamsSchema, ReturnCycleParamsSchema, ReturnReasonMapBodySchema, splitAnalysisQuery } from './returns-analysis-query.js'

describe('退货原因三层', () => {
  it('每个预置代码都有中文释义和一个明确的大类（不能留在“未分类”）', () => {
    for (const code of Object.keys(RETURN_REASON_LABEL)) {
      const preset = RETURN_REASON_PRESETS[code]
      expect(preset, code).toBeDefined()
      expect(preset!.labelZh.length, code).toBeGreaterThan(0)
      expect(preset!.category, code).not.toBe(UNCLASSIFIED_CATEGORY)
      expect(RETURN_REASON_CATEGORIES, code).toContain(preset!.category)
    }
  })

  it('归并键：去空白转大写，没有原因是 UNSPECIFIED；解析时企业映射优先于预置', () => {
    expect(reasonKey(' defective ')).toBe('DEFECTIVE')
    expect(reasonKey(null)).toBe(UNSPECIFIED_REASON_KEY)
    expect(reasonKey('   ')).toBe(UNSPECIFIED_REASON_KEY)
    expect(resolveReason('defective')).toMatchObject({ code: 'DEFECTIVE', category: '商品质量', mapped: true, source: 'PRESET' })
    const overrides = new Map<string, ReasonOverride>([['DEFECTIVE', { labelZh: '做工问题', category: '其他原因', isSystem: true }]])
    expect(resolveReason('DEFECTIVE', overrides)).toMatchObject({ label: '做工问题', category: '其他原因', source: 'PRESET_EDITED' })
  })

  it('没登记的新代码按原样显示并标“未分类”；自动加入后还没补全的同样算未补全；补全后算已映射', () => {
    expect(resolveReason('BRAND_NEW_CODE')).toMatchObject({ label: 'BRAND_NEW_CODE', category: '未分类', mapped: false, source: 'UNMAPPED' })
    const auto = new Map<string, ReasonOverride>([['BRAND_NEW_CODE', { labelZh: 'BRAND_NEW_CODE', category: '未分类', isSystem: false }]])
    expect(resolveReason('BRAND_NEW_CODE', auto)).toMatchObject({ mapped: false, source: 'AUTO' })
    const filled = new Map<string, ReasonOverride>([['BRAND_NEW_CODE', { labelZh: '新原因', category: '兼容性', isSystem: false }]])
    expect(resolveReason('BRAND_NEW_CODE', filled)).toMatchObject({ label: '新原因', mapped: true, source: 'CUSTOM' })
    expect(resolveReason(null)).toMatchObject({ code: UNSPECIFIED_REASON_KEY, label: '未提供原因', mapped: false, source: 'NONE' })
  })
})

describe('天数段与周期统计', () => {
  it('解析天数段：没写用默认；写错给出原因而不是悄悄改默认', () => {
    expect(parseBounds(undefined)).toEqual({ bounds: [7, 14, 30, 60, 90], error: null })
    expect(parseBounds('10, 20,45')).toEqual({ bounds: [10, 20, 45], error: null })
    expect(parseBounds('7,7').error).toContain('从小到大')
    expect(parseBounds('0,5').error).toContain('整数')
    expect(parseBounds('a,b').error).toContain('整数')
    expect(parseBounds('1,2,3,4,5,6,7,8,9,10,11').error).toContain('最多')
    expect(parseBounds('2000').error).toContain('1095')
  })

  it('天数段标签与归段：0–7、8–14…最后一段没有上界；同一天是 0；起点晚于退货（负数）不归任何段', () => {
    const buckets = cycleBucketsOf([7, 14, 30])
    expect(buckets.map(bucket => bucket.label)).toEqual(['0–7 天', '8–14 天', '15–30 天', '30 天以上'])
    expect(buckets[3]).toMatchObject({ min: 31, max: null })
    expect(cycleBucketIndex(0, [7, 14, 30])).toBe(0)
    expect(cycleBucketIndex(7, [7, 14, 30])).toBe(0)
    expect(cycleBucketIndex(8, [7, 14, 30])).toBe(1)
    expect(cycleBucketIndex(31, [7, 14, 30])).toBe(3)
    expect(cycleBucketIndex(-1, [7, 14, 30])).toBe(-1)
  })

  it('整天数差：跨月、跨年、同一天、倒挂为负', () => {
    expect(returnDaysBetween('2026-01-31', '2026-02-01')).toBe(1)
    expect(returnDaysBetween('2025-12-31', '2026-01-01')).toBe(1)
    expect(returnDaysBetween('2026-03-05', '2026-03-05')).toBe(0)
    expect(returnDaysBetween('2026-03-06', '2026-03-05')).toBe(-1)
    expect(returnAddDays('2026-02-28', 1)).toBe('2026-03-01')
  })

  it('中位数按件数加权：一条 2 件按 2 个值算；偶数取中间两个平均；没有样本为 null', () => {
    expect(weightedMedian([])).toBeNull()
    expect(weightedMedian([{ value: 5, weight: 1 }])).toBe(5)
    expect(
      weightedMedian([
        { value: 1, weight: 1 },
        { value: 10, weight: 3 },
      ]),
    ).toBe(10)
    expect(
      weightedMedian([
        { value: 2, weight: 1 },
        { value: 4, weight: 1 },
      ]),
    ).toBe(3)
    expect(
      weightedMedian([
        { value: 9, weight: 0 },
        { value: 4, weight: 2 },
      ]),
    ).toBe(4)
  })

  it('周期统计：缺起点与倒挂的退货单独计数，不当 0 天也不丢；分段件数相加等于可计算件数', () => {
    const stats = cycleStats(
      [
        { days: 3, units: 2 },
        { days: 20, units: 1 },
        { days: 200, units: 1 },
        { days: null, units: 4 },
        { days: -2, units: 1 },
      ],
      [7, 14, 30],
    )
    expect(stats.buckets).toEqual([2, 0, 1, 1])
    expect(stats.units).toBe(4)
    expect(stats.unknownUnits).toBe(5)
    expect(stats.buckets.reduce((sum, value) => sum + value, 0)).toBe(stats.units)
    // 样本 3 天（2 件）、20 天、200 天：共 4 件，中间两件是 3 与 20，中位数 11.5
    expect(stats.median).toBe(11.5)
  })
})

describe('月份、三期对比与榜单', () => {
  it('月份：最近 N 个升序去重；月底按闰年；退货窗口 90 天内算未结束', () => {
    expect(latestMonths(['2026-03', '2026-01', '2026-03', '2026-02'], 2)).toEqual(['2026-02', '2026-03'])
    expect(monthLastDay('2028-02')).toBe('2028-02-29')
    expect(monthLastDay('2026-12')).toBe('2026-12-31')
    expect(cohortWindowOpen('2026-10', '2026-10-27')).toBe(true)
    expect(cohortWindowOpen('2026-06', '2026-10-27')).toBe(false)
  })

  it('三期：上期、上上期与本期等长且首尾相接', () => {
    expect(threePeriods('2026-10-01', '2026-10-30')).toEqual({
      current: { from: '2026-10-01', to: '2026-10-30' },
      previous: { from: '2026-09-01', to: '2026-09-30' },
      beforePrevious: { from: '2026-08-02', to: '2026-08-31' },
    })
  })

  it('榜单：异常榜按增加量、改善榜按减少量；太少的波动不入榜；连续两期同向标 streak；并列顺序稳定', () => {
    const { anomalies, improvements } = rankMovers([
      { asin: 'B0A', current: 10, previous: 4, beforePrevious: 1 },
      { asin: 'B0B', current: 8, previous: 2, beforePrevious: 5 },
      { asin: 'B0C', current: 2, previous: 0, beforePrevious: 0 },
      { asin: 'B0D', current: 1, previous: 9, beforePrevious: 12 },
      { asin: 'B0E', current: 0, previous: 2, beforePrevious: 2 },
      { asin: 'B0F', current: 8, previous: 2, beforePrevious: 0 },
    ])
    expect(anomalies.map(row => row.asin)).toEqual(['B0A', 'B0B', 'B0F'])
    expect(anomalies[0]).toMatchObject({ delta: 6, streak: true })
    expect(anomalies[1]).toMatchObject({ delta: 6, streak: false })
    expect(improvements.map(row => row.asin)).toEqual(['B0D'])
    expect(improvements[0]).toMatchObject({ delta: -8, streak: true })
  })
})

describe('请求校验', () => {
  it('范围参数与本页参数分开；概览只认时间口径，周期还认起点、天数段、维度', () => {
    expect(splitAnalysisQuery({ from: '2026-01-01', timeBasis: 'order', anchor: 'ship' })).toEqual({ scope: { from: '2026-01-01' }, params: { timeBasis: 'order', anchor: 'ship' } })
    expect(ReturnBasisParamsSchema.parse({})).toEqual({ timeBasis: 'return' })
    expect(ReturnBasisParamsSchema.safeParse({ anchor: 'ship' }).success).toBe(false)
    expect(ReturnCycleParamsSchema.parse({})).toMatchObject({ timeBasis: 'return', anchor: 'order', dimension: 'none' })
    expect(ReturnCycleParamsSchema.safeParse({ bounds: '5,5' }).success).toBe(false)
  })

  it('保存映射：代码大小写不分去重；大类必须在列表里', () => {
    const base = { code: 'A', labelZh: '甲', category: '兼容性' }
    expect(ReturnReasonMapBodySchema.safeParse({ items: [base] }).success).toBe(true)
    expect(ReturnReasonMapBodySchema.safeParse({ items: [base, { ...base, code: 'a' }] }).success).toBe(false)
    expect(ReturnReasonMapBodySchema.safeParse({ items: [{ ...base, category: '乱写' }] }).success).toBe(false)
  })
})
