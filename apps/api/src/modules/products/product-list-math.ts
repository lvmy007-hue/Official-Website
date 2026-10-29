import { productMargin, productMarginState, type ProductListRow, type ProductSort } from '@nova/api-contracts'

// 商品列表的纯函数（P4-07）：把商品记录与各来源的汇总装成行、排序。不碰数据库，单测直接喂数据。
// 空值是 null，不是 0：没有记录的列显示“尚无记录”，排序时永远排在最后。

export interface ProductRecord {
  id: string
  sellerAccountId: string
  storeName: string
  asin: string
  sellerSku: string
  fnsku: string | null
  title: string
  imageUrl: string | null
  parentAsin: string | null
  brand: string | null
  categoryPath: string | null
  fulfillmentChannel: string
  listingStatus: string
  price: number | null
  currency: string
  ownerUserId: string | null
  tagIds: string[]
  version: number
  updatedAt: Date
  catalogStatus: string | null
}

export interface SalesFact {
  amount: number
  units: number
}

/** 一个店铺 × SKU 在统计窗口里的利润日表合计；profit 为 null 表示至少有一天缺成本。 */
export interface MarginFact {
  rows: number
  revenue: number
  profit: number | null
}

export const salesKey = (storeId: string, asin: string) => `${storeId}|${asin}`
export const skuKey = (storeId: string, sku: string) => `${storeId}\u001f${sku}`

export interface BuildInput {
  records: readonly ProductRecord[]
  sales: ReadonlyMap<string, SalesFact>
  /** 店铺 × SKU 的可售数量；没有 inventory.read 时为 null。 */
  stock: ReadonlyMap<string, number> | null
  /** 店铺 × SKU 的利润合计；没有 profit.read 与 field.profit 时为 null（行上不出现利润字段）。 */
  margins: ReadonlyMap<string, MarginFact> | null
  names: ReadonlyMap<string, string>
  watched: ReadonlySet<string>
  formerLabel: string
}

const catalogStateOf = (status: string | null): ProductListRow['catalogState'] => (status === 'FOUND' ? 'OK' : status === 'NOT_FOUND' ? 'NOT_FOUND' : 'NOT_SYNCED')

export function buildProductRows(input: BuildInput): ProductListRow[] {
  const perAsin = new Map<string, number>()
  for (const record of input.records) {
    const key = salesKey(record.sellerAccountId, record.asin)
    perAsin.set(key, (perAsin.get(key) ?? 0) + 1)
  }
  return input.records.map(record => {
    const sale = input.sales.get(salesKey(record.sellerAccountId, record.asin))
    const row: ProductListRow = {
      id: record.id,
      sellerAccountId: record.sellerAccountId,
      storeName: record.storeName,
      asin: record.asin,
      sku: record.sellerSku,
      fnsku: record.fnsku,
      title: record.title,
      imageUrl: record.imageUrl,
      parentAsin: record.parentAsin,
      brand: record.brand,
      categoryPath: record.categoryPath,
      fulfillmentChannel: record.fulfillmentChannel,
      listingStatus: record.listingStatus,
      price: record.price,
      currency: record.currency,
      sellable: input.stock?.get(skuKey(record.sellerAccountId, record.sellerSku)) ?? null,
      sales30: sale ? sale.amount : null,
      units30: sale ? sale.units : null,
      salesShared: (perAsin.get(salesKey(record.sellerAccountId, record.asin)) ?? 0) > 1,
      ownerUserId: record.ownerUserId,
      ownerName: record.ownerUserId ? (input.names.get(record.ownerUserId) ?? input.formerLabel) : null,
      tags: record.tagIds,
      watched: input.watched.has(record.id),
      version: record.version,
      updatedAt: record.updatedAt.toISOString(),
      catalogState: catalogStateOf(record.catalogStatus),
    }
    if (input.margins) {
      const fact = input.margins.get(skuKey(record.sellerAccountId, record.sellerSku)) ?? { rows: 0, revenue: 0, profit: null }
      const state = productMarginState(fact)
      row.marginState = state
      row.margin30 = state === 'OK' ? productMargin(fact.profit, fact.revenue) : null
    }
    return row
  })
}

const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

const NUMERIC: Partial<Record<ProductSort, (row: ProductListRow) => number | null>> = {
  price: row => row.price,
  sales30: row => row.sales30,
  units30: row => row.units30,
  margin30: row => row.margin30 ?? null,
  sellable: row => row.sellable,
}

/** 排序：数值列没有值的永远在最后（不管升降序）；并列按编号稳定。排序别用 localeCompare，下划线与字母的先后随区域设置变。 */
export function compareProductRows(a: ProductListRow, b: ProductListRow, field: ProductSort, dir: 'asc' | 'desc'): number {
  const sign = dir === 'asc' ? 1 : -1
  const numeric = NUMERIC[field]
  if (numeric) {
    const left = numeric(a)
    const right = numeric(b)
    if (left === null || right === null) return left === right ? compareText(a.id, b.id) : left === null ? 1 : -1
    return left === right ? compareText(a.id, b.id) : (left - right) * sign
  }
  const text = (row: ProductListRow) => (field === 'asin' ? row.asin : field === 'sku' ? row.sku : row.updatedAt)
  const order = compareText(text(a), text(b))
  return order === 0 ? compareText(a.id, b.id) : order * sign
}

/** 标签去重后的候选清单（筛选下拉用）：不分大小写去重，按码点排序。 */
export function distinctTags(rows: ReadonlyArray<{ tagIds: readonly string[] }>, limit: number): string[] {
  const seen = new Map<string, string>()
  for (const row of rows) for (const tag of row.tagIds) if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag)
  return [...seen.values()].sort(compareText).slice(0, limit)
}
