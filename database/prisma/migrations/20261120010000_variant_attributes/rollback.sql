-- M-P4-03 回滚：去掉 FbaProduct 的变体属性列与父体索引。
-- 说明：variantAttributes 由目录同步器（I-09）每日重建，回滚不丢失手工数据。
DROP INDEX IF EXISTS "FbaProduct_parent_idx";
ALTER TABLE "FbaProduct" DROP COLUMN IF EXISTS "variantAttributes";
