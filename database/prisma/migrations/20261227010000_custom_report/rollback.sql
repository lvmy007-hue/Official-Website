-- 回滚 M-P6-32：删除自定义指标与我的报表（含索引与行级安全策略）。
-- 丢失的数据：已保存的自定义指标、报表配置、收藏与定时。不影响商品、订单与利润日表。
DROP TABLE IF EXISTS "CustomReport";
DROP TABLE IF EXISTS "CustomMetric";
