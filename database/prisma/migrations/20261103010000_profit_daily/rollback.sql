-- M-P2b-09 回滚：删除利润日表。
-- 说明：利润日表是派生数据（由订单、财务明细、广告、成本版本、汇率计算），回滚后重新运行派生任务 profit_daily 即可重建；没有人工录入的数据。
DROP TABLE IF EXISTS "ProfitDaily";
