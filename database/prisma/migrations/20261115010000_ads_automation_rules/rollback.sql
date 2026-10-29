-- M-P3-13 回滚：删除自动规则的执行记录与规则两张表。
-- 说明：AdsAutomationRule 是用户配置的规则（没有别处可恢复），回滚前请先导出；AdsAutomationRun 是评估留下的记录，回滚后丢失，已生成的待办不受影响。

DROP TABLE IF EXISTS "AdsAutomationRun";
DROP TABLE IF EXISTS "AdsAutomationRule";
