import { Module } from '@nestjs/common'
import { AdsModule } from '../ads'
import { AuthModule } from '../auth'
import { InventoryModule } from '../inventory'
import { AsinAnalyticsController } from './asin-analytics.controller'
import { AsinAnalyticsService } from './asin-analytics.service'
import { AsinSelectionService } from './asin-analytics-selection.service'
import { BrandAccessService } from './brand-access.service'
import { BrandBasketService } from './brand-basket.service'
import { BrandCatalogService } from './brand-catalog.service'
import { BrandRepeatService } from './brand-repeat.service'
import { BrandSqpService } from './brand-sqp.service'
import { BrandTermsService } from './brand-terms.service'
import { BrandController } from './brand.controller'
import { BusinessReportsAccessService } from './business-reports-access.service'
import { BusinessReportsAsinService } from './business-reports-asin.service'
import { BusinessReportsDateService } from './business-reports-date.service'
import { BusinessReportsSummaryService } from './business-reports-summary.service'
import { BusinessReportsController } from './business-reports.controller'
import { ParentContextService } from './parent-context.service'
import { ParentDetailService } from './parent-detail.service'
import { ParentExtrasService } from './parent-extras.service'
import { ProductPerformanceController } from './product-performance.controller'
import { ProductPerformanceSlowService } from './product-performance-slow.service'
import { ProductPerformanceService } from './product-performance.service'
import { SalesStatController } from './sales-stat.controller'
import { SalesStatService } from './sales-stat.service'
import { ShareTrendService } from './share-trend.service'

@Module({
  imports: [AuthModule, InventoryModule, AdsModule],
  controllers: [BusinessReportsController, AsinAnalyticsController, BrandController, ProductPerformanceController, SalesStatController],
  providers: [
    BusinessReportsAccessService,
    BusinessReportsSummaryService,
    BusinessReportsDateService,
    BusinessReportsAsinService,
    AsinSelectionService,
    AsinAnalyticsService,
    ParentContextService,
    ParentDetailService,
    ParentExtrasService,
    BrandAccessService,
    BrandSqpService,
    BrandCatalogService,
    BrandTermsService,
    BrandBasketService,
    BrandRepeatService,
    ProductPerformanceService,
    ProductPerformanceSlowService,
    SalesStatService,
    ShareTrendService,
  ],
  exports: [ProductPerformanceService],
})
export class AnalyticsModule {}
