import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common'
import { PRODUCT_META_ACTION, PRODUCT_META_WRITE, PRODUCT_SYNC_ACTION, PRODUCT_SYNC_PERMISSION } from '@nova/api-contracts'
import { ok, RequestWithContext } from '../../platform/http'
import { Write } from '../../platform/write'
import { AuthGuard } from '../auth'
import { ProductAdsService } from './product-ads.service'
import { ProductAlertsService } from './product-alerts.service'
import { ProductCompareService } from './product-compare.service'
import { ProductCompetitorCompareService } from './product-competitor-compare.service'
import { ProductChangesService } from './product-changes.service'
import { ProductEconomicsService } from './product-economics.service'
import { ProductIdentityService } from './product-identity.service'
import { ProductInventoryService } from './product-inventory.service'
import { ProductOfficialService } from './product-official.service'
import { ProductListService } from './product-list.service'
import { ProductMarketService } from './product-market.service'
import { ProductMetaService } from './product-meta.service'
import { ProductOverviewService } from './product-overview.service'
import { ProductPanelsService } from './product-panels.service'
import { ProductReturnsService } from './product-returns.service'
import { ProductSyncService } from './product-sync.service'
import { ProductTrafficService } from './product-traffic.service'

// ASIN 360（P2a-14，05 章 5.2）：一个商品行一页。全部是读接口，要求 products.read；库存页签另需 inventory.read。
// 利润与成本、退货页签另需各自的权限（见 asin360-economics.ts）。数据范围按成员本身的范围收窄，不在范围内的编号返回 404。
// 注意：查询参数的类型必须直接写 Record<string, string>，不能起别名。
@UseGuards(AuthGuard)
@Controller('products')
export class ProductsController {
  constructor(
    private readonly identity: ProductIdentityService,
    private readonly overview: ProductOverviewService,
    private readonly inventory: ProductInventoryService,
    private readonly changes: ProductChangesService,
    private readonly economics: ProductEconomicsService,
    private readonly official: ProductOfficialService,
    private readonly returns: ProductReturnsService,
    private readonly ads: ProductAdsService,
    private readonly lists: ProductListService,
    private readonly metas: ProductMetaService,
    private readonly syncs: ProductSyncService,
    private readonly trafficTab: ProductTrafficService,
    private readonly market: ProductMarketService,
    private readonly panels: ProductPanelsService,
    private readonly compares: ProductCompareService,
    private readonly rivals: ProductCompetitorCompareService,
    private readonly alertLog: ProductAlertsService,
  ) {}

  // 商品主数据列表（P4-07，05 章 5.1）。静态路径 meta、sync 与空路径不会和 :id 冲突（方法不同或没有第二段）。
  @Get()
  async list(@Req() req: RequestWithContext, @Query() query: Record<string, string>) {
    return ok(await this.lists.list(req, query), req)
  }

  // 批量设置负责人与标签：只改本系统的数据，不写亚马逊。
  @Write({ action: PRODUCT_META_ACTION, resourceType: 'FbaProduct', permission: PRODUCT_META_WRITE })
  @Patch('meta')
  async meta(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.metas.update(req, body), req)
  }

  // 同步商品目录：按店铺发起（亚马逊商品目录同步是店铺授权级任务）。
  @Write({ action: PRODUCT_SYNC_ACTION, resourceType: 'SellerAccount', permission: PRODUCT_SYNC_PERMISSION })
  @Post('sync')
  async sync(@Req() req: RequestWithContext, @Body() body: unknown) {
    return ok(await this.syncs.create(req, body), req)
  }

  @Get(':id')
  async getIdentity(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.identity.identity(req, id), req)
  }

  @Get(':id/overview')
  async getOverview(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.overview.overview(req, id, query), req)
  }

  // 广告页签（P3-19）：另需 ads.read；同一 ASIN 的多个 SKU 合在一起看。
  @Get(':id/ads')
  async getAds(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.ads.ads(req, id, query), req)
  }

  @Get(':id/inventory')
  async getInventory(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.inventory.inventoryRef(req, id), req)
  }

  @Get(':id/actions')
  async getActions(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.inventory.actions(req, id), req)
  }

  // 利润与成本页签（P2b-17）：我方单位经济、官方对照、费用预览、成本版本；各有各的准入，缺权限只影响对应区块。
  @Get(':id/economics')
  async getEconomics(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.economics.economics(req, id, query), req)
  }

  @Get(':id/economics/official')
  async getOfficial(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.official.official(req, id, query), req)
  }

  @Get(':id/economics/preview')
  async getPreview(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.official.preview(req, id), req)
  }

  @Get(':id/economics/costs')
  async getCosts(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.official.costVersions(req, id), req)
  }

  @Get(':id/returns')
  async getReturns(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.returns.returns(req, id, query), req)
  }

  // 流量转化页签（P4-08）：逐日流量、核心搜索词份额漏斗与断点、目录表现；品牌分析区块另需 analytics.brand.read（没有是受限，不是 403）。
  @Get(':id/traffic')
  async getTraffic(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.trafficTab.traffic(req, id, query), req)
  }

  // 刊登与问题、评价、内容与 A+、定价与购物车、竞品页签（P4-08）：各自另需页签权限；没有数据来源的区块返回“尚未接入”。
  @Get(':id/listing')
  async getListing(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.panels.listing(req, id), req)
  }

  @Get(':id/reviews')
  async getReviews(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.panels.reviews(req, id), req)
  }

  @Get(':id/content')
  async getContent(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.panels.content(req, id), req)
  }

  @Get(':id/pricing')
  async getPricing(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.market.pricing(req, id, query), req)
  }

  @Get(':id/competitors')
  async getCompetitors(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.market.competitors(req, id, query), req)
  }

  // 锚点长页新增区块（P6-21）：同环比明细、竞品对比、预警日志。事件带复用 GET /events。
  @Get(':id/compare')
  async getCompare(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.compares.compare(req, id, query), req)
  }

  @Get(':id/competitor-compare')
  async getCompetitorCompare(@Req() req: RequestWithContext, @Param('id') id: string, @Query() query: Record<string, string>) {
    return ok(await this.rivals.compare(req, id, query), req)
  }

  @Get(':id/alerts')
  async getAlerts(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.alertLog.list(req, id), req)
  }

  @Get(':id/changes') async getChanges(@Req() req: RequestWithContext, @Param('id') id: string) {
    return ok(await this.changes.changes(req, id), req)
  }
}
