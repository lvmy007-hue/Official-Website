-- M-P1-12 回滚：手工执行；同时需从 _prisma_migrations 删除本迁移记录，并回退 schema.prisma。
-- 注意：回滚会丢失成员的数据范围授权与广告账户绑定关系，请先确认已导出。
DROP INDEX IF EXISTS "AdsProfile_sellerAccountId_idx";
ALTER TABLE "AdsProfile" DROP CONSTRAINT IF EXISTS "AdsProfile_sellerAccountId_fkey";
ALTER TABLE "AdsProfile" DROP CONSTRAINT IF EXISTS "AdsProfile_bindingStatus_check";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "boundBy";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "bindingStatus";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "sellerAccountId";
DROP TABLE IF EXISTS "MembershipScope";
