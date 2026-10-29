-- M-P5-06 回滚：删除 SyncJob 在同步中心包里新增的两列。
-- 说明：任务行保留；写入统计与过程时间线丢失；已导入的业务数据不受影响。

ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "timelineJson";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "resultJson";
