-- M-P6-06 统一事件接口（GET /events）的两个读取索引：按店铺与时间倒序取预警与 Listing 变更，每类最多 201 行。
-- 只加索引，不改列、不改约束、不动数据。
-- 回滚方法：见同目录 rollback.sql（删掉这两个索引）。
CREATE INDEX IF NOT EXISTS "AlertInstance_store_time_idx" ON "AlertInstance" ("tenantId", "sellerAccountId", "firstTriggeredAt");
CREATE INDEX IF NOT EXISTS "ListingChangeEvent_store_time_idx" ON "ListingChangeEvent" ("sellerAccountId", "occurredAt");
