import type { BrCommon, BrGranularity } from './business-reports.js'
import { weekStartOf, type WeekStartDay } from './business-rules.js'
import type { InventoryFreshness } from './inventory.js'

// 销量统计、跨仓总览、进销存报表（P6-25，16 章第 2.2、4 节）：常量、标签、响应类型与纯函数（没有 zod，请求校验在 stock-reports-query.ts）。
// 口径约定：
//   - 没有来源的值是 null（页面写“—”或“尚未接入”），不是 0；合计只加有值的格；
//   - 销量统计来自 ASIN 日汇总（美元）；周起始日读业务口径（P6-31）；周与月的桶以起始日命名，范围边缘的桶只含范围内的天；
//   - 周转天数 = 可用库存 ÷（范围内销量 ÷ 范围天数）；范围内没有销量时没有周转天数；
//   - 进销存的货值 = 数量 × 当月期末日生效的成本版本的单件总成本（商品 + 头程 + 关税 + 其他，空项不计），一行用同一个单价，所以货值也满足“期初 + 变动 = 期末”；
//   - 跨仓总览的“在途”和“已到仓”互斥：头程在途只含已出库、没有送达、没有关联亚马逊货件的运单（关联了的由 FBA 入库中计入）。

export const SALES_STAT_PERMISSION = 'analytics.read'
export const INVENTORY_REPORT_PERMISSION = 'inventory.read'
export const WAREHOUSE_PERMISSION = 'warehouse.read'

export const SS_DIMENSIONS = ['asin', 'parentAsin', 'sku', 'store', 'owner'] as const
export type SsDimension = (typeof SS_DIMENSIONS)[number]
export const SS_DIMENSION_LABEL: Readonly<Record<SsDimension, string>> = { asin: 'ASIN', parentAsin: '父 ASIN', sku: 'SKU', store: '店铺', owner: '负责人' }
export const SS_METRICS = ['units', 'sales'] as const
export type SsMetric = (typeof SS_METRICS)[number]
export const SS_METRIC_LABEL: Readonly<Record<SsMetric, string>> = { units: '销量（件）', sales: '销售额（美元）' }
export const SS_SORT_FIELDS = ['total', 'title', 'availableStock', 'turnoverDays'] as const
export type SsSortField = (typeof SS_SORT_FIELDS)[number]
export const SS_DEFAULT_SORT = { field: 'total', dir: 'desc' } as const
/** 一次最多列出多少个日期（周、月）列：超出要求缩小范围，不静默截断。 */
export const SS_BUCKET_MAX = 120
export const SS_PAGE_SIZE_MAX = 200
/** 内存聚合的单元上限（Prisma 单次读取 20000，多读一行判断截断）。 */
export const STOCK_REPORT_LIMIT = 19_999
export const SS_TOTAL_KEY = 'total'
export const SS_DATE_PREFIX = 'd:'
export const ssColumnId = (bucket: string) => `${SS_DATE_PREFIX}${bucket}`
export const SS_SPLIT_NOTE = '该 ASIN 在店铺下有多个 SKU，销量按 ASIN 统计，不拆分到 SKU'

export interface SsRow {
  id: string
  dimension: SsDimension
  title: string
  subtitle: string | null
  imageUrl: string | null
  asin: string | null
  sku: string | null
  storeName: string | null
  /** 与 `buckets` 按位置对齐；没有记录的日期是 null。 */
  values: Array<number | null>
  total: number | null
  /** 范围内销量（周转天数的分子，不随“销量 / 销售额”切换）。 */
  units: number | null
  availableStock: number | null
  turnoverDays: number | null
  /** 这一行没有数值的原因（例如 SKU 维度下的多 SKU ASIN）。 */
  gap: string | null
}

export interface SsResponse extends BrCommon {
  dimension: SsDimension
  metric: SsMetric
  granularity: BrGranularity
  /** 每个日期列的起始日，升序。 */
  buckets: string[]
  weekStart: WeekStartDay
  /** 可用库存的口径文字（P6-31），列头问号里显示。 */
  inventoryBasis: string
  rows: SsRow[]
  /** 符合筛选的全部行按日期列合计（不是当前页之和）。 */
  summary: { values: Array<number | null>; total: number | null; availableStock: number | null }
  total: number
  page: number
  pageSize: number
}

// ---- 分桶 ----

const DAY_MS = 86_400_000
const dayMs = (date: string) => Date.parse(`${date}T00:00:00Z`)
const dateOf = (value: number) => new Date(value).toISOString().slice(0, 10)

/** 日期落在哪个桶：日是自己，周是周起始日，月是当月 1 日。 */
export function bucketStartOf(date: string, granularity: BrGranularity, weekDay: WeekStartDay): string {
  if (granularity === 'MONTH') return `${date.slice(0, 7)}-01`
  if (granularity === 'WEEK') return weekStartOf(date, weekDay)
  return date
}

/** 范围内的全部桶（升序，含首尾）。 */
export function bucketsBetween(from: string, to: string, granularity: BrGranularity, weekDay: WeekStartDay): string[] {
  if (to < from) return []
  const result: string[] = []
  for (let cursor = dayMs(from); cursor <= dayMs(to); cursor += DAY_MS) {
    const key = bucketStartOf(dateOf(cursor), granularity, weekDay)
    if (result[result.length - 1] !== key) result.push(key)
  }
  return result
}

export const daysInRange = (from: string, to: string) => Math.round((dayMs(to) - dayMs(from)) / DAY_MS) + 1
const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits

/** 周转天数：可用库存 ÷ 日均销量；没有库存数据、没有销量（或销量为 0）时没有值。 */
export function turnoverDaysOf(available: number | null, units: number | null, days: number): number | null {
  if (available === null || units === null || units <= 0 || days <= 0) return null
  return round(available / (units / days), 1)
}

/** 只加有值的格；全是空返回 null。 */
export function sumKnown(values: ReadonlyArray<number | null | undefined>): number | null {
  let total: number | null = null
  for (const value of values) if (value !== null && value !== undefined) total = (total ?? 0) + value
  return total === null ? null : round(total, 6)
}

// ---- 跨仓总览 ----

export const AW_KINDS = ['FBA', 'AWD', 'DOMESTIC', 'FIRST_MILE'] as const
export type AwKind = (typeof AW_KINDS)[number]
export const AW_KIND_LABEL: Readonly<Record<AwKind, string>> = { FBA: 'FBA', AWD: 'AWD', DOMESTIC: '国内仓', FIRST_MILE: '头程在途' }
export const AW_SORT_FIELDS = ['sku', 'total', 'onHand', 'inTransit'] as const
export type AwSortField = (typeof AW_SORT_FIELDS)[number]
export const AW_DEFAULT_SORT = { field: 'total', dir: 'desc' } as const

/** 一个数量列：已到仓（onHand 一部分）、在途（inTransit 一部分）、仅展示（不计入合计）。 */
export type AwPart = 'ON_HAND' | 'IN_TRANSIT' | 'INFO'
export const AW_COLUMNS = [
  { key: 'fbaSellable', label: 'FBA 可售', part: 'ON_HAND', source: '表 FbaInventoryRecord 的 fulfillableQuantity（库存接口，按店铺与 SKU）', need: 'inventory' },
  { key: 'fbaReserved', label: 'FBA 预留', part: 'ON_HAND', source: '表 FbaInventoryRecord 的 reservedQuantity', need: 'inventory' },
  { key: 'fbaUnsellable', label: 'FBA 不可售', part: 'ON_HAND', source: '表 FbaInventoryRecord 的 unfulfillableQuantity', need: 'inventory' },
  { key: 'awdOnhand', label: 'AWD 在库', part: 'ON_HAND', source: '表 AwdInventory 的 onhandQty（每个店铺与 SKU 取最近一天的快照）', need: 'inventory' },
  { key: 'domesticOnhand', label: '国内仓在库', part: 'ON_HAND', source: '表 InventoryMovement 的 quantity 按国内仓与 SKU 汇总（流水就是账）；需要仓库读取权限', need: 'warehouse' },
  { key: 'fbaInbound', label: 'FBA 入库中', part: 'IN_TRANSIT', source: '表 FbaInventoryRecord 的 inboundWorkingQuantity + inboundShippedQuantity + inboundReceivingQuantity', need: 'inventory' },
  { key: 'awdInbound', label: 'AWD 入库中', part: 'IN_TRANSIT', source: '表 AwdInventory 的 inboundToAwdQty', need: 'inventory' },
  {
    key: 'firstMileTransit',
    label: '头程在途',
    part: 'IN_TRANSIT',
    source: '表 FirstMileShipmentItem 的 quantity：运单已出库（outboundAt）、未送达（ataDelivery 为空）、未关联亚马逊货件',
    need: 'warehouse',
  },
  { key: 'awdToFba', label: 'AWD 发往 FBA', part: 'INFO', source: '表 AwdInventory 的 outboundToFbaInTransit；与 FBA 入库中是同一批货，只展示不计入合计', need: 'inventory' },
] as const
export type AwColumnKey = (typeof AW_COLUMNS)[number]['key']
export type AwCells = Record<AwColumnKey, number | null>

export interface AwChild {
  id: string
  kind: AwKind
  /** 仓库或店铺名称；头程在途显示运单号。 */
  label: string
  cells: AwCells
  total: number | null
}

export interface AwRow {
  id: string
  sku: string
  title: string | null
  cells: AwCells
  /** 已到仓合计 = 各“已到仓”列相加；在途合计同理；合计 = 已到仓 + 在途（不含“仅展示”列）。 */
  onHand: number | null
  inTransit: number | null
  total: number | null
  unitCost: number | null
  stockValue: number | null
  children: AwChild[]
}

export interface AwResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: AwRow[]
  total: number
  page: number
  pageSize: number
  /** 合计行：全部符合筛选的 SKU 相加，不是当前页。 */
  summary: { cells: AwCells; onHand: number | null; inTransit: number | null; total: number | null; stockValue: number | null }
  restrictions: Array<{ metrics: AwColumnKey[]; reason: string }>
  costRestricted: boolean
  truncated: boolean
  freshness: InventoryFreshness
}

const AW_PARTS: Readonly<Record<AwColumnKey, AwPart>> = Object.fromEntries(AW_COLUMNS.map(column => [column.key, column.part])) as Record<AwColumnKey, AwPart>
export const emptyAwCells = (): AwCells => Object.fromEntries(AW_COLUMNS.map(column => [column.key, null])) as AwCells

/** 已到仓、在途、合计：某一类全是空就是 null；合计只在两类至少有一类有值时给出。 */
export function awTotalsOf(cells: AwCells): { onHand: number | null; inTransit: number | null; total: number | null } {
  const part = (kind: AwPart) => sumKnown(AW_COLUMNS.filter(column => AW_PARTS[column.key] === kind).map(column => cells[column.key]))
  const onHand = part('ON_HAND')
  const inTransit = part('IN_TRANSIT')
  return { onHand, inTransit, total: sumKnown([onHand, inTransit]) }
}

export function addAwCells(base: AwCells, extra: Partial<AwCells>): AwCells {
  const next = { ...base }
  for (const column of AW_COLUMNS) {
    const value = extra[column.key]
    if (value !== null && value !== undefined) next[column.key] = (next[column.key] ?? 0) + value
  }
  return next
}

// ---- 成本版本取价 ----

export interface CostPoint {
  sku: string
  versionNo: number
  effectiveFrom: string
  currency: string
  unitProductCost: number | null
  unitFirstMileCost: number | null
  unitDutyCost: number | null
  unitOtherCost: number | null
}

/** 单件总成本：四项相加，空项不计；四项全空是 null（没有成本，不是 0）。 */
export function landedUnitCost(version: Pick<CostPoint, 'unitProductCost' | 'unitFirstMileCost' | 'unitDutyCost' | 'unitOtherCost'>): number | null {
  return sumKnown([version.unitProductCost, version.unitFirstMileCost, version.unitDutyCost, version.unitOtherCost])
}

/** 某天生效的成本版本：生效日不晚于这一天的最新一版（同一天取版本号大的）。 */
export function costVersionAt<T extends Pick<CostPoint, 'effectiveFrom' | 'versionNo'>>(versions: readonly T[], date: string): T | null {
  let best: T | null = null
  for (const version of versions) {
    if (version.effectiveFrom > date) continue
    if (!best || version.effectiveFrom > best.effectiveFrom || (version.effectiveFrom === best.effectiveFrom && version.versionNo > best.versionNo)) best = version
  }
  return best
}

// ---- 进销存 ----

export const MV_FLOW_KEYS = ['receipts', 'shipments', 'returns', 'transfers', 'adjustments', 'other'] as const
export type MvFlowKey = (typeof MV_FLOW_KEYS)[number]
export const MV_FLOW_LABEL: Readonly<Record<MvFlowKey, string>> = {
  receipts: '接收',
  shipments: '发货',
  returns: '退货',
  transfers: '调拨',
  adjustments: '丢失、损坏、处置、找回',
  other: '其他与未识别',
}
export const MV_SORT_FIELDS = ['month', 'sku', 'endingQty', 'turnoverDays', 'difference'] as const
export type MvSortField = (typeof MV_SORT_FIELDS)[number]
export const MV_DEFAULT_SORT = { field: 'month', dir: 'desc' } as const

export interface MvFlowsInput {
  receipts: number
  customerShipments: number
  customerReturns: number
  vendorReturns: number
  transfers: number
  found: number
  lost: number
  damaged: number
  disposed: number
  other: number
  unknownEvents: number
}

/** 台账的 11 类变动归并成报表的 6 类（发货本身带负号）。 */
export function movementFlowsOf(flows: MvFlowsInput): Record<MvFlowKey, number> {
  return {
    receipts: flows.receipts,
    shipments: flows.customerShipments,
    returns: flows.customerReturns + flows.vendorReturns,
    transfers: flows.transfers,
    adjustments: flows.found + flows.lost + flows.damaged + flows.disposed,
    other: flows.other + flows.unknownEvents,
  }
}

/** 存销比：期末数量 ÷ 当月发货件数；没有发货没有值。周转天数：期末数量 ÷ 日均发货件数。 */
export function sellThroughOf(endingQty: number, shippedUnits: number): number | null {
  return shippedUnits > 0 ? round(endingQty / shippedUnits, 2) : null
}
export function movementTurnoverOf(endingQty: number, shippedUnits: number, days: number): number | null {
  return turnoverDaysOf(endingQty, shippedUnits, days)
}

export interface MvValues {
  opening: number | null
  flows: Record<MvFlowKey, number | null>
  ending: number | null
  /** 货值层面的差额：期末货值 − （期初货值 + 全部变动货值）；数量不平衡时不为 0。 */
  difference: number | null
}

export interface MvRow {
  id: string
  sku: string
  asin: string
  month: string
  periodStart: string
  periodEnd: string
  storeCount: number
  openingQty: number
  flows: Record<MvFlowKey, number>
  endingQty: number
  /** 期初 + 全部变动；与报告给的期末不等就是不平衡。 */
  expectedEnding: number
  difference: number
  balanced: boolean
  shippedUnits: number
  turnoverDays: number | null
  sellThrough: number | null
  /** 货值：没有成本字段权限、没有成本版本或成本不是美元时为 null，并在 `valueNote` 里写原因。 */
  values: MvValues | null
  unitCost: number | null
  costVersionNo: number | null
  costEffectiveFrom: string | null
  valueNote: string | null
}

export interface MvTotals {
  openingQty: number
  flows: Record<MvFlowKey, number>
  endingQty: number
  difference: number
  openingValue: number | null
  endingValue: number | null
}

export interface MvResponse {
  state: 'OK' | 'NO_DATA'
  note: string | null
  items: MvRow[]
  total: number
  page: number
  pageSize: number
  from: string
  to: string
  totals: MvTotals
  unbalancedCount: number
  costRestricted: boolean
  truncated: boolean
  freshness: InventoryFreshness
}
