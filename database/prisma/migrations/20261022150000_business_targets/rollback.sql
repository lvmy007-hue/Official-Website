-- M-P2a-04 回滚：移除经营目标表。
-- 说明：目标值是人工在页面设置的业务数据，不是派生数据，删除后不可恢复，回滚前请先导出。
DROP TABLE IF EXISTS "BusinessTarget";
