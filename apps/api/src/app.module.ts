import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { PlatformModule } from './platform/platform.module'
import { AdsModule } from './modules/ads'
import { AnalyticsModule } from './modules/analytics'
import { CustomReportsModule } from './modules/custom-reports'
import { DashboardsModule } from './modules/dashboards'
import { AuditModule } from './modules/audit'
import { AwdModule } from './modules/awd'
import { AuthModule } from './modules/auth'
import { CollabModule } from './modules/collab'
import { EventsModule } from './modules/events'
import { CommerceModule } from './modules/commerce'
import { ConnectionsModule } from './modules/connections'
import { ContactModule } from './modules/contact'
import { ExportsModule } from './modules/exports'
import { FinanceModule } from './modules/finance'
import { PeriodsModule } from './modules/periods'
import { CostsModule } from './modules/costs'
import { FinancePolicyModule } from './modules/finance-policy'
import { FreshnessModule } from './modules/freshness'
import { MetricsModule } from './modules/metrics'
import { FxModule } from './modules/fx'
import { HealthModule } from './modules/health'
import { InboundModule } from './modules/inbound'
import { IntegrationsModule } from './modules/integrations'
import { InventoryModule } from './modules/inventory'
import { ReplenishmentModule } from './modules/replenishment'
import { LifecycleModule } from './modules/lifecycle'
import { ListingsModule } from './modules/listings'
import { CompetitorsModule } from './modules/competitors'
import { ProfitItemsModule } from './modules/profit-items'
import { AllocationRulesModule } from './modules/allocation-rules'
import { EstimatedFeesModule } from './modules/estimated-fees'
import { MetricVersionsModule } from './modules/metric-versions'
import { ToolsModule } from './modules/tools'
import { ReviewsModule } from './modules/reviews'
import { AplusModule } from './modules/aplus'
import { PricingModule } from './modules/pricing'
import { NotificationsModule } from './modules/notifications'
import { ProfileModule } from './modules/profile'
import { OrdersModule } from './modules/orders'
import { OverviewModule } from './modules/overview'
import { TodayModule } from './modules/today'
import { PlatformAdminModule } from './modules/platform-admin'
import { ProcurementModule } from './modules/procurement'
import { FirstMileModule } from './modules/first-mile'
import { ApprovalsModule } from './modules/approvals'
import { ProductsModule } from './modules/products'
import { EconomicsModule } from './modules/economics'
import { ProfitModule } from './modules/profit'
import { ReportsModule } from './modules/reports'
import { ReimbursementsModule } from './modules/reimbursements'
import { ReturnsModule } from './modules/returns'
import { SettingsModule } from './modules/settings'
import { StorageModule } from './modules/storage'
import { SupportModule } from './modules/support'
import { PromotionsModule } from './modules/promotions'
import { SubscribeSaveModule } from './modules/subscribe-save'
import { SyncModule } from './modules/sync'
import { TargetsModule } from './modules/targets'
import { TelemetryModule } from './modules/telemetry'
import { TenantModule } from './modules/tenant'
import { WorkModule } from './modules/work'
import { AlertsModule } from './modules/alerts'
import { AccountHealthModule } from './modules/account-health'
import { EntitiesModule } from './modules/entities'
import { MembersModule } from './modules/members'
import { GridViewsModule } from './modules/grid-views'
import { ShipFromModule } from './modules/ship-from'
import { BatchInboundModule } from './modules/batch-inbound'
import { SkuAliasModule } from './modules/sku-alias'
import { LabelTemplatesModule } from './modules/label-templates'
import { PiiModule } from './modules/pii'
// 应用根模块：只负责装配。业务逻辑全部在 modules/ 下的领域模块里，
// 横向基础设施（数据库、队列、限流）在 platform/。
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PlatformModule,
    HealthModule,
    AuthModule,
    TenantModule,
    EntitiesModule,
    MembersModule,
    TelemetryModule,
    AuditModule,
    ConnectionsModule,
    SyncModule,
    ReportsModule,
    OrdersModule,
    InventoryModule,
    ReplenishmentModule,
    InboundModule,
    AwdModule,
    ReturnsModule,
    ReimbursementsModule,
    SupportModule,
    PromotionsModule,
    SubscribeSaveModule,
    FinanceModule,
    PeriodsModule,
    CostsModule,
    FinancePolicyModule,
    ProfitModule,
    EconomicsModule,
    ProcurementModule,
    FirstMileModule,
    ApprovalsModule,
    AdsModule,
    AnalyticsModule,
    CustomReportsModule,
    DashboardsModule,
    ContactModule,
    CommerceModule,
    LifecycleModule,
    PlatformAdminModule,
    StorageModule,
    IntegrationsModule,
    NotificationsModule,
    ProfileModule,
    SettingsModule,
    FxModule,
    WorkModule,
    AlertsModule,
    CollabModule,
    EventsModule,
    ExportsModule,
    FreshnessModule,
    MetricsModule,
    OverviewModule,
    TodayModule,
    TargetsModule,
    ProductsModule,
    ListingsModule,
    PricingModule,
    CompetitorsModule,
    ProfitItemsModule,
    AllocationRulesModule,
    EstimatedFeesModule,
    MetricVersionsModule,
    ToolsModule,
    ReviewsModule,
    AplusModule,
    AccountHealthModule,
    GridViewsModule,
    ShipFromModule,
    BatchInboundModule,
    SkuAliasModule,
    LabelTemplatesModule,
    PiiModule,
  ],
})
export class AppModule {}
