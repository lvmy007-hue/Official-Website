-- 回滚 M-P6-26：删除运单上的渠道与预估时间两列，再删除 ChannelRate、CarrierChannel、Carrier（含索引、约束与行级安全策略）。
-- 丢失的数据：物流商、渠道、阶梯报价，以及运单上“预估依据哪个渠道、何时采用”的记录。
-- 运单上已经保存的预估费用金额（estimatedCost）保留，只是不再能追溯到渠道。
ALTER TABLE "FirstMileShipment" DROP CONSTRAINT IF EXISTS "FirstMileShipment_carrierChannelId_fkey";
DROP INDEX IF EXISTS "FirstMileShipment_channel_idx";
ALTER TABLE "FirstMileShipment" DROP COLUMN IF EXISTS "carrierChannelId";
ALTER TABLE "FirstMileShipment" DROP COLUMN IF EXISTS "estimatedAt";
DROP TABLE IF EXISTS "ChannelRate";
DROP TABLE IF EXISTS "CarrierChannel";
DROP TABLE IF EXISTS "Carrier";
