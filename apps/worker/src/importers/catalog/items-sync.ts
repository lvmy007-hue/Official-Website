import { CATALOG_BATCH_SIZE, isBadIdentifiers, type CatalogApi } from '../../connectors/catalog-api'
import type { ImportContext } from '../../types'
import { parseCatalogItems, type ParsedCatalogItem } from './items-parse'
import { attributeChangeEvents, parentChangeEvents } from './variation-events'

// 商品目录同步器（importers.md I-09，P2a-14）：对店铺里的每个 ASIN 取目录条目，写回 FbaProduct 的图片、品牌、类目、父体与商品类型，
// 同步父子变体关系与销售排名快照。每日全量。
// 规则：
//   - 目录没返回的 ASIN 标记 catalogStatus = NOT_FOUND（待核实），不清空已有数据；返回了但某个字段缺失，保留原值（不用空值覆盖）；
//   - 已有值与目录值不同（且两边都有值）时，记一条“亚马逊侧变更”事件到商品的变更时间线（首次填入不算变更）；
//   - 同一父体下目录已不再列出的子体，在该父体自己被取回的前提下从关系表里删除（整体对账）；父体没被取回时只增不删；
//   - 整批被拒（400）时退化为逐个请求，只有单个 ASIN 仍被拒才标记待核实；其余错误（缺角色、限流、5xx）原样抛出，交给任务运行时分类重试。

export interface CatalogScope {
  tenantId: string
  sellerAccountId: string
}
export interface CatalogOptions {
  /** 企业数据口径的“今天”（UTC 零点的日期）：销售排名快照的日期。 */
  today: Date
  /** 本次同步的时间（事件发生时间与核对时间）；测试注入，缺省取当前时间。 */
  now?: Date
}
export type CatalogResult =
  | { notApplicable: true; reason: 'NO_PRODUCTS'; imported: 0 }
  | { notApplicable: false; imported: number; products: number; found: number; notFound: number; relations: number; ranks: number; changes: number; skipped: number }

const MARKETPLACE = 'ATVPDKIKX0DER'
const PRODUCT_TAKE = 20_000
const ymd = (date: Date) => date.toISOString().slice(0, 10)

/** 会产生“亚马逊侧变更”事件的字段与中文名（主图只记“已更换”，不把地址写进标题）。 */
const WATCHED = [
  { field: 'brand', label: '品牌' },
  { field: 'categoryPath', label: '类目' },
  { field: 'parentAsin', label: '父体' },
  { field: 'productType', label: '商品类型' },
  { field: 'imageUrl', label: '主图' },
] as const
type WatchedField = (typeof WATCHED)[number]['field']

interface ProductRow {
  id: string
  asin: string
  brand: string | null
  imageUrl: string | null
  categoryPath: string | null
  parentAsin: string | null
  productType: string | null
  variantAttributes: unknown
  catalogSyncedAt: Date | null
}

export function changeTitle(field: WatchedField, before: string, after: string): string {
  if (field === 'imageUrl') return '主图已更换'
  const label = WATCHED.find(item => item.field === field)!.label
  return `${label}由「${before}」变为「${after}」`
}

async function fetchBatch(api: CatalogApi, asins: string[]): Promise<{ items: ParsedCatalogItem[]; skipped: number }> {
  try {
    return parseCatalogItems(await api.getItems(asins))
  } catch (error) {
    if (!isBadIdentifiers(error) || asins.length === 1) {
      if (isBadIdentifiers(error)) return { items: [], skipped: 0 } // 单个 ASIN 被拒：当作目录里没有
      throw error
    }
    const items: ParsedCatalogItem[] = []
    let skipped = 0
    for (const asin of asins) {
      const one = await fetchBatch(api, [asin])
      items.push(...one.items)
      skipped += one.skipped
    }
    return { items, skipped }
  }
}

export async function syncCatalogItems(ctx: ImportContext, api: CatalogApi, scope: CatalogScope, options: CatalogOptions): Promise<CatalogResult> {
  const { prisma } = ctx
  const now = options.now ?? new Date()
  const products: ProductRow[] = await prisma.fbaProduct.findMany({
    where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE },
    select: { id: true, asin: true, brand: true, imageUrl: true, categoryPath: true, parentAsin: true, productType: true, variantAttributes: true, catalogSyncedAt: true },
    orderBy: { id: 'asc' },
    take: PRODUCT_TAKE,
  })
  const byAsin = new Map<string, ProductRow[]>()
  for (const product of products) if (product.asin) byAsin.set(product.asin, [...(byAsin.get(product.asin) ?? []), product])
  const asins = [...byAsin.keys()]
  if (asins.length === 0) return { notApplicable: true, reason: 'NO_PRODUCTS', imported: 0 }

  const where = { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, marketplaceId: MARKETPLACE }
  let found = 0
  let notFound = 0
  let relations = 0
  let ranks = 0
  let changes = 0
  let skipped = 0
  // 父体 → 它自己被取回时目录列出的全部子体（用于对账删除）；以及只从子体一侧看到的关系（只增不删）
  const ownChildren = new Map<string, Set<string>>()

  const upsertRelation = async (parentAsin: string, childAsin: string, variationTheme: string | null) => {
    if (parentAsin === childAsin) return
    const data = { variationTheme, sourceUpdatedAt: now }
    await prisma.productVariantRelation.upsert({
      where: { tenantId_sellerAccountId_parentAsin_childAsin: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, parentAsin, childAsin } },
      create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, parentAsin, childAsin, ...data },
      update: data,
    })
    relations += 1
  }

  for (let start = 0; start < asins.length; start += CATALOG_BATCH_SIZE) {
    const batch = asins.slice(start, start + CATALOG_BATCH_SIZE)
    const page = await fetchBatch(api, batch)
    skipped += page.skipped
    const returned = new Set<string>()
    for (const item of page.items) {
      const rows = byAsin.get(item.asin)
      if (!rows) continue // 目录返回了我们没请求的 ASIN（例如合并后的新编号）：不处理
      returned.add(item.asin)
      found += 1
      const incoming: Record<WatchedField, string | null> = { brand: item.brand, categoryPath: item.categoryPath, parentAsin: item.parentAsin, productType: item.productType, imageUrl: item.imageUrl }
      for (const row of rows) {
        for (const { field } of WATCHED) {
          const before = row[field]
          const after = incoming[field]
          if (before && after && before !== after) {
            await prisma.entityEvent.create({
              data: {
                tenantId: scope.tenantId,
                sellerAccountId: scope.sellerAccountId,
                entityType: 'ASIN',
                entityId: row.id,
                kind: 'listing.change',
                occurredAt: now,
                title: changeTitle(field, before, after),
                detailJson: { field, before, after, observedBy: 'catalog-sync' },
                actorKind: 'AMAZON',
                sourceRef: `catalog:${field}:${ymd(now)}`,
              },
            })
            changes += 1
          }
        }
      }
      const day = ymd(now)
      const events = [
        ...parentChangeEvents({ childAsin: item.asin, before: rows[0]!.parentAsin, after: item.parentAsin, previouslySynced: rows[0]!.catalogSyncedAt !== null, day }),
        ...rows.flatMap(row =>
          attributeChangeEvents({
            productId: row.id,
            childAsin: item.asin,
            parentAsin: item.parentAsin,
            before: row.variantAttributes,
            after: item.variantValues,
            previouslySynced: row.catalogSyncedAt !== null,
            day,
          }),
        ),
      ]
      for (const event of events) {
        await prisma.entityEvent.create({
          data: {
            tenantId: scope.tenantId,
            sellerAccountId: scope.sellerAccountId,
            entityType: event.entityType,
            entityId: event.entityId,
            kind: event.kind,
            occurredAt: now,
            title: event.title,
            detailJson: event.detailJson,
            actorKind: 'AMAZON',
            sourceRef: event.sourceRef,
          },
        })
        changes += 1
      }
      await prisma.fbaProduct.updateMany({
        where: { ...where, asin: item.asin },
        data: {
          ...(Object.keys(item.variantValues).length > 0 ? { variantAttributes: item.variantValues } : {}),
          ...(item.brand ? { brand: item.brand } : {}),
          ...(item.imageUrl ? { imageUrl: item.imageUrl } : {}),
          ...(item.categoryPath ? { categoryPath: item.categoryPath } : {}),
          ...(item.productType ? { productType: item.productType } : {}),
          parentAsin: item.parentAsin, // 目录明确没有父体就清空（它可能已脱离变体组）
          catalogStatus: 'FOUND',
          catalogSyncedAt: now,
        },
      })
      for (const child of item.childAsins) await upsertRelation(item.asin, child, item.variationTheme)
      if (item.childAsins.length > 0) ownChildren.set(item.asin, new Set(item.childAsins))
      if (item.parentAsin) await upsertRelation(item.parentAsin, item.asin, item.variationTheme)
      for (const rank of item.ranks) {
        const data = { classificationName: rank.name, rank: rank.rank }
        await prisma.salesRankSnapshot.upsert({
          where: {
            tenantId_sellerAccountId_asin_classificationId_snapshotDate: {
              tenantId: scope.tenantId,
              sellerAccountId: scope.sellerAccountId,
              asin: item.asin,
              classificationId: rank.classificationId,
              snapshotDate: options.today,
            },
          },
          create: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, asin: item.asin, classificationId: rank.classificationId, snapshotDate: options.today, ...data },
          update: data,
        })
        ranks += 1
      }
    }
    const missing = batch.filter(asin => !returned.has(asin))
    if (missing.length > 0) {
      notFound += missing.length
      await prisma.fbaProduct.updateMany({ where: { ...where, asin: { in: missing } }, data: { catalogStatus: 'NOT_FOUND', catalogSyncedAt: now } })
    }
  }

  // 对账：父体自己被取回时，目录已不再列出的子体从关系表里删掉
  for (const [parentAsin, children] of ownChildren) {
    await prisma.productVariantRelation.deleteMany({
      where: { tenantId: scope.tenantId, sellerAccountId: scope.sellerAccountId, parentAsin, childAsin: { notIn: [...children] } },
    })
  }

  if (skipped > 0) ctx.logger.warn({ ...scope, skipped }, 'catalog items skipped: missing asin')
  return { notApplicable: false, imported: found + relations + ranks, products: products.length, found, notFound, relations, ranks, changes, skipped }
}
