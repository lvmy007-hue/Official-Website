import type { ForecastPoint, InventoryDemand, SnapshotValue, StructurePoint } from '@nova/api-contracts'
import { plusDays } from './inventory-rules'

// 库存详情里几个页签的纯计算：库存结构趋势、历史快照字段、日销预测序列、台账单据类型。

/** 同一天有多个来源时的优先级：接口（实时）> 未抑制库存报告 > 全部库存报告 > 亚马逊物流库存报告。来源之间不相加。 */
export const STRUCTURE_SOURCE_PRIORITY = ['API', 'MYI_UNSUPPRESSED', 'MYI_ALL', 'AFN'] as const

export interface DailyRow {
  snapshotDate: Date
  source: string
  sellable: number | null
  inbound: number | null
  reserved: number | null
  unsellable: number | null
  researching: number | null
}

const hasQuantity = (row: DailyRow) => [row.sellable, row.inbound, row.reserved, row.unsellable, row.researching].some(value => value !== null)
const dateOf = (date: Date) => date.toISOString().slice(0, 10)

/** 把某一天的各来源行合成一个结构点：取优先级最高且有数量的来源整行；预留数量缺失时用预留库存报告补。 */
export function pickStructure(rows: readonly DailyRow[]): Omit<StructurePoint, 'date'> | null {
  const chosen = STRUCTURE_SOURCE_PRIORITY.map(source => rows.find(row => row.source === source && hasQuantity(row))).find(Boolean)
  if (!chosen) return null
  const reservedRow = rows.find(row => row.source === 'RESERVED' && row.reserved !== null)
  return {
    source: chosen.source,
    sellable: chosen.sellable,
    inbound: chosen.inbound,
    reserved: chosen.reserved ?? reservedRow?.reserved ?? null,
    unsellable: chosen.unsellable,
    researching: chosen.researching,
  }
}

export function structurePoints(rows: readonly DailyRow[]): StructurePoint[] {
  const byDate = new Map<string, DailyRow[]>()
  for (const row of rows) byDate.set(dateOf(row.snapshotDate), [...(byDate.get(dateOf(row.snapshotDate)) ?? []), row])
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .flatMap(([date, list]) => {
      const point = pickStructure(list)
      return point ? [{ date, ...point }] : []
    })
}

export const SNAPSHOT_LABELS: Record<string, string> = {
  sellable: '可售',
  inbound: '在途',
  reserved: '预留',
  unsellable: '不可售',
  researching: '调查中',
  source: '数量来源',
  unitsShippedT30: '近 30 天销量（亚马逊口径）',
  daysOfSupply: '亚马逊可售天数',
  nextMonthStorage: '预计下月仓储费',
  ageSurcharge: '库龄附加费预估',
  age0to90: '库龄 0-90 天',
  age91to180: '库龄 91-180 天',
  age181to270: '库龄 181-270 天',
  age271to365: '库龄 271-365 天',
  age365plus: '库龄 365 天以上',
}

export interface SnapshotPlanning {
  unitsShippedT30: number | null
  daysOfSupply: { toString(): string } | null
  estimatedStorageCostNextMonth: { toString(): string } | null
}
export interface SnapshotAge {
  age0to90: number | null
  age91to180: number | null
  age181to270: number | null
  age271to365: number | null
  age365plus: number | null
  ageSurchargeEstimate: { toString(): string } | null
}
const dec = (value: { toString(): string } | null | undefined): number | null => (value === null || value === undefined ? null : Number(value.toString()))

/** 某一天的快照字段：数量（结构点）、规划报告关键列、库龄分段；没有的来源整组缺省为 null。 */
export function snapshotValues(daily: readonly DailyRow[], planning: SnapshotPlanning | null, age: SnapshotAge | null): Record<string, SnapshotValue> {
  const point = pickStructure(daily)
  return {
    sellable: point?.sellable ?? null,
    inbound: point?.inbound ?? null,
    reserved: point?.reserved ?? null,
    unsellable: point?.unsellable ?? null,
    researching: point?.researching ?? null,
    source: point?.source ?? null,
    unitsShippedT30: planning?.unitsShippedT30 ?? null,
    daysOfSupply: dec(planning?.daysOfSupply),
    nextMonthStorage: dec(planning?.estimatedStorageCostNextMonth),
    ageSurcharge: dec(age?.ageSurchargeEstimate),
    age0to90: age?.age0to90 ?? null,
    age91to180: age?.age91to180 ?? null,
    age181to270: age?.age181to270 ?? null,
    age271to365: age?.age271to365 ?? null,
    age365plus: age?.age365plus ?? null,
  }
}

/** 日销预测序列：近期日均外推（低、中、高为 7/30/90 天日均的最小、30 天、最大），未来 days 天内逐日相同。 */
export function forecastSeries(demand: InventoryDemand, today: string, days = 30): ForecastPoint[] {
  if (demand.mid === null) return []
  return Array.from({ length: days }, (_, index) => ({ date: plusDays(today, index), low: demand.low, mid: demand.mid, high: demand.high }))
}

/** 台账事件类型对应的单据：发货与退货对应订单，接收对应入仓货件；其余（调整、转仓等）没有单据页。 */
export function ledgerReferenceKind(eventType: string): 'ORDER' | 'INBOUND_SHIPMENT' | null {
  const type = eventType.trim().toLowerCase()
  if (type === 'shipments' || type === 'customerreturns') return 'ORDER'
  if (type === 'receipts') return 'INBOUND_SHIPMENT'
  return null
}
