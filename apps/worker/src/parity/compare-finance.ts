import { AMOUNT_EPSILON, FINANCE_LAG_MS, money, nearEdge, type ParityDiff, type ParityReport, type ParityWindow } from './types'

// 财务核对：旧接口（v0 财务事件）与新接口（v2024-06-19 交易）在同一入账时间窗内，按订单号汇总金额逐单比对。
// 范围声明：没有订单号的交易（平台服务费、广告扣费、调整等）不参与逐订单核对；它们在新接口里完整落库，核对不覆盖。

export type FinanceEntry = { amazonOrderId?: string; amount: number; currency: string; postedAt: Date; deferred?: boolean }

export type CompareFinanceInput = {
  legacy: FinanceEntry[]
  next: FinanceEntry[]
  window: ParityWindow
  /** 新接口取数的时刻：官方说明财务事件可能不包含最近 48 小时的订单，以它为基准判断是否太新。 */
  fetchedAt: Date
}

type Sum = { total: number; deferred: number; latest: Date; earliest: Date }

function group(entries: FinanceEntry[]) {
  const sums = new Map<string, Sum>()
  for (const entry of entries) {
    if (!entry.amazonOrderId) continue
    const key = `${entry.amazonOrderId}|${entry.currency}`
    const sum = sums.get(key) ?? { total: 0, deferred: 0, latest: entry.postedAt, earliest: entry.postedAt }
    sum.total += entry.amount
    if (entry.deferred) sum.deferred += entry.amount
    if (entry.postedAt > sum.latest) sum.latest = entry.postedAt
    if (entry.postedAt < sum.earliest) sum.earliest = entry.postedAt
    sums.set(key, sum)
  }
  return sums
}

const label = (key: string) => key.split('|')[0]

export function compareFinance(input: CompareFinanceInput): ParityReport {
  const { window } = input
  const legacy = group(input.legacy)
  const next = group(input.next)
  const lagFrom = input.fetchedAt.getTime() - FINANCE_LAG_MS
  const diffs: ParityDiff[] = []
  let matched = 0

  for (const [key, old] of legacy) {
    const now = next.get(key)
    if (!now) {
      diffs.push(
        nearEdge(old.latest, window) || nearEdge(old.earliest, window)
          ? {
              category: 'TIME_BASIS',
              entityKey: label(key),
              field: 'presence',
              legacyValue: money(old.total),
              newValue: '无',
              explanation: '入账时间落在时间窗边界，两个接口的截止时刻相差几分钟导致只有一边包含',
            }
          : {
              category: 'UNEXPLAINED',
              entityKey: label(key),
              field: 'presence',
              legacyValue: money(old.total),
              newValue: '无',
              explanation: '旧接口有该订单的财务记录，新接口在同一入账时间窗内没有，且不在窗口边界',
            },
      )
      continue
    }
    const gap = now.total - old.total
    if (Math.abs(gap) < AMOUNT_EPSILON) {
      matched += 1
      continue
    }
    const base = { entityKey: label(key), field: 'amount', legacyValue: money(old.total), newValue: money(now.total) }
    if (now.deferred !== 0 && Math.abs(gap - now.deferred) < AMOUNT_EPSILON)
      diffs.push({ ...base, category: 'SCOPE', explanation: `差额 ${money(gap)} 正好等于新接口里的递延交易合计：旧接口不返回递延交易` })
    else if (now.latest.getTime() >= lagFrom || nearEdge(now.latest, window) || nearEdge(now.earliest, window))
      diffs.push({ ...base, category: 'TIME_BASIS', explanation: '该订单有交易入账在最近 48 小时内或落在时间窗边界：官方说明财务事件可能不包含最近 48 小时的订单，两次拉取之间还有新交易入账' })
    else diffs.push({ ...base, category: 'UNEXPLAINED', explanation: `同一订单两边的入账合计相差 ${money(gap)}，不是递延交易，也不在最近 48 小时或窗口边界` })
  }

  for (const [key, now] of next) {
    if (legacy.has(key)) continue
    const base = { entityKey: label(key), field: 'presence', legacyValue: '无', newValue: money(now.total) }
    if (now.deferred !== 0 && Math.abs(now.total - now.deferred) < AMOUNT_EPSILON) diffs.push({ ...base, category: 'SCOPE', explanation: '该订单在新接口里全部是递延交易：旧接口不返回递延交易' })
    else if (now.latest.getTime() >= lagFrom || nearEdge(now.latest, window) || nearEdge(now.earliest, window))
      diffs.push({ ...base, category: 'TIME_BASIS', explanation: '该订单的交易入账在最近 48 小时内或落在时间窗边界，旧接口取数时还没有' })
    else diffs.push({ ...base, category: 'UNEXPLAINED', explanation: '新接口有该订单的财务记录，旧接口在同一入账时间窗内没有，且不在窗口边界' })
  }
  return { legacyCount: legacy.size, newCount: next.size, matchedCount: matched, diffs }
}
