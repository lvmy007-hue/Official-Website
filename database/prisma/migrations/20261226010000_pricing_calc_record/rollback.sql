-- 回滚 M-P6-29：删除新品定价试算记录表（含索引与行级安全策略）。
-- 丢失的数据：已保存的试算与 24 小时参数缓存。不影响商品、订单与费用事件。
DROP TABLE IF EXISTS "PricingCalcRecord";
