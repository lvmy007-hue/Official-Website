import type { ComponentType } from 'react'
import { ScopeSearchParser, type SearchParser } from '@nova/api-contracts'

// 已上线页面登记表（P1-03）：只有登记在这里的页面才会注册路由、进入导航。
// 清单（manifest）里的其余路由属于“未上线”：不进导航，直接访问显示正式的“页面不存在”页。
// 每个阶段交付页面时，在这里登记；测试保证登记的组件名都在路由清单里。

export type PageModule = { default: ComponentType }

export type LivePage = {
  load: () => Promise<PageModule>
  /**
   * 本页的地址栏参数规则（筛选、分页、排序），需包含全局范围参数（使用 pageListQuery / cursorListQuery 生成）。
   * 不提供时只校验全局范围参数，页面自己的参数不做限制。
   */
  search?: SearchParser
}

export type LivePages = Readonly<Record<string, LivePage>>

export const LIVE_PAGES: LivePages = {
  // P4-07：商品主数据
  ProductsPage: { load: () => import('../pages/products/ProductsPage') },
  // P2a-06：库存健康与库存详情
  InventoryHealthPage: { load: () => import('../pages/inventory/InventoryHealthPage') },
  InventoryDetailPage: { load: () => import('../pages/inventory/InventoryDetailPage') },
  // P2a-07：补货建议与批次详情
  ReplenishmentPage: { load: () => import('../pages/replenishment/ReplenishmentPage') },
  ReplenishmentBatchDetailPage: { load: () => import('../pages/replenishment/ReplenishmentBatchDetailPage') },
  // P2a-08：亚马逊仓储分销
  AwdPage: { load: () => import('../pages/awd/AwdPage') },
  AwdOrderDetailPage: { load: () => import('../pages/awd/AwdOrderDetailPage') },
  // P2a-09：库存台账、移除与弃置、仓储容量与费用
  InventoryLedgerPage: { load: () => import('../pages/inventory/InventoryLedgerPage') },
  RemovalsPage: { load: () => import('../pages/inventory/RemovalsPage') },
  RemovalDetailPage: { load: () => import('../pages/inventory/RemovalDetailPage') },
  StorageCapacityPage: { load: () => import('../pages/inventory/StorageCapacityPage') },
  // 连接中心：授权、健康检查、广告账户与店铺绑定（P3-03、P5-04）
  ConnectionsPage: { load: () => import('../pages/connections/ConnectionsPage') },
  // P5-05：消息推送订阅
  NotificationSubscriptionsPage: { load: () => import('../pages/connections/NotificationSubscriptionsPage') },
  // P5-06：同步中心（任务、队列监控、限速状态）与同步任务详情
  SyncCenterPage: { load: () => import('../pages/sync/SyncCenterPage') },
  SyncJobDetailPage: { load: () => import('../pages/sync/SyncJobDetailPage') },
  // P5-03：报表中心与报告任务详情
  ReportCenterPage: { load: () => import('../pages/reports/ReportCenterPage') },
  ReportJobDetailPage: { load: () => import('../pages/reports/ReportJobDetailPage') },
  AdsConsolePage: { load: () => import('../pages/advertising/AdsConsolePage') },
  AdsTodayPage: { load: () => import('../pages/advertising/AdsTodayPage') },
  AdsCampaignsPage: { load: () => import('../pages/advertising/AdsCampaignsPage') },
  // P6-23：广告层级统一骨架（广告组、投放、搜索词列表）
  AdsAdGroupsPage: { load: () => import('../pages/advertising/AdsAdGroupsPage') },
  AdsTargetsPage: { load: () => import('../pages/advertising/AdsTargetsPage') },
  AdsSearchTermsPage: { load: () => import('../pages/advertising/AdsSearchTermsPage') },
  AdsCampaignDetailPage: { load: () => import('../pages/advertising/AdsCampaignDetailPage') },
  AdsAdGroupDetailPage: { load: () => import('../pages/advertising/AdsAdGroupDetailPage') },
  AdsTargetDetailPage: { load: () => import('../pages/advertising/AdsTargetDetailPage') },
  AdsProductsPage: { load: () => import('../pages/advertising/AdsProductsPage') },
  // P3-11：广告组合与预算
  AdsPortfoliosPage: { load: () => import('../pages/advertising/AdsPortfoliosPage') },
  AdsPortfolioDetailPage: { load: () => import('../pages/advertising/AdsPortfolioDetailPage') },
  // P3-12：分时策略
  AdsDaypartingPage: { load: () => import('../pages/advertising/AdsDaypartingPage') },
  AdsRulesPage: { load: () => import('../pages/advertising/AdsRulesPage') },
  AdsRuleDetailPage: { load: () => import('../pages/advertising/AdsRuleDetailPage') },
  AdsChangesPage: { load: () => import('../pages/advertising/AdsChangesPage') },
  // P3-10：词级中心与词级分析（词放在地址栏的 term 参数里，所以详情页要放行 term）
  AdTermsPage: { load: () => import('../pages/advertising/AdTermsPage') },
  AdTermDetailPage: { load: () => import('../pages/advertising/AdTermDetailPage'), search: ScopeSearchParser },
  // P3-15：广告报表与广告指标
  AdsReportsPage: { load: () => import('../pages/advertising/AdsReportsPage') },
  AdsMetricsPage: { load: () => import('../pages/advertising/AdsMetricsPage') },
  EntitiesPage: { load: () => import('../pages/entities/EntitiesPage') },
  EntityDetailPage: { load: () => import('../pages/entities/EntityDetailPage') },
  MembersPage: { load: () => import('../pages/members/MembersPage') },
  MemberDetailPage: { load: () => import('../pages/members/MemberDetailPage') },
  RolesPage: { load: () => import('../pages/roles/RolesPage') },
  // P5-09：审计中心与审计详情（预警跳转会带 view、actorId 参数，所以首页要放行这些参数）
  AuditPage: { load: () => import('../pages/audit/AuditPage'), search: ScopeSearchParser },
  AuditDetailPage: { load: () => import('../pages/audit/AuditDetailPage') },
  // P2b-15：企业设置（财务口径页签提前到 2b，其余页签在 P5-10）
  SettingsPage: { load: () => import('../pages/settings/SettingsPage') },
  // P5-11：个人账号（个人资料、登录安全、会话管理、通知偏好）
  ProfilePage: { load: () => import('../pages/profile/ProfilePage'), search: ScopeSearchParser },
  // 14.11：演示驾驶舱替换为“企业初始化与数据源健康”（P2a-02 换成正式经营控制台）
  OverviewPage: { load: () => import('../pages/overview/OverviewPage') },
  // P2a-03：今日实时
  TodayPage: { load: () => import('../pages/today/TodayPage') },
  // P2a-12：入仓计划与详情
  InboundPlansPage: { load: () => import('../pages/inbound/InboundPlansPage') },
  InboundPlanDetailPage: { load: () => import('../pages/inbound/InboundPlanDetailPage') },
  // P6-11：外部货号映射与装箱单列映射
  SkuAliasesPage: { load: () => import('../pages/sku-alias/SkuAliasesPage') },
  // P6-08：发货地址（P6-08 漏登记，P6-12 补上）
  ShipFromAddressesPage: { load: () => import('../pages/ship-from/ShipFromAddressesPage') },
  // P6-12：标签模板
  LabelTemplatesPage: { load: () => import('../pages/label-templates/LabelTemplatesPage') },
  // P2a-13：货件接收与差异
  ShipmentReceivingPage: { load: () => import('../pages/inbound/ShipmentReceivingPage') },
  ShipmentReceivingDetailPage: { load: () => import('../pages/inbound/ShipmentReceivingDetailPage') },
  // P2a-10：采购订单、供应商、国内仓
  PurchaseOrdersPage: { load: () => import('../pages/procurement/PurchaseOrdersPage') },
  PurchaseOrderDetailPage: { load: () => import('../pages/procurement/PurchaseOrderDetailPage') },
  SuppliersPage: { load: () => import('../pages/procurement/SuppliersPage') },
  SupplierDetailPage: { load: () => import('../pages/procurement/SupplierDetailPage') },
  DomesticWarehousePage: { load: () => import('../pages/procurement/DomesticWarehousePage') },
  // P2a-11：头程物流
  FirstMilePage: { load: () => import('../pages/first-mile/FirstMilePage') },
  FirstMileCarriersPage: { load: () => import('../pages/first-mile/FirstMileCarriersPage') },
  // P6-27：审批收件箱（首页入口，只需要登录；信箱与状态是页面内状态，不进地址栏）
  ApprovalsPage: { load: () => import('../pages/approvals/ApprovalsPage'), search: ScopeSearchParser },
  FirstMileDetailPage: { load: () => import('../pages/first-mile/FirstMileDetailPage') },
  // P2a-04：目标与预算
  TargetsPage: { load: () => import('../pages/targets/TargetsPage') },
  // P2b-01：订单与订单详情
  OrdersPage: { load: () => import('../pages/orders/OrdersPage') },
  OrderDetailPage: { load: () => import('../pages/orders/OrderDetailPage') },
  // P2b-02：退货与退货详情
  ReturnsPage: { load: () => import('../pages/returns/ReturnsPage') },
  ReturnDetailPage: { load: () => import('../pages/returns/ReturnDetailPage') },
  // P2b-03：赔付中心与赔付案件详情
  ReimbursementsPage: { load: () => import('../pages/reimbursements/ReimbursementsPage') },
  ReimbursementDetailPage: { load: () => import('../pages/reimbursements/ReimbursementDetailPage') },
  // P2b-04：支持案件与支持案件详情
  SupportCasesPage: { load: () => import('../pages/support/SupportCasesPage') },
  SupportCaseDetailPage: { load: () => import('../pages/support/SupportCaseDetailPage') },
  // P2b-05：费用事件
  FeeEventsPage: { load: () => import('../pages/finance/FeeEventsPage') },
  // P2b-06：费用核查
  FeeAuditPage: { load: () => import('../pages/finance/FeeAuditPage') },
  // P2b-07：结算交易与结算详情
  SettlementsPage: { load: () => import('../pages/finance/SettlementsPage') },
  SettlementDetailPage: { load: () => import('../pages/finance/SettlementDetailPage') },
  // P2b-08：回款与现金流
  CashflowPage: { load: () => import('../pages/finance/CashflowPage') },
  // P2b-13：期间关账与关账详情
  AccountingPeriodsPage: { load: () => import('../pages/finance/AccountingPeriodsPage') },
  AccountingPeriodDetailPage: { load: () => import('../pages/finance/AccountingPeriodDetailPage') },
  // P2b-14：商品成本
  CostsPage: { load: () => import('../pages/costs/CostsPage') },
  // P2b-12：销售税
  SalesTaxPage: { load: () => import('../pages/finance/SalesTaxPage') },
  // P2b-10：利润分析
  ProfitPage: { load: () => import('../pages/profit/ProfitPage') },
  ProfitItemsPage: { load: () => import('../pages/finance/ProfitItemsPage') },
  AllocationRulesPage: { load: () => import('../pages/finance/AllocationRulesPage') },
  EstimatedFeesPage: { load: () => import('../pages/finance/EstimatedFeesPage') },
  // P6-31：利润公式与业务口径（口径版本化）
  ProfitFormulaPage: { load: () => import('../pages/finance/ProfitFormulaPage') },
  BusinessRulesPage: { load: () => import('../pages/settings/BusinessRulesPage') },
  EconomicsReconciliationPage: { load: () => import('../pages/economics/EconomicsReconciliationPage') },
  // P4-02：业务报告
  BusinessReportsPage: { load: () => import('../pages/analytics/BusinessReportsPage') },
  // P4-03：ASIN 与父体分析、父体详情
  AsinAnalyticsPage: { load: () => import('../pages/analytics/AsinAnalyticsPage') },
  ParentAsinDetailPage: { load: () => import('../pages/analytics/ParentAsinDetailPage') },
  // P4-04：品牌分析五页
  BrandSearchQueryPage: { load: () => import('../pages/analytics/BrandSearchQueryPage') },
  BrandCatalogPerformancePage: { load: () => import('../pages/analytics/BrandCatalogPerformancePage') },
  BrandSearchTermsPage: { load: () => import('../pages/analytics/BrandSearchTermsPage') },
  BrandMarketBasketPage: { load: () => import('../pages/analytics/BrandMarketBasketPage') },
  BrandRepeatPurchasePage: { load: () => import('../pages/analytics/BrandRepeatPurchasePage') },
  // P4-05：促销与优惠券、促销详情
  PromotionsPage: { load: () => import('../pages/promotions/PromotionsPage') },
  PromotionDetailPage: { load: () => import('../pages/promotions/PromotionDetailPage') },
  // P4-06：订阅省
  SubscribeSavePage: { load: () => import('../pages/subscribe-save/SubscribeSavePage') },
  // P4-09：刊登表现
  ListingPerformancePage: { load: () => import('../pages/listings/ListingPerformancePage') },
  ListingQualityPage: { load: () => import('../pages/listings/ListingQualityPage') },
  PricingPage: { load: () => import('../pages/pricing/PricingPage') },
  PricingSkuDetailPage: { load: () => import('../pages/pricing/PricingSkuDetailPage') },
  // P4-12：竞品监控
  CompetitorsPage: { load: () => import('../pages/competitors/CompetitorsPage') },
  CompetitorDetailPage: { load: () => import('../pages/competitors/CompetitorDetailPage') },
  // P4-13：评价与反馈（页签与选择放在地址栏的 tab、storeId、asin、nodeId 里，所以要放行这些参数）
  ReviewsPage: { load: () => import('../pages/reviews/ReviewsPage'), search: ScopeSearchParser },
  // P4-14：A+ 内容与详情
  AplusListPage: { load: () => import('../pages/aplus/AplusListPage') },
  AplusDetailPage: { load: () => import('../pages/aplus/AplusDetailPage') },
  // P5-01：风险预警中心（列表、详情、规则配置）
  // P6-15：列表的筛选（domain、severity、readState、q）、规则页的 template（从模板新建）、模板页的分组筛选都放在地址栏里，要放行这些参数；新增规则模板页
  AlertsPage: { load: () => import('../pages/alerts/AlertsPage'), search: ScopeSearchParser },
  AlertDetailPage: { load: () => import('../pages/alerts/AlertDetailPage') },
  AlertRulesPage: { load: () => import('../pages/alerts/AlertRulesPage'), search: ScopeSearchParser },
  AlertTemplatesPage: { load: () => import('../pages/alerts/AlertTemplatesPage'), search: ScopeSearchParser },
  // P5-02：账户健康
  AccountHealthPage: { load: () => import('../pages/account-health/AccountHealthPage') },
  // P6-17：跟卖监控（筛选 status、whitelist、q 放在地址栏里，要放行）
  HijackMonitorPage: { load: () => import('../pages/tools/HijackMonitorPage'), search: ScopeSearchParser },
  // P6-29：新品定价试算（地址栏沿用范围栏参数）
  PricingCalculatorPage: { load: () => import('../pages/tools/PricingCalculatorPage'), search: ScopeSearchParser },
  // P6-32：我的报表、自定义指标（地址栏沿用范围栏参数）
  CustomReportsPage: { load: () => import('../pages/reports/CustomReportsPage'), search: ScopeSearchParser },
  CustomMetricsPage: { load: () => import('../pages/reports/CustomMetricsPage'), search: ScopeSearchParser },
  // P6-33：自定义仪表盘（地址栏沿用范围栏参数，组件取数按当前范围）
  DashboardsPage: { load: () => import('../pages/dashboards/DashboardsPage'), search: ScopeSearchParser },
  DashboardDetailPage: { load: () => import('../pages/dashboards/DashboardDetailPage'), search: ScopeSearchParser },
  // P6-22：商品表现宽表（维度 dimension、搜索 q 放在地址栏里，要放行）
  ProductPerformancePage: { load: () => import('../pages/analytics/ProductPerformancePage'), search: ScopeSearchParser },
  // P6-25：销量统计、跨仓总览、进销存报表
  SalesStatPage: { load: () => import('../pages/analytics/SalesStatPage'), search: ScopeSearchParser },
  AllWarehousesPage: { load: () => import('../pages/inventory/AllWarehousesPage'), search: ScopeSearchParser },
  InventoryMovementPage: { load: () => import('../pages/inventory/InventoryMovementPage'), search: ScopeSearchParser },
  // P2a-14：ASIN 360
  Asin360Page: { load: () => import('../pages/products/Asin360Page') },

  // P1-28 平台能力
  MyWorkItemsPage: { load: () => import('../pages/my/MyWorkItemsPage') },
  // P5-11：通知中心带业务域与免打扰筛选（汇总通知的链接带 silenced、domain 参数，要放行）
  NotificationCenterPage: { load: () => import('../pages/my/NotificationCenterPage'), search: ScopeSearchParser },
  ExportCenterPage: { load: () => import('../pages/my/ExportCenterPage') },
  MetricDefinitionsPage: { load: () => import('../pages/settings/MetricDefinitionsPage') },
  IntegrationSwitchesPage: { load: () => import('../pages/settings/IntegrationSwitchesPage') },
  FxSettingsPage: { load: () => import('../pages/settings/FxSettingsPage') },
}

export const isLivePage = (component: string, pages: LivePages = LIVE_PAGES) => component in pages
