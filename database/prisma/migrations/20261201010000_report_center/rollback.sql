-- M-P5-03 回滚：删除 FbaReportJob 在报表中心包里新增的列、约束与索引。
-- 说明：任务行保留；导入统计、字段变化警告、状态时间线、失败说明与重试关系丢失；已导入的业务数据不受影响。
-- 已取消（CANCELLED）的任务回滚后状态约束不再存在，旧页面不认识这个状态，建议回滚前执行：
--   UPDATE "FbaReportJob" SET "status" = 'FAILED', "failureCode" = 'REPORT_CANCELLED' WHERE "status" = 'CANCELLED';

DROP INDEX IF EXISTS "FbaReportJob_retry_idx";
DROP INDEX IF EXISTS "FbaReportJob_type_idx";
ALTER TABLE "FbaReportJob" DROP CONSTRAINT IF EXISTS "FbaReportJob_rows_check";
ALTER TABLE "FbaReportJob" DROP CONSTRAINT IF EXISTS "FbaReportJob_attempt_check";
ALTER TABLE "FbaReportJob" DROP CONSTRAINT IF EXISTS "FbaReportJob_status_check";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "finishedAt";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "startedAt";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "attempt";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "retryOfId";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "timelineJson";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "failureMessage";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "warningsJson";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "columnsJson";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "skippedRows";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "importedRows";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "readRows";
ALTER TABLE "FbaReportJob" DROP COLUMN IF EXISTS "syncJobId";
