-- M-P2b-01 回滚：去掉 3 个索引，并去掉 Order 的订单项目标记与销售渠道两列（两列都由订单同步器重建，回滚不丢手工数据）。
DROP INDEX IF EXISTS "FbaFinancialTransaction_tenantId_amazonOrderId_idx";
DROP INDEX IF EXISTS "FbaFeeEvent_tenantId_amazonOrderId_idx";
DROP INDEX IF EXISTS "Order_tenantId_replacedOrderId_idx";
ALTER TABLE "Order" DROP COLUMN IF EXISTS "programs", DROP COLUMN IF EXISTS "salesChannel";
