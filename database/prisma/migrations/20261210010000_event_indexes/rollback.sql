-- M-P6-06 回滚：删掉统一事件接口新增的两个索引（接口会变慢，但结果不变）。
DROP INDEX IF EXISTS "AlertInstance_store_time_idx";
DROP INDEX IF EXISTS "ListingChangeEvent_store_time_idx";
