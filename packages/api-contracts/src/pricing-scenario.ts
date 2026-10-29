import type { PriceUnit } from './pricing-math.js'
import type { GuardrailLimits } from './pricing.js'

// 定价规则的“情形 × 动作”矩阵（P6-17，16 章第 3.2 节）：纯数据与纯计算，前端、接口与 worker 共用；不引 zod，也没有模块级函数调用。
//
// 五种情形（按这个顺序判断，命中第一个就停）：
//   LOST_BUYBOX     失去推荐报价时      最近一次观察里我方不是推荐报价获得者（ownIsFeatured 为 false；没有观察不算）
//   I_AM_LOWEST     我是最低价时        我方当前价不高于其他卖家的最低报价
//   OTHER_BELOW_MIN 对方低于我的最低价时  对方最低报价低于我方“最低价”护栏（店铺、类目、ASIN、SKU 四层合并后的值）
//   OTHER_ABOVE_MAX 对方高于我的最高价时  对方最低报价高于我方“最高价”护栏（此时我方当前价比对方还高，一般是价格被抬到了最高价之上）
//   OTHER_BETWEEN   对方介于最低价与最高价之间  其余情况；护栏没有设最低价或最高价的一侧按不设限处理
// 五种动作：不调价、调到我的最低价、调到我的最高价、跟随对方价格加减 N（美元）、回到基础价。
// 基础价：矩阵里单独填的 basePrice；没填取近 30 天平均成交价（利润日表折算，缺销量或缺成本算不出时没有）。算不出目标价时不调价并写明原因，不猜。
// 目标价算出后仍走规则原有的检查：单次调幅收窄，再核对最低价、最高价、最低利润率；超出护栏的不执行，记一条“被护栏拦截”并写明原因。

export const PRICING_SITUATIONS = ['LOST_BUYBOX', 'I_AM_LOWEST', 'OTHER_BELOW_MIN', 'OTHER_BETWEEN', 'OTHER_ABOVE_MAX'] as const
export type PricingSituation = (typeof PRICING_SITUATIONS)[number]
export const PRICING_SITUATION_LABEL: Readonly<Record<PricingSituation, string>> = {
  LOST_BUYBOX: '失去推荐报价时',
  I_AM_LOWEST: '我是最低价时',
  OTHER_BELOW_MIN: '对方低于我的最低价时',
  OTHER_BETWEEN: '对方介于我的最低价和最高价之间',
  OTHER_ABOVE_MAX: '对方高于我的最高价时',
}

export const PRICING_ACTIONS = ['NONE', 'TO_MIN', 'TO_MAX', 'FOLLOW_OTHER', 'TO_BASE'] as const
export type PricingAction = (typeof PRICING_ACTIONS)[number]
export const PRICING_ACTION_LABEL: Readonly<Record<PricingAction, string>> = {
  NONE: '不调价',
  TO_MIN: '调到我的最低价',
  TO_MAX: '调到我的最高价',
  FOLLOW_OTHER: '跟随对方价格加减 N',
  TO_BASE: '回到基础价',
}

export const SCENARIO_LIMITS = {
  /** 跟随对方价格的加减额（美元）：与“与最低竞争报价保持差额”策略同一个范围。 */
  offsetMax: 20,
  basePriceMax: 100_000,
} as const

export interface ScenarioCell {
  action: PricingAction
  /** 只有 FOLLOW_OTHER 用：对方最低报价加（正）或减（负）多少美元，缺省为 0。 */
  offset?: number
}
export interface ScenarioMatrix {
  cells: Partial<Record<PricingSituation, ScenarioCell>>
  /** 基础价（美元）：所有商品共用；为空取近 30 天平均成交价。 */
  basePrice?: number | null
}

export interface SituationInput {
  currentPrice: number | null
  ownIsFeatured: boolean | null
  lowestOtherPrice: number | null
  minPrice: number | null
  maxPrice: number | null
}

const EPS = 0.005
const round2 = (value: number): number => Math.round(value * 100) / 100

/** 判断商品所处的情形；数据不够（没有当前价，或既没有“失去推荐报价”的观察也没有其他卖家的报价）时返回 null。 */
export function situationOf(input: SituationInput): PricingSituation | null {
  if (input.currentPrice === null || input.currentPrice <= 0) return null
  if (input.ownIsFeatured === false) return 'LOST_BUYBOX'
  const other = input.lowestOtherPrice
  if (other === null) return null
  if (input.currentPrice <= other + EPS) return 'I_AM_LOWEST'
  if (input.minPrice !== null && other < input.minPrice - EPS) return 'OTHER_BELOW_MIN'
  if (input.maxPrice !== null && other > input.maxPrice + EPS) return 'OTHER_ABOVE_MAX'
  return 'OTHER_BETWEEN'
}

export interface ScenarioTarget {
  /** 目标价；不调价或算不出时为 null。 */
  price: number | null
  /** 为 null 且 reason 为 null 表示配置的动作就是“不调价”；reason 有值表示该调价但缺数据算不出。 */
  reason: string | null
}

export function scenarioTarget(
  cell: ScenarioCell | undefined,
  input: { lowestOtherPrice: number | null; limits: Pick<GuardrailLimits, 'minPrice' | 'maxPrice'>; unit: PriceUnit | null; basePrice: number | null | undefined },
): ScenarioTarget {
  const action = cell?.action ?? 'NONE'
  if (action === 'NONE') return { price: null, reason: null }
  if (action === 'TO_MIN') return input.limits.minPrice === null ? { price: null, reason: '没有设置最低价护栏，“调到我的最低价”算不出目标价' } : { price: round2(input.limits.minPrice), reason: null }
  if (action === 'TO_MAX') return input.limits.maxPrice === null ? { price: null, reason: '没有设置最高价护栏，“调到我的最高价”算不出目标价' } : { price: round2(input.limits.maxPrice), reason: null }
  if (action === 'FOLLOW_OTHER') {
    if (input.lowestOtherPrice === null) return { price: null, reason: '没有其他卖家的竞争报价，“跟随对方价格”算不出目标价' }
    const price = round2(input.lowestOtherPrice + (cell?.offset ?? 0))
    return price > 0 ? { price, reason: null } : { price: null, reason: '按加减额算出的价格不是正数' }
  }
  const base = input.basePrice ?? input.unit?.avgPrice ?? null
  return base !== null && base > 0 ? { price: round2(base), reason: null } : { price: null, reason: '没有设置基础价，近 30 天也没有可折算的平均成交价（缺销量或销售额），“回到基础价”算不出目标价' }
}

/** 一格的文字：例如“跟随对方价格 −$0.50”。 */
export function describeCell(cell: ScenarioCell | undefined): string {
  const action = cell?.action ?? 'NONE'
  if (action !== 'FOLLOW_OTHER') return PRICING_ACTION_LABEL[action]
  const offset = cell?.offset ?? 0
  if (offset === 0) return '跟随对方价格（相同）'
  return `跟随对方价格 ${offset > 0 ? '+' : '−'}$${Math.abs(offset).toFixed(2)}`
}

/** 整张矩阵的一句话描述：只列会调价的格子；没有就写“没有会调价的格子”。 */
export function describeMatrix(matrix: ScenarioMatrix): string {
  const parts = PRICING_SITUATIONS.filter(situation => (matrix.cells[situation]?.action ?? 'NONE') !== 'NONE').map(
    situation => `${PRICING_SITUATION_LABEL[situation]}：${describeCell(matrix.cells[situation])}`,
  )
  return parts.length > 0 ? parts.join('；') : '没有会调价的格子'
}

/** 矩阵的问题（没有问题返回 null）：前后端共用。 */
export function scenarioMatrixIssue(matrix: ScenarioMatrix): string | null {
  let active = 0
  for (const situation of PRICING_SITUATIONS) {
    const cell = matrix.cells[situation]
    if (!cell || cell.action === 'NONE') continue
    active += 1
    if (cell.action === 'FOLLOW_OTHER') {
      const offset = cell.offset ?? 0
      if (!Number.isFinite(offset) || Math.abs(offset) > SCENARIO_LIMITS.offsetMax)
        return `“${PRICING_SITUATION_LABEL[situation]}”的加减额要在 -${SCENARIO_LIMITS.offsetMax} 到 ${SCENARIO_LIMITS.offsetMax} 美元之间`
    }
  }
  const base = matrix.basePrice
  if (base !== null && base !== undefined && !(Number.isFinite(base) && base > 0 && base <= SCENARIO_LIMITS.basePriceMax)) return '基础价要大于 0'
  return active === 0 ? '矩阵里没有任何会调价的格子；全部不调价等于没有规则，请至少设置一格，或不使用矩阵' : null
}

/** 把存库的 JSON 规整成矩阵（脏数据按“不调价”处理，不抛错）；不是对象时返回 null，表示这条规则不用矩阵。 */
export function normalizeMatrix(value: unknown): ScenarioMatrix | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as { cells?: unknown; basePrice?: unknown }
  const cellsRaw = raw.cells && typeof raw.cells === 'object' ? (raw.cells as Record<string, unknown>) : {}
  const cells: Partial<Record<PricingSituation, ScenarioCell>> = {}
  for (const situation of PRICING_SITUATIONS) {
    const cell = cellsRaw[situation]
    if (!cell || typeof cell !== 'object') continue
    const { action, offset } = cell as { action?: unknown; offset?: unknown }
    if (typeof action !== 'string' || !(PRICING_ACTIONS as readonly string[]).includes(action)) continue
    cells[situation] = { action: action as PricingAction, ...(typeof offset === 'number' && Number.isFinite(offset) ? { offset } : {}) }
  }
  const base = typeof raw.basePrice === 'number' && Number.isFinite(raw.basePrice) ? raw.basePrice : null
  return { cells, basePrice: base }
}
