import { Module } from '@nestjs/common'
import { AuthModule } from '../auth'
import { ConnectionsModule } from '../connections'
import { AdsController } from './ads.controller'
import { AdsCampaignAdviceService } from './ads-campaigns-advice.service'
import { AdsLevelsController } from './ads-levels.controller'
import { AdsGroupListService } from './ads-groups-list.service'
import { AdsCampaignsController } from './ads-campaigns.controller'
import { AdsCampaignAccessService } from './ads-campaigns-common'
import { AdsCampaignDetailService } from './ads-campaigns-detail.service'
import { AdsCampaignEntitiesService } from './ads-campaigns-entities.service'
import { AdsCampaignListService } from './ads-campaigns-list.service'
import { AdsCampaignMetaService } from './ads-campaigns-meta.service'
import { AdsCampaignProductsService } from './ads-campaigns-products.service'
import { AdsCampaignRecommendationsService } from './ads-campaigns-recommendations.service'
import { AdsCampaignTermsService } from './ads-campaigns-terms.service'
import { AdsCampaignTrendService } from './ads-campaigns-trend.service'
import { AdTermDetailService } from './ad-terms-detail.service'
import { AdTermsController } from './ad-terms.controller'
import { AdTermsService } from './ad-terms.service'
import { AdsGroupsController, AdsTargetsController } from './ads-groups.controller'
import { AdsDaypartingController } from './ads-dayparting.controller'
import { AdsDaypartingService } from './ads-dayparting.service'
import { AdsDaypartingSimulateService } from './ads-dayparting-simulate.service'
import { AdsDaypartingWriteService } from './ads-dayparting-write.service'
import { AdsMetricsController } from './ads-metrics.controller'
import { AdsMetricsService } from './ads-metrics.service'
import { AdsParityService } from './ads-parity.service'
import { AdsReportsController } from './ads-reports.controller'
import { AdsReportsService } from './ads-reports.service'
import { AdsReportsWriteService } from './ads-reports-write.service'
import { AdsChangesController } from './ads-changes.controller'
import { AdsChangesService } from './ads-changes.service'
import { AdsChangeCompareService } from './ads-changes-compare.service'
import { AdsRulesController } from './ads-rules.controller'
import { AdsRulesService } from './ads-rules.service'
import { AdsRulesDryRunService } from './ads-rules-dryrun.service'
import { AdsRulesRunsService } from './ads-rules-runs.service'
import { AdsRulesWriteService } from './ads-rules-write.service'
import { AdsPortfoliosController } from './ads-portfolios.controller'
import { AdsPortfolioDetailService } from './ads-portfolios-detail.service'
import { AdsPortfolioListService } from './ads-portfolios-list.service'
import { AsinAdsCoverageService } from './ads-asin-coverage.service'
import { AsinAdsTabService } from './ads-asin-tab.service'
import { AdsProductsController } from './ads-products.controller'
import { AdsAsinListService } from './ads-products.service'
import { AdsGroupAccessService } from './ads-groups-common'
import { AdsGroupDetailService } from './ads-groups-detail.service'
import { AdsGroupTabsService } from './ads-groups-tabs.service'
import { AdsTargetDetailService } from './ads-targets-detail.service'
import { AdsTargetTabsService } from './ads-targets-tabs.service'
import { AdsBudgetTimelineService } from './ads-budget-timeline.service'
import { AdsBulkAddService } from './ads-bulk-add.service'
import { AdsConflictsService } from './ads-conflicts.service'
import { AdsDuplicatesService } from './ads-duplicates.service'
import { AdsToolsController } from './ads-tools.controller'
import { AdsWriteController } from './ads-write.controller'
import { AdsWriteService } from './ads-write.service'
import { AdsWriteResolver } from './ads-write-resolve'
import { AdsWriteStatusService } from './ads-write-status.service'
import { AdsOverviewController } from './ads-overview.controller'
import { AdsOverviewService } from './ads-overview.service'
import { AdsService } from './ads.service'
import { AdsTodayController } from './ads-today.controller'
import { AdsTodayService } from './ads-today.service'

@Module({
  imports: [AuthModule, ConnectionsModule],
  controllers: [
    AdsLevelsController,
    AdsToolsController,
    AdsController,
    AdsOverviewController,
    AdsTodayController,
    AdsCampaignsController,
    AdsGroupsController,
    AdsTargetsController,
    AdsProductsController,
    AdsPortfoliosController,
    AdsDaypartingController,
    AdsRulesController,
    AdsChangesController,
    AdsWriteController,
    AdsReportsController,
    AdsMetricsController,
    AdTermsController,
  ],
  providers: [
    AdsBudgetTimelineService,
    AdsBulkAddService,
    AdsConflictsService,
    AdsDuplicatesService,
    AdsGroupListService,
    AdsService,
    AdsOverviewService,
    AdsTodayService,
    AdsCampaignAccessService,
    AdsCampaignListService,
    AdsCampaignMetaService,
    AdsCampaignDetailService,
    AdsCampaignAdviceService,
    AdsCampaignTrendService,
    AdsCampaignEntitiesService,
    AdsCampaignTermsService,
    AdsCampaignProductsService,
    AdsCampaignRecommendationsService,
    AdsGroupAccessService,
    AdsGroupDetailService,
    AdsGroupTabsService,
    AdsTargetDetailService,
    AdsTargetTabsService,
    AdsAsinListService,
    AsinAdsTabService,
    AsinAdsCoverageService,
    AdsPortfolioListService,
    AdsPortfolioDetailService,
    AdsDaypartingService,
    AdsDaypartingWriteService,
    AdsDaypartingSimulateService,
    AdsRulesService,
    AdsRulesWriteService,
    AdsRulesDryRunService,
    AdsRulesRunsService,
    AdsChangesService,
    AdsChangeCompareService,
    AdsWriteService,
    AdsWriteResolver,
    AdsWriteStatusService,
    AdsReportsService,
    AdsReportsWriteService,
    AdsParityService,
    AdsMetricsService,
    AdTermsService,
    AdTermDetailService,
  ],
  exports: [AdsService, AsinAdsTabService, AsinAdsCoverageService, AdsMetricsService],
})
export class AdsModule {}
