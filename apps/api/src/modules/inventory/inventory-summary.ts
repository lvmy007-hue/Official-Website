import {
  AGE_BUCKETS_COARSE,
  AGE_BUCKETS_FINE,
  POLICY_NOT_CONFIGURED_NOTE,
  type InventoryCard,
  type InventoryListQuery,
  type InventoryRow,
  type InventorySummaryResponse,
  type InventoryTab,
} from '@nova/api-contracts'
import { riskRank } from './inventory-rules'

// 库存健康的页签筛选、排序与顶部汇总（纯函数）。口径：
// - 低库存 = 风险等级为高或中，或亚马逊低库存水平费有风险；冗余 = 风险等级为冗余；
// - 没有配置规则时不判定风险，低库存、冗余数量显示“尚未配置规则”，不显示 0；
// - 数量类汇总只累加有记录的 SKU；没有来源数据的汇总显示“尚无记录”，不显示 0。

export function inTab(row: InventoryRow, tab: InventoryTab): boolean {
  switch (tab) {
    case 'all':
      return true
    case 'low':
      return row.assessment.risk === 'HIGH' || row.assessment.risk === 'MEDIUM' || row.fees.lowFeeAtRisk === true
    case 'excess':
      return row.assessment.risk === 'EXCESS'
    case 'aging':
      return row.age.atRisk === true
    case 'stranded':
      return Boolean(row.status.strandedReason) || (row.quantity.strandedQty ?? 0) > 0
    case 'unsellable':
      return row.quantity.unsellable > 0 || row.quantity.researching > 0
    case 'inbound':
      return row.quantity.inboundTotal > 0
  }
}

export function matchesText(row: InventoryRow, q: string | undefined): boolean {
  if (!q) return true
  const needle = q.toLowerCase()
  return [row.sku, row.asin, row.fnsku, row.title, row.brand].some(value => value?.toLowerCase().includes(needle))
}

/** 批量搜索（P6-04）：SKU、ASIN、FNSKU 任一项精确等于其中一个词（不区分大小写）；没有词不过滤。 */
export function matchesTerms(row: InventoryRow, terms: ReadonlySet<string>): boolean {
  if (terms.size === 0) return true
  return [row.sku, row.asin, row.fnsku].some(value => value != null && terms.has(value.toLowerCase()))
}

type Sortable = number | string | null
const accessor = (field: InventoryListQuery['sort']['field']): ((row: InventoryRow) => Sortable) => {
  switch (field) {
    case 'sellerSku':
      return row => row.sku
    case 'asin':
      return row => row.asin
    case 'sellable':
      return row => row.quantity.sellable
    case 'inbound':
      return row => row.quantity.inboundTotal
    case 'unsellable':
      return row => row.quantity.unsellable
    case 'daysOfCover':
      // 没有销量的行（无穷大覆盖）排在最后
      return row => row.assessment.daysOfCover
    case 'units30':
      return row => row.demand.units30
    case 'storageFee':
      return row => row.fees.nextMonthStorage
    case 'ageSurcharge':
      return row => row.age.surchargeEstimate
    default:
      return row => riskRank(row.assessment.risk)
  }
}

/** 排序：空值永远排在最后；风险按“高、中、正常、冗余、未判定”，同级再按可售天数与 SKU。 */
export function sortRows(rows: InventoryRow[], sort: InventoryListQuery['sort']): InventoryRow[] {
  const get = accessor(sort.field)
  const sign = sort.dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const x = get(a)
    const y = get(b)
    if (x === null && y === null) return a.sku.localeCompare(b.sku)
    if (x === null) return 1
    if (y === null) return -1
    const diff = typeof x === 'string' || typeof y === 'string' ? String(x).localeCompare(String(y)) : x - y
    if (diff !== 0) return diff * sign
    const cover = (a.assessment.daysOfCover ?? Infinity) - (b.assessment.daysOfCover ?? Infinity)
    return cover !== 0 && Number.isFinite(cover) ? cover : a.sku.localeCompare(b.sku)
  })
}

const card = (state: InventoryCard['state'], value: number | null, note: string | null = null): InventoryCard => ({ state, value, note })
const NO_RECORD = '范围内尚无库存记录'
const NO_PLANNING = '尚无亚马逊库存规划报告记录'

const COVER_BINS: Array<{ key: string; label: string; test: (days: number) => boolean }> = [
  { key: 'd0', label: '不足 7 天', test: days => days < 7 },
  { key: 'd7', label: '7-14 天', test: days => days >= 7 && days < 15 },
  { key: 'd15', label: '15-30 天', test: days => days >= 15 && days < 31 },
  { key: 'd31', label: '31-60 天', test: days => days >= 31 && days < 61 },
  { key: 'd61', label: '61-90 天', test: days => days >= 61 && days < 91 },
  { key: 'd91', label: '91-180 天', test: days => days >= 91 && days < 181 },
  { key: 'd181', label: '181 天以上', test: days => days >= 181 },
]

export interface SummaryContext {
  policyVersion: number | null
  truncated: boolean
  stores: Map<string, string>
  feeMonths: InventorySummaryResponse['charts']['feeTrend']['months']
}

export function buildSummary(rows: InventoryRow[], ctx: SummaryContext): Omit<InventorySummaryResponse, 'freshness'> {
  const hasPolicy = ctx.policyVersion !== null
  const sum = (pick: (row: InventoryRow) => number | null) => rows.reduce((total, row) => total + (pick(row) ?? 0), 0)
  const known = (pick: (row: InventoryRow) => number | null) => rows.filter(row => pick(row) !== null)
  const undecided = rows.filter(row => hasPolicy && row.assessment.state === 'NO_DATA').length
  const undecidedNote = undecided > 0 ? `${undecided} 个 SKU 没有销量记录，未判定` : null
  const count = (test: (row: InventoryRow) => boolean) => card('OK', rows.filter(test).length, undecidedNote)

  const storage = known(row => row.fees.nextMonthStorage)
  const surcharge = known(row => row.age.surchargeEstimate)
  const lowFeeKnown = rows.filter(row => row.fees.lowFeeAtRisk !== null)

  const cards: InventorySummaryResponse['cards'] = {
    sellableTotal: rows.length
      ? card(
          'OK',
          sum(row => row.quantity.sellable),
        )
      : card('NO_DATA', null, NO_RECORD),
    inboundTotal: rows.length
      ? card(
          'OK',
          sum(row => row.quantity.inboundTotal),
        )
      : card('NO_DATA', null, NO_RECORD),
    unsellableTotal: rows.length
      ? card(
          'OK',
          sum(row => row.quantity.unsellable),
        )
      : card('NO_DATA', null, NO_RECORD),
    lowSkuCount: !hasPolicy ? card('NOT_CONNECTED', null, POLICY_NOT_CONFIGURED_NOTE) : count(row => row.assessment.risk === 'HIGH' || row.assessment.risk === 'MEDIUM'),
    excessSkuCount: !hasPolicy ? card('NOT_CONNECTED', null, POLICY_NOT_CONFIGURED_NOTE) : count(row => row.assessment.risk === 'EXCESS'),
    nextMonthStorageFee: storage.length
      ? card('OK', Math.round(sum(row => row.fees.nextMonthStorage) * 100) / 100, `${storage.length}/${rows.length} 个 SKU 有预估`)
      : card('NO_DATA', null, NO_PLANNING),
    ageSurchargeEstimate: surcharge.length
      ? card('OK', Math.round(sum(row => row.age.surchargeEstimate) * 100) / 100, `${surcharge.length}/${rows.length} 个 SKU 有预估`)
      : card('NO_DATA', null, '尚无库龄快照记录'),
    lowFeeRiskSkuCount: lowFeeKnown.length
      ? card('OK', lowFeeKnown.filter(row => row.fees.lowFeeAtRisk === true).length, `${lowFeeKnown.length}/${rows.length} 个 SKU 有亚马逊低库存水平费字段`)
      : card('NO_DATA', null, NO_PLANNING),
  }

  const byStore = new Map<string, InventorySummaryResponse['charts']['structure'][number]>()
  for (const row of rows) {
    const item = byStore.get(row.sellerAccountId) ?? {
      storeId: row.sellerAccountId,
      storeName: ctx.stores.get(row.sellerAccountId) ?? row.storeName,
      sellable: 0,
      reserved: 0,
      inbound: 0,
      unsellable: 0,
      researching: 0,
    }
    item.sellable += row.quantity.sellable
    item.reserved += row.quantity.reserved
    item.inbound += row.quantity.inboundTotal
    item.unsellable += row.quantity.unsellable
    item.researching += row.quantity.researching
    byStore.set(row.sellerAccountId, item)
  }

  const fine = rows.some(row => row.age.granularity === 'FINE')
  const defs = fine ? AGE_BUCKETS_FINE : AGE_BUCKETS_COARSE
  const withAge = rows.filter(row => row.age.granularity !== null)
  const ageDistribution = {
    granularity: withAge.length === 0 ? null : fine ? ('FINE' as const) : ('COARSE' as const),
    buckets:
      withAge.length === 0
        ? []
        : defs.map(def => ({ key: def.key, label: def.label, qty: withAge.reduce((total, row) => total + (row.age.buckets.find(bucket => bucket.key === def.key)?.qty ?? 0), 0) })),
  }

  const cover = [
    ...COVER_BINS.map(bin => ({ key: bin.key, label: bin.label, count: rows.filter(row => row.assessment.daysOfCover !== null && bin.test(row.assessment.daysOfCover)).length })),
    { key: 'noDemand', label: '近期无销量', count: rows.filter(row => row.assessment.noDemand).length },
    { key: 'unknown', label: '未判定', count: rows.filter(row => row.assessment.daysOfCover === null && !row.assessment.noDemand).length },
  ]

  return {
    policyState: hasPolicy ? 'OK' : 'NOT_CONNECTED',
    policyNote: hasPolicy ? null : POLICY_NOT_CONFIGURED_NOTE,
    policyVersion: ctx.policyVersion,
    skuCount: rows.length,
    truncated: ctx.truncated,
    cards,
    charts: {
      structure: [...byStore.values()],
      ageDistribution,
      coverDistribution: cover,
      feeTrend: { currency: 'USD', months: ctx.feeMonths, projectedNextMonth: storage.length ? Math.round(sum(row => row.fees.nextMonthStorage) * 100) / 100 : null },
    },
  }
}
