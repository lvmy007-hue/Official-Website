import { describe, expect, it } from 'vitest'
import { CashflowQuerySchema, DisbursementConfirmBodySchema } from './cashflow.js'
import { buildForecast, deferralBuckets, forecastWeeks, matchDisbursement, medianDays, payoutCycleOf, planPayouts, unregisteredStateOf, weekIndexOf, type CashSource } from './cashflow-math.js'

// 回款与现金流的纯函数与请求校验（P2b-08）。日期是 YYYY-MM-DD 文字；2026-10-23 是星期五，不影响计算（周从今天起算）。

const TODAY = '2026-10-23'
const ok = <T>(value: T): CashSource<T> => ({ state: 'OK', value })

describe('请求校验', () => {
  it('查询：币种默认美元、周数默认 8；币种必须三位大写，周数 1 到 13', () => {
    expect(CashflowQuerySchema.parse({})).toEqual({ currency: 'USD', weeks: 8 })
    expect(CashflowQuerySchema.parse({ currency: 'CNY', weeks: '13' })).toEqual({ currency: 'CNY', weeks: 13 })
    for (const bad of [{ currency: 'usd' }, { currency: 'USDD' }, { weeks: '0' }, { weeks: '14' }, { weeks: '1.5' }]) expect(CashflowQuerySchema.safeParse(bad).success).toBe(false)
  })

  it('到账登记：金额必须大于 0，日期要真实存在，末四位只能是数字，不认识的字段拒绝', () => {
    const base = { settlementId: 'st_1', disbursedAt: '2026-10-20', amount: 100, currency: 'USD' }
    expect(DisbursementConfirmBodySchema.safeParse(base).success).toBe(true)
    expect(DisbursementConfirmBodySchema.safeParse({ ...base, bankLast4: '6789', note: '  已核对流水  ', version: 2 }).success).toBe(true)
    for (const bad of [
      { amount: 0 },
      { amount: -1 },
      { disbursedAt: '2026-02-30' },
      { disbursedAt: '10/20' },
      { bankLast4: '12a4' },
      { bankLast4: '12345' },
      { currency: 'usd' },
      { version: 0 },
      { settlementId: 'a b' },
      { extra: 1 },
    ]) {
      expect(DisbursementConfirmBodySchema.safeParse({ ...base, ...bad }).success).toBe(false)
    }
    expect(DisbursementConfirmBodySchema.parse({ ...base, note: '  已核对  ' }).note).toBe('已核对')
  })
})

describe('打款周期推断', () => {
  it('中位数：奇数取中间，偶数取中间两个的平均并取整，没有数据为 null', () => {
    expect(medianDays([14, 7, 14])).toBe(14)
    expect(medianDays([14, 15])).toBe(15)
    expect(medianDays([])).toBeNull()
  })

  it('周期取相邻周期结束日间隔的中位数，到账延迟取结束日到打款日的中位数', () => {
    const cycle = payoutCycleOf([
      { periodEnd: '2026-09-01', depositDate: '2026-09-04' },
      { periodEnd: '2026-09-15', depositDate: '2026-09-18' },
      { periodEnd: '2026-09-29', depositDate: '2026-10-02' },
      { periodEnd: '2026-10-13', depositDate: null },
    ])
    expect(cycle).toEqual({ ok: true, cycleDays: 14, lagDays: 3, samples: 4, lastPeriodEnd: '2026-10-13' })
  })

  it('历史不足、周期不合理、没有任何打款日时返回原因，不给默认值', () => {
    expect(payoutCycleOf([{ periodEnd: '2026-09-01', depositDate: '2026-09-04' }])).toMatchObject({ ok: false, reason: expect.stringContaining('至少需要 2 张') })
    expect(payoutCycleOf([])).toMatchObject({ ok: false })
    expect(
      payoutCycleOf([
        { periodEnd: '2026-01-01', depositDate: '2026-01-03' },
        { periodEnd: '2026-06-01', depositDate: '2026-06-03' },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('1 到 45 天') })
    expect(
      payoutCycleOf([
        { periodEnd: '2026-09-01', depositDate: null },
        { periodEnd: '2026-09-15', depositDate: null },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('没有打款日') })
    expect(
      payoutCycleOf([
        { periodEnd: '2026-09-01', depositDate: '2026-12-01' },
        { periodEnd: '2026-09-15', depositDate: '2026-12-15' },
      ]),
    ).toMatchObject({ ok: false, reason: expect.stringContaining('0 到 30 天') })
  })

  it('同一个周期结束日重复出现只算一次，带打款日的那条优先；只看最近 6 个周期', () => {
    const rows = Array.from({ length: 9 }, (_unused, index) => ({
      periodEnd: `2026-0${Math.floor(index / 4) + 7}-${String((index % 4) * 7 + 1).padStart(2, '0')}`,
      depositDate: null as string | null,
    }))
    const many = payoutCycleOf(rows.map(row => ({ ...row, depositDate: null as string | null })).concat([{ periodEnd: rows[8].periodEnd, depositDate: '2026-09-05' }]))
    expect(many).toMatchObject({ ok: true, samples: 6, lastPeriodEnd: rows[8].periodEnd })
    expect(
      payoutCycleOf([
        { periodEnd: '2026-09-01', depositDate: null },
        { periodEnd: '2026-09-01', depositDate: '2026-09-04' },
        { periodEnd: '2026-09-15', depositDate: '2026-09-18' },
      ]),
    ).toMatchObject({ ok: true, samples: 2, lagDays: 3 })
  })
})

describe('后续打款', () => {
  const cycle = { ok: true as const, cycleDays: 14, lagDays: 3, samples: 4, lastPeriodEnd: '2026-10-13' }

  it('从最近周期结束日起每个周期一次，只保留打款日在今天到截止日之间的；金额 = 日均 × 周期天数', () => {
    const payouts = planPayouts({ cycle, today: TODAY, horizonEnd: '2026-12-31', dailyRate: 100, deferred: [] })
    expect(payouts.map(item => [item.periodEnd, item.depositDate, item.estimated])).toEqual([
      ['2026-10-27', '2026-10-30', 1400],
      ['2026-11-10', '2026-11-13', 1400],
      ['2026-11-24', '2026-11-27', 1400],
      ['2026-12-08', '2026-12-11', 1400],
      ['2026-12-22', '2026-12-25', 1400],
    ])
  })

  it('最近周期已经很旧时，跳过打款日早于今天的周期（报告还没同步到的不凭空补）', () => {
    const stale = planPayouts({ cycle: { ...cycle, lastPeriodEnd: '2026-07-01' }, today: TODAY, horizonEnd: '2026-11-30', dailyRate: 10, deferred: [] })
    expect(stale.every(item => item.depositDate >= TODAY)).toBe(true)
    // 07-01 起每 14 天一个周期：10-21 结束的这个周期打款日是 10-24，是第一个不早于今天的
    expect(stale[0]).toMatchObject({ periodEnd: '2026-10-21', depositDate: '2026-10-24' })
  })

  it('日均为 null 时金额为 null；有递延释放则只含递延；净额为负按 0', () => {
    const none = planPayouts({ cycle, today: TODAY, horizonEnd: '2026-11-20', dailyRate: null, deferred: [] })
    expect(none.map(item => item.estimated)).toEqual([null, null])
    const onlyDeferred = planPayouts({ cycle, today: TODAY, horizonEnd: '2026-11-20', dailyRate: null, deferred: [{ date: '2026-11-02', amount: 250 }] })
    expect(onlyDeferred.map(item => [item.runRateAmount, item.deferredAmount, item.estimated])).toEqual([
      [null, 0, null],
      [null, 250, 250],
    ])
    const negative = planPayouts({ cycle, today: TODAY, horizonEnd: '2026-11-01', dailyRate: -20, deferred: [] })
    expect(negative[0]).toMatchObject({ runRateAmount: 0, estimated: 0 })
  })

  it('递延按预计释放日并入周期结束日不早于它的第一次打款；已逾期并入第一次；没有释放日或超出窗口不并入', () => {
    const payouts = planPayouts({
      cycle,
      today: TODAY,
      horizonEnd: '2026-11-20',
      dailyRate: 10,
      deferred: [
        { date: '2026-10-01', amount: 5 },
        { date: '2026-10-27', amount: 7 },
        { date: '2026-10-28', amount: 11 },
        { date: null, amount: 1000 },
        { date: '2027-03-01', amount: 2000 },
      ],
    })
    expect(payouts.map(item => item.deferredAmount)).toEqual([12, 11])
    expect(payouts[0].estimated).toBe(140 + 12)
  })
})

describe('按周现金流', () => {
  it('周从今天起每 7 天；早于今天的归第一周，超出窗口为 -1', () => {
    expect(forecastWeeks(TODAY, 2)).toEqual([
      { index: 0, from: '2026-10-23', to: '2026-10-29' },
      { index: 1, from: '2026-10-30', to: '2026-11-05' },
    ])
    expect(weekIndexOf('2026-10-01', TODAY, 4)).toBe(0)
    expect(weekIndexOf('2026-10-29', TODAY, 4)).toBe(0)
    expect(weekIndexOf('2026-10-30', TODAY, 4)).toBe(1)
    expect(weekIndexOf('2026-11-19', TODAY, 4)).toBe(3)
    expect(weekIndexOf('2026-11-20', TODAY, 4)).toBe(-1)
  })

  it('已公布与预计打款入账，采购、头程、广告出账，累计净额不含期初；窗口外的忽略', () => {
    const rows = buildForecast({
      today: TODAY,
      weeks: 3,
      published: [{ date: '2026-10-25', amount: 1000 }],
      predicted: ok([
        { date: '2026-11-02', amount: 700 },
        { date: '2027-01-01', amount: 9999 },
      ]),
      purchase: ok([
        { date: '2026-10-10', amount: 100 },
        { date: '2026-11-03', amount: 300 },
      ]),
      firstMile: ok([{ date: '2026-11-10', amount: 50 }]),
      adsDaily: ok(10),
    })
    expect(rows.map(row => [row.publishedInflow, row.estimatedInflow, row.purchaseOutflow, row.firstMileOutflow, row.adsOutflow, row.net, row.cumulative])).toEqual([
      [1000, 0, 100, 0, 70, 830, 830],
      [0, 700, 300, 0, 70, 330, 1160],
      [0, 0, 0, 50, 70, -120, 1040],
    ])
    expect(rows.every(row => row.missing.length === 0)).toBe(true)
  })

  it('不可用的来源该列为 null，不当 0 加进净额，并列在 missing 里', () => {
    const rows = buildForecast({
      today: TODAY,
      weeks: 2,
      published: [{ date: '2026-10-25', amount: 100 }],
      predicted: { state: 'NOT_CONNECTED', reason: '历史不足' },
      purchase: { state: 'OUT_OF_SCOPE', reason: '范围不适用' },
      firstMile: { state: 'RESTRICTED', reason: '无权限' },
      adsDaily: { state: 'NOT_CONNECTED', reason: '广告未接入' },
    })
    expect(rows[0]).toMatchObject({ estimatedInflow: null, purchaseOutflow: null, firstMileOutflow: null, adsOutflow: null, net: 100, cumulative: 100 })
    expect(rows[0].missing).toEqual(['预计打款', '采购付款', '头程付款', '广告扣款'])
    expect(rows[1]).toMatchObject({ publishedInflow: 0, net: 0, cumulative: 100 })
  })
})

describe('到账核对', () => {
  it('同币种比较差额（登记 − 报告），容差内一致，少到与多到分开', () => {
    const base = { expectedAmount: 1000, expectedCurrency: 'USD', actualCurrency: 'USD' }
    expect(matchDisbursement({ ...base, actualAmount: 1000.04 })).toEqual({ state: 'MATCHED', diff: 0.04 })
    expect(matchDisbursement({ ...base, actualAmount: 1000.05 })).toEqual({ state: 'MATCHED', diff: 0.05 })
    expect(matchDisbursement({ ...base, actualAmount: 995 })).toEqual({ state: 'SHORT', diff: -5 })
    expect(matchDisbursement({ ...base, actualAmount: 1010.5 })).toEqual({ state: 'OVER', diff: 10.5 })
  })

  it('币种不同不比较也不换算', () => {
    expect(matchDisbursement({ expectedAmount: 1000, expectedCurrency: 'USD', actualAmount: 7100, actualCurrency: 'CNY' })).toEqual({ state: 'CURRENCY_DIFFERENT', diff: null })
  })

  it('没登记：没有打款日、打款日未到、宽限内等待登记、超期未登记', () => {
    expect(unregisteredStateOf(null, TODAY)).toBe('NO_DEPOSIT_DATE')
    expect(unregisteredStateOf('2026-10-24', TODAY)).toBe('PENDING_DEPOSIT')
    expect(unregisteredStateOf('2026-10-23', TODAY)).toBe('AWAITING')
    expect(unregisteredStateOf('2026-10-20', TODAY)).toBe('AWAITING')
    expect(unregisteredStateOf('2026-10-19', TODAY)).toBe('UNREGISTERED')
  })
})

describe('递延分桶', () => {
  it('按预计释放日分：已逾期、未来每周、超出窗口、未提供释放日', () => {
    const schedule = deferralBuckets(
      [
        { date: '2026-10-01', amount: 10, count: 1 },
        { date: '2026-10-23', amount: 20, count: 2 },
        { date: '2026-11-04', amount: 30.5, count: 3 },
        { date: '2026-11-04', amount: 0.25, count: 1 },
        { date: '2027-05-01', amount: 40, count: 4 },
        { date: null, amount: 50, count: 5 },
      ],
      TODAY,
      2,
    )
    expect(schedule.overdue).toEqual({ amount: 10, count: 1 })
    expect(schedule.weeks.map(week => [week.from, week.amount, week.count])).toEqual([
      ['2026-10-23', 20, 2],
      ['2026-10-30', 30.75, 4],
    ])
    expect(schedule.later).toEqual({ amount: 40, count: 4 })
    expect(schedule.unknown).toEqual({ amount: 50, count: 5 })
  })
})
