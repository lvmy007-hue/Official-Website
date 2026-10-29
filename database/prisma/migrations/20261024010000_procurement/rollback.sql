-- M-P2a-10 回滚：删除采购、国内仓新增的表与列。
-- 说明：收货、质检、付款、审批、附件记录、盘点单与成本版本草稿都是业务记录，删除后不可恢复，回滚前请先导出；
-- 附件文件本身留在对象存储里（只删除数据库里的登记），需要时按存储生命周期清理。
-- 国内仓入库流水（InventoryMovement 里 reasonCode 不为空的行）保留，只是不再带原因码、占用数量与入库成本。
DROP TABLE IF EXISTS "CostVersion";
DROP TABLE IF EXISTS "StockCount";
DROP TABLE IF EXISTS "Attachment";
DROP TABLE IF EXISTS "PurchaseApproval";
DROP TABLE IF EXISTS "PurchasePayment";
DROP TABLE IF EXISTS "QualityInspection";
DROP TABLE IF EXISTS "PurchaseReceipt";

ALTER TABLE "InventoryMovement" DROP COLUMN IF EXISTS "reasonCode", DROP COLUMN IF EXISTS "lockedForShipment", DROP COLUMN IF EXISTS "unitCost", DROP COLUMN IF EXISTS "currency", DROP COLUMN IF EXISTS "createdBy";

ALTER TABLE "Warehouse" DROP CONSTRAINT IF EXISTS "Warehouse_costMethod_check";
ALTER TABLE "Warehouse" DROP COLUMN IF EXISTS "costMethod";

ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_status_check";
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_approval_check";
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_payment_check";
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "PurchaseOrder_received_check";
ALTER TABLE "PurchaseOrder" DROP COLUMN IF EXISTS "approvalStatus", DROP COLUMN IF EXISTS "paymentStatus", DROP COLUMN IF EXISTS "receivedQtyTotal", DROP COLUMN IF EXISTS "submittedAt", DROP COLUMN IF EXISTS "orderedAt", DROP COLUMN IF EXISTS "completedAt";

ALTER TABLE "Supplier" DROP CONSTRAINT IF EXISTS "Supplier_metrics_check";
ALTER TABLE "Supplier" DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "onTimeRate", DROP COLUMN IF EXISTS "qualityPassRate", DROP COLUMN IF EXISTS "avgLeadDays", DROP COLUMN IF EXISTS "rating", DROP COLUMN IF EXISTS "metricsAt";
