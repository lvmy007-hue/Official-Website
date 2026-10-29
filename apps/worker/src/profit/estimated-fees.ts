import { allocateByWeights, feeCoversDay, fixedAmountOnDay, percentAmount, type EstimatedFeeLite, type LineTarget } from '@nova/api-contracts'
import type { DayRange } from './types'

// 预估与自定义费用的估算（P6-20，纯函数，不碰数据库）：按企业录入的规则，生成利润日表里的“估算费用行”，
// 装配时与实际费用明细走同一条路径（归到费用项在字典里对应的利润桥项目、按项目累计、店铺级费用按分摊规则拆到 SKU）。
// 冲销：同一店铺同一费用项在对应期间（按日的看当天，按月的看当月）已经有实际费用出账，这一期的估算不再生成。

export interface EstimateRule extends EstimatedFeeLite {
  /** 写进 itemAmounts 的键，即费用项编号。 */
  itemKey: string
  /** 费用项在字典里归到的利润桥项目（只会是花费类）。 */
  target: LineTarget
  /** 这些项目键下出现实际费用，就冲销这条规则：费用项自己，以及（系统项目时）按内置口径未映射的同一利润桥项目。 */
  actualKeys: readonly string[]
}

export interface EstimateInputs {
  rules: readonly EstimateRule[]
  /** 实际费用出账：键 `店铺|项目键|YYYY-MM-DD`（按日）与 `店铺|项目键|YYYY-MM`（按月）。 */
  actual: ReadonlySet<string>
  /** SKU → 商品类型与类目路径（品类规则按它匹配）。 */
  categories: ReadonlyMap<string, ReadonlySet<string>>
}
export const EMPTY_ESTIMATES: EstimateInputs = { rules: [], actual: new Set(), categories: new Map() }

/** 一条估算费用行：金额是正数的“花费”；sku 为空串表示店铺级费用（可按分摊规则拆到 SKU）。 */
export interface EstimateLine {
  sellerAccountId: string
  sku: string
  day: string
  itemKey: string
  target: LineTarget
  amount: number
}

export interface EstimateRevenueRow {
  sellerAccountId: string
  sku: string
  day: string
  revenue: number
}

const DAY_MS = 86_400_000
const SEP = '\u0000'

function daysOf(from: string, to: string): string[] {
  const out: string[] = []
  for (let time = Date.parse(`${from}T00:00:00Z`); time <= Date.parse(`${to}T00:00:00Z`); time += DAY_MS) out.push(new Date(time).toISOString().slice(0, 10))
  return out
}

export const actualDayKey = (store: string, itemKey: string, day: string) => `${store}|${itemKey}|${day}`
export const actualMonthKey = (store: string, itemKey: string, day: string) => `${store}|${itemKey}|${day.slice(0, 7)}`

export interface BuildEstimatesInput {
  estimates: EstimateInputs
  range: DayRange
  /** 企业时区的今天：只估算到今天为止的日子。 */
  today: string
  /** 费用明细装配完以后每个（店铺、SKU、日）的销售额（美元），比例规则据此计算。 */
  revenue: readonly EstimateRevenueRow[]
  /** 出现过销售的（店铺、SKU），固定金额的 SKU 规则据此决定落到哪些店铺。 */
  pairs: ReadonlyArray<{ sellerAccountId: string; sku: string }>
}

export function buildEstimateLines(input: BuildEstimatesInput): EstimateLine[] {
  const { estimates, range } = input
  if (estimates.rules.length === 0) return []
  const last = input.today < range.to ? input.today : range.to
  if (last < range.from) return []
  const days = daysOf(range.from, last)
  const byDay = new Map<string, EstimateRevenueRow[]>()
  for (const row of input.revenue) if (row.revenue > 0) byDay.set(row.day, [...(byDay.get(row.day) ?? []), row])
  const storesOfSku = new Map<string, Set<string>>()
  for (const pair of input.pairs) storesOfSku.set(pair.sku, (storesOfSku.get(pair.sku) ?? new Set()).add(pair.sellerAccountId))
  const inCategory = (sku: string, scopeId: string) => estimates.categories.get(sku)?.has(scopeId) === true
  const lines: EstimateLine[] = []
  for (const rule of estimates.rules) {
    if (rule.status !== 'ACTIVE' || !(rule.value > 0)) continue
    for (const day of days) {
      if (!feeCoversDay(rule, day)) continue
      const reversed = (store: string) => rule.actualKeys.some(key => estimates.actual.has(rule.period === 'DAILY' ? actualDayKey(store, key, day) : actualMonthKey(store, key, day)))
      const push = (sellerAccountId: string, sku: string, amount: number) => {
        if (amount > 0 && !reversed(sellerAccountId)) lines.push({ sellerAccountId, sku, day, itemKey: rule.itemKey, target: rule.target, amount })
      }
      if (rule.mode === 'FIXED') {
        const amount = fixedAmountOnDay(rule, day) ?? 0
        if (rule.scopeType === 'STORE') push(rule.scopeId, '', amount)
        else if (rule.scopeType === 'SKU') for (const store of [...(storesOfSku.get(rule.scopeId) ?? [])].sort()) push(store, rule.scopeId, amount)
        else {
          // 品类下的固定金额：按当天品类内各 SKU 的销售额分摊，当天没有销售就不计入
          const rows = (byDay.get(day) ?? []).filter(row => inCategory(row.sku, rule.scopeId))
          const result = allocateByWeights(
            amount,
            rows.map(row => ({ key: `${row.sellerAccountId}${SEP}${row.sku}`, weight: row.revenue })),
          )
          for (const part of result.parts) {
            const [store, sku] = part.key.split(SEP) as [string, string]
            push(store, sku, part.amount)
          }
        }
      } else {
        for (const row of byDay.get(day) ?? []) {
          const hit = rule.scopeType === 'STORE' ? row.sellerAccountId === rule.scopeId : rule.scopeType === 'SKU' ? row.sku === rule.scopeId : inCategory(row.sku, rule.scopeId)
          if (hit) push(row.sellerAccountId, row.sku, percentAmount(rule, row.revenue))
        }
      }
    }
  }
  return lines
}
