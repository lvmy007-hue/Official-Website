import { Module } from '@nestjs/common'
import { AdsModule } from '../ads'
import { AlertsModule } from '../alerts'
import { AuthModule } from '../auth'
import { CostsModule } from '../costs'
import { EconomicsModule } from '../economics'
import { InventoryModule } from '../inventory'
import { SyncModule } from '../sync'
import { ProductAccessService } from './product-access.service'
import { ProductAdsService } from './product-ads.service'
import { ProductAlertsService } from './product-alerts.service'
import { ProductCompareService } from './product-compare.service'
import { ProductCompetitorCompareService } from './product-competitor-compare.service'
import { ProductChangesService } from './product-changes.service'
import { ProductEconomicsService } from './product-economics.service'
import { ProductIdentityService } from './product-identity.service'
import { ProductInventoryService } from './product-inventory.service'
import { ProductListService } from './product-list.service'
import { ProductMarketService } from './product-market.service'
import { ProductMetaService } from './product-meta.service'
import { ProductOfficialService } from './product-official.service'
import { ProductOverviewService } from './product-overview.service'
import { ProductPanelsService } from './product-panels.service'
import { ProductReturnsService } from './product-returns.service'
import { ProductSyncService } from './product-sync.service'
import { ProductTrafficService } from './product-traffic.service'
import { ProductsController } from './products.controller'

@Module({
  imports: [AuthModule, InventoryModule, EconomicsModule, CostsModule, AdsModule, SyncModule, AlertsModule],
  controllers: [ProductsController],
  providers: [
    ProductAccessService,
    ProductIdentityService,
    ProductOverviewService,
    ProductInventoryService,
    ProductChangesService,
    ProductEconomicsService,
    ProductOfficialService,
    ProductReturnsService,
    ProductAdsService,
    ProductListService,
    ProductMetaService,
    ProductSyncService,
    ProductTrafficService,
    ProductMarketService,
    ProductPanelsService,
    ProductCompareService,
    ProductCompetitorCompareService,
    ProductAlertsService,
  ],
})
export class ProductsModule {}
