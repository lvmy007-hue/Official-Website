-- M-P2a-05 回滚：移除库存类 10 张新表，恢复 FbaInventoryRecord 的 healthStatus 列。
-- 说明：
--   · 10 张表的数据都来自亚马逊报告或接口，可由下一次同步重建，原始报告文件仍在对象存储；
--   · 从旧表 InventorySnapshot 迁入的行（id 以 legacy- 开头）随表一起删除，旧表本身从未被删除，数据仍在；
--   · healthStatus 按旧规则回填（可售少于 20 为 LOW_STOCK，否则 HEALTHY）：这是回滚到旧行为所需的最小还原，不是业务判断。
DROP TABLE IF EXISTS "AmazonRestockRecommendation";
DROP TABLE IF EXISTS "RemovalShipment";
DROP TABLE IF EXISTS "RemovalOrder";
DROP TABLE IF EXISTS "StorageFeeRecord";
DROP TABLE IF EXISTS "StorageCapacitySnapshot";
DROP TABLE IF EXISTS "InventoryPlanningSnapshot";
DROP TABLE IF EXISTS "InventoryAgeSnapshot";
DROP TABLE IF EXISTS "InventoryLedgerSummary";
DROP TABLE IF EXISTS "InventoryLedgerEntry";
DROP TABLE IF EXISTS "InventoryDailySnapshot";

ALTER TABLE "FbaInventoryRecord" DROP CONSTRAINT IF EXISTS "fba_inventory_source_check";
ALTER TABLE "FbaInventoryRecord" ADD COLUMN "healthStatus" TEXT NOT NULL DEFAULT 'HEALTHY';
UPDATE "FbaInventoryRecord" SET "healthStatus" = CASE WHEN "fulfillableQuantity" < 20 THEN 'LOW_STOCK' ELSE 'HEALTHY' END;
CREATE INDEX "FbaInventoryRecord_tenantId_healthStatus_daysOfSupply_idx" ON "FbaInventoryRecord"("tenantId", "healthStatus", "daysOfSupply");
DROP INDEX IF EXISTS "FbaInventoryRecord_tenantId_daysOfSupply_idx";
ALTER TABLE "FbaInventoryRecord" DROP COLUMN "realtimeSyncedAt", DROP COLUMN "source";
