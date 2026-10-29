-- M-P2b-02 回滚：去掉 2 个索引与 7 个新列，恢复旧唯一键。
-- 旧唯一键不区分退货件编号：同一订单、ASIN、退货时间若有多行，只保留最早创建的一行（其余是报告重复导入的明细，下次报告导入会按旧键重新写入）。
DROP INDEX IF EXISTS "FbaReturnCase_order_idx";
DROP INDEX IF EXISTS "FbaReturnCase_date_idx";
DROP INDEX IF EXISTS "FbaReturnCase_report_uq";

DELETE FROM "FbaReturnCase" a
USING "FbaReturnCase" b
WHERE a."sellerAccountId" = b."sellerAccountId"
  AND a."amazonOrderId" = b."amazonOrderId"
  AND a."asin" = b."asin"
  AND a."returnDate" = b."returnDate"
  AND (a."createdAt", a."id") > (b."createdAt", b."id");

ALTER TABLE "FbaReturnCase"
  DROP COLUMN IF EXISTS "fnsku",
  DROP COLUMN IF EXISTS "licensePlateNumber",
  DROP COLUMN IF EXISTS "detailedDisposition",
  DROP COLUMN IF EXISTS "fulfillmentCenterId",
  DROP COLUMN IF EXISTS "reportStatus",
  DROP COLUMN IF EXISTS "customerComments",
  DROP COLUMN IF EXISTS "reimbursementCaseId";

CREATE UNIQUE INDEX "FbaReturnCase_sellerAccountId_amazonOrderId_asin_returnDate_key" ON "FbaReturnCase"("sellerAccountId", "amazonOrderId", "asin", "returnDate");