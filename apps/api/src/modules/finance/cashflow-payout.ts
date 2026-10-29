import { CASHFLOW_RUN_RATE_DAYS, payoutCycleOf, planPayouts, roundCash, type CashSource, type CashflowPayout, type CashflowPayoutStore, type Dated } from '@nova/api-contracts'
import type { DeferredGroup, SettlementPoint, Store } from './cashflow-load'

// 打款预测（P2b-08，07 章 7.8“下次结算的打款日与金额估算”）：每个店铺单独推断周期，已公布的打款（结算单上有打款日与金额）与模型预计的打款分开。
// 模型：周期与到账延迟取自该店铺最近几张结算单；金额 = 近 28 天已释放交易的日均净入账 × 周期天数，递延交易按预计释放日并入；净额为负不打款（按 0）。

export interface PayoutAssembly {
  payout: CashflowPayout
  published: Dated[]
  predicted: CashSource<Dated[]>
  /** 因历史不足没有预测的店铺数。 */
  unpredicted: number
}

const BASIS = `金额 = 最近 ${CASHFLOW_RUN_RATE_DAYS} 天已释放交易的日均净入账 × 结算周期天数，另加按预计释放日并入的递延金额；周期与到账延迟取自该店铺最近几张结算单的中位数。这是模型估算，不是亚马逊的承诺。`

export function assemblePayout(input: {
  stores: readonly Store[]
  history: readonly SettlementPoint[]
  rates: ReadonlyMap<string, number>
  deferred: readonly DeferredGroup[]
  currency: string
  today: string
  horizonEnd: string
}): PayoutAssembly {
  const { currency, today, horizonEnd } = input
  const rows: CashflowPayoutStore[] = []
  const published: Dated[] = []
  const predictedItems: Dated[] = []
  let unpredicted = 0
  let predictedStores = 0
  const best: { next: CashflowPayout['next'] } = { next: null }
  const consider = (date: string, amount: number | null, kind: 'PUBLISHED' | 'ESTIMATED', storeName: string) => {
    const current = best.next
    if (!current || date < current.date || (date === current.date && kind === 'PUBLISHED' && current.kind === 'ESTIMATED')) best.next = { date, amount, kind, storeName }
  }
  for (const store of input.stores) {
    const all = input.history.filter(point => point.sellerAccountId === store.id)
    const mine = all.filter(point => point.currency === currency)
    // 这个店铺所有结算单都是别的币种：这个币种下不列它
    if (all.length > 0 && mine.length === 0) continue
    const cycle = payoutCycleOf(mine.map(point => ({ periodEnd: point.periodEnd, depositDate: point.depositDate })))
    const upcoming = mine.filter(point => point.depositDate !== null && point.depositDate >= today && (point.disbursementAmount ?? 0) > 0)
    const dailyRate = input.rates.get(`${store.id}|${currency}`) ?? null
    const predicted = cycle.ok
      ? planPayouts({
          cycle,
          today,
          horizonEnd,
          dailyRate,
          deferred: input.deferred.filter(group => group.sellerAccountId === store.id && group.currency === currency).map(group => ({ date: group.maturityDate, amount: group.amount })),
        })
      : []
    let reason: string | null = cycle.ok ? null : all.length === 0 ? '这个店铺还没有结算单，无法推断打款周期' : cycle.reason
    if (cycle.ok && dailyRate === null) reason = `最近 ${CASHFLOW_RUN_RATE_DAYS} 天没有已释放的交易，打款金额只含递延释放部分`
    if (cycle.ok) predictedStores += 1
    else unpredicted += 1
    for (const point of upcoming) {
      const amount = point.disbursementAmount ?? 0
      published.push({ date: point.depositDate as string, amount })
      consider(point.depositDate as string, amount, 'PUBLISHED', store.name)
    }
    for (const item of predicted) {
      if (item.estimated === null) continue
      predictedItems.push({ date: item.depositDate, amount: item.estimated })
    }
    for (const item of predicted) consider(item.depositDate, item.estimated, 'ESTIMATED', store.name)
    rows.push({
      sellerAccountId: store.id,
      storeName: store.name,
      currency,
      cycleDays: cycle.ok ? cycle.cycleDays : null,
      lagDays: cycle.ok ? cycle.lagDays : null,
      samples: cycle.ok ? cycle.samples : mine.length,
      lastPeriodEnd: cycle.ok ? cycle.lastPeriodEnd : (mine[0]?.periodEnd ?? null),
      published: upcoming.map(point => ({
        settlementId: point.id,
        externalSettlementId: point.externalSettlementId,
        depositDate: point.depositDate as string,
        amount: point.disbursementAmount ?? 0,
        currency: point.currency,
      })),
      predicted,
      reason,
    })
  }
  const rateValues = rows.map(row => input.rates.get(`${row.sellerAccountId}|${currency}`)).filter((value): value is number => value !== undefined)
  const predicted: CashSource<Dated[]> =
    predictedStores > 0 ? { state: 'OK', value: predictedItems } : { state: 'NOT_CONNECTED', reason: '结算单历史不足（每个店铺至少 2 张带打款日的结算单），无法推断打款周期，预计打款不可用' }
  return {
    payout: { stores: rows, next: best.next, dailyRate: rateValues.length > 0 ? roundCash(rateValues.reduce((sum, value) => sum + value, 0)) : null, basis: BASIS },
    published,
    predicted,
    unpredicted,
  }
}
