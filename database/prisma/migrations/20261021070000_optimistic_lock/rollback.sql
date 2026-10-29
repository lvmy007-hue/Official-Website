-- M-P1-15 回滚：移除采购单版本号（版本号本身是派生的并发控制信息，丢失不影响业务数据）。
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "version";
