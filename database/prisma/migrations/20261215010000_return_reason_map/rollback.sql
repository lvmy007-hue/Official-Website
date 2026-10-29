-- 回滚 M-P6-13：删除退货原因映射表，去掉退货记录上的下单时间、发货时间两列与它们的索引。
-- 企业维护过的映射随表一起删除（预置映射在代码里，不受影响）；两列的数据可以由订单重新回填（重新升级时迁移会做一次）。
DROP INDEX IF EXISTS "FbaReturnCase_orderdate_idx";
ALTER TABLE "FbaReturnCase" DROP COLUMN IF EXISTS "orderPurchasedAt";
ALTER TABLE "FbaReturnCase" DROP COLUMN IF EXISTS "orderShippedAt";
DROP TABLE IF EXISTS "ReturnReasonMap";
