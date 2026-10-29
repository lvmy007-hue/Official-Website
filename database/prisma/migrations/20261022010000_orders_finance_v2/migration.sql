-- M-P1-26 订单接口与财务接口升级：新增表、字段迁移、同步表统一来源字段、新旧通道核对。
-- 依据：freeze/models.md 第十一项迁移（M-P1-26）、0.3 同步表来源字段；10 章 10.1；14 章 P1-26。
--
-- 内容：
--   一、15 张同步表补齐统一来源字段：syncedAt（同步时间）、sourceReportJobId（来源报告任务）、sourceRecordId（原始来源标识）。
--       同步时间由触发器维护：来源更新时间变化时刷新，不依赖每个导入器记得写。
--   二、Order、OrderItem、FbaFinancialTransaction 字段迁移（订单接口新版字段、财务交易状态与关联标识）。
--   三、新增 OrderCharge（按月分区）、OrderStatusHistory、OrderPackage、OrderCancellation、AccountBalanceSnapshot。
--   四、新增新旧通道核对三张表：ConnectorChannelState、ConnectorParityRun、ConnectorParityDiff。
--   五、为订单、财务、广告大表补建过去 24 个月的分区：历史回补写入早于当前月的数据时不再落入默认分区。
--   六、行级安全与授权。
--
-- 回滚方法：见同目录 rollback.sql（删除新增表与新增列，数据按所写说明处理；不在自动流程中执行）。
-- 大表变更按“先加后删”：本迁移只新增列与表，不删除任何既有列。

-- ============================================================
-- 一、同步表统一来源字段
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'Order', 'InventorySnapshot', 'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaInboundShipment', 'FbaFeeEvent', 'FbaReturnCase',
    'AdsProfile', 'AdsCampaign', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD COLUMN "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP', tbl);
    EXECUTE format('ALTER TABLE %I ADD COLUMN "sourceReportJobId" TEXT', tbl);
    -- 订单表原本就有必填的 sourceRecordId
    IF tbl <> 'Order' THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN "sourceRecordId" TEXT', tbl);
    END IF;
    -- 既有记录的同步时间无从得知，取来源更新时间（同步时 sourceUpdatedAt 就是同步时刻）
    EXECUTE format('UPDATE %I SET "syncedAt" = "sourceUpdatedAt"', tbl);
  END LOOP;
END $$;

-- 同步时间触发器：新增记录用列默认值；更新时只要来源更新时间变化就刷新同步时间。
-- 这样“重复同步没有变化”的记录不会被误认为刚刚同步过，也不依赖各个导入器各自写入。
CREATE FUNCTION nova_touch_synced_at() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."sourceUpdatedAt" IS DISTINCT FROM OLD."sourceUpdatedAt" THEN
    NEW."syncedAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END
$$;

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'Order', 'InventorySnapshot', 'FbaProduct', 'FbaInventoryRecord', 'FbaInboundPlan', 'FbaInboundShipment', 'FbaFeeEvent', 'FbaReturnCase',
    'AdsProfile', 'AdsCampaign', 'OrderItem', 'FbaSettlement', 'FbaFinancialTransaction', 'AdsMetric', 'AdsTermMetric'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION nova_touch_synced_at()', tbl || '_touch_synced_at', tbl);
  END LOOP;
END $$;

-- ============================================================
-- 二、既有表字段迁移
-- ============================================================

-- 订单：订单接口新版字段（履约状态、发货与送达承诺窗口、取消执行方、换货关联、退款状态）
ALTER TABLE "Order" ADD COLUMN "fulfillmentStatus" TEXT;
ALTER TABLE "Order" ADD COLUMN "latestShipDate" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "earliestDelivery" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "latestDelivery" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "cancelledBy" TEXT;
ALTER TABLE "Order" ADD COLUMN "isReplacement" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Order" ADD COLUMN "replacedOrderId" TEXT;
ALTER TABLE "Order" ADD COLUMN "replacementReason" TEXT;
ALTER TABLE "Order" ADD COLUMN "refundStatus" TEXT;

-- 订单行：冗余站点（美国站固定）、促销折扣、税额、行状态
ALTER TABLE "OrderItem" ADD COLUMN "marketplaceId" TEXT NOT NULL DEFAULT 'ATVPDKIKX0DER';
ALTER TABLE "OrderItem" ADD COLUMN "promotionDiscount" DECIMAL(20,6);
ALTER TABLE "OrderItem" ADD COLUMN "taxAmount" DECIMAL(20,6);
ALTER TABLE "OrderItem" ADD COLUMN "itemStatus" TEXT;

-- 财务交易：交易状态只允许接口给出的三种（旧接口没有状态，旧导入器写入的“已入账”占位值清空），关联标识与对账状态
UPDATE "FbaFinancialTransaction" SET "transactionStatus" = NULL WHERE "transactionStatus" IS NOT NULL;
ALTER TABLE "FbaFinancialTransaction" ADD COLUMN "relatedIdentifiers" JSONB;
ALTER TABLE "FbaFinancialTransaction" ADD COLUMN "reconciliationStatus" TEXT NOT NULL DEFAULT 'UNRECONCILED';
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_transactionStatus_check" CHECK ("transactionStatus" IS NULL OR "transactionStatus" IN ('DEFERRED', 'RELEASED', 'DEFERRED_RELEASED'));
ALTER TABLE "FbaFinancialTransaction" ADD CONSTRAINT "FbaFinancialTransaction_reconciliationStatus_check" CHECK ("reconciliationStatus" IN ('UNRECONCILED', 'RECONCILED', 'DISCREPANCY'));

-- ============================================================
-- 三、订单与财务新增表
-- ============================================================

-- 订单收入、费用、促销、税的逐项金额（按月分区，分区列 purchaseDate，与所属订单一致）
CREATE TABLE "OrderCharge" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderItemId" TEXT NOT NULL,
  "amazonOrderId" TEXT NOT NULL,
  "purchaseDate" TIMESTAMP(3) NOT NULL,
  "chargeKind" TEXT NOT NULL,
  "componentKey" TEXT NOT NULL,
  "amount" DECIMAL(20,6) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "feeCategory" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderCharge_pkey" PRIMARY KEY ("id", "purchaseDate"),
  CONSTRAINT "OrderCharge_chargeKind_check" CHECK ("chargeKind" IN ('ITEM', 'SHIPPING', 'PROMOTION', 'TAX', 'FEE', 'OTHER'))
) PARTITION BY RANGE ("purchaseDate");

CREATE UNIQUE INDEX "OrderCharge_dedupe_key" ON "OrderCharge"("sellerAccountId", "orderItemId", "chargeKind", "componentKey", "purchaseDate");
CREATE INDEX "OrderCharge_tenantId_purchaseDate_idx" ON "OrderCharge"("tenantId", "purchaseDate");
CREATE INDEX "OrderCharge_orderId_purchaseDate_idx" ON "OrderCharge"("orderId", "purchaseDate");
CREATE INDEX "OrderCharge_tenantId_amazonOrderId_idx" ON "OrderCharge"("tenantId", "amazonOrderId");
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCharge" ADD CONSTRAINT "OrderCharge_orderId_purchaseDate_fkey" FOREIGN KEY ("orderId", "purchaseDate") REFERENCES "Order"("id", "purchaseDate") ON DELETE CASCADE ON UPDATE CASCADE;

-- 订单状态变化：每次状态变化追加一条，不覆盖
CREATE TABLE "OrderStatusHistory" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderPurchaseDate" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL,
  "source" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderStatusHistory_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderStatusHistory_source_check" CHECK ("source" IN ('API', 'NOTIFICATION', 'REPORT'))
);

CREATE UNIQUE INDEX "OrderStatusHistory_orderId_status_sourceUpdatedAt_key" ON "OrderStatusHistory"("orderId", "status", "sourceUpdatedAt");
CREATE INDEX "OrderStatusHistory_tenantId_occurredAt_idx" ON "OrderStatusHistory"("tenantId", "occurredAt");
CREATE INDEX "OrderStatusHistory_sellerAccountId_occurredAt_idx" ON "OrderStatusHistory"("sellerAccountId", "occurredAt");
CREATE INDEX "OrderStatusHistory_orderId_orderPurchaseDate_idx" ON "OrderStatusHistory"("orderId", "orderPurchaseDate");
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderStatusHistory" ADD CONSTRAINT "OrderStatusHistory_orderId_orderPurchaseDate_fkey" FOREIGN KEY ("orderId", "orderPurchaseDate") REFERENCES "Order"("id", "purchaseDate") ON DELETE CASCADE ON UPDATE CASCADE;

-- 订单包裹与物流
CREATE TABLE "OrderPackage" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderPurchaseDate" TIMESTAMP(3) NOT NULL,
  "packageId" TEXT NOT NULL,
  "carrier" TEXT NOT NULL DEFAULT '',
  "trackingNumber" TEXT NOT NULL DEFAULT '',
  "shippingService" TEXT,
  "packageStatus" TEXT,
  "shipDate" TIMESTAMP(3),
  "deliveredAt" TIMESTAMP(3),
  "fulfillmentCenter" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderPackage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPackage_dedupe_key" ON "OrderPackage"("sellerAccountId", "orderId", "packageId", "trackingNumber");
CREATE INDEX "OrderPackage_tenantId_shipDate_idx" ON "OrderPackage"("tenantId", "shipDate");
CREATE INDEX "OrderPackage_orderId_orderPurchaseDate_idx" ON "OrderPackage"("orderId", "orderPurchaseDate");
ALTER TABLE "OrderPackage" ADD CONSTRAINT "OrderPackage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderPackage" ADD CONSTRAINT "OrderPackage_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderPackage" ADD CONSTRAINT "OrderPackage_orderId_orderPurchaseDate_fkey" FOREIGN KEY ("orderId", "orderPurchaseDate") REFERENCES "Order"("id", "purchaseDate") ON DELETE CASCADE ON UPDATE CASCADE;

-- 订单取消：谁取消、为什么取消
CREATE TABLE "OrderCancellation" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "orderPurchaseDate" TIMESTAMP(3) NOT NULL,
  "cancelledBy" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL DEFAULT '',
  "requestedAt" TIMESTAMP(3),
  "cancelledAt" TIMESTAMP(3),
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderCancellation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderCancellation_cancelledBy_check" CHECK ("cancelledBy" IN ('BUYER', 'SELLER', 'AMAZON', 'UNKNOWN'))
);

CREATE UNIQUE INDEX "OrderCancellation_sellerAccountId_orderId_key" ON "OrderCancellation"("sellerAccountId", "orderId");
CREATE INDEX "OrderCancellation_tenantId_cancelledAt_idx" ON "OrderCancellation"("tenantId", "cancelledAt");
CREATE INDEX "OrderCancellation_orderId_orderPurchaseDate_idx" ON "OrderCancellation"("orderId", "orderPurchaseDate");
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OrderCancellation" ADD CONSTRAINT "OrderCancellation_orderId_orderPurchaseDate_fkey" FOREIGN KEY ("orderId", "orderPurchaseDate") REFERENCES "Order"("id", "purchaseDate") ON DELETE CASCADE ON UPDATE CASCADE;

-- 账户余额快照：账户类型并入唯一键（同一余额类型可在多个账户类型下并存，见 CR-021）
CREATE TABLE "AccountBalanceSnapshot" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "snapshotDate" DATE NOT NULL,
  "balanceType" TEXT NOT NULL,
  "accountType" TEXT NOT NULL DEFAULT '',
  "currency" TEXT NOT NULL,
  "amount" DECIMAL(20,6) NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountBalanceSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountBalanceSnapshot_dedupe_key" ON "AccountBalanceSnapshot"("sellerAccountId", "snapshotDate", "currency", "balanceType", "accountType");
CREATE INDEX "AccountBalanceSnapshot_tenantId_snapshotDate_idx" ON "AccountBalanceSnapshot"("tenantId", "snapshotDate");
CREATE INDEX "AccountBalanceSnapshot_sellerAccountId_snapshotDate_idx" ON "AccountBalanceSnapshot"("sellerAccountId", "snapshotDate");
ALTER TABLE "AccountBalanceSnapshot" ADD CONSTRAINT "AccountBalanceSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountBalanceSnapshot" ADD CONSTRAINT "AccountBalanceSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 新增同步表同样挂上同步时间触发器
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['OrderCharge', 'OrderPackage', 'OrderCancellation', 'AccountBalanceSnapshot'] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION nova_touch_synced_at()', tbl || '_touch_synced_at', tbl);
  END LOOP;
END $$;

-- ============================================================
-- 四、新旧通道核对
-- ============================================================

CREATE TABLE "ConnectorChannelState" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "legacyEnabled" BOOLEAN NOT NULL DEFAULT true,
  "consecutivePasses" INTEGER NOT NULL DEFAULT 0,
  "requiredPasses" INTEGER NOT NULL DEFAULT 7,
  "lastRunAt" TIMESTAMP(3),
  "closedAt" TIMESTAMP(3),
  "closedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ConnectorChannelState_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorChannelState_domain_check" CHECK ("domain" IN ('ORDERS', 'FINANCE')),
  CONSTRAINT "ConnectorChannelState_requiredPasses_check" CHECK ("requiredPasses" BETWEEN 1 AND 90)
);

CREATE UNIQUE INDEX "ConnectorChannelState_sellerAccountId_domain_key" ON "ConnectorChannelState"("sellerAccountId", "domain");
CREATE INDEX "ConnectorChannelState_tenantId_domain_idx" ON "ConnectorChannelState"("tenantId", "domain");
ALTER TABLE "ConnectorChannelState" ADD CONSTRAINT "ConnectorChannelState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorChannelState" ADD CONSTRAINT "ConnectorChannelState_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConnectorParityRun" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "sellerAccountId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "windowStart" TIMESTAMP(3) NOT NULL,
  "windowEnd" TIMESTAMP(3) NOT NULL,
  "legacyCount" INTEGER NOT NULL DEFAULT 0,
  "newCount" INTEGER NOT NULL DEFAULT 0,
  "matchedCount" INTEGER NOT NULL DEFAULT 0,
  "unexplainedCount" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL,
  "syncJobId" TEXT,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMP(3),
  CONSTRAINT "ConnectorParityRun_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorParityRun_domain_check" CHECK ("domain" IN ('ORDERS', 'FINANCE')),
  CONSTRAINT "ConnectorParityRun_status_check" CHECK ("status" IN ('PASSED', 'HAS_DIFFS', 'LEGACY_UNAVAILABLE'))
);

CREATE INDEX "ConnectorParityRun_tenantId_sellerAccountId_domain_startedA_idx" ON "ConnectorParityRun"("tenantId", "sellerAccountId", "domain", "startedAt");
CREATE INDEX "ConnectorParityRun_sellerAccountId_startedAt_idx" ON "ConnectorParityRun"("sellerAccountId", "startedAt");
ALTER TABLE "ConnectorParityRun" ADD CONSTRAINT "ConnectorParityRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorParityRun" ADD CONSTRAINT "ConnectorParityRun_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ConnectorParityDiff" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "entityKey" TEXT NOT NULL,
  "field" TEXT NOT NULL,
  "legacyValue" TEXT,
  "newValue" TEXT,
  "explanation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ConnectorParityDiff_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectorParityDiff_category_check" CHECK ("category" IN ('TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED'))
);

CREATE INDEX "ConnectorParityDiff_runId_category_idx" ON "ConnectorParityDiff"("runId", "category");
CREATE INDEX "ConnectorParityDiff_tenantId_createdAt_idx" ON "ConnectorParityDiff"("tenantId", "createdAt");
ALTER TABLE "ConnectorParityDiff" ADD CONSTRAINT "ConnectorParityDiff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConnectorParityDiff" ADD CONSTRAINT "ConnectorParityDiff_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ConnectorParityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 五、分区：新表建分区；订单、财务、广告大表补建过去 24 个月
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['"OrderCharge"', '"Order"', '"OrderItem"', '"FbaFinancialTransaction"', '"FbaFeeEvent"', '"AdsMetric"', '"AdsTermMetric"'] LOOP
    PERFORM nova_ensure_partitions_around(tbl::regclass, (timezone('UTC', now()) - interval '24 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  END LOOP;
END $$;

-- ============================================================
-- 六、行级安全与授权
-- ============================================================

DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'OrderCharge', 'OrderStatusHistory', 'OrderPackage', 'OrderCancellation', 'AccountBalanceSnapshot',
    'ConnectorChannelState', 'ConnectorParityRun', 'ConnectorParityDiff'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    FOREACH tbl IN ARRAY ARRAY[
      'OrderCharge', 'OrderStatusHistory', 'OrderPackage', 'OrderCancellation', 'AccountBalanceSnapshot',
      'ConnectorChannelState', 'ConnectorParityRun', 'ConnectorParityDiff'
    ] LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END LOOP;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "OrderCharge", "OrderStatusHistory", "OrderPackage", "OrderCancellation", "AccountBalanceSnapshot", "ConnectorChannelState", "ConnectorParityRun", "ConnectorParityDiff" TO nova_system;
  END IF;
END $$;
