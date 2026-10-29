-- M-P3-12 回滚：删除分时策略的执行记录与策略两张表。
-- 说明：DaypartingStrategy 是用户配置的策略（没有别处可恢复），回滚前请先导出；DaypartingRun 目前没有程序写入，通常是空表。

DROP TABLE IF EXISTS "DaypartingRun";
DROP TABLE IF EXISTS "DaypartingStrategy";
