-- M-P2a-01 回滚：移除经营日汇总与 ASIN 日汇总。
-- 说明：汇总表由派生任务根据订单与财务交易计算，删除后可重新计算，不丢失原始数据。
DROP TABLE IF EXISTS "AsinDailySummary";
DROP TABLE IF EXISTS "StoreDailySummary";
