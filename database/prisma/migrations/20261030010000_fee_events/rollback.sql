-- M-P2b-05 回滚：去掉费用事件的分类、子类型、交易状态、对账状态与备注、版本列，以及对应的索引与检查约束。
-- 说明：分类、子类型、交易状态可由财务同步器重新写入（下一次财务同步的 14 天重拉与新的写入会补上，历史部分需要重新回补）；
--       对账状态、备注、对账人、对账时间、版本是人工录入的内容，回滚会丢失，回滚前请先导出费用事件。
ALTER TABLE "FbaFeeEvent" DROP CONSTRAINT IF EXISTS "FbaFeeEvent_feeCategory_check";
ALTER TABLE "FbaFeeEvent" DROP CONSTRAINT IF EXISTS "FbaFeeEvent_reconciliationStatus_check";
ALTER TABLE "FbaFeeEvent" DROP CONSTRAINT IF EXISTS "FbaFeeEvent_version_check";
DROP INDEX IF EXISTS "FbaFeeEvent_tenantId_feeCategory_postedAt_idx";
ALTER TABLE "FbaFeeEvent"
DROP COLUMN IF EXISTS "feeCategory",
DROP COLUMN IF EXISTS "feeSubtype",
DROP COLUMN IF EXISTS "transactionStatus",
DROP COLUMN IF EXISTS "reconciliationStatus",
DROP COLUMN IF EXISTS "reconciliationNote",
DROP COLUMN IF EXISTS "reconciledBy",
DROP COLUMN IF EXISTS "reconciledAt",
DROP COLUMN IF EXISTS "version";
