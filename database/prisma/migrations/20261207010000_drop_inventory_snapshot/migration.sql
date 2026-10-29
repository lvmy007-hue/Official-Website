-- M-P5-12 删除旧表 InventorySnapshot（G-10 / D-08）。
-- 依据：freeze/models.md G-10。行已在 P2a-05（20261022160000_inventory_sync）迁入 InventoryDailySnapshot（source = API）。
-- 运行代码不再读写这张表。删除前把还没有对应当日快照的行再补迁一遍（与 P2a-05 同一段数据迁移，幂等：已存在的行不覆盖），
-- 避免 P2a-05 之后、旧版本仍在运行期间写进旧表的行随表丢失。
--
-- 回滚方法：见同目录 rollback.sql（只重建空表，不把当日快照的行复制回来）。

INSERT INTO "InventoryDailySnapshot" ("id", "tenantId", "sellerAccountId", "snapshotDate", "sku", "fnsku", "asin", "sellable", "inbound", "reserved", "source", "sourceUpdatedAt", "syncedAt", "sourceReportJobId", "sourceRecordId", "updatedAt")
SELECT 'legacy-' || s."id", s."tenantId", s."sellerAccountId", (timezone('UTC', s."sourceUpdatedAt"))::date, s."sku", '', '', s."available", s."inbound", s."reserved", 'API', s."sourceUpdatedAt", s."syncedAt", s."sourceReportJobId", s."sourceRecordId", CURRENT_TIMESTAMP
FROM "InventorySnapshot" s
ON CONFLICT DO NOTHING;

DROP TABLE "InventorySnapshot";
