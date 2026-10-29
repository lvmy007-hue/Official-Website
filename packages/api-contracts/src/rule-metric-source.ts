import { requiredQueries, type ConditionGroups, type ConditionQuery, type ConditionWindow, type RuleAgg } from './rule-conditions.js'
import type { ConditionValues } from './rule-conditions-eval.js'

// 规则指标的统一取数层（P6-16）：把“指标 + 统计窗口 + 聚合方式”变成一个数。worker 评估自定义指标规则与 API 的试算接口共用这一份，所以两边结论一致。
// 本文件不碰数据库：行由调用方通过 `RuleMetricReader` 读出（店铺日汇总、销售与流量日表、库存日快照），这里只做窗口换算与聚合，**不引入 zod**。
//
// 口径（与 P6-07 的约定一致）：
//   - 以“店铺 × 日”为单位判断：每个店铺各取各的数，不跨店铺合并；
//   - 窗口以企业时区的“今天”为基准（today 由调用方传入）：`days` 是截至昨日的最近 N 个完整日；缺数据的日子跳过，整个窗口一天都没有就是缺数据（null），不当成 0；
//   - 比率类指标（ACoS、退款率等）先按日算出比率，再对窗口内有值的日子求平均、最新、最小或最大（所以“平均”是日均比率，不是窗口合计后的比率）；
//   - 先支持下面登记的 13 个核心指标（销售、广告、库存、利润、售后五个域），其余可用于规则的指标暂时取不到数（缺数据），保存规则时会被拒绝。

export interface StoreDayRow {
  date: string
  orders: number
  units: number
  sales: number
  adsSpend: number | null
  adsSales: number | null
  profit: number | null
  sessions: number | null
}
export interface TrafficDayRow {
  date: string
  unitsOrdered: number | null
  unitsRefunded: number | null
}
export interface InventoryDayRow {
  date: string
  sellable: number
}

export interface StoreMetricData {
  store: ReadonlyMap<string, StoreDayRow>
  traffic: ReadonlyMap<string, TrafficDayRow>
  inventory: ReadonlyMap<string, InventoryDayRow>
}

type Source = 'store' | 'traffic' | 'inventory'
const num = (value: number | null | undefined) => (typeof value === 'number' && Number.isFinite(value) ? value : null)

interface SupportedMetric {
  source: Source
  daily: (row: never) => number | null
}
const fromStore = (daily: (row: StoreDayRow) => number | null): SupportedMetric => ({ source: 'store', daily: daily as SupportedMetric['daily'] })

const SUPPORTED: Readonly<Record<string, SupportedMetric>> = {
  'M-001': fromStore(row => row.sales),
  'M-002': fromStore(row => row.units),
  'M-004': fromStore(row => row.orders),
  'M-120': fromStore(row => num(row.sessions)),
  'M-005': fromStore(row => num(row.profit)),
  'M-007': fromStore(row => num(row.adsSpend)),
  'M-500': fromStore(row => num(row.adsSales)),
  'M-501': fromStore(row => (row.adsSpend !== null && row.adsSales !== null && row.adsSales > 0 ? (row.adsSpend / row.adsSales) * 100 : null)),
  'M-502': fromStore(row => (row.adsSpend !== null && row.adsSales !== null && row.adsSpend > 0 ? row.adsSales / row.adsSpend : null)),
  'M-008': fromStore(row => (row.adsSpend !== null && row.sales > 0 ? (row.adsSpend / row.sales) * 100 : null)),
  'M-125': { source: 'traffic', daily: ((row: TrafficDayRow) => num(row.unitsRefunded)) as SupportedMetric['daily'] },
  'M-126': {
    source: 'traffic',
    daily: ((row: TrafficDayRow) =>
      row.unitsOrdered !== null && row.unitsOrdered > 0 && row.unitsRefunded !== null ? (row.unitsRefunded / row.unitsOrdered) * 100 : null) as SupportedMetric['daily'],
  },
  'M-200': { source: 'inventory', daily: ((row: InventoryDayRow) => num(row.sellable)) as SupportedMetric['daily'] },
}

/** 已接入取数层的指标编号（其余“可用于规则”的指标暂时取不到数）。 */
export const RULE_SUPPORTED_METRICS: readonly string[] = Object.keys(SUPPORTED)
export const isRuleMetricSupported = (metric: string) => Object.prototype.hasOwnProperty.call(SUPPORTED, metric)

/** 条件里还没有接入取数层的指标（去重）。 */
export function unsupportedRuleMetrics(value: ConditionGroups): string[] {
  const found = new Set<string>()
  for (const group of value.groups ?? [])
    for (const condition of group?.conditions ?? []) if (condition && typeof condition.metric === 'string' && !isRuleMetricSupported(condition.metric)) found.add(condition.metric)
  return [...found]
}

// ---------- 日期（YYYY-MM-DD 字符串，按 UTC 做日历运算，不受运行机器时区影响） ----------

const DAY_MS = 86_400_000
const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const fromMs = (ms: number) => new Date(ms).toISOString().slice(0, 10)
export const addDays = (date: string, days: number) => fromMs(toMs(date) + days * DAY_MS)

/** 企业时区下此刻的日期（时区无效时回退到美国太平洋时区）。 */
export function localDateOf(now: Date, zone: string | null | undefined): string {
  for (const candidate of [zone, 'America/Los_Angeles']) {
    if (!candidate) continue
    try {
      return new Intl.DateTimeFormat('en-CA', { timeZone: candidate, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
    } catch {
      // 时区无效，换下一个
    }
  }
  return now.toISOString().slice(0, 10)
}

export interface DateRange {
  start: string
  end: string
}

function shiftYear(date: string, years: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year + years, month - 1, day))
  // 2 月 29 日挪到没有闰日的年份会滚到 3 月 1 日，退回到 2 月最后一天
  if (target.getUTCMonth() !== month - 1) return fromMs(Date.UTC(year + years, month, 0))
  return fromMs(target.getTime())
}

function mainRange(window: ConditionWindow, today: string): DateRange | null {
  switch (window.kind) {
    case 'today':
      return { start: today, end: today }
    case 'yesterday':
      return { start: addDays(today, -1), end: addDays(today, -1) }
    case 'days':
      return typeof window.days === 'number' && window.days >= 1 ? { start: addDays(today, -window.days), end: addDays(today, -1) } : null
    case 'month_to_date': {
      const first = `${today.slice(0, 7)}-01`
      return first === today ? null : { start: first, end: addDays(today, -1) }
    }
    case 'last_month': {
      const first = `${today.slice(0, 7)}-01`
      const end = addDays(first, -1)
      return { start: `${end.slice(0, 7)}-01`, end }
    }
    default:
      return null
  }
}

/** 窗口换算成具体日期区间；对比窗口是相对窗口时要带上基准窗口 `base`；算不出区间（如 1 日的“本月累计”）返回 null。 */
export function resolveRange(window: ConditionWindow, base: ConditionWindow | undefined, today: string): DateRange | null {
  if (window.kind === 'previous_period' || window.kind === 'same_period_last_year') {
    const main = base ? mainRange(base, today) : null
    if (!main) return null
    if (window.kind === 'same_period_last_year') return { start: shiftYear(main.start, -1), end: shiftYear(main.end, -1) }
    const length = (toMs(main.end) - toMs(main.start)) / DAY_MS + 1
    return { start: addDays(main.start, -length), end: addDays(main.start, -1) }
  }
  return mainRange(window, today)
}

function aggregate(values: readonly number[], agg: RuleAgg): number | null {
  if (values.length === 0) return null
  switch (agg) {
    case 'sum':
      return values.reduce((sum, value) => sum + value, 0)
    case 'avg':
      return values.reduce((sum, value) => sum + value, 0) / values.length
    case 'min':
      return Math.min(...values)
    case 'max':
      return Math.max(...values)
    case 'last':
      return values[values.length - 1]
  }
}

const rowsOf = (data: StoreMetricData, source: Source): ReadonlyMap<string, unknown> => data[source]

/** 一个店铺的取值函数，交给 `evaluateConditions` 用；不支持的指标、窗口里一天都没有数据都返回 null。 */
export function conditionValuesOf(data: StoreMetricData, today: string): ConditionValues {
  return (query: ConditionQuery) => {
    const metric = SUPPORTED[query.metric]
    if (!metric) return null
    const range = resolveRange(query.window, query.base, today)
    if (!range) return null
    const rows = rowsOf(data, metric.source)
    const values: number[] = []
    for (let date = range.start; date <= range.end; date = addDays(date, 1)) {
      const row = rows.get(date)
      if (!row) continue
      const value = metric.daily(row as never)
      if (value !== null) values.push(value)
    }
    return aggregate(values, query.agg)
  }
}

// ---------- 批量读数 ----------

export interface RuleMetricReader {
  storeDays(tenantId: string, storeIds: readonly string[], from: string, to: string): Promise<Array<StoreDayRow & { storeId: string }>>
  trafficDays(tenantId: string, storeIds: readonly string[], from: string, to: string): Promise<Array<TrafficDayRow & { storeId: string }>>
  inventoryDays(tenantId: string, storeIds: readonly string[], from: string, to: string): Promise<Array<InventoryDayRow & { storeId: string }>>
}

/** 一批店铺在若干个“今天”下，这份条件需要读的日期范围与数据来源（一次读全，不要一个店铺一次）。 */
export function dataPlan(groups: ConditionGroups, todays: readonly string[]): { from: string; to: string; sources: Set<Source> } | null {
  const sources = new Set<Source>()
  let from: string | null = null
  let to: string | null = null
  for (const query of requiredQueries(groups)) {
    const metric = SUPPORTED[query.metric]
    if (!metric) continue
    sources.add(metric.source)
    for (const today of todays) {
      const range = resolveRange(query.window, query.base, today)
      if (!range) continue
      if (from === null || range.start < from) from = range.start
      if (to === null || range.end > to) to = range.end
    }
  }
  return from && to ? { from, to, sources } : null
}

/** 每次数据库查询预期读的行数上限（低于租户库单次查询 2 万行的硬上限，留出库存分来源的余量）。 */
export const RULE_READ_ROWS_PER_QUERY = 6000

/** 读出每个店铺的日数据；条件里没有可取数的指标时返回空表（每个店铺都取不到数）。 */
export async function loadStoreMetricData(
  reader: RuleMetricReader,
  tenantId: string,
  storeIds: readonly string[],
  groups: ConditionGroups,
  todays: readonly string[],
): Promise<Map<string, StoreMetricData>> {
  const result = new Map<string, { store: Map<string, StoreDayRow>; traffic: Map<string, TrafficDayRow>; inventory: Map<string, InventoryDayRow> }>()
  for (const id of storeIds) result.set(id, { store: new Map(), traffic: new Map(), inventory: new Map() })
  const plan = dataPlan(groups, todays)
  if (!plan || storeIds.length === 0) return result
  // 数据库单次查询最多读 2 万行：按“店铺数 × 天数”分批读（库存按来源分组，最多按 3 倍留余量），批与批之间顺序执行
  const span = Math.max(1, Math.round((Date.parse(`${plan.to}T00:00:00Z`) - Date.parse(`${plan.from}T00:00:00Z`)) / 86_400_000) + 1)
  const chunkSize = Math.max(1, Math.floor(RULE_READ_ROWS_PER_QUERY / span))
  const store: Array<StoreDayRow & { storeId: string }> = []
  const traffic: Array<TrafficDayRow & { storeId: string }> = []
  const inventory: Array<InventoryDayRow & { storeId: string }> = []
  for (let index = 0; index < storeIds.length; index += chunkSize) {
    const ids = storeIds.slice(index, index + chunkSize)
    const [s, t, i] = await Promise.all([
      plan.sources.has('store') ? reader.storeDays(tenantId, ids, plan.from, plan.to) : [],
      plan.sources.has('traffic') ? reader.trafficDays(tenantId, ids, plan.from, plan.to) : [],
      plan.sources.has('inventory') ? reader.inventoryDays(tenantId, ids, plan.from, plan.to) : [],
    ])
    store.push(...s)
    traffic.push(...t)
    inventory.push(...i)
  }
  for (const row of store) result.get(row.storeId)?.store.set(row.date, row)
  for (const row of traffic) result.get(row.storeId)?.traffic.set(row.date, row)
  for (const row of inventory) result.get(row.storeId)?.inventory.set(row.date, row)
  return result
}
