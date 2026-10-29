import { SS_SPLIT_NOTE, sumKnown, turnoverDaysOf, type SsDimension, type SsMetric, type SsRow } from '@nova/api-contracts'

// 销量统计的行装配（P6-25，纯函数）：把“店铺 × ASIN × 日”的销量与销售额按维度合并成行，每个日期桶一格，最后算合计、可用库存、周转天数。
// 基本单元是 店铺 × ASIN；SKU 维度一个 SKU 一行：只有 ASIN 在该店铺下只有一个 SKU 时，销量才归到这个 SKU，多个 SKU 时这几行留空并写明原因（不平均拆分）。
// 没有记录的日期是 null（页面写“—”），不是 0。

export interface StatRef {
  storeId: string
  storeName: string
  asin: string
  sku: string
  title: string
  imageUrl: string | null
  parentAsin: string | null
  ownerUserId: string | null
}

export interface DailyCell {
  storeId: string
  asin: string
  date: string
  units: number | null
  sales: number | null
}

export interface Draft {
  id: string
  dimension: SsDimension
  key: string
  ref: StatRef
  refs: StatRef[]
  units: Map<string, number | null>
  sales: Map<string, number | null>
  gap: string | null
}

const SEP = '|'
const unitKey = (storeId: string, asin: string) => `${storeId}${SEP}${asin}`
export const skuKey = (storeId: string, sku: string) => `${storeId}${SEP}${sku}`

export const bareRef = (storeId: string, storeName: string, asin: string): StatRef => ({ storeId, storeName, asin, sku: '', title: '', imageUrl: null, parentAsin: null, ownerUserId: null })

function keyOf(dimension: SsDimension, ref: StatRef): string {
  switch (dimension) {
    case 'asin':
      return ref.asin
    case 'parentAsin':
      return ref.parentAsin ?? ref.asin
    case 'sku':
      return ref.sku ? skuKey(ref.storeId, ref.sku) : `${ref.storeId}${SEP}asin:${ref.asin}`
    case 'store':
      return ref.storeId
    case 'owner':
      return ref.ownerUserId ?? ''
  }
}

const add = (map: Map<string, number | null>, bucket: string, value: number | null) => {
  if (value === null) return
  map.set(bucket, (map.get(bucket) ?? 0) + value)
}

export interface FoldInput {
  dimension: SsDimension
  refs: readonly StatRef[]
  stores: ReadonlyMap<string, string>
  daily: readonly DailyCell[]
  bucketOf: (date: string) => string
}

/** 合并成行草稿；没有任何日数据的商品不出行。 */
export function foldSalesStat(input: FoldInput): Draft[] {
  const byUnit = new Map<string, StatRef[]>()
  for (const ref of input.refs) byUnit.set(unitKey(ref.storeId, ref.asin), [...(byUnit.get(unitKey(ref.storeId, ref.asin)) ?? []), ref])
  const drafts = new Map<string, Draft>()
  const draftOf = (ref: StatRef, refs: StatRef[], gap: string | null): Draft => {
    const key = keyOf(input.dimension, ref)
    const held = drafts.get(key)
    if (held) {
      for (const item of refs) if (!held.refs.some(own => own.storeId === item.storeId && own.sku === item.sku && own.asin === item.asin)) held.refs.push(item)
      return held
    }
    const created: Draft = { id: `${input.dimension}${SEP}${key}`, dimension: input.dimension, key, ref, refs: [...refs], units: new Map(), sales: new Map(), gap }
    drafts.set(key, created)
    return created
  }
  for (const cell of input.daily) {
    const unit = unitKey(cell.storeId, cell.asin)
    const found = byUnit.get(unit) ?? []
    const refs = found.length > 0 ? found : [bareRef(cell.storeId, input.stores.get(cell.storeId) ?? '', cell.asin)]
    const bucket = input.bucketOf(cell.date)
    if (input.dimension === 'sku' && refs.length > 1) {
      for (const ref of refs) draftOf(ref, [ref], SS_SPLIT_NOTE)
      continue
    }
    const draft = draftOf(refs[0]!, refs, null)
    add(draft.units, bucket, cell.units)
    add(draft.sales, bucket, cell.sales)
  }
  return [...drafts.values()]
}

export interface StockFigure {
  /** 这个 店铺 × SKU 的可用库存（按业务口径）；口径里某项没有数据时为 null。 */
  available: number | null
}

/** 一行的可用库存：成员 SKU 里有记录的相加；一个都没有记录是 null；有记录但口径缺项（null）的不参与，全部缺项也是 null。 */
export function stockOf(draft: Draft, stock: ReadonlyMap<string, StockFigure>): number | null {
  const values = draft.refs.flatMap(ref => (ref.sku && stock.has(skuKey(ref.storeId, ref.sku)) ? [stock.get(skuKey(ref.storeId, ref.sku))!.available] : []))
  return sumKnown(values)
}

export function rowOf(
  draft: Draft,
  buckets: readonly string[],
  metric: SsMetric,
  stock: ReadonlyMap<string, StockFigure>,
  days: number,
  owners: ReadonlyMap<string, string>,
  storeNames: ReadonlyMap<string, string>,
): SsRow {
  const source = metric === 'units' ? draft.units : draft.sales
  const values = buckets.map(bucket => (source.has(bucket) ? round(source.get(bucket)!) : null))
  const units = sumKnown([...draft.units.values()])
  const available = stockOf(draft, stock)
  const base = describe(draft, owners, storeNames)
  return {
    id: draft.id,
    dimension: draft.dimension,
    ...base,
    values,
    total: sumKnown(values),
    units,
    availableStock: available,
    turnoverDays: turnoverDaysOf(available, units, days),
    gap: draft.gap,
  }
}

const round = (value: number) => Math.round(value * 100) / 100
const distinct = (values: Iterable<string>) => [...new Set(values)]

function describe(draft: Draft, owners: ReadonlyMap<string, string>, storeNames: ReadonlyMap<string, string>) {
  const { ref } = draft
  const asins = distinct(draft.refs.map(item => item.asin))
  const stores = distinct(draft.refs.map(item => item.storeName || storeNames.get(item.storeId) || ''))
  const storeName = stores.length === 1 ? stores[0]! : `${stores.length} 个店铺`
  const empty = { subtitle: null, imageUrl: null, asin: null, sku: null, storeName }
  switch (draft.dimension) {
    case 'asin':
      return {
        ...empty,
        title: ref.title || ref.asin,
        subtitle: draft.refs.length > 1 ? `${draft.refs.length} 个 SKU` : null,
        imageUrl: ref.imageUrl,
        asin: ref.asin,
        sku: draft.refs.length === 1 && ref.sku ? ref.sku : null,
      }
    case 'parentAsin': {
      const own = draft.refs.find(item => item.asin === draft.key) ?? ref
      return { ...empty, title: own.title || draft.key, subtitle: `${asins.length} 个子体`, imageUrl: own.imageUrl, asin: draft.key }
    }
    case 'sku':
      return {
        ...empty,
        title: ref.title || ref.sku || ref.asin,
        subtitle: [ref.asin, ref.sku].filter(Boolean).join(' · ') || null,
        imageUrl: ref.imageUrl,
        asin: ref.asin || null,
        sku: ref.sku || null,
        storeName: ref.storeName,
      }
    case 'store':
      return { ...empty, title: ref.storeName || storeNames.get(draft.key) || draft.key, subtitle: `${asins.length} 个 ASIN` }
    case 'owner':
      return { ...empty, title: draft.key ? (owners.get(draft.key) ?? '已离开的成员') : '未设置负责人', subtitle: `${asins.length} 个 ASIN` }
  }
}

type Sortable = { title: string; total: number | null; availableStock: number | null; turnoverDays: number | null }
const FIELD = { total: 'total', availableStock: 'availableStock', turnoverDays: 'turnoverDays' } as const

/** 排序：空值永远排在最后（不论升降序）；同值按标题与编号稳定排。 */
export function sortStatRows<T extends Sortable & { id: string }>(rows: readonly T[], field: 'total' | 'title' | 'availableStock' | 'turnoverDays', dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    if (field === 'title') return sign * a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    const x = a[FIELD[field]]
    const y = b[FIELD[field]]
    if (x === null && y === null) return a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
    if (x === null) return 1
    if (y === null) return -1
    return sign * (x - y) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id)
  })
}

/** 汇总行：全部符合筛选的行按列合计；周转与库存的合计只加有值的行。 */
export function summaryOf(rows: readonly SsRow[], bucketCount: number) {
  const values = Array.from({ length: bucketCount }, (_, index) => sumKnown(rows.map(row => row.values[index] ?? null)))
  return { values, total: sumKnown(values), availableStock: sumKnown(rows.map(row => row.availableStock)) }
}
