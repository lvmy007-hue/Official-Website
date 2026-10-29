-- M-P3-01 回滚：删除广告连接器的五张表。
-- 说明：推荐的人工处理结果（已采纳、已忽略）与旧版核对记录会丢失，请先导出；预测记录同样丢失。
DROP TABLE IF EXISTS "AdsParityDiff";
DROP TABLE IF EXISTS "AdsParityRun";
DROP TABLE IF EXISTS "AdsParityState";
DROP TABLE IF EXISTS "AdsForecastRun";
DROP TABLE IF EXISTS "AdsRecommendation";
