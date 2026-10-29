import { describe, expect, it } from 'vitest'
import { freshnessSourceOfJobType, freshnessSourceOfReport, freshnessStatusForFailure } from './freshness.js'
import {
  PROMOTION_STATUSES,
  PROMOTION_TYPES,
  benefitTextOf,
  budgetTextOf,
  discountTextOf,
  itemBenefitText,
  promotionListState,
  promotionStatusLabel,
  promotionTypeLabel,
  type PromotionSync,
} from './promotions.js'
import { PromotionListQuerySchema } from './promotions-query.js'
import { baselineExpectation, baselineRange, effectWindow, promoIncrementOf, promoOverlaps, promoShiftDate, promoWeekdayOf, promotionRoi, type BaselineDay } from './promotions-math.js'

const sync = (over: Partial<PromotionSync>): PromotionSync => ({ status: 'NORMAL', statusLabel: '正常', lastSuccessAt: null, errorCode: null, errorMessage: null, rolePending: false, ...over })

describe('促销标签与折扣文字（P4-05）', () => {
  it('类型与状态：已知值给中文，未知值显示原值', () => {
    expect(PROMOTION_TYPES.map(promotionTypeLabel)).toEqual(['秒杀', '优惠券', '价格折扣', '满减'])
    expect(PROMOTION_STATUSES.map(promotionStatusLabel)).toEqual(['处理中', '即将开始', '进行中', '已结束', '失败', '取消中', '已取消'])
    expect(promotionTypeLabel('NEW_KIND')).toBe('其他类型（NEW_KIND）')
    expect(promotionStatusLabel('PAUSED')).toBe('其他状态（PAUSED）')
  })

  it('折扣力度：百分比、固定金额、赠品；认不出来就是 null，不猜', () => {
    expect(discountTextOf({ type: 'PERCENTAGE_OFF', percentOff: 15 })).toBe('立减 15%')
    expect(discountTextOf({ type: 'AMOUNT_OFF', amountOff: 5, currencyCode: 'USD' })).toBe('立减 $5.00')
    expect(discountTextOf({ type: 'FREE_ITEM' })).toBe('赠品')
    expect(discountTextOf({ type: 'PERCENTAGE_OFF' })).toBeNull()
    expect(discountTextOf(null)).toBeNull()
    expect(benefitTextOf({ discount: { type: 'PERCENTAGE_OFF', percentOff: 10 }, additionalTiers: [{}, {}] })).toBe('立减 10%（另有 2 档阶梯）')
    expect(benefitTextOf({ additionalTiers: [{}] })).toBe('2 档阶梯')
    expect(benefitTextOf({})).toBeNull()
  })

  it('商品级折扣与预算文字', () => {
    const base = { benefitType: null, discountType: null, percentOff: null, amountOff: null, fixedPrice: null, currency: 'USD' }
    expect(itemBenefitText({ ...base, benefitType: 'FIXED_PRICE', fixedPrice: 9.99 })).toBe('固定价 $9.99')
    expect(itemBenefitText({ ...base, benefitType: 'DISCOUNTED_PRICE', discountType: 'PERCENTAGE_OFF', percentOff: 20 })).toBe('立减 20%')
    expect(itemBenefitText(base)).toBeNull()
    expect(budgetTextOf({ type: 'UNITS', value: 300, currency: null })).toBe('300 件')
    expect(budgetTextOf({ type: 'AMOUNT', value: 1000, currency: 'USD' })).toBe('$1000.00')
    expect(budgetTextOf(null)).toBeNull()
  })

  it('列表状态：有行就是 OK；没有行时区分没授权、没同步、没有促销、同步失败', () => {
    expect(promotionListState(sync({}), true).state).toBe('OK')
    expect(promotionListState(sync({ rolePending: true, status: 'UNAUTHORIZED' }), false).state).toBe('ROLE_PENDING')
    expect(promotionListState(sync({ status: 'NO_RECORD' }), false).state).toBe('NOT_CONNECTED')
    expect(promotionListState(sync({}), false)).toMatchObject({ state: 'NO_DATA', note: expect.stringContaining('尚无记录') })
    expect(promotionListState(sync({ status: 'FAILED', errorMessage: '上游错误' }), false)).toMatchObject({ state: 'NOT_CONNECTED', note: '上游错误' })
  })

  it('新鲜度登记：同步任务与两份报告；接口角色未批算“未授权”', () => {
    expect(freshnessSourceOfJobType('PROMOTIONS_SYNC')).toMatchObject({ key: 'promotions.api', intervalMinutes: 1440 })
    expect(freshnessSourceOfReport('GET_PROMOTION_PERFORMANCE_REPORT')?.key).toBe('rpt.promotion-performance')
    expect(freshnessSourceOfReport('GET_COUPON_PERFORMANCE_REPORT')?.key).toBe('rpt.coupon-performance')
    expect(freshnessStatusForFailure('ROLE_MISSING')).toBe('UNAUTHORIZED')
  })

  it('列表查询：筛选值校验、未知参数拒绝、默认按开始时间新到旧', () => {
    expect(PromotionListQuerySchema.parse({}).sort).toEqual({ field: 'startAt', dir: 'desc' })
    expect(PromotionListQuerySchema.parse({ status: 'RUNNING', type: 'COUPON', q: ' 夏季 ' })).toMatchObject({ status: 'RUNNING', type: 'COUPON', q: '夏季' })
    expect(() => PromotionListQuerySchema.parse({ status: 'WAITING' })).toThrow()
    expect(() => PromotionListQuerySchema.parse({ type: 'LIGHTNING' })).toThrow()
    expect(() => PromotionListQuerySchema.parse({ bogus: '1' })).toThrow()
  })
})

const days = (from: string, count: number, valueOf: (date: string, index: number) => number | null, excluded: (date: string) => boolean = () => false): BaselineDay[] =>
  Array.from({ length: count }, (_, index) => {
    const date = promoShiftDate(from, index)
    return { date, value: valueOf(date, index), excluded: excluded(date) }
  })

describe('基线估算（P4-05，D-06）', () => {
  it('日期工具：星期、平移、基线取数范围与活动期间', () => {
    expect(promoWeekdayOf('2026-11-01')).toBe(0) // 周日
    expect(promoShiftDate('2026-03-01', -1)).toBe('2026-02-28')
    expect(baselineRange('2026-11-10', 28)).toEqual({ from: '2026-10-13', to: '2026-11-09' })
    expect(effectWindow({ startDate: '2026-11-10', endDate: '2026-11-14' }, '2026-11-12')).toEqual({ from: '2026-11-10', to: '2026-11-12', days: 3 })
    expect(effectWindow({ startDate: '2026-11-10', endDate: '2026-11-14' }, '2026-11-30')).toEqual({ from: '2026-11-10', to: '2026-11-14', days: 5 })
    expect(effectWindow({ startDate: '2026-11-10', endDate: null }, '2026-11-12')?.days).toBe(3)
    expect(effectWindow({ startDate: '2026-11-10', endDate: '2026-11-14' }, '2026-11-09')).toBeNull()
  })

  it('按星期对齐：周末是平日的两倍时，活动期间的周末基线也是两倍', () => {
    // 2026-10-13 是周二；工作日 10，周六周日 20
    const base = days('2026-10-13', 28, date => (promoWeekdayOf(date) === 0 || promoWeekdayOf(date) === 6 ? 20 : 10))
    const window = ['2026-11-10', '2026-11-14', '2026-11-15'] // 周二、周六、周日
    const result = baselineExpectation(base, window)
    expect(result.info).toEqual({ state: 'OK', usedDays: 28, excludedDays: 0 })
    expect([...result.perDate.values()]).toEqual([10, 20, 20])
    expect(result.total).toBe(50)
  })

  it('被其他促销占用与没有数据的日子不进基线；有效日不足不给数字', () => {
    const base = days(
      '2026-10-13',
      28,
      (_date, index) => (index < 5 ? null : 10),
      date => date >= '2026-10-25' && date <= '2026-11-02',
    )
    const enough = baselineExpectation(base, ['2026-11-10'])
    expect(enough.info).toEqual({ state: 'OK', usedDays: 14, excludedDays: 14 })
    expect(enough.total).toBe(10)
    const few = baselineExpectation(
      base.map((day, index) => (index > 12 ? { ...day, excluded: true } : day)),
      ['2026-11-10'],
    )
    expect(few).toMatchObject({ info: { state: 'INSUFFICIENT' }, total: null })
    expect(few.perDate.size).toBe(0)
    expect(
      baselineExpectation(
        days('2026-10-13', 28, () => null),
        ['2026-11-10'],
      ),
    ).toMatchObject({ info: { state: 'NONE', usedDays: 0, excludedDays: 28 }, total: null })
  })

  it('某个星期没有有效日时，用全部有效日的总均值', () => {
    const base = days('2026-10-13', 28, (date, index) => (promoWeekdayOf(date) === 1 ? null : index % 2 === 0 ? 8 : 12))
    const result = baselineExpectation(base, ['2026-11-09']) // 周一
    expect(result.info.state).toBe('OK')
    const valid = base.filter(day => day.value !== null).map(day => day.value as number)
    expect(result.perDate.get('2026-11-09')).toBeCloseTo(valid.reduce((a, b) => a + b, 0) / valid.length, 6)
  })

  it('增量与提升幅度：任一缺失不给，基线为 0 不给提升幅度', () => {
    expect(promoIncrementOf(130, 100)).toEqual({ value: 30, liftPct: 30 })
    expect(promoIncrementOf(80, 100)).toEqual({ value: -20, liftPct: -20 })
    expect(promoIncrementOf(5, 0)).toEqual({ value: 5, liftPct: null })
    expect(promoIncrementOf(null, 100)).toEqual({ value: null, liftPct: null })
    expect(promoIncrementOf(100, null)).toEqual({ value: null, liftPct: null })
  })

  it('促销投入回报率：分母必须大于 0；缺折扣成本或平台费用不给', () => {
    expect(promotionRoi(300, 100, 50)).toEqual({ value: 2, denominator: 150 })
    expect(promotionRoi(-30, 100, 50)).toEqual({ value: -0.2, denominator: 150 })
    expect(promotionRoi(300, 0, 0)).toEqual({ value: null, denominator: 0 })
    expect(promotionRoi(null, 100, 50)).toEqual({ value: null, denominator: 150 })
    expect(promotionRoi(300, null, 50)).toEqual({ value: null, denominator: null })
  })

  it('区间重叠：含首尾日；结束日为空按一直持续', () => {
    expect(promoOverlaps({ from: '2026-10-01', to: '2026-10-10' }, { from: '2026-10-10', to: '2026-10-20' })).toBe(true)
    expect(promoOverlaps({ from: '2026-10-01', to: '2026-10-09' }, { from: '2026-10-10', to: '2026-10-20' })).toBe(false)
    expect(promoOverlaps({ from: '2026-10-01', to: null }, { from: '2027-01-01', to: '2027-01-02' })).toBe(true)
  })
})
