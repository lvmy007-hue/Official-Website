-- M-P3-15 回滚：删除广告报告任务新增的列与约束、广告档案上的历史可用起点。
-- 说明：新报告接口任务的模板、维度、行数、警告与重试关系会丢失（任务行本身保留，退化成旧任务）；
-- 已经导入的指标数据不受影响；历史可用起点可由下一次日粒度报告任务重新登记。

ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "historyProbedAt";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "historyFrom";

DROP INDEX IF EXISTS "AdsReportJob_source_idx";
ALTER TABLE "AdsReportJob" DROP CONSTRAINT IF EXISTS "AdsReportJob_rows_check";
ALTER TABLE "AdsReportJob" DROP CONSTRAINT IF EXISTS "AdsReportJob_attempt_check";
ALTER TABLE "AdsReportJob" DROP CONSTRAINT IF EXISTS "AdsReportJob_v1_spec_check";
ALTER TABLE "AdsReportJob" DROP CONSTRAINT IF EXISTS "AdsReportJob_granularity_check";
ALTER TABLE "AdsReportJob" DROP CONSTRAINT IF EXISTS "AdsReportJob_source_check";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "finishedAt";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "startedAt";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "requestedBy";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "attempt";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "retryOfId";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "failureMessage";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "warningSignals";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "skippedRows";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "importedRows";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "metricKeys";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "dimensions";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "granularity";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "templateKey";
ALTER TABLE "AdsReportJob" DROP COLUMN IF EXISTS "source";
