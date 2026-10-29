import {
  ASIN_MEMBER_LIMIT,
  MATRIX_RISK_RANK,
  type AsinPoint,
  type AsinTreeChild,
  type AsinTreeNode,
  type AsinValues,
  type InventoryRiskLevel,
  type MatrixCell,
  type MatrixPivot,
  type MatrixRow,
  type TrafficRow,
} from '@nova/api-contracts'
import { nullableSum } from '../overview'
import { splitOf } from './business-reports-math'
import { compareText } from './business-reports-page'

// ASIN 与父体分析的纯计算（P4-03，不访问数据库）：家族（父体与子体）归并、逐日指标装配、父体树、变体属性透视、流量占比。
// 约定同业务报告：没有记录或来源没给的值是 null，不当 0；合计只加有值的行，整段都没有值才是 null。

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits
const roundOrNull = (value: number | null, digits: number) => (value === null ? null : round(value, digits))

export interface ProductLite {
  id: string
  sellerAccountId: string
  sellerSku: string
  asin: string
  parentAsin: string | null
  title: string
  brand: string | null
  imageUrl: string | null
  categoryPath: string | null
  listingStatus: string
  catalogStatus: string | null
  variantAttributes: unknown
  ownerUserId: string | null
  tagIds: string[]
}

export interface ChildAsin {
  asin: string
  title: string | null
  productId: string | null
  storeIds: string[]
  skuCount: number
  attributes: Record<string, string>
}

const attributesOf = (value: unknown): Record<string, string> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (typeof item === 'string' && item ? [[key, item]] : [])))
}

/** 把商品行按 ASIN 合并成子体：同一个 ASIN 的多个 SKU 与多个店铺合在一起；父体自己的商品行不算子体；relationOnly 是只在父子关系表里出现的子体。 */
export function childrenOf(products: readonly ProductLite[], parentAsin: string, relationOnly: readonly string[] = []): ChildAsin[] {
  const byAsin = new Map<string, ChildAsin>()
  for (const product of [...products].sort((a, b) => compareText(a.id, b.id))) {
    if (product.asin === parentAsin) continue
    const held = byAsin.get(product.asin)
    if (!held) {
      byAsin.set(product.asin, {
        asin: product.asin,
        title: product.title,
        productId: product.id,
        storeIds: [product.sellerAccountId],
        skuCount: 1,
        attributes: attributesOf(product.variantAttributes),
      })
      continue
    }
    held.skuCount += 1
    if (!held.storeIds.includes(product.sellerAccountId)) held.storeIds.push(product.sellerAccountId)
    held.attributes = { ...attributesOf(product.variantAttributes), ...held.attributes }
  }
  for (const asin of relationOnly) if (asin !== parentAsin && !byAsin.has(asin)) byAsin.set(asin, { asin, title: null, productId: null, storeIds: [], skuCount: 0, attributes: {} })
  return [...byAsin.values()].sort((a, b) => compareText(a.asin, b.asin))
}

/** 子体太多时按销售额从高到低保留（没有销售额的排在后面），返回是否截断。 */
export function limitChildren<T extends { asin: string }>(children: readonly T[], sales: ReadonlyMap<string, number | null>, limit = ASIN_MEMBER_LIMIT): { kept: T[]; truncated: boolean } {
  if (children.length <= limit) return { kept: [...children], truncated: false }
  const sorted = [...children].sort((a, b) => {
    const left = sales.get(a.asin) ?? null
    const right = sales.get(b.asin) ?? null
    if (left === null || right === null) return left === right ? compareText(a.asin, b.asin) : left === null ? 1 : -1
    return left === right ? compareText(a.asin, b.asin) : right - left
  })
  return { kept: sorted.slice(0, limit), truncated: true }
}

// ---- 父体树 ----

export interface AsinTotals {
  sales: number | null
  sessions: number | null
}

/** 商品行 → 父体树：有父体的归到父体下，没有父体且没有别人把它当父体的单独成一项。销售额从高到低（没有的在后）。 */
export function buildTree(products: readonly ProductLite[], totals: ReadonlyMap<string, AsinTotals>): AsinTreeNode[] {
  const parents = new Set(products.flatMap(product => (product.parentAsin ? [product.parentAsin] : [])))
  const groups = new Map<string, ProductLite[]>()
  for (const product of products) {
    const key = product.parentAsin ?? (parents.has(product.asin) ? product.asin : `single:${product.asin}`)
    groups.set(key, [...(groups.get(key) ?? []), product])
  }
  const nodes = [...groups.entries()].map<AsinTreeNode>(([key, members]) => {
    if (key.startsWith('single:')) {
      const only = members[0]!
      const own = totals.get(only.asin)
      return { key: `asin:${only.asin}`, kind: 'asin', asin: only.asin, title: only.title, brand: only.brand, childCount: 0, sales: own?.sales ?? null, sessions: own?.sessions ?? null, children: [] }
    }
    const kids = childrenOf(members, key)
    const children = kids.map<AsinTreeChild>(kid => ({
      asin: kid.asin,
      title: kid.title,
      productId: kid.productId,
      sales: totals.get(kid.asin)?.sales ?? null,
      sessions: totals.get(kid.asin)?.sessions ?? null,
    }))
    const own = members.find(member => member.asin === key)
    const first = own ?? members[0]!
    return {
      key: `parent:${key}`,
      kind: 'parent',
      asin: key,
      title: own?.title ?? null,
      brand: first.brand,
      childCount: children.length,
      sales: roundOrNull(nullableSum(children.map(child => child.sales)), 2),
      sessions: nullableSum(children.map(child => child.sessions)),
      children: children.sort((a, b) => (a.sales === b.sales ? compareText(a.asin, b.asin) : a.sales === null ? 1 : b.sales === null ? -1 : b.sales - a.sales)),
    }
  })
  return nodes.sort((a, b) => (a.sales === b.sales ? compareText(a.key, b.key) : a.sales === null ? 1 : b.sales === null ? -1 : b.sales - a.sales))
}

// ---- 逐日指标 ----

export interface StockDay {
  units: number | null
  available: number | null
}

export interface PointInputs {
  days: readonly string[]
  /** 逐日的销售与流量（已按来源取舍、已合并成日合计）。 */
  daily: ReadonlyMap<string, { sales: number | null; units: number | null; sessions: number | null; pageViews: number | null; buyBox: number | null }>
  /** 广告销售额逐日；null = 没有广告数据来源。 */
  adsByDay: ReadonlyMap<string, number> | null
  /** 退货件数逐日；null = 退货报告尚未同步。 */
  returnsByDay: ReadonlyMap<string, number> | null
  stock: ReadonlyMap<string, StockDay>
  /** 销售排名逐日；null = 不适用或没有快照。 */
  rankByDay: ReadonlyMap<string, number> | null
  /** 整段的转化率、价格、购物车获得率：由调用方按行（分子分母同一行都有值）算好，与父体身份区、贡献矩阵口径一致。 */
  ratios: Pick<AsinValues, 'conversion' | 'price' | 'buyBox'>
}

export const EMPTY_VALUES: AsinValues = {
  sales: null,
  units: null,
  sessions: null,
  pageViews: null,
  conversion: null,
  price: null,
  buyBox: null,
  adsSales: null,
  organicSales: null,
  returnRate: null,
  daysOfSupply: null,
  salesRank: null,
}

const ratio = (top: number | null, bottom: number | null, digits: number) => (top === null || bottom === null || bottom <= 0 ? null : round(top / bottom, digits))

/** 近 7 天（含当天，范围内不足 7 天就用已有的）的合计；任一天都没值就是 null。 */
function trailing(days: readonly string[], index: number, value: (day: string) => number | null): number | null {
  return nullableSum(days.slice(Math.max(0, index - 6), index + 1).map(value))
}

export function assemblePoints(input: PointInputs): { points: AsinPoint[]; totals: AsinValues } {
  const { days, daily, adsByDay, returnsByDay, stock, rankByDay } = input
  const points = days.map<AsinPoint>((date, index) => {
    const row = daily.get(date)
    const sales = roundOrNull(row?.sales ?? null, 2)
    const ads = adsByDay?.get(date) ?? null
    const stockDay = stock.get(date)
    const demand = trailing(days, index, day => stock.get(day)?.units ?? null)
    const returns = returnsByDay ? trailing(days, index, day => returnsByDay.get(day) ?? 0) : null
    const unitsWindow = trailing(days, index, day => daily.get(day)?.units ?? null)
    return {
      date,
      sales,
      units: row?.units ?? null,
      sessions: row?.sessions ?? null,
      pageViews: row?.pageViews ?? null,
      conversion: ratio(row?.units ?? null, row?.sessions ?? null, 6),
      price: ratio(row?.sales ?? null, row?.units ?? null, 4),
      buyBox: roundOrNull(row?.buyBox ?? null, 6),
      adsSales: roundOrNull(ads, 2),
      organicSales: ads !== null && sales !== null && ads <= sales + 0.005 ? round(sales - ads, 2) : null,
      returnRate: returns === null ? null : ratio(returns, unitsWindow, 6),
      daysOfSupply: stockDay?.available === null || stockDay?.available === undefined || demand === null || demand <= 0 ? null : round(stockDay.available / (demand / Math.min(7, index + 1)), 1),
      salesRank: rankByDay?.get(date) ?? null,
    }
  })
  return { points, totals: totalsOf(points, input) }
}

const lastValue = (points: readonly AsinPoint[], key: 'daysOfSupply' | 'salesRank') => [...points].reverse().find(point => point[key] !== null)?.[key] ?? null

function totalsOf(points: readonly AsinPoint[], input: PointInputs): AsinValues {
  const sales = roundOrNull(nullableSum(points.map(point => point.sales)), 2)
  const units = nullableSum(points.map(point => point.units))
  const sessions = nullableSum(points.map(point => point.sessions))
  const ads = input.adsByDay && input.adsByDay.size > 0 ? roundOrNull(nullableSum(points.map(point => point.adsSales)), 2) : null
  const returns = input.returnsByDay ? (nullableSum([...input.returnsByDay.values()]) ?? 0) : null
  const split = splitOf(sales, ads)
  return {
    sales,
    units,
    sessions,
    pageViews: nullableSum(points.map(point => point.pageViews)),
    ...input.ratios,
    adsSales: ads,
    organicSales: split.state === 'OK' ? split.organicSales : null,
    returnRate: returns === null ? null : ratio(returns, units, 6),
    daysOfSupply: lastValue(points, 'daysOfSupply'),
    salesRank: lastValue(points, 'salesRank'),
  }
}

// ---- 变体属性透视 ----

export const UNSET = '未填写'
const worstRisk = (risks: ReadonlyArray<InventoryRiskLevel | null>): InventoryRiskLevel | null => {
  const given = risks.filter((risk): risk is InventoryRiskLevel => risk !== null)
  return given.length === 0 ? null : given.reduce((worst, risk) => (MATRIX_RISK_RANK[risk] > MATRIX_RISK_RANK[worst] ? risk : worst))
}

function cellOf(row: string, col: string, members: readonly MatrixRow[]): MatrixCell {
  const withBoth = members.filter(member => member.units !== null && member.sessions !== null)
  const sessionsBase = withBoth.reduce((total, member) => total + member.sessions!, 0)
  return {
    row,
    col,
    asins: members.map(member => member.asin),
    sales: roundOrNull(nullableSum(members.map(member => member.sales)), 2),
    units: nullableSum(members.map(member => member.units)),
    sessions: nullableSum(members.map(member => member.sessions)),
    conversion: sessionsBase > 0 ? round(withBoth.reduce((total, member) => total + member.units!, 0) / sessionsBase, 6) : null,
    risk: worstRisk(members.map(member => member.risk)),
  }
}

const NO_ATTRIBUTES_NOTE = '商品目录里没有这个父体子体的变体属性（颜色、尺码等）：目录同步只读变体主题列出的维度，目录还没同步或亚马逊没给出取值时这里没有内容；不用 SKU 或标题去猜'

/** 变体属性透视：维度按“出现的子体数”从多到少；没有指定就取最多的两个（只有一个维度时是一维）。 */
export function pivotOf(rows: readonly MatrixRow[], chosen: readonly [string, string] | null): MatrixPivot {
  const counts = new Map<string, number>()
  for (const row of rows) for (const name of Object.keys(row.attributes)) counts.set(name, (counts.get(name) ?? 0) + 1)
  const dimensions = [...counts.entries()].sort((a, b) => b[1] - a[1] || compareText(a[0], b[0])).map(([name]) => name)
  if (dimensions.length === 0) return { state: 'NOT_CONNECTED', note: NO_ATTRIBUTES_NOTE, dimensions, rowDim: null, colDim: null, rowValues: [], colValues: [], cells: [] }
  const valid = chosen && dimensions.includes(chosen[0]) && dimensions.includes(chosen[1])
  const [rowDim, colDim] = valid ? chosen : ([dimensions[0]!, dimensions[1] ?? null] as [string, string | null])
  const keyOf = (row: MatrixRow) => [row.attributes[rowDim] ?? UNSET, colDim ? (row.attributes[colDim] ?? UNSET) : '全部'] as const
  const groups = new Map<string, { row: string; col: string; members: MatrixRow[] }>()
  for (const row of rows) {
    const [r, c] = keyOf(row)
    const key = `${r}\u001f${c}`
    const held = groups.get(key) ?? { row: r, col: c, members: [] }
    held.members.push(row)
    groups.set(key, held)
  }
  const cells = [...groups.values()].map(group => cellOf(group.row, group.col, group.members))
  const order = (pick: (cell: MatrixCell) => string) => {
    const totals = new Map<string, number | null>()
    for (const cell of cells) totals.set(pick(cell), nullableSum([totals.get(pick(cell)) ?? null, cell.sales]))
    return [...totals.entries()].sort((a, b) => (a[1] === b[1] ? compareText(a[0], b[0]) : a[1] === null ? 1 : b[1] === null ? -1 : b[1] - a[1])).map(([label]) => label)
  }
  const note = chosen && !valid ? `所选维度不在这个父体的变体属性里，已改用 ${rowDim}${colDim ? ` × ${colDim}` : ''}` : null
  return { state: 'OK', note, dimensions, rowDim, colDim, rowValues: order(cell => cell.row), colValues: order(cell => cell.col), cells }
}

/** 矩阵着色的刻度：销售额与转化率取子体的最小最大值；风险没有数值刻度。 */
export function scaleOf(rows: readonly MatrixRow[], metric: 'sales' | 'conversion' | 'risk'): { min: number; max: number } | null {
  if (metric === 'risk') return null
  const values = rows.map(row => row[metric]).filter((value): value is number => value !== null)
  return values.length === 0 ? null : { min: Math.min(...values), max: Math.max(...values) }
}

// ---- 流量分布 ----

export function trafficRows(
  children: ReadonlyArray<{ asin: string; title: string | null }>,
  current: ReadonlyMap<string, number | null>,
  compare: ReadonlyMap<string, number | null> | null,
): TrafficRow[] {
  const total = nullableSum([...current.values()])
  const compareTotal = compare ? nullableSum([...compare.values()]) : null
  const share = (value: number | null, base: number | null) => (value === null || base === null || base <= 0 ? null : round(value / base, 6))
  return children
    .map<TrafficRow>(child => {
      const sessions = current.get(child.asin) ?? null
      const compareSessions = compare ? (compare.get(child.asin) ?? null) : null
      const now = share(sessions, total)
      const before = share(compareSessions, compareTotal)
      return { asin: child.asin, title: child.title, sessions, share: now, compareSessions, compareShare: before, shareChange: now === null || before === null ? null : round(now - before, 6) }
    })
    .sort((a, b) => (a.sessions === b.sessions ? compareText(a.asin, b.asin) : a.sessions === null ? 1 : b.sessions === null ? -1 : b.sessions - a.sessions))
}
