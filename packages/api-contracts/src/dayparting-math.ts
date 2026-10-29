import { weekdayHourOf } from './ads-campaigns-math'
import type { AdsHourlyCell } from './ads-campaigns-tabs'
import { DAYPARTING_GRID_SIZE, DAYPARTING_MULTIPLIER, DAYPARTING_SIM_MODEL, type DaypartingDue, type DaypartingKind, type DaypartingTotals } from './dayparting'

// 分时策略的纯函数（P3-12）：取值校验、当前时段、取值摘要、效果模拟。API 与前端共用；全部不碰数据库与时钟（时间由调用方传入）。

/** 星期 × 小时 → 格子下标（周一 0 点为 0，周日 23 点为 167）。 */
export const gridIndexOf = (weekday: number, hour: number): number => weekday * 24 + hour

/** 全部“不改变”的格子：竞价系数 1，启停全部启用——两种策略的中性值都是 1。 */
export const neutralGrid = (): number[] => new Array<number>(DAYPARTING_GRID_SIZE).fill(1)

/** IANA 时区名是否被运行环境认识。 */
export function isValidTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return zone.trim().length > 0
  } catch {
    return false
  }
}

const hasAtMostTwoDecimals = (value: number): boolean => Math.abs(value * 100 - Math.round(value * 100)) < 1e-9

/** 168 格取值的合法性；合法返回 null，否则返回原因（中文）。竞价系数取 0.1 至 3、最多两位小数；启停只能是 0 或 1；全部是 1（不会改变任何东西）也不允许。 */
export function gridIssue(kind: DaypartingKind, grid: readonly number[]): string | null {
  if (grid.length !== DAYPARTING_GRID_SIZE) return `必须给满一周 ${DAYPARTING_GRID_SIZE} 个小时格（现在是 ${grid.length} 个）`
  for (let index = 0; index < grid.length; index += 1) {
    const value = grid[index]
    const where = `第 ${Math.floor(index / 24) + 1} 天 ${index % 24} 点`
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${where}的取值不是数字`
    if (kind === 'ON_OFF') {
      if (value !== 0 && value !== 1) return `${where}的取值只能是 0（暂停）或 1（启用）`
    } else {
      if (value < DAYPARTING_MULTIPLIER.min || value > DAYPARTING_MULTIPLIER.max) return `${where}的竞价系数必须在 ${DAYPARTING_MULTIPLIER.min} 至 ${DAYPARTING_MULTIPLIER.max} 之间`
      if (!hasAtMostTwoDecimals(value)) return `${where}的竞价系数最多两位小数`
    }
  }
  if (grid.every(value => value === 1)) return kind === 'ON_OFF' ? '所有时段都是启用，策略不会改变任何东西；至少要有一个暂停的时段' : '所有时段的竞价系数都是 1，策略不会改变任何东西'
  return null
}

/** 取值的中文：竞价系数“竞价 ×1.20”，启停“暂停”“启用”。 */
export const daypartingValueLabel = (kind: DaypartingKind, value: number | null): string => {
  if (value === null) return '无'
  if (kind === 'ON_OFF') return value === 0 ? '暂停' : '启用'
  return `竞价 ×${value.toFixed(2)}`
}

/** 此刻（按策略自己的时区）应执行的取值；执行器接入后每小时按它写亚马逊。 */
export function daypartingDueOf(kind: DaypartingKind, grid: readonly number[], zone: string, at: Date): DaypartingDue {
  const { weekday, hour } = weekdayHourOf(at, zone)
  const value = grid[gridIndexOf(weekday, hour)] ?? null
  return { weekday, hour, value, label: daypartingValueLabel(kind, value) }
}

/** 一句话摘要：竞价系数“提高 N 格、降低 N 格、不变 N 格”；启停“暂停 N 格、启用 N 格”。 */
export function describeGrid(kind: DaypartingKind, grid: readonly number[]): string {
  if (kind === 'ON_OFF') {
    const off = grid.filter(value => value === 0).length
    return `启停：暂停 ${off} 个小时格，启用 ${grid.length - off} 个`
  }
  const up = grid.filter(value => value > 1).length
  const down = grid.filter(value => value < 1).length
  return `竞价系数：提高 ${up} 格，降低 ${down} 格，不变 ${grid.length - up - down} 格`
}

const round = (value: number, digits: number): number => {
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}
const divide = (numerator: number | null, denominator: number | null): number | null => (numerator === null || denominator === null || denominator === 0 ? null : numerator / denominator)

/** 合计与比率；花费、销售额全是空保持空。 */
export function daypartingTotals(clicks: number, spend: number | null, sales: number | null, orders: number): DaypartingTotals {
  return { clicks, spend, sales, orders, acos: divide(spend, sales), cpc: divide(spend, clicks) }
}

export interface SimulationOutcome {
  coveredCells: number
  changedCells: number
  baseline: DaypartingTotals | null
  estimated: DaypartingTotals | null
}

/**
 * 效果模拟：历史格子（星期 × 小时，已按策略时区累计）逐格套用策略。模型参数与口径见 DAYPARTING_SIM_MODEL 与 DAYPARTING_SIM_ASSUMPTIONS。
 * 没有历史格子（cells 为空）时两个合计都是 null，调用方写“没有历史，无法估算”。花费或销售额没给的格子不凭空补值。
 */
export function simulateGrid(cells: readonly AdsHourlyCell[], kind: DaypartingKind, grid: readonly number[]): SimulationOutcome {
  const changedCells = grid.filter(value => value !== 1).length
  if (cells.length === 0) return { coveredCells: 0, changedCells, baseline: null, estimated: null }
  let clicks = 0
  let orders = 0
  let spend: number | null = null
  let sales: number | null = null
  let estClicks = 0
  let estOrders = 0
  let estSpend: number | null = null
  let estSales: number | null = null
  for (const cell of cells) {
    const value = grid[gridIndexOf(cell.weekday, cell.hour)] ?? 1
    const clickFactor = kind === 'ON_OFF' ? (value === 0 ? 0 : 1) : value ** DAYPARTING_SIM_MODEL.clickElasticity
    const cpcFactor = kind === 'ON_OFF' ? 1 : value ** DAYPARTING_SIM_MODEL.cpcPassThrough
    clicks += cell.clicks
    orders += cell.orders
    estClicks += cell.clicks * clickFactor
    estOrders += cell.orders * clickFactor
    if (cell.spend !== null) {
      spend = (spend ?? 0) + cell.spend
      estSpend = (estSpend ?? 0) + cell.spend * clickFactor * cpcFactor
    }
    if (cell.sales !== null) {
      sales = (sales ?? 0) + cell.sales
      estSales = (estSales ?? 0) + cell.sales * clickFactor
    }
  }
  return {
    coveredCells: cells.length,
    changedCells,
    baseline: daypartingTotals(clicks, spend === null ? null : round(spend, 2), sales === null ? null : round(sales, 2), orders),
    estimated: daypartingTotals(round(estClicks, 1), estSpend === null ? null : round(estSpend, 2), estSales === null ? null : round(estSales, 2), round(estOrders, 1)),
  }
}
