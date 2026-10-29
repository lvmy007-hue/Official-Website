-- M-P2a-08 回滚：删除上游仓储（AWD）的 4 张表。
-- 说明：库存快照、货件与明细可由同步器重新拉取；入库订单里的本地草稿、提交失败记录与操作结果是业务记录，删除后不可恢复，回滚前请先导出。
DROP TABLE IF EXISTS "AwdShipmentItem";
DROP TABLE IF EXISTS "AwdInboundShipment";
DROP TABLE IF EXISTS "AwdInboundOrder";
DROP TABLE IF EXISTS "AwdInventory";