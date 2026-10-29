-- M-P2a-12 回滚：删除入仓计划新增的表与列。
-- 说明：这些都是业务记录（方案、箱子、操作时间线、标签任务），删除后不可恢复，回滚前请先导出；
-- 对象存储里的标签文件不随回滚删除；FbaInboundPlan 的旧 status 列没有被修改，回滚后旧页面继续可用。
DROP TABLE IF EXISTS "InboundOperation";
DROP TABLE IF EXISTS "LabelPrintJob";
DROP TABLE IF EXISTS "TrackingEvent";
DROP TABLE IF EXISTS "ShipmentItem";
DROP TABLE IF EXISTS "DeliveryWindow";
DROP TABLE IF EXISTS "TransportOption";
DROP TABLE IF EXISTS "PlacementOption";
DROP TABLE IF EXISTS "InboundBox";
DROP TABLE IF EXISTS "PackingGroup";
DROP TABLE IF EXISTS "PackingOption";
DROP TABLE IF EXISTS "InboundEligibilityCheck";
DROP TABLE IF EXISTS "InboundPlanItem";
DROP INDEX IF EXISTS "FbaInboundPlan_stage_idx";
ALTER TABLE "FbaInboundShipment" DROP CONSTRAINT IF EXISTS "FbaInboundShipment_inbound_check";
ALTER TABLE "FbaInboundPlan" DROP CONSTRAINT IF EXISTS "FbaInboundPlan_inbound_check";
ALTER TABLE "FbaInboundShipment"
  DROP COLUMN IF EXISTS "shipmentConfirmationId", DROP COLUMN IF EXISTS "receivedFirstAt", DROP COLUMN IF EXISTS "receivedDoneAt", DROP COLUMN IF EXISTS "carrier",
  DROP COLUMN IF EXISTS "boxCount", DROP COLUMN IF EXISTS "trackingJson", DROP COLUMN IF EXISTS "selectedTransportOptionId", DROP COLUMN IF EXISTS "selectedWindowId";
ALTER TABLE "FbaInboundPlan"
  DROP COLUMN IF EXISTS "stage", DROP COLUMN IF EXISTS "sourceType", DROP COLUMN IF EXISTS "sourceRefId", DROP COLUMN IF EXISTS "prepOwner", DROP COLUMN IF EXISTS "labelOwner",
  DROP COLUMN IF EXISTS "pendingOp", DROP COLUMN IF EXISTS "selectedPackingOptionId", DROP COLUMN IF EXISTS "selectedPlacementOptionId", DROP COLUMN IF EXISTS "shippingMode",
  DROP COLUMN IF EXISTS "transportConfirmedAt", DROP COLUMN IF EXISTS "voidDeadlineAt", DROP COLUMN IF EXISTS "shippedAt", DROP COLUMN IF EXISTS "estimateJson",
  DROP COLUMN IF EXISTS "prepCost", DROP COLUMN IF EXISTS "labelCost", DROP COLUMN IF EXISTS "costCurrency", DROP COLUMN IF EXISTS "lastErrorCode", DROP COLUMN IF EXISTS "lastErrorMessage",
  DROP COLUMN IF EXISTS "version", DROP COLUMN IF EXISTS "createdBy";