import type { InventoryFreshness } from './inventory.js'

// 回款增强（P6-20，16 章第 7 节；freeze/api.md `GET /finance/cashflow/funnel`）：回款率、未退还的预留金、收入到应收的漏斗。
// 纯类型、常量与纯函数（零 zod）。接口复用回款与现金流（P2b-08）的取数口径：财务交易（递延、释放）与结算单（打款额、打款日）。
//
// 口径（CR-129）：
//  - 窗口：最近 90 天（企业时区）。交易按入账日，结算单按周期结束日落在窗口里；两者时间轴不同，漏斗各级之间是“同一窗口内的规模对比”，不是逐笔对应；
//  - 回款率 = 已到账的打款额 ÷ 已公布的打款额（同一批结算单，打款日已过的算已到账）；没有已公布的打款额不给回款率；
//  - 预留金：交易类型含 reserve 的财务交易，扣留为负、返还为正；未退还 = 扣留 − 返还（不小于 0）。窗口取最近 180 天（预留金常跨月）；没有任何财务数据显示“未接入”，有财务数据但没有预留金交易显示“无预留金交易”，不显示 0；
//  - 币种：各币种分别汇总，不换算。

export const FUNNEL_WINDOW_DAYS = 90
export const FUNNEL_RESERVE_DAYS = 180
export const FUNNEL_RESERVE_KEYWORD = 'reserve'
export const FUNNEL_STAGE_KEYS = ['POSTED', 'RELEASED', 'DEFERRED', 'ANNOUNCED', 'PAID', 'UPCOMING'] as const
export type FunnelStageKey = (typeof FUNNEL_STAGE_KEYS)[number]
export const FUNNEL_STAGE_LABEL: Readonly<Record<FunnelStageKey, string>> = {
  POSTED: '已入账交易净额',
  RELEASED: '其中已释放',
  DEFERRED: '其中递延中',
  ANNOUNCED: '已公布打款（结算单）',
  PAID: '其中已到账（打款日已过）',
  UPCOMING: '应收未到账（打款日未到）',
}
export const FUNNEL_STAGE_NOTE: Readonly<Record<FunnelStageKey, string>> = {
  POSTED: '最近 90 天入账的财务交易合计（不含打款本身与预留金）',
  RELEASED: '其中状态已释放的部分（入账日在窗口内）',
  DEFERRED: '其中仍在递延、预计以后释放的部分',
  ANNOUNCED: '结算周期结束日在窗口内、官方已公布打款额的结算单合计',
  PAID: '其中打款日不晚于今天的部分',
  UPCOMING: '其中打款日还没到的部分（应收）',
}

export interface FunnelStage {
  key: FunnelStageKey
  label: string
  note: string
  /** 金额；这一级没有数据来源时为 null（页面显示“尚未接入”，不是 0）。 */
  amount: number | null
  count: number
}

export type ReserveState = 'OK' | 'NONE' | 'NOT_CONNECTED'
export interface FunnelReserve {
  state: ReserveState
  /** 窗口内被扣留的预留金合计（正数）；NONE、NOT_CONNECTED 为 null。 */
  held: number | null
  /** 窗口内返还的预留金合计（正数）。 */
  returned: number | null
  /** 未退还 = 扣留 − 返还（不小于 0）。 */
  unreturned: number | null
  count: number
  note: string
}

export interface FunnelPayoutRate {
  /** 已到账 ÷ 已公布（0 到 1 之外也如实给出，比如多打款）；没有已公布打款额为 null。 */
  value: number | null
  paid: number | null
  announced: number | null
  note: string
}

export interface CashflowFunnelResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  asOf: string
  from: string
  to: string
  windowDays: number
  currency: string
  currencies: string[]
  stages: FunnelStage[]
  payoutRate: FunnelPayoutRate
  reserve: FunnelReserve
  assumptions: string[]
  freshness: InventoryFreshness
}

export const FUNNEL_ASSUMPTIONS: readonly string[] = [
  '漏斗各级是同一个最近 90 天窗口里的规模对比：交易按入账日、结算单按周期结束日，不是逐笔对应，也不换算币种。',
  '回款率 = 已到账的打款额 ÷ 已公布的打款额（同一批结算单）；打款日以官方结算单为准，实际到账以“到账核对”登记为准。',
  '预留金来自交易类型含 reserve 的财务交易；官方没有通用的账户余额接口，所以不显示可用余额。',
]

const round2 = (value: number) => Math.round(value * 100) / 100

/** 回款率（0 到 1）：已公布的打款额不大于 0 返回 null。 */
export function payoutRateOf(paid: number, announced: number): number | null {
  if (!(announced > 0)) return null
  return Math.round((paid / announced) * 10_000) / 10_000
}

/** 预留金汇总：交易金额带符号（扣留为负、返还为正）。 */
export function reserveSummary(amounts: readonly number[], hasFinanceData: boolean): FunnelReserve {
  if (!hasFinanceData) return { state: 'NOT_CONNECTED', held: null, returned: null, unreturned: null, count: 0, note: '财务交易尚未接入，暂无法计算预留金' }
  if (amounts.length === 0) return { state: 'NONE', held: null, returned: null, unreturned: null, count: 0, note: '最近 180 天没有预留金交易（官方没有扣留预留金，或交易里没有这类记录）' }
  let held = 0
  let returned = 0
  for (const amount of amounts) {
    if (amount < 0) held += -amount
    else returned += amount
  }
  const unreturned = Math.max(0, held - returned)
  return { state: 'OK', held: round2(held), returned: round2(returned), unreturned: round2(unreturned), count: amounts.length, note: '未退还 = 扣留 − 返还；官方返还后会减少' }
}

/** 漏斗各级：没有来源的传 null。应收未到账 = 已公布 − 已到账（不小于 0）。 */
export function buildFunnelStages(input: {
  posted: { amount: number; count: number } | null
  released: { amount: number; count: number } | null
  deferred: { amount: number; count: number } | null
  announced: { amount: number; count: number } | null
  paid: { amount: number; count: number } | null
}): FunnelStage[] {
  const upcoming = input.announced && input.paid ? { amount: Math.max(0, round2(input.announced.amount - input.paid.amount)), count: Math.max(0, input.announced.count - input.paid.count) } : null
  const pick = (key: FunnelStageKey, value: { amount: number; count: number } | null): FunnelStage => ({
    key,
    label: FUNNEL_STAGE_LABEL[key],
    note: FUNNEL_STAGE_NOTE[key],
    amount: value ? round2(value.amount) : null,
    count: value?.count ?? 0,
  })
  return [pick('POSTED', input.posted), pick('RELEASED', input.released), pick('DEFERRED', input.deferred), pick('ANNOUNCED', input.announced), pick('PAID', input.paid), pick('UPCOMING', upcoming)]
}
