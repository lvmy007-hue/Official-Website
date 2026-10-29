-- M-P2a-05 库存类同步器：库存快照、台账、库龄、规划、仓储容量与费用、移除订单与货件、官方补货建议。
-- 依据：freeze/models.md 第十一节、importers.md I-05、R-08～R-22、N-04、10 章 10.3、14 章 P2a-05。
--
-- 内容：
--   一、修改既有表 FbaInventoryRecord：去掉固定阈值判断列 healthStatus（及其索引），新增 source、realtimeSyncedAt。
--      先迁移后删除：healthStatus 只有“可售少于 20 即低库存”这一条固定规则写入，没有任何不可重建的数据；库存健康由 P2a-06 规则引擎按版本计算。
--   二、新增 10 张表：InventoryDailySnapshot（按月 snapshotDate 分区）、InventoryLedgerEntry、InventoryLedgerSummary、InventoryAgeSnapshot、
--      InventoryPlanningSnapshot、StorageCapacitySnapshot、StorageFeeRecord、RemovalOrder、RemovalShipment、AmazonRestockRecommendation。
--   三、检查约束（枚举取值）、行级安全与授权（与其他租户表一致）。
--   四、数据迁移（D-08 / G-10）：旧表 InventorySnapshot 的行迁入 InventoryDailySnapshot（source = 'API'，快照日期取来源更新时间的 UTC 日期，
--      FNSKU 与 ASIN 旧表没有，存空串）；旧表保留不删，到 P5-12 再删除。重复执行不会产生重复行。
--
-- 回滚方法：见同目录 rollback.sql（删除 10 张新表，恢复 healthStatus 列并按旧规则回填；报告类数据可由下一次同步重建，原始文件仍在对象存储）。


-- DropIndex
DROP INDEX "FbaInventoryRecord_tenantId_healthStatus_daysOfSupply_idx";

-- AlterTable
ALTER TABLE "FbaInventoryRecord" DROP COLUMN "healthStatus",
ADD COLUMN     "realtimeSyncedAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'API';

-- CreateTable
CREATE TABLE "InventoryDailySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT NOT NULL DEFAULT '',
    "sellable" INTEGER,
    "inbound" INTEGER,
    "reserved" INTEGER,
    "unsellable" INTEGER,
    "researching" INTEGER,
    "reservedCustomerOrder" INTEGER,
    "reservedTransfer" INTEGER,
    "reservedProcessing" INTEGER,
    "stranded" INTEGER,
    "strandedReason" TEXT,
    "source" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryDailySnapshot_pkey" PRIMARY KEY ("id","snapshotDate")
) PARTITION BY RANGE ("snapshotDate");

-- CreateTable
CREATE TABLE "InventoryLedgerEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "eventDate" DATE NOT NULL,
    "eventTime" TIMESTAMP(3),
    "fnsku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "sku" TEXT NOT NULL DEFAULT '',
    "fulfillmentCenter" TEXT NOT NULL DEFAULT '',
    "disposition" TEXT NOT NULL DEFAULT '',
    "reasonCode" TEXT NOT NULL DEFAULT '',
    "eventType" TEXT NOT NULL DEFAULT '',
    "referenceId" TEXT,
    "quantity" INTEGER NOT NULL,
    "country" TEXT,
    "reconciledQty" INTEGER,
    "unreconciledQty" INTEGER,
    "rowHash" TEXT NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryLedgerSummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "fnsku" TEXT NOT NULL,
    "asin" TEXT NOT NULL DEFAULT '',
    "sku" TEXT NOT NULL DEFAULT '',
    "fulfillmentCenter" TEXT NOT NULL DEFAULT '',
    "disposition" TEXT NOT NULL DEFAULT '',
    "aggregation" TEXT NOT NULL DEFAULT 'DAILY',
    "startingQty" INTEGER NOT NULL DEFAULT 0,
    "inTransitQty" INTEGER NOT NULL DEFAULT 0,
    "receipts" INTEGER NOT NULL DEFAULT 0,
    "customerShipments" INTEGER NOT NULL DEFAULT 0,
    "customerReturns" INTEGER NOT NULL DEFAULT 0,
    "vendorReturns" INTEGER NOT NULL DEFAULT 0,
    "transfers" INTEGER NOT NULL DEFAULT 0,
    "found" INTEGER NOT NULL DEFAULT 0,
    "lost" INTEGER NOT NULL DEFAULT 0,
    "damaged" INTEGER NOT NULL DEFAULT 0,
    "disposed" INTEGER NOT NULL DEFAULT 0,
    "other" INTEGER NOT NULL DEFAULT 0,
    "endingQty" INTEGER NOT NULL DEFAULT 0,
    "unknownEvents" INTEGER NOT NULL DEFAULT 0,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryLedgerSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryAgeSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "age0to90" INTEGER,
    "age91to180" INTEGER,
    "age181to270" INTEGER,
    "age271to365" INTEGER,
    "age365plus" INTEGER,
    "age0to30" INTEGER,
    "age31to60" INTEGER,
    "age61to90" INTEGER,
    "age366to455" INTEGER,
    "age456plus" INTEGER,
    "ageSurchargeEstimate" DECIMAL(20,6),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryAgeSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InventoryPlanningSnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT NOT NULL DEFAULT '',
    "productName" TEXT,
    "condition" TEXT,
    "currency" TEXT,
    "available" INTEGER,
    "pendingRemovalQty" INTEGER,
    "age0to90" INTEGER,
    "age91to180" INTEGER,
    "age181to270" INTEGER,
    "age271to365" INTEGER,
    "age365plus" INTEGER,
    "age0to30" INTEGER,
    "age31to60" INTEGER,
    "age61to90" INTEGER,
    "age366to455" INTEGER,
    "age456plus" INTEGER,
    "unitsShippedT7" INTEGER,
    "unitsShippedT30" INTEGER,
    "unitsShippedT60" INTEGER,
    "unitsShippedT90" INTEGER,
    "alert" TEXT,
    "yourPrice" DECIMAL(20,6),
    "salesPrice" DECIMAL(20,6),
    "recommendedAction" TEXT,
    "sellThrough" DECIMAL(12,6),
    "itemVolume" DECIMAL(20,6),
    "volumeUnit" TEXT,
    "storageType" TEXT,
    "daysOfSupply" DECIMAL(12,2),
    "estimatedExcessQty" INTEGER,
    "weeksOfCoverT7" DECIMAL(12,6),
    "weeksOfCoverT30" DECIMAL(12,6),
    "weeksOfCoverT60" DECIMAL(12,6),
    "weeksOfCoverT90" DECIMAL(12,6),
    "estimatedStorageCostNextMonth" DECIMAL(20,6),
    "inboundQty" INTEGER,
    "inboundWorking" INTEGER,
    "inboundShipped" INTEGER,
    "inboundReceived" INTEGER,
    "noSaleLast6Months" INTEGER,
    "reservedQty" INTEGER,
    "reservedFcTransfer" INTEGER,
    "reservedFcProcessing" INTEGER,
    "reservedCustomerOrder" INTEGER,
    "unfulfillableQty" INTEGER,
    "historicalDaysOfSupply" DECIMAL(12,2),
    "shortTermHistoricalDaysOfSupply" DECIMAL(12,2),
    "longTermHistoricalDaysOfSupply" DECIMAL(12,2),
    "seasonality" TEXT,
    "fbaMinimumInventoryLevel" INTEGER,
    "amazonHealthStatus" TEXT,
    "lowInventoryLevelFeeApplied" TEXT,
    "lowInventoryLevelFee" DECIMAL(20,6),
    "recommendedShipInQty" INTEGER,
    "recommendedShipInDate" DATE,
    "recommendedSalesPrice" DECIMAL(20,6),
    "recommendedSaleDurationDays" INTEGER,
    "recommendedRemovalQty" INTEGER,
    "estimatedCostSavings" DECIMAL(20,6),
    "aisEst181To210" DECIMAL(20,6),
    "aisEst211To240" DECIMAL(20,6),
    "aisEst241To270" DECIMAL(20,6),
    "aisEst271To300" DECIMAL(20,6),
    "aisEst301To330" DECIMAL(20,6),
    "aisEst331To365" DECIMAL(20,6),
    "aisEst365Plus" DECIMAL(20,6),
    "ltsfQty6Mo" INTEGER,
    "ltsfProjected6Mo" DECIMAL(20,6),
    "ltsfQty12Mo" INTEGER,
    "ltsfProjected12Mo" DECIMAL(20,6),
    "removalReportQty" INTEGER,
    "removalReportReason" TEXT,
    "removalReportUpdatedAt" TIMESTAMP(3),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryPlanningSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageCapacitySnapshot" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "storageType" TEXT NOT NULL,
    "limitQty" DECIMAL(20,6),
    "usedQty" DECIMAL(20,6),
    "utilizationPct" DECIMAL(12,6),
    "sourceKind" TEXT NOT NULL DEFAULT 'REPORT',
    "sourceFileId" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageCapacitySnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StorageFeeRecord" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "chargeMonth" DATE NOT NULL,
    "feeKind" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL,
    "fulfillmentCenter" TEXT NOT NULL DEFAULT '',
    "asin" TEXT NOT NULL DEFAULT '',
    "sku" TEXT NOT NULL DEFAULT '',
    "amount" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "volume" DECIMAL(20,6),
    "rate" DECIMAL(20,6),
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StorageFeeRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemovalOrder" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'OTHER',
    "status" TEXT NOT NULL DEFAULT '',
    "requestDate" DATE NOT NULL,
    "lastUpdatedDate" DATE,
    "serviceSpeed" TEXT,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "disposition" TEXT NOT NULL DEFAULT '',
    "requestedQty" INTEGER NOT NULL DEFAULT 0,
    "shippedQty" INTEGER NOT NULL DEFAULT 0,
    "disposedQty" INTEGER NOT NULL DEFAULT 0,
    "cancelledQty" INTEGER NOT NULL DEFAULT 0,
    "inProcessQty" INTEGER NOT NULL DEFAULT 0,
    "fee" DECIMAL(20,6),
    "currency" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemovalOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RemovalShipment" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shipmentId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "disposition" TEXT NOT NULL DEFAULT '',
    "carrier" TEXT,
    "trackingNumber" TEXT,
    "shippedQty" INTEGER NOT NULL DEFAULT 0,
    "shipDate" DATE,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RemovalShipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmazonRestockRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "sellerAccountId" TEXT NOT NULL,
    "snapshotDate" DATE NOT NULL,
    "sku" TEXT NOT NULL,
    "fnsku" TEXT NOT NULL DEFAULT '',
    "asin" TEXT NOT NULL DEFAULT '',
    "recommendedQty" INTEGER,
    "recommendedShipDate" DATE,
    "alertReason" TEXT,
    "recommendedAction" TEXT,
    "daysOfSupply" INTEGER,
    "daysOfSupplyAtFba" INTEGER,
    "availableQty" INTEGER,
    "inboundQty" INTEGER,
    "unitsSold30d" INTEGER,
    "salesLast30d" DECIMAL(20,6),
    "currency" TEXT,
    "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceReportJobId" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmazonRestockRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InventoryDailySnapshot_store_date_idx" ON "InventoryDailySnapshot"("tenantId", "sellerAccountId", "snapshotDate");

-- CreateIndex
CREATE INDEX "InventoryDailySnapshot_store_idx" ON "InventoryDailySnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryDailySnapshot_uq" ON "InventoryDailySnapshot"("tenantId", "sellerAccountId", "sku", "fnsku", "snapshotDate", "source");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_store_date_idx" ON "InventoryLedgerEntry"("tenantId", "sellerAccountId", "eventDate");

-- CreateIndex
CREATE INDEX "InventoryLedgerEntry_store_idx" ON "InventoryLedgerEntry"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedgerEntry_uq" ON "InventoryLedgerEntry"("tenantId", "sellerAccountId", "rowHash");

-- CreateIndex
CREATE INDEX "InventoryLedgerSummary_store_date_idx" ON "InventoryLedgerSummary"("tenantId", "sellerAccountId", "date");

-- CreateIndex
CREATE INDEX "InventoryLedgerSummary_store_idx" ON "InventoryLedgerSummary"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryLedgerSummary_uq" ON "InventoryLedgerSummary"("tenantId", "sellerAccountId", "date", "fnsku", "fulfillmentCenter", "disposition", "aggregation");

-- CreateIndex
CREATE INDEX "InventoryAgeSnapshot_store_date_idx" ON "InventoryAgeSnapshot"("tenantId", "sellerAccountId", "snapshotDate");

-- CreateIndex
CREATE INDEX "InventoryAgeSnapshot_store_idx" ON "InventoryAgeSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryAgeSnapshot_uq" ON "InventoryAgeSnapshot"("tenantId", "sellerAccountId", "sku", "fnsku", "snapshotDate");

-- CreateIndex
CREATE INDEX "InventoryPlanningSnapshot_store_date_idx" ON "InventoryPlanningSnapshot"("tenantId", "sellerAccountId", "snapshotDate");

-- CreateIndex
CREATE INDEX "InventoryPlanningSnapshot_store_idx" ON "InventoryPlanningSnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "InventoryPlanningSnapshot_uq" ON "InventoryPlanningSnapshot"("tenantId", "sellerAccountId", "sku", "fnsku", "snapshotDate");

-- CreateIndex
CREATE INDEX "StorageCapacitySnapshot_store_idx" ON "StorageCapacitySnapshot"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageCapacitySnapshot_uq" ON "StorageCapacitySnapshot"("tenantId", "sellerAccountId", "snapshotDate", "storageType");

-- CreateIndex
CREATE INDEX "StorageFeeRecord_store_month_idx" ON "StorageFeeRecord"("tenantId", "sellerAccountId", "chargeMonth");

-- CreateIndex
CREATE INDEX "StorageFeeRecord_store_idx" ON "StorageFeeRecord"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "StorageFeeRecord_uq" ON "StorageFeeRecord"("tenantId", "sellerAccountId", "chargeMonth", "fnsku", "fulfillmentCenter", "feeKind");

-- CreateIndex
CREATE INDEX "RemovalOrder_store_date_idx" ON "RemovalOrder"("tenantId", "sellerAccountId", "requestDate");

-- CreateIndex
CREATE INDEX "RemovalOrder_store_idx" ON "RemovalOrder"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RemovalOrder_uq" ON "RemovalOrder"("tenantId", "sellerAccountId", "orderId", "sku", "fnsku", "disposition");

-- CreateIndex
CREATE INDEX "RemovalShipment_store_order_idx" ON "RemovalShipment"("tenantId", "sellerAccountId", "orderId");

-- CreateIndex
CREATE INDEX "RemovalShipment_store_idx" ON "RemovalShipment"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "RemovalShipment_uq" ON "RemovalShipment"("tenantId", "sellerAccountId", "orderId", "shipmentId", "sku", "fnsku");

-- CreateIndex
CREATE INDEX "AmazonRestockRecommendation_store_date_idx" ON "AmazonRestockRecommendation"("tenantId", "sellerAccountId", "snapshotDate");

-- CreateIndex
CREATE INDEX "AmazonRestockRecommendation_store_idx" ON "AmazonRestockRecommendation"("sellerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "AmazonRestockRecommendation_uq" ON "AmazonRestockRecommendation"("tenantId", "sellerAccountId", "sku", "fnsku", "snapshotDate");

-- CreateIndex
CREATE INDEX "FbaInventoryRecord_tenantId_daysOfSupply_idx" ON "FbaInventoryRecord"("tenantId", "daysOfSupply");

-- AddForeignKey
ALTER TABLE "InventoryDailySnapshot" ADD CONSTRAINT "InventoryDailySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryDailySnapshot" ADD CONSTRAINT "InventoryDailySnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerEntry" ADD CONSTRAINT "InventoryLedgerEntry_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerSummary" ADD CONSTRAINT "InventoryLedgerSummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryLedgerSummary" ADD CONSTRAINT "InventoryLedgerSummary_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAgeSnapshot" ADD CONSTRAINT "InventoryAgeSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryAgeSnapshot" ADD CONSTRAINT "InventoryAgeSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPlanningSnapshot" ADD CONSTRAINT "InventoryPlanningSnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InventoryPlanningSnapshot" ADD CONSTRAINT "InventoryPlanningSnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageCapacitySnapshot" ADD CONSTRAINT "StorageCapacitySnapshot_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageCapacitySnapshot" ADD CONSTRAINT "StorageCapacitySnapshot_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageFeeRecord" ADD CONSTRAINT "StorageFeeRecord_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorageFeeRecord" ADD CONSTRAINT "StorageFeeRecord_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemovalOrder" ADD CONSTRAINT "RemovalOrder_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemovalOrder" ADD CONSTRAINT "RemovalOrder_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemovalShipment" ADD CONSTRAINT "RemovalShipment_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RemovalShipment" ADD CONSTRAINT "RemovalShipment_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonRestockRecommendation" ADD CONSTRAINT "AmazonRestockRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmazonRestockRecommendation" ADD CONSTRAINT "AmazonRestockRecommendation_sellerAccountId_fkey" FOREIGN KEY ("sellerAccountId") REFERENCES "SellerAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 枚举取值检查（用文本加检查约束实现，便于以后加值）
ALTER TABLE "InventoryDailySnapshot" ADD CONSTRAINT "inventory_daily_source_check" CHECK ("source" IN ('MYI_ALL', 'MYI_UNSUPPRESSED', 'AFN', 'RESERVED', 'STRANDED', 'API'));
ALTER TABLE "StorageFeeRecord" ADD CONSTRAINT "storage_fee_kind_check" CHECK ("feeKind" IN ('STORAGE', 'OVERAGE', 'LONGTERM', 'UTILIZATION'));
ALTER TABLE "StorageCapacitySnapshot" ADD CONSTRAINT "storage_capacity_source_check" CHECK ("sourceKind" IN ('REPORT', 'FILE_IMPORT'));
ALTER TABLE "RemovalOrder" ADD CONSTRAINT "removal_order_type_check" CHECK ("type" IN ('RETURN', 'DISPOSAL', 'OTHER'));
ALTER TABLE "InventoryLedgerSummary" ADD CONSTRAINT "ledger_summary_aggregation_check" CHECK ("aggregation" IN ('DAILY', 'WEEKLY', 'MONTHLY'));
ALTER TABLE "FbaInventoryRecord" ADD CONSTRAINT "fba_inventory_source_check" CHECK ("source" IN ('API', 'NOTIFICATION'));

-- 分区：按月 snapshotDate；默认分区接住范围外的异常日期；之后由后台任务每天提前 3 个月续建。
DO $$
BEGIN
  PERFORM nova_ensure_partitions_around('"InventoryDailySnapshot"'::regclass, (timezone('UTC', now()) - interval '14 months')::timestamp, timezone('UTC', now())::timestamp, 3);
END $$;

-- 数据迁移：旧表 InventorySnapshot → InventoryDailySnapshot（幂等：已存在的行不覆盖）。
-- 迁移账号是表的所有者，不受行级安全限制，租户编号照原行搬运。
INSERT INTO "InventoryDailySnapshot" ("id", "tenantId", "sellerAccountId", "snapshotDate", "sku", "fnsku", "asin", "sellable", "inbound", "reserved", "source", "sourceUpdatedAt", "syncedAt", "sourceReportJobId", "sourceRecordId", "updatedAt")
SELECT 'legacy-' || s."id", s."tenantId", s."sellerAccountId", (timezone('UTC', s."sourceUpdatedAt"))::date, s."sku", '', '', s."available", s."inbound", s."reserved", 'API', s."sourceUpdatedAt", s."syncedAt", s."sourceReportJobId", s."sourceRecordId", CURRENT_TIMESTAMP
FROM "InventorySnapshot" s
ON CONFLICT ("tenantId", "sellerAccountId", "sku", "fnsku", "snapshotDate", "source") DO NOTHING;

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['InventoryDailySnapshot', 'InventoryLedgerEntry', 'InventoryLedgerSummary', 'InventoryAgeSnapshot', 'InventoryPlanningSnapshot', 'StorageCapacitySnapshot', 'StorageFeeRecord', 'RemovalOrder', 'RemovalShipment', 'AmazonRestockRecommendation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', tbl);
    END IF;
  END LOOP;
END $$;
