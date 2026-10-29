-- M-P3-15 广告报表与广告指标：AdsReportJob 加新报告接口任务所需的列，AdsProfile 登记历史可用起点。
-- 依据：08 章 8.12、8.13，14 章 P3-15（含 CR-001 补充：回补时登记日级数据的实际可用起点），freeze/importers.md A-02。
--
-- 内容：
--   一、AdsReportJob 新增（旧任务全部是 LEGACY，不动）：
--      source           LEGACY 旧版报告接口 / V1 新报告接口（Reporting API v1）；
--      templateKey      模板键（活动、广告组、投放对象、搜索词、广告商品、广告位、小时、转化商品）；
--      granularity      HOURLY / DAILY / MONTHLY；
--      dimensions、metricKeys  任务实际请求的维度与指标（页面“报告任务”列表展示）；
--      importedRows、skippedRows  导入与跳过的行数（没完成时为空）；
--      warningSignals   报告返回的警告信号（原样保存，数据照常入库）；
--      failureMessage   失败原因（中文说明）；failureCode 沿用原列；
--      retryOfId、attempt  重试关系：重试建一个新任务，指向被重试的任务；
--      requestedBy、startedAt、finishedAt  谁提交、何时开始与结束。
--      检查约束：来源与粒度取值；V1 任务必须带模板、粒度与起止日期；尝试次数不小于 1；行数不为负。
--   二、AdsProfile 新增 historyFrom（已取得日级数据的最早日期，只由完成的日粒度报告任务登记，只往前推不往后退）与
--      historyProbedAt（最近一次登记的时间）。亚马逊日级数据保留期官方有 15 与 24 个月两种说法（CR-001），这一列是实测值，不是承诺值。
-- 与冻结的出入：冻结的 AdsReportJob 没有这些列，是为页面展示与重试补的；没有新增表，所以不需要新的行级安全与授权。
--
-- 回滚方法：见同目录 rollback.sql（删除新增列与约束；已有任务记录保留，V1 任务退化成没有模板信息的旧任务）。

ALTER TABLE "AdsReportJob" ADD COLUMN "source" TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "AdsReportJob" ADD COLUMN "templateKey" TEXT;
ALTER TABLE "AdsReportJob" ADD COLUMN "granularity" TEXT;
ALTER TABLE "AdsReportJob" ADD COLUMN "dimensions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AdsReportJob" ADD COLUMN "metricKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "AdsReportJob" ADD COLUMN "importedRows" INTEGER;
ALTER TABLE "AdsReportJob" ADD COLUMN "skippedRows" INTEGER;
ALTER TABLE "AdsReportJob" ADD COLUMN "warningSignals" JSONB;
ALTER TABLE "AdsReportJob" ADD COLUMN "failureMessage" TEXT;
ALTER TABLE "AdsReportJob" ADD COLUMN "retryOfId" TEXT;
ALTER TABLE "AdsReportJob" ADD COLUMN "attempt" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "AdsReportJob" ADD COLUMN "requestedBy" TEXT;
ALTER TABLE "AdsReportJob" ADD COLUMN "startedAt" TIMESTAMP(3);
ALTER TABLE "AdsReportJob" ADD COLUMN "finishedAt" TIMESTAMP(3);

ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_source_check" CHECK ("source" IN ('LEGACY', 'V1'));
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_granularity_check" CHECK ("granularity" IS NULL OR "granularity" IN ('HOURLY', 'DAILY', 'MONTHLY'));
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_v1_spec_check" CHECK (
  "source" = 'LEGACY' OR ("templateKey" IS NOT NULL AND "granularity" IS NOT NULL AND "fromDate" IS NOT NULL AND "toDate" IS NOT NULL)
);
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_attempt_check" CHECK ("attempt" >= 1);
ALTER TABLE "AdsReportJob" ADD CONSTRAINT "AdsReportJob_rows_check" CHECK (("importedRows" IS NULL OR "importedRows" >= 0) AND ("skippedRows" IS NULL OR "skippedRows" >= 0));
CREATE INDEX "AdsReportJob_source_idx" ON "AdsReportJob"("tenantId", "source", "createdAt");

ALTER TABLE "AdsProfile" ADD COLUMN "historyFrom" DATE;
ALTER TABLE "AdsProfile" ADD COLUMN "historyProbedAt" TIMESTAMP(3);
