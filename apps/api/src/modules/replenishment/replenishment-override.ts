import { forecastPeriodDays, forecastPeriodsOverlap, type AppliedOverride, type ForecastMode, type ForecastScopeType } from '@nova/api-contracts'
import { plusDays } from '../inventory'
import { round3, type AdjustedDemand } from './replenishment-math'

// 人工预测规则进入计算链（P6-09，16 章第 4 节）：按“日”解析每一天用哪条规则，再把预测范围内的逐日日销求平均，替换模型的日销。纯函数，不读数据库。
// 预测范围 = 今天起算 max（目标覆盖天数，主提前期）天：目标库存位置用“日销 × 天数”算，规则只在这段范围内起作用。
// 优先级：同一天里 SKU 规则优先于品类规则，两者都优先于模型预测（含订阅省与趋势调整）；去年同期没有销量记录的规则不生效（不当 0），那几天按下一级规则或模型预测。

/** 装配层解析好的一条规则：rate 是换算后的日销（件/天），去年同期缺数据时为 null。 */
export interface ResolvedOverride {
  id: string
  scopeType: ForecastScopeType
  scopeId: string
  mode: ForecastMode
  value: number
  from: string
  to: string
  rate: number | null
}

export type DemandBand = 'low' | 'mid' | 'high'

export interface DemandPlan {
  low: number
  mid: number
  high: number
  /** 第 offset 天（0 是今天）某一档的日销：命中规则取规则日销，否则取模型的日销。 */
  rateAt(band: DemandBand, offset: number): number
  /** 预测范围内真的改变了日销的天数。 */
  changedDays: number
  applied: AppliedOverride[]
  notes: string[]
}

const RANK: Record<ForecastScopeType, number> = { SKU: 0, CATEGORY: 1 }

/** 某一天命中的规则：只看有日销的规则，SKU 先于品类，同级按编号倒序（并发创建出现重叠时结果也稳定）。 */
function pick(rules: readonly ResolvedOverride[], date: string): ResolvedOverride | null {
  let best: ResolvedOverride | null = null
  for (const rule of rules) {
    if (rule.rate === null || rule.from > date || rule.to < date) continue
    if (!best || RANK[rule.scopeType] < RANK[best.scopeType] || (rule.scopeType === best.scopeType && rule.id > best.id)) best = rule
  }
  return best
}

const noteOf = (rule: ResolvedOverride, usedDays: number, windowDays: number): string | null => {
  if (rule.rate === null) return '去年同期没有销量记录，规则没有生效，这段时间按模型预测'
  if (usedDays === 0) return windowDays > 0 ? '这段时间已被优先级更高的 SKU 规则覆盖，没有生效' : null
  if (usedDays < windowDays) return `有 ${windowDays - usedDays} 天被优先级更高的 SKU 规则覆盖`
  return null
}

export function planDemand(adjusted: Pick<AdjustedDemand, 'low' | 'mid' | 'high'>, today: string, horizon: number, rules: readonly ResolvedOverride[]): DemandPlan {
  const days = Math.max(1, Math.round(horizon))
  const range = { from: today, to: plusDays(today, days - 1) }
  const relevant = rules.filter(rule => forecastPeriodsOverlap(rule, range))
  const sums: Record<DemandBand, number> = { low: 0, mid: 0, high: 0 }
  const used = new Map<string, number>()
  const chosen: Array<ResolvedOverride | null> = []
  for (let offset = 0; offset < days; offset += 1) {
    const rule = relevant.length ? pick(relevant, plusDays(today, offset)) : null
    chosen.push(rule)
    if (rule) used.set(rule.id, (used.get(rule.id) ?? 0) + 1)
    for (const band of ['low', 'mid', 'high'] as const) sums[band] += rule ? (rule.rate as number) : adjusted[band]
  }
  const rateAt = (band: DemandBand, offset: number): number => {
    const rule = offset >= 0 && offset < days ? chosen[offset] : pick(relevant, plusDays(today, offset))
    return rule ? (rule.rate as number) : adjusted[band]
  }
  const changedDays = chosen.filter(rule => rule !== null).length
  const applied = relevant.map<AppliedOverride>(rule => {
    const windowDays = forecastPeriodDays(rule.from > range.from ? rule.from : range.from, rule.to < range.to ? rule.to : range.to)
    const usedDays = used.get(rule.id) ?? 0
    return {
      id: rule.id,
      scopeType: rule.scopeType,
      scopeId: rule.scopeId,
      mode: rule.mode,
      value: rule.value,
      from: rule.from,
      to: rule.to,
      rate: rule.rate,
      days: usedDays,
      applied: usedDays > 0,
      note: noteOf(rule, usedDays, windowDays),
    }
  })
  const notes = applied.map(item =>
    item.applied
      ? `人工预测规则（${item.scopeType === 'SKU' ? 'SKU' : '品类'} ${item.scopeId}，${item.from} 至 ${item.to}）取代模型预测 ${item.days} 天，日销 ${item.rate} 件/天`
      : `人工预测规则（${item.scopeType === 'SKU' ? 'SKU' : '品类'} ${item.scopeId}，${item.from} 至 ${item.to}）未生效：${item.note ?? '没有覆盖预测范围'}`,
  )
  // 没有任何一天被规则改写：原样返回模型的日销（不经过平均，数值与没有规则时完全一致）
  const same = changedDays === 0
  return {
    low: same ? adjusted.low : round3(sums.low / days),
    mid: same ? adjusted.mid : round3(sums.mid / days),
    high: same ? adjusted.high : round3(sums.high / days),
    rateAt,
    changedDays,
    applied,
    notes,
  }
}
