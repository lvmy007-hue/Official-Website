import type { PrismaClient } from '@prisma/client'

// 商品与口碑预警评估器的公共小件（P4-15）：商品记录与店铺名称的读取、对象登记方式、文字截断。
// 商品预警的对象多是 店铺 × SKU 或 店铺 × ASIN；有商品记录的链到商品全景（ASIN）或定价详情（SKU），没有的按 店铺|键 登记，不编造链接。

export const DAY_MS = 86_400_000
export const READ_LIMIT = 20_000
const PRODUCT_LIMIT = 5000

export const keyOf = (storeId: string, value: string) => `${storeId}|${value}`
export const utcDay = (now: Date) => Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
export const dayText = (value: Date | number) => new Date(value).toISOString().slice(0, 10)
export const clip = (text: string | null | undefined, max: number) => {
  const value = (text ?? '').trim()
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}
type Dec = { toString(): string } | null | undefined
export const num = (value: Dec): number | null => (value === null || value === undefined ? null : Number(value.toString()))

export interface ProductInfo {
  id: string
  sellerAccountId: string
  sellerSku: string
  asin: string
  title: string
}

export interface ProductLookup {
  /** 键：店铺|SKU */
  bySku: Map<string, ProductInfo>
  /** 键：店铺|ASIN（同一店铺同一 ASIN 有多个 SKU 时取最近更新的一个） */
  byAsin: Map<string, ProductInfo>
  storeName: Map<string, string>
}

/** 读取命中对象对应的商品记录与店铺名称；没有对应记录的键在 Map 里没有，不是错误。 */
export async function loadProductLookup(db: PrismaClient, tenantId: string, targets: { storeIds: readonly string[]; skus?: readonly string[]; asins?: readonly string[] }): Promise<ProductLookup> {
  const storeIds = [...new Set(targets.storeIds)]
  const skus = [...new Set(targets.skus ?? [])]
  const asins = [...new Set(targets.asins ?? [])]
  const lookup: ProductLookup = { bySku: new Map(), byAsin: new Map(), storeName: new Map() }
  if (storeIds.length === 0) return lookup
  const either = [...(skus.length > 0 ? [{ sellerSku: { in: skus } }] : []), ...(asins.length > 0 ? [{ asin: { in: asins } }] : [])]
  const [products, stores] = await Promise.all([
    either.length === 0
      ? Promise.resolve([] as ProductInfo[])
      : db.fbaProduct.findMany({
          where: { tenantId, sellerAccountId: { in: storeIds }, OR: either },
          select: { id: true, sellerAccountId: true, sellerSku: true, asin: true, title: true },
          orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
          take: PRODUCT_LIMIT,
        }),
    db.sellerAccount.findMany({ where: { tenantId, id: { in: storeIds } }, select: { id: true, displayName: true }, take: 1000 }),
  ])
  for (const product of products) {
    if (!lookup.bySku.has(keyOf(product.sellerAccountId, product.sellerSku))) lookup.bySku.set(keyOf(product.sellerAccountId, product.sellerSku), product)
    if (product.asin && !lookup.byAsin.has(keyOf(product.sellerAccountId, product.asin))) lookup.byAsin.set(keyOf(product.sellerAccountId, product.asin), product)
  }
  for (const store of stores) lookup.storeName.set(store.id, store.displayName)
  return lookup
}

/** 规则范围里的 SKU 换成这些 SKU 对应的 ASIN（ASIN 级数据用）；没有设置 SKU 范围返回 null。 */
export async function asinsOfSkus(db: PrismaClient, tenantId: string, stores: readonly string[] | null, skus: readonly string[] | null): Promise<string[] | null> {
  if (!skus) return null
  const products = await db.fbaProduct.findMany({
    where: { tenantId, ...(stores ? { sellerAccountId: { in: [...stores] } } : {}), sellerSku: { in: [...skus] } },
    select: { asin: true },
    take: PRODUCT_LIMIT,
  })
  return [...new Set(products.map(product => product.asin).filter(asin => asin !== ''))]
}

/** 每个键只留最近的一行（输入需按时间倒序）。 */
export function firstBy<T>(rows: readonly T[], keyFn: (row: T) => string): Map<string, T> {
  const map = new Map<string, T>()
  for (const row of rows) if (!map.has(keyFn(row))) map.set(keyFn(row), row)
  return map
}
