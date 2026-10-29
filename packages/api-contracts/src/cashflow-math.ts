import {
  CASHFLOW_CYCLE_MAX_DAYS,
  CASHFLOW_LAG_MAX_DAYS,
  DISBURSEMENT_GRACE_DAYS,
  DISBURSEMENT_TOLERANCE,
  PAYOUT_HISTORY_SETTLEMENTS,
  PAYOUT_MIN_SETTLEMENTS,
  type DeferralSchedule,
  type DisbursementMatchState,
  type ForecastWeek,
  type PayoutCycle,
  type PredictedPayout,
} from './cashflow.js'

// 回款与现金流的纯函数（P2b-08，07 章 7.8）：打款周期推断、按周现金流预测、到账核对、递延释放分桶。API 与测试共用；日期一律是 YYYY-MM-DD 文字（企业时区的自然日）。
// 所有预测都是“模型估算”：周期与到账延迟取自已有结算单的历史，没有足够历史就返回原因，不猜。

const DAY_MS = 86_400_000

export const roundCash = (value: number) => Math.round(value * 100) / 100
export const dayNumber = (text: string) => Math.floor(Date.parse(`${text}T00:00:00Z`) / DAY_MS)
export const addDaysText = (text: string, days: number) => new Date((dayNumber(text) + days) * DAY_MS).toISOString().slice(0, 10)
export const daysBetweenText = (from: string, to: string) => dayNumber(to) - dayNumber(from)

/** 中位数（偶数个取中间两个的平均，再四舍五入到整天）；没有数据返回 null。 */
export function medianDays(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return Math.round(sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2)
}

/**
 * 打款周期：用最近几张结算单的周期结束日推断“每几天结一次算”，用结束日到打款日的间隔推断“结算后几天到账”。
 * 不足两张结算单、周期不在 1 到 45 天、没有任何带打款日的结算单时，返回原因而不是默认值。
 */
export function payoutCycleOf(history: ReadonlyArray<{ periodEnd: string; depositDate: string | null }>): PayoutCycle {
  const byEnd = new Map<string, string | null>()
  for (const row of history) if (!byEnd.has(row.periodEnd) || (byEnd.get(row.periodEnd) === null && row.depositDate)) byEnd.set(row.periodEnd, row.depositDate)
  const ends = [...byEnd.keys()].sort().slice(-PAYOUT_HISTORY_SETTLEMENTS)
  if (ends.length < PAYOUT_MIN_SETTLEMENTS) return { ok: false, reason: `结算单只有 ${ends.length} 张，至少需要 ${PAYOUT_MIN_SETTLEMENTS} 张才能推断打款周期` }
  const cycleDays = medianDays(ends.slice(1).map((end, index) => daysBetweenText(ends[index], end)))
  if (cycleDays === null || cycleDays < 1 || cycleDays > CASHFLOW_CYCLE_MAX_DAYS)
    return { ok: false, reason: `推断出的结算周期 ${cycleDays ?? '?'} 天不在 1 到 ${CASHFLOW_CYCLE_MAX_DAYS} 天之内，不做预测` }
  const lags = ends.flatMap(end => {
    const deposit = byEnd.get(end)
    return deposit ? [daysBetweenText(end, deposit)] : []
  })
  const lagDays = medianDays(lags)
  if (lagDays === null) return { ok: false, reason: '已有的结算单都没有打款日，无法推断结算后几天到账' }
  if (lagDays < 0 || lagDays > CASHFLOW_LAG_MAX_DAYS) return { ok: false, reason: `推断出的到账延迟 ${lagDays} 天不在 0 到 ${CASHFLOW_LAG_MAX_DAYS} 天之内，不做预测` }
  return { ok: true, cycleDays, lagDays, samples: ends.length, lastPeriodEnd: ends[ends.length - 1] }
}

/**
 * 后续几次打款：从最近一个已知周期结束日起每隔一个周期一次，只保留打款日在今天到预测截止日之间的。
 * 金额 = 近期日均净入账 × 周期天数（日均为空则金额为空）；递延交易按“预计释放日”并入周期结束日不早于它的第一次打款（已逾期的并入第一次）。
 * 金额不会为负：净额为负时亚马逊不打款，欠款滚入下一期，这里按 0 处理并在页面说明。
 */
export function planPayouts(input: {
  cycle: Extract<PayoutCycle, { ok: true }>
  today: string
  horizonEnd: string
  dailyRate: number | null
  deferred: ReadonlyArray<{ date: string | null; amount: number }>
}): PredictedPayout[] {
  const { cycle, today, horizonEnd, dailyRate } = input
  const payouts: PredictedPayout[] = []
  for (let k = 1; k <= 400; k += 1) {
    const periodEnd = addDaysText(cycle.lastPeriodEnd, k * cycle.cycleDays)
    const depositDate = addDaysText(periodEnd, cycle.lagDays)
    if (depositDate > horizonEnd) break
    if (depositDate < today) continue
    payouts.push({ periodEnd, depositDate, runRateAmount: dailyRate === null ? null : roundCash(Math.max(0, dailyRate * cycle.cycleDays)), deferredAmount: 0, estimated: null })
  }
  for (const item of input.deferred) {
    // 没有预计释放日的递延交易不并入任何一次打款（页面单独列出“未提供释放日”）
    const releaseDate = item.date
    if (releaseDate === null) continue
    const target = payouts.find(payout => payout.periodEnd >= releaseDate)
    if (target) target.deferredAmount = roundCash(target.deferredAmount + item.amount)
  }
  for (const payout of payouts) {
    payout.estimated = payout.runRateAmount === null && payout.deferredAmount === 0 ? null : roundCash((payout.runRateAmount ?? 0) + payout.deferredAmount)
  }
  return payouts
}

/** 预测窗口：第 1 周从今天起，每周 7 天。 */
export function forecastWeeks(today: string, weeks: number): Array<{ index: number; from: string; to: string }> {
  return Array.from({ length: weeks }, (_unused, index) => ({ index, from: addDaysText(today, index * 7), to: addDaysText(today, index * 7 + 6) }))
}

/** 日期落在第几周（从 0 起）；早于今天的归到第 0 周（逾期未付仍是要付的钱），超出窗口返回 -1。 */
export function weekIndexOf(date: string, today: string, weeks: number): number {
  const offset = Math.max(0, daysBetweenText(today, date))
  const index = Math.floor(offset / 7)
  return index < weeks ? index : -1
}

export type Dated = { date: string; amount: number }
/** 现金流来源：能算就给明细，不能算就给状态与原因（权限不够、没有店铺归属、尚未接入），页面据此显示“不可用”而不是 0。 */
export type CashSource<T> = { state: 'OK'; value: T } | { state: 'RESTRICTED' | 'OUT_OF_SCOPE' | 'NOT_CONNECTED'; reason: string }

/**
 * 按周现金流：已公布的打款（确定）+ 模型预计的打款 − 采购付款计划 − 头程付款 − 广告扣款。
 * 不可用的来源该列为 null，不当 0 加进净额，并记入 missing；预测打款不可用时 estimatedInflow 为 null。
 * 累计净额不含期初余额（官方没有可用的账户余额接口）。
 */
export function buildForecast(input: {
  today: string
  weeks: number
  published: readonly Dated[]
  predicted: CashSource<readonly Dated[]>
  purchase: CashSource<readonly Dated[]>
  firstMile: CashSource<readonly Dated[]>
  adsDaily: CashSource<number>
}): ForecastWeek[] {
  const rows: ForecastWeek[] = forecastWeeks(input.today, input.weeks).map(week => ({
    ...week,
    publishedInflow: 0,
    estimatedInflow: input.predicted.state === 'OK' ? 0 : null,
    purchaseOutflow: input.purchase.state === 'OK' ? 0 : null,
    firstMileOutflow: input.firstMile.state === 'OK' ? 0 : null,
    adsOutflow: input.adsDaily.state === 'OK' ? roundCash(input.adsDaily.value * 7) : null,
    net: 0,
    cumulative: 0,
    missing: [],
  }))
  const add = (items: readonly Dated[], key: 'publishedInflow' | 'estimatedInflow' | 'purchaseOutflow' | 'firstMileOutflow') => {
    for (const item of items) {
      const index = weekIndexOf(item.date, input.today, input.weeks)
      if (index >= 0) rows[index][key] = roundCash((rows[index][key] ?? 0) + item.amount)
    }
  }
  add(input.published, 'publishedInflow')
  if (input.predicted.state === 'OK') add(input.predicted.value, 'estimatedInflow')
  if (input.purchase.state === 'OK') add(input.purchase.value, 'purchaseOutflow')
  if (input.firstMile.state === 'OK') add(input.firstMile.value, 'firstMileOutflow')
  const missing = [
    ...(input.predicted.state === 'OK' ? [] : ['预计打款']),
    ...(input.purchase.state === 'OK' ? [] : ['采购付款']),
    ...(input.firstMile.state === 'OK' ? [] : ['头程付款']),
    ...(input.adsDaily.state === 'OK' ? [] : ['广告扣款']),
  ]
  let cumulative = 0
  for (const row of rows) {
    row.net = roundCash(row.publishedInflow + (row.estimatedInflow ?? 0) - (row.purchaseOutflow ?? 0) - (row.firstMileOutflow ?? 0) - (row.adsOutflow ?? 0))
    cumulative = roundCash(cumulative + row.net)
    row.cumulative = cumulative
    row.missing = missing
  }
  return rows
}

/**
 * 到账核对：登记金额与结算报告打款金额按同一币种比较，差额 = 登记 − 报告；容差内算一致。
 * 币种不同（银行按收款账户币种结汇）不比较金额，也不换算，状态单列。
 */
export function matchDisbursement(input: { expectedAmount: number; expectedCurrency: string; actualAmount: number; actualCurrency: string; tolerance?: number }): {
  state: Extract<DisbursementMatchState, 'MATCHED' | 'SHORT' | 'OVER' | 'CURRENCY_DIFFERENT'>
  diff: number | null
} {
  if (input.expectedCurrency !== input.actualCurrency) return { state: 'CURRENCY_DIFFERENT', diff: null }
  const diff = roundCash(input.actualAmount - input.expectedAmount)
  const tolerance = input.tolerance ?? DISBURSEMENT_TOLERANCE
  if (Math.abs(diff) <= tolerance) return { state: 'MATCHED', diff }
  return { state: diff < 0 ? 'SHORT' : 'OVER', diff }
}

/** 没登记的结算单：打款日还没到、已过打款日（给财务几天核对银行流水的宽限）、已超过宽限仍未登记。 */
export function unregisteredStateOf(expectedDate: string | null, today: string): Extract<DisbursementMatchState, 'NO_DEPOSIT_DATE' | 'PENDING_DEPOSIT' | 'AWAITING' | 'UNREGISTERED'> {
  if (expectedDate === null) return 'NO_DEPOSIT_DATE'
  if (expectedDate > today) return 'PENDING_DEPOSIT'
  return daysBetweenText(expectedDate, today) <= DISBURSEMENT_GRACE_DAYS ? 'AWAITING' : 'UNREGISTERED'
}

/** 递延金额按预计释放日分桶：已过释放日仍递延、未来每周、超出窗口、接口未提供释放日。 */
export function deferralBuckets(items: ReadonlyArray<{ date: string | null; amount: number; count: number }>, today: string, weeks: number): DeferralSchedule {
  const schedule: DeferralSchedule = {
    overdue: { amount: 0, count: 0 },
    weeks: forecastWeeks(today, weeks).map(week => ({ from: week.from, to: week.to, amount: 0, count: 0 })),
    later: { amount: 0, count: 0 },
    unknown: { amount: 0, count: 0 },
  }
  const put = (target: { amount: number; count: number }, item: { amount: number; count: number }) => {
    target.amount = roundCash(target.amount + item.amount)
    target.count += item.count
  }
  for (const item of items) {
    if (item.date === null) put(schedule.unknown, item)
    else if (item.date < today) put(schedule.overdue, item)
    else {
      const index = weekIndexOf(item.date, today, weeks)
      put(index >= 0 ? schedule.weeks[index] : schedule.later, item)
    }
  }
  return schedule
}
