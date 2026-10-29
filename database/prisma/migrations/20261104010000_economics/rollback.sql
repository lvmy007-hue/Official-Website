-- M-P2b-11 回滚：删除官方经济数据两张表。
-- 说明：两张表的内容都是从亚马逊数据中心拉取的数据（没有人工录入），回滚后下一次定时任务会重新拉取；30 天保留期内的历史查询结果可重新下载，更早的日期以亚马逊保留为准。
DROP TABLE IF EXISTS "EconomicsPreview";
DROP TABLE IF EXISTS "EconomicsDaily";
