-- 回滚 M-P6-08：删除 ShipFromAddress，并把 FbaInboundPlan 的来源类型检查约束还原成 P2a-12 的取值。
-- 已经由补货批次生成的草稿保留：来源类型 REPLENISHMENT_BATCH 先改回 REPLENISHMENT（同样表示补货来源，sourceRefId 里的批次编号不变），
-- 计划与地址的关联会丢失（地址表被删），计划里已经存的 sourceAddress 文本不受影响。
ALTER TABLE "FbaInboundPlan" DROP CONSTRAINT IF EXISTS "FbaInboundPlan_inbound_check";
UPDATE "FbaInboundPlan" SET "sourceType" = 'REPLENISHMENT' WHERE "sourceType" = 'REPLENISHMENT_BATCH';
ALTER TABLE "FbaInboundPlan" ADD CONSTRAINT "FbaInboundPlan_inbound_check" CHECK (
  "stage" IN ('DRAFT', 'ELIGIBILITY', 'CREATED', 'PACKING_CONFIRMED', 'PACKING_INFO_SUBMITTED', 'PLACEMENT_CONFIRMED', 'TRANSPORT_CONFIRMED', 'LABELS_PRINTED', 'SHIPPED', 'RECEIVING', 'DISCREPANCY', 'COMPLETED', 'CANCELLED')
  AND "sourceType" IN ('MANUAL', 'REPLENISHMENT', 'PURCHASE_ORDER')
  AND "prepOwner" = 'SELLER' AND "labelOwner" = 'SELLER'
  AND ("shippingMode" IS NULL OR "shippingMode" IN ('SPD', 'LTL', 'FTL'))
  AND ("prepCost" IS NULL OR "prepCost" >= 0) AND ("labelCost" IS NULL OR "labelCost" >= 0)
  AND "version" >= 1);
ALTER TABLE "FbaInboundPlan" DROP CONSTRAINT IF EXISTS "FbaInboundPlan_shipFromAddressId_fkey";
DROP INDEX IF EXISTS "FbaInboundPlan_shipFromAddressId_idx";
ALTER TABLE "FbaInboundPlan" DROP COLUMN IF EXISTS "shipFromAddressId";
DROP TABLE IF EXISTS "ShipFromAddress";
