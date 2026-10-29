-- M-P3-04 回滚：移除广告日汇总。
-- 说明：汇总表由派生任务根据 AdsMetric 计算，删除后可重新计算，不丢失原始数据。
DROP TABLE IF EXISTS "AdsDailySummary";
