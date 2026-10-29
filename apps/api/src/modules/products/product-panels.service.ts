import { Injectable } from '@nestjs/common'
import {
  ASIN360_CONTENT_BASIS,
  ASIN360_LISTING_BASIS,
  ASIN360_PENDING_SECTIONS,
  ASIN360_REVIEWS_BASIS,
  type Asin360ContentResponse,
  type Asin360Fact,
  type Asin360ListingResponse,
  type Asin360ReviewsResponse,
} from '@nova/api-contracts'
import { RequestWithContext } from '../../platform/http'
import { PrismaService } from '../../platform/prisma.service'
import { ProductAccessService, type ResolvedProduct } from './product-access.service'
import { catalogStateOf } from './product-identity.service'
import { loadAplus, loadReviews } from './product-panels-more'

const LISTING_LABEL: Record<string, string> = { ACTIVE: '在售', INACTIVE: '不可售', INCOMPLETE: '信息不全' }
const CHANNEL_LABEL: Record<string, string> = { AFN: '亚马逊物流 FBA', FBA: '亚马逊物流 FBA', MFN: '自发货 FBM', FBM: '自发货 FBM' }
const CATALOG_LABEL = { OK: '目录已核对', NOT_FOUND: '目录查无此 ASIN（待核实）', NOT_SYNCED: '目录尚未同步' } as const

const text = (value: string | null | undefined): string | null => (value && value.trim() ? value.trim() : null)

/** 变体属性（{"color":"Red","size":"L"}）拼成“color：Red；size：L”；没有为 null。 */
function variantText(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parts = Object.entries(value as Record<string, unknown>).flatMap(([key, item]) => (typeof item === 'string' && item.trim() ? [`${key}：${item.trim()}`] : []))
  return parts.length > 0 ? parts.join('；') : null
}

// ASIN 360“刊登与问题”“评价”“内容与 A+”页签（05 章 5.2 第 7、8、11 个页签，P4-08）：这三类的数据来源（刊登问题、客户反馈、A+ 内容）都还没有同步器，
// 所以每个页签只给本系统已经有的真实资料（商品目录同步写入的字段），其余区块逐项写明“尚未接入”与负责的工作包，不给分数、不给示例数字。
// 顺序：先校验 products.read 与页签权限，再按成员数据范围找商品（范围外与不存在都是 404）。
@Injectable()
export class ProductPanelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: ProductAccessService,
  ) {}

  async listing(req: RequestWithContext, id: string): Promise<Asin360ListingResponse> {
    const { product } = await this.access.resolve(req, id, 'listing.read')
    return { facts: this.listingFacts(product), pending: [...ASIN360_PENDING_SECTIONS.listing], basis: ASIN360_LISTING_BASIS }
  }

  async reviews(req: RequestWithContext, id: string): Promise<Asin360ReviewsResponse> {
    const { product } = await this.access.resolve(req, id, 'reviews.read')
    return { ...(await loadReviews(this.prisma, product)), pending: [...ASIN360_PENDING_SECTIONS.reviews], basis: ASIN360_REVIEWS_BASIS }
  }

  async content(req: RequestWithContext, id: string): Promise<Asin360ContentResponse> {
    const { product } = await this.access.resolve(req, id, 'aplus.read')
    const facts: Asin360Fact[] = [
      { label: '标题', value: text(product.title) },
      { label: '品牌', value: text(product.brand) },
      { label: '类目路径', value: text(product.categoryPath) },
      { label: '商品类型', value: text(product.productType) },
      { label: '变体属性', value: variantText(product.variantAttributes) },
    ]
    return { facts, imageUrl: text(product.imageUrl), aplus: await loadAplus(this.prisma, product), pending: [...ASIN360_PENDING_SECTIONS.content], basis: ASIN360_CONTENT_BASIS }
  }

  private listingFacts(product: ResolvedProduct): Asin360Fact[] {
    const catalog = catalogStateOf(product)
    return [
      { label: '刊登状态', value: LISTING_LABEL[product.listingStatus] ?? product.listingStatus },
      { label: '配送方式', value: CHANNEL_LABEL[product.fulfillmentChannel] ?? product.fulfillmentChannel },
      { label: '商品类型', value: text(product.productType) },
      { label: '目录核对', value: CATALOG_LABEL[catalog.state] },
      { label: '目录同步时间', value: catalog.syncedAt, kind: 'time' },
      { label: '主图', value: text(product.imageUrl) ? '已有' : null },
      { label: '父 ASIN', value: text(product.parentAsin) },
    ]
  }
}
