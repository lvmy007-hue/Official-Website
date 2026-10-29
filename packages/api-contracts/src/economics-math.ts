import {
  DIFF_CLASSES,
  ECONOMICS_OURS_CURRENCY,
  ECONOMICS_TOLERANCE,
  type CompareVerdict,
  type DiffClass,
  type EconomicsCompareRow,
  type EconomicsCompareSummary,
  type EconomicsOfficialView,
  type EconomicsOursView,
  type EconomicsSideTotals,
  type NotComparableReason,
  type PreviewImpactState,
} from './economics.js'
import { round6 } from './profit-math.js'

// 官方经济数据对账的纯函数（P2b-11）：官方与我方逐 SKU 逐日核对，把差异拆成成本口径、广告口径、时间口径、未解释四类。API 与测试共用，不碰数据库。
//
// 符号约定：所有“影响”都是对“官方净收益 − 我方可比净收益”的带符号贡献，正数表示官方更高。
//   销售额影响 = 官方净销售额 − 我方销售净额；费用影响 = −(官方费用 − 我方费用)；广告影响 = −(官方广告 − 我方已分摊广告)；成本影响 = −(官方成本 − 我方成本)。
// 我方一天里没有记录但官方有（或相反）按 0 核对；整个 SKU 在所选区间里某一边一天都没有记录，则无法核对，不当作“全部差异”。

const abs = (value: number) => Math.abs(value)
/** 取负后的 0 会变成 -0，页面格式化会显示成“-0.00”。 */
const noNegativeZero = (value: number) => (value === 0 ? 0 : value)
const SEP = '\u001f'

/** 我方一天的数（利润日表，已按所选收入确认口径取出）。ads 为 null：广告尚未分摊到商品；cost 为 null：没有成本。 */
export interface OursRecord {
  sales: number
  fees: number
  ads: number | null
  cost: number | null
  units: number
  profit: number | null
}

export interface CompareCandidate {
  sellerAccountId: string
  msku: string
  date: string
  asin: string | null
  official: EconomicsOfficialView | null
  ours: OursRecord | null
}

export type ComparedRow = Omit<EconomicsCompareRow, 'storeName'>

export interface CompareOptions {
  /** 有成本字段权限才核对成本。 */
  withCost: boolean
}

interface Core {
  official: EconomicsOfficialView | null
  ours: OursRecord | null
  sales: number
  fees: number
  ads: number
  cost: number | null
  rest: number
  notes: string[]
}

const ZERO = { sales: 0, fees: 0, ads: 0 }

function coreOf(item: CompareCandidate, options: CompareOptions): Core {
  const o = item.official
  const c = item.ours
  const notes: string[] = []
  if (!o) notes.push('官方这一天没有记录，按 0 核对')
  if (!c) notes.push('我方这一天没有记录，按 0 核对')
  const sales = round6((o?.sales ?? ZERO.sales) - (c?.sales ?? ZERO.sales))
  const fees = noNegativeZero(round6(-((o?.fees ?? ZERO.fees) - (c?.fees ?? ZERO.fees))))
  const ads = noNegativeZero(round6(-((o?.ads ?? ZERO.ads) - (c?.ads ?? 0))))
  if (o && o.ads !== 0 && c && c.ads === null) notes.push('我方广告尚未分摊到商品，官方的广告扣款全部归广告口径')
  let cost: number | null = null
  if (options.withCost && o) {
    if (o.cost === null) notes.push('官方未提供成本（卖家没有在亚马逊后台填写），成本不核对')
    else if (!c || c.cost === null) notes.push('我方这一天没有成本，成本不核对')
    else cost = noNegativeZero(round6(-(o.cost - c.cost)))
  }
  return { official: o, ours: c, sales, fees, ads, cost, rest: round6(sales + fees), notes }
}

const oursView = (core: Core): EconomicsOursView => {
  const c = core.ours
  if (!c) return { state: 'NO_RECORD', sales: null, fees: null, ads: null, cost: null, units: null, netComparable: null, profit: null }
  const costIn = core.cost !== null && c.cost !== null ? c.cost : 0
  return { state: 'OK', sales: c.sales, fees: c.fees, ads: c.ads, cost: c.cost, units: c.units, netComparable: round6(c.sales - c.fees - (c.ads ?? 0) - costIn), profit: c.profit }
}

const keyOf = (item: CompareCandidate) => [item.sellerAccountId, item.msku, item.date].join(SEP)

function notComparable(item: CompareCandidate, reason: NotComparableReason): ComparedRow {
  const ours: EconomicsOursView = item.ours
    ? { state: 'OK', sales: item.ours.sales, fees: item.ours.fees, ads: item.ours.ads, cost: item.ours.cost, units: item.ours.units, netComparable: null, profit: item.ours.profit }
    : { state: 'NO_RECORD', sales: null, fees: null, ads: null, cost: null, units: null, netComparable: null, profit: null }
  return {
    key: keyOf(item),
    sellerAccountId: item.sellerAccountId,
    msku: item.msku,
    asin: item.asin,
    date: item.date,
    official: item.official,
    ours,
    impact: null,
    parts: null,
    verdict: 'NOT_COMPARABLE',
    notComparable: reason,
    notes: [],
  }
}

/** 取绝对值最大的一类；全部在容差内为“一致”。并列时按 成本、广告、时间、未解释 的顺序取靠前的。 */
export function verdictOf(parts: Record<DiffClass, number>): CompareVerdict {
  let best: DiffClass | null = null
  for (const name of DIFF_CLASSES) {
    if (abs(parts[name]) <= ECONOMICS_TOLERANCE) continue
    if (best === null || abs(parts[name]) > abs(parts[best])) best = name
  }
  return best ?? 'MATCH'
}

function compareGroup(items: readonly CompareCandidate[], options: CompareOptions): ComparedRow[] {
  const hasOfficial = items.some(item => item.official)
  const hasOurs = items.some(item => item.ours)
  const blocked = (item: CompareCandidate): NotComparableReason | null => {
    if (!hasOurs) return 'OURS_NO_RECORD'
    if (!hasOfficial) return 'OFFICIAL_NO_RECORD'
    return item.official && item.official.currency !== ECONOMICS_OURS_CURRENCY ? 'CURRENCY_MISMATCH' : null
  }
  const cores = items.map(item => ({ item, reason: blocked(item), core: blocked(item) ? null : coreOf(item, options) }))
  const live = cores.flatMap(entry => (entry.core ? [entry.core] : []))
  // 时间口径：按区间合计后互相抵消的部分。区间合计（S）超出容差的那部分差额是“未解释”，按各行差额的绝对值占比分摊。
  const total = round6(live.reduce((sum, core) => sum + core.rest, 0))
  const spread = live.reduce((sum, core) => sum + abs(core.rest), 0)
  const rangeTolerance = ECONOMICS_TOLERANCE * Math.max(1, live.length)
  return cores.map(({ item, reason, core }): ComparedRow => {
    if (!core) return notComparable(item, reason ?? 'OURS_NO_RECORD')
    const unexplained = abs(total) > rangeTolerance && spread > 0 ? round6((total * abs(core.rest)) / spread) : 0
    const parts: Record<DiffClass, number> = { COST: core.cost ?? 0, ADS: core.ads, TIME: round6(core.rest - unexplained), UNEXPLAINED: unexplained }
    const net = round6(core.sales + core.fees + core.ads + (core.cost ?? 0))
    return {
      key: keyOf(item),
      sellerAccountId: item.sellerAccountId,
      msku: item.msku,
      asin: item.asin,
      date: item.date,
      official: core.official,
      ours: oursView(core),
      impact: { sales: core.sales, fees: core.fees, ads: core.ads, cost: core.cost, net },
      parts,
      verdict: verdictOf(parts),
      notComparable: null,
      notes: core.notes,
    }
  })
}

/** 逐 SKU 逐日核对。同一个 SKU（店铺 × MSKU）的所有天一起判断时间口径与无法核对。 */
export function compareDays(inputs: readonly CompareCandidate[], options: CompareOptions): ComparedRow[] {
  const groups = new Map<string, CompareCandidate[]>()
  for (const item of inputs) {
    const key = `${item.sellerAccountId}${SEP}${item.msku}`
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return [...groups.values()].flatMap(items => compareGroup(items, options))
}

const sumOf = (values: ReadonlyArray<number | null>): number | null => {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : round6(present.reduce((sum, value) => sum + value, 0))
}

/** 过滤后各行的合计：可核对行里官方与我方各自的合计、净差异与按来源的差异。店铺层面广告核对由调用方另算。 */
export function summarizeCompare(rows: ReadonlyArray<Pick<ComparedRow, 'verdict' | 'official' | 'ours' | 'impact' | 'parts'>>): Omit<EconomicsCompareSummary, 'ads'> {
  const live = rows.filter(row => row.verdict !== 'NOT_COMPARABLE')
  const costCompared = live.filter(row => row.impact?.cost !== null && row.impact?.cost !== undefined)
  const official: EconomicsSideTotals = {
    sales: sumOf(live.map(row => row.official?.sales ?? 0)),
    fees: sumOf(live.map(row => row.official?.fees ?? 0)),
    ads: sumOf(live.map(row => row.official?.ads ?? 0)),
    cost: sumOf(costCompared.map(row => row.official?.cost ?? null)),
    netProceeds: sumOf(live.map(row => row.official?.netProceeds ?? null)),
  }
  const ours: EconomicsSideTotals = {
    sales: sumOf(live.map(row => row.ours.sales ?? 0)),
    fees: sumOf(live.map(row => row.ours.fees ?? 0)),
    ads: sumOf(live.map(row => row.ours.ads)),
    cost: sumOf(costCompared.map(row => row.ours.cost)),
    netProceeds: sumOf(live.map(row => row.ours.netComparable)),
  }
  const byClass = Object.fromEntries(DIFF_CLASSES.map(name => [name, { amount: 0, rows: 0 }])) as Record<DiffClass, { amount: number; rows: number }>
  for (const row of live) {
    for (const name of DIFF_CLASSES) byClass[name].amount = round6(byClass[name].amount + (row.parts?.[name] ?? 0))
    if (row.verdict !== 'MATCH') byClass[row.verdict as DiffClass].rows += 1
  }
  return {
    rows: rows.length,
    comparable: live.length,
    matched: live.filter(row => row.verdict === 'MATCH').length,
    notComparable: rows.length - live.length,
    official,
    ours,
    netDiff: live.length === 0 ? null : round6(live.reduce((sum, row) => sum + (row.impact?.net ?? 0), 0)),
    byClass,
  }
}

/** 店铺层面的广告核对：官方各商品广告扣款合计与我方广告花费（利润日表里已分摊到商品的加店铺级行）比较。 */
export function adsStoreCheck(input: { officialRows: number; official: number; oursRows: number; ours: number | null }): EconomicsCompareSummary['ads'] {
  if (input.officialRows === 0) return { state: 'NO_DATA', official: null, ours: input.ours, diff: null, note: '官方经济数据在所选区间没有记录，无法核对广告' }
  if (input.ours === null) return { state: 'NOT_CONNECTED', official: round6(input.official), ours: null, diff: null, note: '我方广告尚未接入或所选区间没有广告花费记录，不能与官方的广告扣款核对' }
  return {
    state: 'OK',
    official: round6(input.official),
    ours: round6(input.ours),
    diff: round6(input.official - input.ours),
    note: '官方各商品广告扣款合计与我方广告花费（已分摊到商品的加上店铺级行里没分出去的）的差额，官方减我方',
  }
}

/** 费用预览的利润影响：费用调整使单件费用变化了 delta，乘以官方预估的数量；费用变高对利润是负影响。 */
export function previewImpact(delta: number | null, quantity: number | null): { impact: number | null; state: PreviewImpactState } {
  if (delta === null || delta === 0) return { impact: null, state: 'NO_CHANGE' }
  if (quantity === null) return { impact: null, state: 'UNKNOWN_QUANTITY' }
  return { impact: round6(-delta * quantity), state: 'OK' }
}
