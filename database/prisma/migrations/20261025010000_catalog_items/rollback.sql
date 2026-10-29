-- M-P2a-14 回滚：删除 ProductVariantRelation、SalesRankSnapshot，并去掉 FbaProduct 的 7 个目录列。
-- 说明：两张表与目录列都由目录同步器（I-09）每日重建，回滚不丢失手工数据；
-- 唯一例外是 ownerUserId、tagIds（系统内的负责人与标签），回滚会丢失，回滚前请先导出。
DROP TABLE IF EXISTS "ProductVariantRelation";
DROP TABLE IF EXISTS "SalesRankSnapshot";
ALTER TABLE "FbaProduct" DROP CONSTRAINT IF EXISTS "FbaProduct_catalogStatus_check";
ALTER TABLE "FbaProduct"
  DROP COLUMN IF EXISTS "parentAsin",
  DROP COLUMN IF EXISTS "imageUrl",
  DROP COLUMN IF EXISTS "categoryPath",
  DROP COLUMN IF EXISTS "ownerUserId",
  DROP COLUMN IF EXISTS "tagIds",
  DROP COLUMN IF EXISTS "catalogStatus",
  DROP COLUMN IF EXISTS "catalogSyncedAt";
