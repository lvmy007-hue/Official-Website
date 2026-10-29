-- M-P5-03 报表中心：FbaReportJob 加导入统计、字段变化警告、状态时间线、失败说明与重试关系。
-- 依据：09 章 9.3，14 章 P5-03，freeze/api.md /reports*，freeze/importers.md 第三节。
--
-- 内容：
--   FbaReportJob 新增列：
--     syncJobId        关联的同步任务（旧任务为空，详情页按任务上下文兜底查找）；
--     readRows、importedRows、skippedRows  读到、写入、因缺关键字段被跳过的行数（没导入过是空，不是 0）；
--     columnsJson      报告文件的字段名（最多 80 个），用来和上一份同类报告对比出“新出现的字段”；
--     warningsJson     解析警告（字段变化）；
--     failureMessage   失败原因（中文说明）；failureCode 沿用原列；
--     timelineJson     状态时间线（最多 40 条：已创建、已申请、亚马逊侧处理状态、下载解析、完成、失败、取消、重试）；
--     retryOfId、attempt  重试关系：重试建新任务，指向被重试的任务（没有外键）；
--     startedAt、finishedAt  开始与结束时间。
--   状态取值检查约束：PENDING、GENERATING、READY、FAILED、CANCELLED（新增 CANCELLED：报表中心可取消没结束的任务）。
--   检查约束：尝试次数不小于 1；行数不为负。索引：(租户, 报告类型, 创建时间) 用于找同类上一份报告，(租户, 重试来源) 用于判断是否已被重试。
-- 与冻结的出入：冻结没有给 FbaReportJob 列这些字段，是为详情页的导入统计、解析警告、时间线与重试补的；没有新增表，不需要新的行级安全与授权。
-- 冻结里的 ReportSubscription（报表订阅）本包没有建（见 CR-093）。
--
-- 回滚方法：见同目录 rollback.sql（删除新增列、约束与索引；任务行保留，统计、时间线与警告丢失；已取消的任务回滚前要先改成 FAILED，否则状态约束删除后仍可读但页面不认识）。

ALTER TABLE "FbaReportJob" ADD COLUMN "syncJobId" TEXT;
ALTER TABLE "FbaReportJob" ADD COLUMN "readRows" INTEGER;
ALTER TABLE "FbaReportJob" ADD COLUMN "importedRows" INTEGER;
ALTER TABLE "FbaReportJob" ADD COLUMN "skippedRows" INTEGER;
ALTER TABLE "FbaReportJob" ADD COLUMN "columnsJson" JSONB;
ALTER TABLE "FbaReportJob" ADD COLUMN "warningsJson" JSONB;
ALTER TABLE "FbaReportJob" ADD COLUMN "failureMessage" TEXT;
ALTER TABLE "FbaReportJob" ADD COLUMN "timelineJson" JSONB;
ALTER TABLE "FbaReportJob" ADD COLUMN "retryOfId" TEXT;
ALTER TABLE "FbaReportJob" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "FbaReportJob" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "FbaReportJob" ADD COLUMN "finishedAt" TIMESTAMP(3);

ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_status_check" CHECK ("status" IN ('PENDING', 'GENERATING', 'READY', 'FAILED', 'CANCELLED'));
ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "FbaReportJob" ADD CONSTRAINT "FbaReportJob_rows_check" CHECK (
  ("readRows" IS NULL OR "readRows" >= 0) AND ("importedRows" IS NULL OR "importedRows" >= 0) AND ("skippedRows" IS NULL OR "skippedRows" >= 0)
);

CREATE INDEX "FbaReportJob_type_idx" ON "FbaReportJob"("tenantId", "reportType", "createdAt");
CREATE INDEX "FbaReportJob_retry_idx" ON "FbaReportJob"("tenantId", "retryOfId");
