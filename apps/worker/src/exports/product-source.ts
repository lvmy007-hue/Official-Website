import { US_MARKETPLACE_ID, productFilterWhere, type ProductFilters } from '@nova/api-contracts'
import type { Prisma } from '@prisma/client'
import type { ExportRow, SourceContext } from './sources'

// 商品主数据导出（P4-07）：筛选与页面完全一致（共用契约里的 productFilterWhere），范围由调用方按发起人当前授权算好的店铺清单给出。
// 只导出商品自身的资料，不含销售、利润与库存数字；负责人导出成名字（已离开企业的成员显示“已离开的成员”）。

const EXPORT_PAGE_SIZE = 2000 // 与 sources.ts 的页大小一致；不从 sources 引入，避免两个文件互相引用
const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined)
const pick = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined => allowed.find(item => item === value)

export function productFiltersOf(filters: Record<string, unknown>): ProductFilters {
  return {
    q: text(filters.q),
    asin: text(filters.asin),
    sku: text(filters.sku),
    parentAsin: text(filters.parentAsin),
    brand: text(filters.brand),
    category: text(filters.category),
    status: text(filters.status),
    fulfillment: pick(filters.fulfillment, ['AFN', 'MFN'] as const),
    ownerId: text(filters.ownerId),
    tag: text(filters.tag),
  }
}

export async function* products({ db, tenantId, filters, storeIds }: SourceContext): AsyncGenerator<ExportRow> {
  const where = {
    tenantId,
    marketplaceId: US_MARKETPLACE_ID,
    ...(storeIds ? { sellerAccountId: { in: storeIds } } : {}),
    ...productFilterWhere(productFiltersOf(filters)),
  } as Prisma.FbaProductWhereInput
  const names = new Map<string, string>()
  let afterId: string | undefined
  for (;;) {
    const rows = await db.fbaProduct.findMany({
      where,
      orderBy: [{ id: 'asc' }],
      ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
      take: EXPORT_PAGE_SIZE,
      select: {
        id: true,
        asin: true,
        sellerSku: true,
        fnsku: true,
        parentAsin: true,
        title: true,
        brand: true,
        categoryPath: true,
        fulfillmentChannel: true,
        listingStatus: true,
        price: true,
        currency: true,
        ownerUserId: true,
        tagIds: true,
        updatedAt: true,
        sellerAccount: { select: { displayName: true } },
      },
    })
    const unknownOwners = [...new Set(rows.flatMap(row => (row.ownerUserId && !names.has(row.ownerUserId) ? [row.ownerUserId] : [])))]
    if (unknownOwners.length > 0) {
      const members = await db.membership.findMany({
        where: { tenantId, userId: { in: unknownOwners } },
        select: { userId: true, user: { select: { displayName: true, email: true } } },
        take: unknownOwners.length,
      })
      for (const member of members) names.set(member.userId, member.user.displayName || member.user.email)
    }
    for (const row of rows) {
      yield {
        storeName: row.sellerAccount.displayName,
        asin: row.asin,
        sellerSku: row.sellerSku,
        fnsku: row.fnsku,
        parentAsin: row.parentAsin,
        title: row.title,
        brand: row.brand,
        category: row.categoryPath,
        fulfillment: row.fulfillmentChannel,
        listingStatus: row.listingStatus,
        price: row.price === null ? null : Number(row.price.toString()),
        currency: row.currency,
        ownerName: row.ownerUserId ? (names.get(row.ownerUserId) ?? '已离开的成员') : null,
        tags: row.tagIds.join('、'),
        updatedAt: row.updatedAt,
      }
    }
    if (rows.length < EXPORT_PAGE_SIZE) return
    afterId = rows[rows.length - 1].id
  }
}
