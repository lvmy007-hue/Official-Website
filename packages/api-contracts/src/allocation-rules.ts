// 店铺级费用分摊规则（P6-19，16 章第 7 节；09 章 9.12；freeze/models.md `AllocationRule`）。
// 纯类型、常量与纯函数（零 zod，前端与 worker 可引用）；请求校验在 allocation-rules-query.ts。
//
// 口径：
//  - 店铺级费用 = 没有 SKU 的费用明细（订阅费、月度仓储费、移除费、广告发票差额等），按“费用项”（利润项目字典里的项目）选分摊依据；
//  - 规则按月生效：同一费用项取“生效月不晚于所算月份”的最近一条；没有规则的费用项仍留在店铺级行，不分摊；
//  - 分摊只改变归属，不改变总额：各 SKU 分到的金额加起来恰好等于原始费用，尾差记到占比最大的 SKU（占比相同取 SKU 编码小的）；
//  - 权重按“店铺 × 月”取：销售额、销量取该月订单；货件签收量取该月更新过签收数的货件；移除订单取该月申请的移除件数；手动比例按 SKU 直接给。

export const ALLOCATION_RULE_READ = 'finance.read'
export const ALLOCATION_RULE_WRITE = 'finance.policy.write'
export const ALLOCATION_RULE_ACTIONS = { created: 'ALLOCATION_RULE_CREATED', updated: 'ALLOCATION_RULE_UPDATED' } as const
export const ALLOCATION_RULE_LIMITS = { manualSkuMax: 500, previewRowMax: 2000, pageSizeMax: 200, weightMax: 1_000_000_000 } as const

export const ALLOCATION_RULE_BASES = ['SALES_AMOUNT', 'SALES_UNITS', 'SHIPMENT_RECEIVED_UNITS', 'REMOVAL_ORDER_SKU', 'MANUAL'] as const
export type AllocationRuleBasis = (typeof ALLOCATION_RULE_BASES)[number]
export const ALLOCATION_RULE_BASIS_LABEL: Readonly<Record<AllocationRuleBasis, string>> = {
  SALES_AMOUNT: '按销售额',
  SALES_UNITS: '按销量',
  SHIPMENT_RECEIVED_UNITS: '按货件签收量',
  REMOVAL_ORDER_SKU: '按移除订单对应的 SKU',
  MANUAL: '手动比例',
}
export const isAllocationRuleBasis = (value: unknown): value is AllocationRuleBasis => typeof value === 'string' && (ALLOCATION_RULE_BASES as readonly string[]).includes(value)

/** 关账快照里“分摊规则”这一类口径版本的键（P6-31 会在同一个对象里补其余类型）。 */
export const METRIC_SNAPSHOT_ALLOCATION_KEY = 'allocationRules'

/** 规则在计算里的形状（生效月是 YYYY-MM）。 */
export interface AllocationRuleLite {
  id?: string
  feeItemId: string
  basis: AllocationRuleBasis
  manualWeights: Readonly<Record<string, number>> | null
  effectiveMonth: string
  version?: number
}

export const monthOfDay = (day: string): string => day.slice(0, 7)
/** 生效月（YYYY-MM）转成数据库的日期（当月第一天，UTC）。 */
export const monthStartDate = (month: string): Date => new Date(`${month}-01T00:00:00Z`)
export const monthText = (date: Date): string => date.toISOString().slice(0, 7)
export const isMonthText = (value: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(value)

/** 某费用项在某月适用的规则：生效月不晚于该月的最近一条；没有返回 null。 */
export function pickRuleForMonth<T extends { feeItemId: string; effectiveMonth: string }>(rules: readonly T[], feeItemId: string, month: string): T | null {
  let best: T | null = null
  for (const rule of rules) {
    if (rule.feeItemId !== feeItemId || rule.effectiveMonth > month) continue
    if (best === null || rule.effectiveMonth > best.effectiveMonth) best = rule
  }
  return best
}

export interface AllocationPart {
  key: string
  amount: number
  /** 占比（0 到 1）。 */
  share: number
}
export interface AllocationResult {
  parts: AllocationPart[]
  /** 没有任何正权重时分不出去的金额（整笔留在店铺级）。有分摊时恒为 0。 */
  unallocated: number
}

const MICRO = 1_000_000

/**
 * 把一笔费用按权重分摊（纯函数）：权重小于等于 0 的不参与；各份加起来恰好等于原始金额（按六位小数的最小单位计算，不会多一分少一分）；
 * 尾差记到权重最大的一份，权重相同取 key 排序靠前的。金额可以为负（退款、返还），符号保持。
 */
export function allocateByWeights(total: number, weights: ReadonlyArray<{ key: string; weight: number }>): AllocationResult {
  const valid = weights.filter(item => Number.isFinite(item.weight) && item.weight > 0).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  const sum = valid.reduce((acc, item) => acc + item.weight, 0)
  if (valid.length === 0 || sum <= 0 || !Number.isFinite(total)) return { parts: [], unallocated: total }
  const micro = Math.round(total * MICRO)
  const sign = micro < 0 ? -1 : 1
  const absolute = Math.abs(micro)
  const floors = valid.map(item => Math.floor((absolute * item.weight) / sum))
  let largest = 0
  for (let index = 1; index < valid.length; index += 1) if ((valid[index] as { weight: number }).weight > (valid[largest] as { weight: number }).weight) largest = index
  const remainder = absolute - floors.reduce((acc, value) => acc + value, 0)
  floors[largest] = (floors[largest] as number) + remainder
  return {
    parts: valid.map((item, index) => ({ key: item.key, amount: (sign * (floors[index] as number)) / MICRO, share: item.weight / sum })),
    unallocated: 0,
  }
}

/** 某店铺某月的权重原料：订单（销售额、销量）、货件签收量、移除订单件数，都是 SKU → 数值。 */
export interface AllocationWeightData {
  sales: ReadonlyMap<string, { revenue: number; units: number }>
  shipment: ReadonlyMap<string, number>
  removal: ReadonlyMap<string, number>
}

/**
 * 按规则的依据取各 SKU 的权重（纯函数，worker 的利润日表派生与 API 的预览共用同一份，保证预览与实际一致）。
 * 销售额依据在订单销售额全为 0 时（结算释放口径下销售额来自费用明细）退回按销量。
 */
export function allocationWeights(rule: Pick<AllocationRuleLite, 'basis' | 'manualWeights'>, data: AllocationWeightData): Array<{ key: string; weight: number }> {
  switch (rule.basis) {
    case 'MANUAL':
      return Object.entries(rule.manualWeights ?? {}).map(([key, weight]) => ({ key, weight }))
    case 'SHIPMENT_RECEIVED_UNITS':
      return [...data.shipment].map(([key, weight]) => ({ key, weight }))
    case 'REMOVAL_ORDER_SKU':
      return [...data.removal].map(([key, weight]) => ({ key, weight }))
    case 'SALES_UNITS':
      return [...data.sales].map(([key, value]) => ({ key, weight: value.units }))
    default: {
      const byRevenue = [...data.sales].map(([key, value]) => ({ key, weight: value.revenue }))
      return byRevenue.some(item => item.weight > 0) ? byRevenue : [...data.sales].map(([key, value]) => ({ key, weight: value.units }))
    }
  }
}

// ---- 接口形状 ----

export interface AllocationRuleRow {
  id: string
  feeItemId: string
  feeItemName: string
  feeItemPath: string
  basis: AllocationRuleBasis
  basisLabel: string
  manualWeights: Record<string, number> | null
  /** 生效月 YYYY-MM。 */
  effectiveMonth: string
  version: number
  /** 这个生效月所在的期间是否已关账（已关账的月份不能改，要先重开关账）。 */
  locked: boolean
  createdBy: string | null
  updatedAt: string
}

/** 可以配置分摊规则的费用项：利润项目字典里接收交易明细的项目（不含系统里的“销售额”“代收代缴税”等不适合分摊的）。 */
export interface AllocationFeeItemOption {
  id: string
  name: string
  path: string
  /** 近 90 天里没有 SKU 的费用明细笔数（帮助挑选哪些费用项真的有店铺级费用）。 */
  storeLevelLines90d: number
}

export interface AllocationRulesResponse {
  rows: AllocationRuleRow[]
  total: number
  feeItems: AllocationFeeItemOption[]
  bases: Array<{ value: AllocationRuleBasis; label: string }>
  notes: string[]
}

export interface AllocationPreviewRow {
  sellerAccountId: string
  sku: string
  /** 新规则下的占比与金额。 */
  share: number
  amount: number
  /** 当前生效规则（没有就是不分摊）下该 SKU 分到的金额。 */
  currentAmount: number
  diff: number
}

export interface AllocationPreviewResponse {
  month: string
  feeItemId: string
  feeItemName: string
  basis: AllocationRuleBasis
  /** 该月店铺级费用原始合计（美元，带符号：花费为负）。 */
  totalAmount: number
  allocatedAmount: number
  unallocatedAmount: number
  currentBasis: AllocationRuleBasis | null
  /** 这个月所在的期间已关账：保存也不会改变已关账的数字。 */
  locked: boolean
  rows: AllocationPreviewRow[]
  truncated: boolean
  notes: string[]
}

export const ALLOCATION_RULE_NOTES: readonly string[] = [
  '规则按月生效：每个费用项取生效月不晚于所算月份的最近一条；没有规则的费用项仍留在店铺级行，不分摊。',
  '分摊只改变费用归属，不改变总额：各 SKU 分到的金额加起来等于原始费用，尾差记到占比最大的 SKU；店铺总利润不变。',
  '新规则在利润日表下一次重算（每 6 小时近 45 天）后生效；已关账的月份不重算，也不能修改规则，需要先重开关账。',
  '当月的销售额、销量等权重是截至重算时的月累计；整月结束后最后一次重算会得到完整权重。',
  '没有任何权重（例如当月没有销售）的费用整笔留在店铺级行，不会丢失。',
]

/** 关账快照里记录的某个月的规则版本。 */
export interface AllocationRuleVersionSnapshot {
  ruleId: string
  feeItemId: string
  basis: AllocationRuleBasis
  effectiveMonth: string
  version: number
}
export interface MetricVersionSnapshot {
  [METRIC_SNAPSHOT_ALLOCATION_KEY]?: { months: Record<string, AllocationRuleVersionSnapshot[]> }
}

function monthsBetween(start: string, end: string): string[] {
  const out: string[] = []
  let [year, month] = [Number(start.slice(0, 4)), Number(start.slice(5, 7))] as [number, number]
  const last = end.slice(0, 7)
  for (let guard = 0; guard < 120; guard += 1) {
    const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
    if (text > last) break
    out.push(text)
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/** 关账时记录期间内每个月各费用项适用的规则版本（期间 start、end 是 YYYY-MM-DD）。 */
export function snapshotAllocationRules(rules: ReadonlyArray<AllocationRuleLite & { id: string; version: number }>, start: string, end: string): MetricVersionSnapshot {
  const months: Record<string, AllocationRuleVersionSnapshot[]> = {}
  const items = [...new Set(rules.map(rule => rule.feeItemId))].sort()
  for (const month of monthsBetween(start, end)) {
    const list: AllocationRuleVersionSnapshot[] = []
    for (const feeItemId of items) {
      const rule = pickRuleForMonth(rules, feeItemId, month)
      if (rule) list.push({ ruleId: rule.id, feeItemId, basis: rule.basis, effectiveMonth: rule.effectiveMonth, version: rule.version })
    }
    months[month] = list
  }
  return { [METRIC_SNAPSHOT_ALLOCATION_KEY]: { months } }
}
