import { ADS_TODAY_ANOMALY_RULES, ADS_TODAY_BAND_MIN_SAMPLES, ADS_TODAY_PREDICT_MIN_HOURS, type AdsTodayBand, type AdsTodayExhaustState } from './ads-today'

// 今日广告的纯函数（P3-06）：历史同时段区间带、预算耗尽外推、单次点击成本突增、花费无转化、超预算状态判断。
// 不含数据库；API 与前端都可用。全部可空：没有数据返回 null，不编造 0。

const HOUR_MS = 3_600_000

export interface HourSample {
  spend: number | null
  clicks: number
}

/** 历史同时段区间带：样本少于 ADS_TODAY_BAND_MIN_SAMPLES 个不给。花费没有任何非空样本时花费上下限为 null。 */
export function hourBand(samples: readonly HourSample[]): AdsTodayBand | null {
  if (samples.length < ADS_TODAY_BAND_MIN_SAMPLES) return null
  const spends = samples.map(sample => sample.spend).filter((value): value is number => value !== null)
  const clicks = samples.map(sample => sample.clicks)
  return {
    spendMin: spends.length > 0 ? Math.min(...spends) : null,
    spendMax: spends.length > 0 ? Math.max(...spends) : null,
    clicksMin: Math.min(...clicks),
    clicksMax: Math.max(...clicks),
    samples: samples.length,
  }
}

export interface ExhaustInput {
  dailyBudget: number
  /** 今日已花费；没有记录为 null */
  spend: number | null
  now: Date
  dayStart: Date
  dayEndExclusive: Date
}

/**
 * 预算耗尽外推（估算）：按今天已过去时间的平均花费速度，剩余预算还够用多久。
 * EXHAUSTED 已用完；TOO_EARLY 过去不到 ADS_TODAY_PREDICT_MIN_HOURS 小时；NO_SPEND 没有花费；
 * PROJECTED 预计在今天内耗尽（给出时刻）；NOT_TODAY 照这个速度今天耗不完。
 */
export function exhaustProjection(input: ExhaustInput): { state: AdsTodayExhaustState; at: Date | null } {
  const spend = input.spend
  if (spend !== null && spend >= input.dailyBudget) return { state: 'EXHAUSTED', at: null }
  const elapsed = input.now.getTime() - input.dayStart.getTime()
  if (elapsed < ADS_TODAY_PREDICT_MIN_HOURS * HOUR_MS) return { state: 'TOO_EARLY', at: null }
  if (spend === null || spend <= 0) return { state: 'NO_SPEND', at: null }
  const remainingMs = ((input.dailyBudget - spend) / spend) * elapsed
  const at = new Date(input.now.getTime() + remainingMs)
  return at.getTime() >= input.dayEndExclusive.getTime() ? { state: 'NOT_TODAY', at: null } : { state: 'PROJECTED', at }
}

/** 单次点击成本 = 花费 ÷ 点击；没有花费、花费为 0 或没有点击为 null。 */
export const adsCpc = (spend: number | null, clicks: number): number | null => (spend === null || clicks <= 0 || spend <= 0 ? null : spend / clicks)

export interface CpcSurge {
  todayCpc: number
  baselineCpc: number
  ratio: number
}

/** 单次点击成本突增：规则见 ADS_TODAY_ANOMALY_RULES；今日或基线任一边没有可算的成本都不判断。 */
export function cpcSurge(today: { spend: number | null; clicks: number }, baseline: { spend: number | null; clicks: number }): CpcSurge | null {
  const rules = ADS_TODAY_ANOMALY_RULES
  if (today.clicks < rules.CPC_MIN_CLICKS || baseline.clicks < rules.BASELINE_MIN_CLICKS) return null
  const todayCpc = adsCpc(today.spend, today.clicks)
  const baselineCpc = adsCpc(baseline.spend, baseline.clicks)
  if (todayCpc === null || baselineCpc === null) return null
  const ratio = todayCpc / baselineCpc
  return ratio >= rules.CPC_RATIO ? { todayCpc, baselineCpc, ratio } : null
}

/** 花费无转化：今日花费与点击都达到门槛但没有订单。订单为 0 是“目前没有”（转化滞后），不是“确定没有”。 */
export function spendWithoutConversion(today: { spend: number | null; clicks: number; orders: number }): boolean {
  const rules = ADS_TODAY_ANOMALY_RULES
  return (today.spend ?? 0) >= rules.NO_CONVERSION_MIN_SPEND && today.clicks >= rules.NO_CONVERSION_MIN_CLICKS && today.orders === 0
}

/**
 * 活动投放状态是不是“预算用完”：活动管理接口的投放状态里带 OUT_OF_BUDGET（例如 CAMPAIGN_OUT_OF_BUDGET）。
 * 统一接口的具体取值从未对真实广告账户核对过，所以只做包含判断，不枚举。
 */
export const isOutOfBudgetStatus = (status: string | null | undefined): boolean => (status ?? '').toUpperCase().includes('OUT_OF_BUDGET')
