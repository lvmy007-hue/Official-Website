-- M-P4-07 回滚：去掉 FbaProduct 的乐观锁版本号与负责人索引。
-- 说明：负责人（ownerUserId）与标签（tagIds）列本身保留（P2a-14 已有），回滚只丢失版本号，不丢失手工设置的负责人与标签。
DROP INDEX IF EXISTS "FbaProduct_owner_idx";
ALTER TABLE "FbaProduct" DROP COLUMN IF EXISTS "version";
