-- 重新授权（P1-25）：把两个连接账号的表权限补齐到与全部迁移执行完之后一致。可重复执行，只增加权限，不会扩大到系统专用表。
--
-- 为什么需要：迁移只在 nova_app / nova_system 已存在时才授权。库如果在账号创建之前就迁移过（例如从旧的单账号部署升级），
-- 这些账号对已有的表没有任何权限，接口服务会报“permission denied”。部署流程在“创建账号之后、迁移之前”先执行本脚本，
-- 之后新增的表由各自的迁移授权。账号不存在或表还没建（全新的库）时本脚本什么也不做。
--
-- 本脚本的授权范围与迁移 20261021080000_tenant_rls、20261021090000_auth_hardening、20261021100000_workflow_reliability、
-- 20261021110000_raw_report_file、20261021120000_data_encryption_key、20261021130000_tenant_lifecycle、20261022010000_orders_finance_v2、20261022020000_platform_capabilities、20261022030000_daily_summaries、20261022140000_hourly_events、20261022150000_business_targets、20261022160000_inventory_sync 保持一致；apps/api/src/testing/regrant.db.test.ts 会在真实数据库上
-- 逐项比对“迁移授权”与“本脚本授权”的结果，两边任何一边改动而另一边没跟上，测试会失败。
--
-- 必须由表的所有者（迁移账号）执行：ALTER DEFAULT PRIVILEGES 只对执行者以后创建的表生效。

DO $$
DECLARE
  tbl text;
  fn text;
BEGIN
  IF to_regclass('public."Tenant"') IS NULL THEN
    RETURN; -- 还没有迁移过：由迁移负责授权
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT USAGE ON SCHEMA public TO nova_app;
    FOREACH tbl IN ARRAY ARRAY[
      'MemberInvitation', 'Membership', 'LegalEntity', 'MembershipScope', 'SellerAccount', 'PlatformConnection', 'OAuthState',
      'Order', 'SyncJob', 'IdempotencyRecord', 'StepUpVerification',
      'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaFeeEvent', 'FbaReturnCase', 'FbaReportJob',
      'AdsProfile', 'AdsCampaign', 'AdsReportJob', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric',
      'Supplier', 'PurchaseOrder', 'Warehouse', 'InventoryMovement', 'Role',
      'FieldPermission', 'PurchaseOrderLine', 'FbaInboundShipment', 'ConnectionHealth',
      'WorkflowRun', 'WorkflowStep', 'DeadLetterJob', 'DistributedLock', 'RawReportFile',
      'TenantOnboarding', 'PlatformSupportAccess',
      'OrderCharge', 'OrderStatusHistory', 'OrderPackage', 'OrderCancellation', 'AccountBalanceSnapshot', 'ConnectorChannelState', 'ConnectorParityRun', 'ConnectorParityDiff',
      'IntegrationSwitch', 'IntegrationSwitchLog', 'FxRate', 'FxSourceConfig', 'WorkItem', 'Assignment', 'AlertRule', 'AlertRuleVersion', 'AlertInstance',
      'Notification', 'ExportJob', 'SavedView', 'EntityEvent', 'OperationLog', 'Comment', 'Watch', 'NotificationSubscription', 'AmazonNotificationEvent',
      'DataFreshness', 'TenantSetting', 'StoreDailySummary', 'AsinDailySummary',
      'HourlySalesEvent', 'HourlyTrafficEvent', 'HourlyInventoryEvent', 'BusinessTarget',
      'InventoryDailySnapshot', 'InventoryLedgerEntry', 'InventoryLedgerSummary', 'InventoryAgeSnapshot', 'InventoryPlanningSnapshot',
      'StorageCapacitySnapshot', 'StorageFeeRecord', 'RemovalOrder', 'RemovalShipment', 'AmazonRestockRecommendation',
      'ReplenishmentPolicy',
      'SubscribeSaveMetric', 'SubscribeSaveOffer', 'ReplenishmentBatch', 'ReplenishmentRecommendation', 'ReplenishmentAction', 'ReplenishmentOutcome', 'EconomicsSimulationRun',
      'AwdInventory', 'AwdInboundOrder', 'AwdInboundShipment', 'AwdShipmentItem',
      'RemovalReceipt',
      'PurchaseReceipt', 'QualityInspection', 'PurchasePayment', 'PurchaseApproval', 'Attachment', 'StockCount', 'CostVersion',
      'FreightForwarder', 'FirstMileShipment', 'FirstMileShipmentItem', 'FirstMileCost', 'FirstMileMilestone', 'LandedCostAllocation', 'TransitTimeStat',
      'InboundPlanItem', 'InboundEligibilityCheck', 'PackingOption', 'PackingGroup', 'InboundBox', 'PlacementOption', 'TransportOption', 'DeliveryWindow', 'ShipmentItem', 'TrackingEvent', 'LabelPrintJob', 'InboundOperation',
      'ReceivingDiscrepancy', 'ReimbursementOpportunity', 'ReimbursementCase', 'ReimbursementRecord', 'EvidencePack',
      'ProductVariantRelation', 'SalesRankSnapshot', 'SupportCase', 'SupportContact', 'FeeBaseline', 'FeeAudit', 'SettlementLine', 'Reconciliation', 'ReconciliationException', 'Disbursement', 'ProfitDaily',
      'EconomicsDaily', 'EconomicsPreview', 'SalesTaxSummary', 'AccountingPeriod', 'PeriodSnapshot', 'FinancePolicyVersion',
      'AdsRecommendation', 'AdsForecastRun', 'AdsParityState', 'AdsParityRun', 'AdsParityDiff',
      'AdsAccount', 'AdsPortfolio', 'AdsAdGroup', 'AdsAd', 'AdsTarget', 'AdsKeyword', 'AdsNegativeTarget', 'AdsCreative', 'AdsBudgetRule', 'DaypartingStrategy', 'DaypartingRun', 'AdsAutomationRule', 'AdsAutomationRun', 'AdsEntitySnapshot', 'AdsChangeLog', 'AdsWriteRun',
      'AdsPlacementMetric', 'AdsAdvertisedProductMetric', 'AdsConvertedProductDaily', 'AdsPerformanceHourly',
      'AdsDailySummary',
      'SalesTrafficDaily', 'SalesTrafficAsinDaily', 'SalesTrafficDiff',
      'BrandSearchQueryPerformance', 'BrandSearchCatalogPerformance', 'BrandSearchTerm', 'BrandMarketBasket', 'BrandRepeatPurchase',
      'Promotion', 'PromotionItem', 'PromotionMetric', 'CouponMetric',
      'ListingSnapshot', 'ListingIssue', 'ListingChangeEvent', 'ListingWriteRun',
      'PriceSnapshot', 'FeaturedOfferExpectedPrice', 'CompetitiveSummarySnapshot', 'CompetitiveOffer', 'BuyBoxSnapshot', 'PriceGuardrail', 'PricingRule', 'PricingRuleRun',
      'WatchedAsin', 'CompetitorSnapshot',
      'ReviewMetricSnapshot', 'ReviewTopic', 'BrowseNodeReviewTrend', 'BrowseNodeReturnTrend', 'SolicitationRequest',
      'AplusContent', 'AplusAsinRelation', 'AplusReviewEvent', 'AplusWriteRun',
      'AccountHealthSnapshot', 'PolicyIssue',
      'UserPreference', 'GridView', 'ShipFromAddress', 'ForecastOverride',
      'SkuAlias', 'PackingListMapping', 'LabelTemplate', 'LabelPrintLog',
      'ReturnReasonMap', 'AlertRead', 'AlertDigest',
      'OfferCompetitor', 'HijackWhitelist',
      'ProfitItem', 'ProfitItemMapping', 'MetricVersion', 'AllocationRule', 'EstimatedFee',
      'Carrier', 'CarrierChannel', 'ChannelRate', 'ApprovalRequest', 'PricingCalcRecord',
      'CustomMetric', 'CustomReport',
      'DashboardFolder', 'Dashboard', 'DashboardWidget'
    ] LOOP
      IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
      END IF;
    END LOOP;
    -- 审计只增不改；用户只读；企业可读可改
    IF to_regclass('public."AuditEvent"') IS NOT NULL THEN GRANT SELECT, INSERT ON "AuditEvent" TO nova_app; END IF;
    IF to_regclass('public."User"') IS NOT NULL THEN GRANT SELECT ON "User" TO nova_app; END IF;
    GRANT SELECT, UPDATE ON "Tenant" TO nova_app;
    -- 数据密钥只有系统连接能访问
    IF to_regclass('public."DataEncryptionKey"') IS NOT NULL THEN
      REVOKE ALL ON "DataEncryptionKey" FROM nova_app;
    END IF;
    -- 生命周期事件与配额：企业只读；平台运营账号、开通邀请只有系统连接能访问
    FOREACH tbl IN ARRAY ARRAY['TenantLifecycleEvent', 'TenantQuota'] LOOP
      IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
        EXECUTE format('GRANT SELECT ON %I TO nova_app', tbl);
      END IF;
    END LOOP;
    FOREACH tbl IN ARRAY ARRAY['PlatformAdmin', 'TenantInvitation'] LOOP
      IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
        EXECUTE format('REVOKE ALL ON %I FROM nova_app', tbl);
      END IF;
    END LOOP;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT USAGE ON SCHEMA public TO nova_system;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nova_system;
    -- 平台函数：旧库还没执行到定义它们的迁移时跳过，由那次迁移授权
    FOREACH fn IN ARRAY ARRAY['nova_ensure_all_partitions(integer)', 'nova_default_partition_rows()', 'nova_current_tenant()'] LOOP
      IF to_regprocedure(fn) IS NOT NULL THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO nova_system', fn);
      END IF;
    END LOOP;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nova_system;
    -- 数据密钥只增不删：即使系统连接被攻破也不能删除密钥
    IF to_regclass('public."DataEncryptionKey"') IS NOT NULL THEN
      REVOKE DELETE, TRUNCATE ON "DataEncryptionKey" FROM nova_system;
    END IF;
  END IF;
END $$;
