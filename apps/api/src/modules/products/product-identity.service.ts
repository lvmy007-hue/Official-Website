import { Injectable } from '@nestjs/common'
import {
  aggregateFreshness,
  CATALOG_FRESHNESS_KEY,
  FRESHNESS_SOURCES,
  INVENTORY_RISK_LABEL,
  JOB_FRESHNESS_SOURCES,
  US_MARKETPLACE_ID,
  type Asin360CatalogState,
  type Asin360IdentityResponse,
  type Asin360Ranks,
  type Asin360Stock,
  type Asin360Variants,
  type InventoryFreshness,
  type InventoryDetailResponse,
} from '@nova/api-contracts'
import { hasPermission } from '@nova/authz'
import { RequestWithContext } from '../../platform/http'
import { memberNames } from '../../platform/people'
import { PrismaService } from '../../platform/prisma.service'
import { InventoryDetailService } from '../inventory'
import { ProductAccessService, type ProductAccess, type ResolvedProduct } from './product-access.service'

const FRESHNESS_SPECS = [
  ...FRESHNESS_SOURCES.filter(source => source.key === 'orders.api' || source.key === 'inventory.api'),
  ...JOB_FRESHNESS_SOURCES.filter(source => source.key === CATALOG_FRESHNESS_KEY),
]
const SIBLING_TAKE = 50
const RANK_TAKE = 20
const num = (value: { toString(): string } | null | undefined) => (value === null || value === undefined ? null : Number(value.toString()))
const dateText = (value: Date) => value.toISOString().slice(0, 10)

/** 商品目录核对状态：没同步过、目录里没有、已找到。 */
export function catalogStateOf(product: Pick<ResolvedProduct, 'catalogStatus' | 'catalogSyncedAt'>): Asin360CatalogState {
  const syncedAt = product.catalogSyncedAt?.toISOString() ?? null
  if (product.catalogStatus === 'FOUND') return { state: 'OK', syncedAt, note: null }
  if (product.catalogStatus === 'NOT_FOUND') return { state: 'NOT_FOUND', syncedAt, note: '亚马逊商品目录里查不到这个 ASIN（可能已被合并或下架），图片、类目、排名等信息暂缺，待核实' }
  return { state: 'NOT_SYNCED', syncedAt: null, note: '商品目录尚未同步，图片、品牌、类目、父体与销售排名同步后显示（每日一次）' }
}

/** 库存摘要：口径与库存健康、库存详情完全一致（直接取库存详情的概览）。 */
export function stockOf(detail: InventoryDetailResponse): Asin360Stock {
  const { row } = detail
  const assessment = row.assessment
  return {
    state: 'OK',
    note: assessment.state === 'OK' ? null : assessment.noDemand ? '近期没有销量，无法计算可售天数' : '尚未配置库存规则或没有足够的销量记录，暂时无法计算可售天数',
    inventoryId: row.id,
    sellable: row.quantity.sellable,
    inboundCounted: row.quantity.inboundCounted,
    daysOfCover: assessment.state === 'OK' ? assessment.daysOfCover : null,
    stockoutDate: assessment.state === 'OK' ? assessment.stockoutDate : null,
    noDemand: assessment.noDemand,
    riskLabel: assessment.state === 'OK' && assessment.risk ? INVENTORY_RISK_LABEL[assessment.risk] : null,
  }
}

@Injectable()
export class ProductIdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
    private readonly inventory: InventoryDetailService,
  ) {}

  async identity(req: RequestWithContext, id: string): Promise<Asin360IdentityResponse> {
    const access = await this.access.resolve(req, id)
    const { product } = access
    const base = { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId }
    const [siblings, variants, ranks, stock, freshness, names] = await Promise.all([
      this.prisma.fbaProduct.findMany({
        where: { ...base, marketplaceId: US_MARKETPLACE_ID, asin: product.asin },
        select: { id: true, sellerSku: true, fnsku: true, listingStatus: true },
        orderBy: [{ sellerSku: 'asc' }, { id: 'asc' }],
        take: SIBLING_TAKE,
      }),
      this.variants(product),
      this.ranks(product),
      this.stock(req, access),
      this.freshness(product, new Date()),
      memberNames(this.prisma, product.tenantId, [product.ownerUserId]),
    ])
    return {
      product: {
        id: product.id,
        sellerAccountId: product.sellerAccountId,
        storeName: product.sellerAccount.displayName,
        asin: product.asin,
        sku: product.sellerSku,
        fnsku: product.fnsku,
        title: product.title,
        brand: product.brand,
        productType: product.productType,
        listingStatus: product.listingStatus,
        fulfillmentChannel: product.fulfillmentChannel,
        price: num(product.price),
        currency: product.currency,
        imageUrl: product.imageUrl,
        categoryPath: product.categoryPath,
        parentAsin: product.parentAsin,
        ownerUserId: product.ownerUserId,
        ownerName: product.ownerUserId ? (names.get(product.ownerUserId) ?? '已离开的成员') : null,
        tags: product.tagIds,
      },
      catalog: catalogStateOf(product),
      siblings: siblings.map(item => ({ id: item.id, sku: item.sellerSku, fnsku: item.fnsku, listingStatus: item.listingStatus })),
      variants,
      ranks,
      stock,
      freshness,
    }
  }

  private async variants(product: ResolvedProduct): Promise<Asin360Variants> {
    const where = { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId }
    const [childCount, siblingCount, relation] = await Promise.all([
      this.prisma.productVariantRelation.count({ where: { ...where, parentAsin: product.asin } }),
      product.parentAsin ? this.prisma.productVariantRelation.count({ where: { ...where, parentAsin: product.parentAsin, childAsin: { not: product.asin } } }) : Promise.resolve(null),
      this.prisma.productVariantRelation.findFirst({
        where: { ...where, OR: [{ childAsin: product.asin }, { parentAsin: product.asin }] },
        select: { variationTheme: true },
        orderBy: { updatedAt: 'desc' },
      }),
    ])
    return { parentAsin: product.parentAsin, childCount: childCount > 0 ? childCount : null, isParent: childCount > 0, siblingCount, variationTheme: relation?.variationTheme ?? null }
  }

  private async ranks(product: ResolvedProduct): Promise<Asin360Ranks> {
    const where = { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, asin: product.asin }
    const latest = await this.prisma.salesRankSnapshot.findFirst({ where, select: { snapshotDate: true }, orderBy: { snapshotDate: 'desc' } })
    if (!latest) {
      const note = product.catalogStatus === 'FOUND' ? '商品目录没有给出这个商品的销售排名（新品或类目不排名时常见）' : '商品目录尚未同步，销售排名同步后显示'
      return { state: 'NO_DATA', note, snapshotDate: null, items: [] }
    }
    const rows = await this.prisma.salesRankSnapshot.findMany({
      where: { ...where, snapshotDate: latest.snapshotDate },
      select: { classificationId: true, classificationName: true, rank: true },
      orderBy: [{ rank: 'asc' }, { classificationId: 'asc' }],
      take: RANK_TAKE,
    })
    return { state: 'OK', note: null, snapshotDate: dateText(latest.snapshotDate), items: rows.map(row => ({ classificationId: row.classificationId, name: row.classificationName, rank: row.rank })) }
  }

  private async stock(req: RequestWithContext, access: ProductAccess): Promise<Asin360Stock> {
    const { context, product } = access
    const empty = { inventoryId: null, sellable: null, inboundCounted: null, daysOfCover: null, stockoutDate: null, noDemand: false, riskLabel: null }
    if (!hasPermission(context.permissions, 'inventory.read')) return { state: 'RESTRICTED', note: '需要“库存”读取权限才能查看可售数量与可售天数', ...empty }
    const detail = await this.inventoryDetail(req, product)
    if (!detail) return { state: 'NO_DATA', note: '这个商品还没有库存记录（库存同步后显示）', ...empty }
    return stockOf(detail)
  }

  /** 按店铺与 SKU 找到库存记录并取库存详情的概览；没有库存读权限或没有记录返回 null。 */
  async inventoryDetail(req: RequestWithContext, product: ResolvedProduct): Promise<InventoryDetailResponse | null> {
    const record = await this.prisma.fbaInventoryRecord.findFirst({
      where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, marketplaceId: US_MARKETPLACE_ID, sellerSku: product.sellerSku },
      select: { id: true },
    })
    return record ? this.inventory.identity(req, record.id) : null
  }

  private async freshness(product: ResolvedProduct, now: Date): Promise<InventoryFreshness> {
    const rows = await this.prisma.dataFreshness.findMany({
      where: { tenantId: product.tenantId, sellerAccountId: product.sellerAccountId, sourceKey: { in: FRESHNESS_SPECS.map(spec => spec.key) } },
      select: { sellerAccountId: true, sourceKey: true, lastAttemptAt: true, lastSuccessAt: true, dataThrough: true, status: true, lastErrorCode: true },
      take: 50,
    })
    const view = aggregateFreshness(rows, [product.sellerAccountId], now, FRESHNESS_SPECS)
    const done = view.sources.filter(source => source.lastSuccessAt)
    const latest = done.reduce<Date | null>((max, source) => (source.lastSuccessAt && (!max || source.lastSuccessAt > max) ? source.lastSuccessAt : max), null)
    return { lastSuccessAt: latest?.toISOString() ?? null, sources: done.map(source => source.label), qualityIssues: view.summary.attention }
  }
}
