import { PP_ID_SEP, type PpDimension } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../../platform/prisma.service'
import type { ResolvedScope } from '../auth'
import { keyOf, parseRowId } from './product-performance-dim'
import { catalogWhere, loadCatalog, unitKey, type ProductRef } from './product-performance-load'

// 按行编号取成员商品（P6-22 的迷你趋势与异步列用）：一批行编号一次查询，再按维度的行键分桶。

export interface Members {
  /** 行编号 → 属于这一行的商品记录（行编号格式不对或没有商品的行没有键）。 */
  byRow: Map<string, ProductRef[]>
  /** 单元（店铺|ASIN）→ 它属于的行编号。 */
  rowsByUnit: Map<string, string[]>
  asins: string[]
  storeIds: string[]
  truncated: boolean
}

function clauseOf(dimension: PpDimension, keys: readonly string[]): Prisma.FbaProductWhereInput {
  const named = keys.filter(key => key !== '')
  const withEmpty = keys.includes('')
  const orNull = (field: 'ownerUserId' | 'brand' | 'categoryPath'): Prisma.FbaProductWhereInput => ({
    OR: [...(named.length ? [{ [field]: { in: named } }] : []), ...(withEmpty ? [{ [field]: null }] : [])],
  })
  switch (dimension) {
    case 'asin':
      return { asin: { in: [...keys] } }
    case 'parentAsin':
      return { OR: [{ parentAsin: { in: [...keys] } }, { asin: { in: [...keys] } }] }
    case 'sku':
      return {
        OR: keys.map(key => {
          const at = key.indexOf(PP_ID_SEP)
          return { sellerAccountId: key.slice(0, at), sellerSku: key.slice(at + 1) }
        }),
      }
    case 'store':
      return { sellerAccountId: { in: [...keys] } }
    case 'owner':
      return orNull('ownerUserId')
    case 'brand':
      return orNull('brand')
    case 'category':
      return orNull('categoryPath')
  }
}

export async function loadMembers(prisma: PrismaService, tenantId: string, scope: ResolvedScope, dimension: PpDimension, ids: readonly string[]): Promise<Members> {
  const wanted = new Map<string, string>()
  for (const id of ids) {
    const parsed = parseRowId(id)
    if (parsed && parsed.dimension === dimension && (dimension !== 'sku' || parsed.key.includes(PP_ID_SEP))) wanted.set(parsed.key, id)
  }
  const result: Members = { byRow: new Map(), rowsByUnit: new Map(), asins: [], storeIds: [], truncated: false }
  if (wanted.size === 0) return result
  const { products, truncated } = await loadCatalog(prisma, { AND: [catalogWhere(tenantId, scope), clauseOf(dimension, [...wanted.keys()])] })
  const asins = new Set<string>()
  const stores = new Set<string>()
  for (const ref of products) {
    const key = keyOf(dimension, ref)
    const id = wanted.get(key)
    if (!id) continue
    result.byRow.set(id, [...(result.byRow.get(id) ?? []), ref])
    const unit = unitKey(ref.storeId, ref.asin)
    const rows = result.rowsByUnit.get(unit) ?? []
    if (!rows.includes(id)) result.rowsByUnit.set(unit, [...rows, id])
    asins.add(ref.asin)
    stores.add(ref.storeId)
  }
  return { ...result, asins: [...asins], storeIds: [...stores], truncated }
}
