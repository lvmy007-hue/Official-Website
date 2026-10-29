-- M-P2a-11 回滚：删除头程物流新增的表。
-- 说明：运单、明细、费用、节点、分摊结果与时效统计都是业务记录，删除后不可恢复，回滚前请先导出；
-- 分摊时写入的成本版本草稿（CostVersion.source = FIRST_MILE_ALLOCATION）不随回滚删除，需要时按来源手工清理；
-- 已记的国内仓“头程发货”出库流水（InventoryMovement.movementType = FIRST_MILE_OUT）保留，库存数量不变。
-- 附件登记（Attachment.entityType = FIRST_MILE）保留在原表，文件本身留在对象存储里。
DROP TABLE IF EXISTS "TransitTimeStat";
DROP TABLE IF EXISTS "LandedCostAllocation";
DROP TABLE IF EXISTS "FirstMileMilestone";
DROP TABLE IF EXISTS "FirstMileCost";
DROP TABLE IF EXISTS "FirstMileShipmentItem";
DROP TABLE IF EXISTS "FirstMileShipment";
DROP TABLE IF EXISTS "FreightForwarder";
