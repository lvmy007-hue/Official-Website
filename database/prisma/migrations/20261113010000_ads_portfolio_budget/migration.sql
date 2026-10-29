-- M-P3-11 广告组合与预算：AdsPortfolio 加预算起止日，新增 AdsBudgetRule。
-- 依据：freeze/models.md AdsBudgetRule（M-P3-11）、08 章 8.8、14 章 P3-11。
--
-- 内容：
--   一、AdsPortfolio 加 budgetStart、budgetEnd（“指定日期范围”预算的起止日，按月预算不用；没给就是空）。冻结表没有这两列，
--      但没有起止日就算不出日期范围预算的节奏；检查约束保证起止日成对出现且起日不晚于止日。
--   二、AdsBudgetRule（预算规则，亚马逊广告统一接口测试版资源的本地副本）：唯一键 (tenantId, adsAccountId, campaignId, ruleType)，
--      带 adsProfileId（范围过滤）与指向 AdsAccount 的级联外键；行级安全与授权同其他租户表。
-- 与冻结的出入：唯一键加了 tenantId（与 P3-02 其他新表一致）；多了 adsProfileId 与同步表统一字段。
-- 本迁移之后没有同步器写 AdsBudgetRule（测试版资源，见 verification-log 第 10 节），表是空的。
--
-- 回滚方法：见同目录 rollback.sql（删除 AdsBudgetRule 与 AdsPortfolio 新增的两列）。

ALTER TABLE "AdsPortfolio" ADD COLUMN "budgetStart" DATE;
ALTER TABLE "AdsPortfolio" ADD COLUMN "budgetEnd" DATE;
ALTER TABLE "AdsPortfolio" ADD CONSTRAINT "AdsPortfolio_budget_range_check" CHECK (
  ("budgetStart" IS NULL AND "budgetEnd" IS NULL) OR ("budgetStart" IS NOT NULL AND "budgetEnd" IS NOT NULL AND "budgetStart" <= "budgetEnd")
);

CREATE TABLE "AdsBudgetRule" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "ruleType" TEXT NOT NULL,
  "paramsJson" JSONB NOT NULL,
  "status" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsBudgetRule_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsBudgetRule_uq" ON "AdsBudgetRule"("tenantId", "adsAccountId", "campaignId", "ruleType");
CREATE INDEX "AdsBudgetRule_profile_idx" ON "AdsBudgetRule"("adsProfileId");

ALTER TABLE "AdsBudgetRule" ADD CONSTRAINT "AdsBudgetRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsBudgetRule" ADD CONSTRAINT "AdsBudgetRule_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsBudgetRule" ADD CONSTRAINT "AdsBudgetRule_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "AdsBudgetRule" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "AdsBudgetRule" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AdsBudgetRule" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AdsBudgetRule" TO nova_system;
  END IF;
END $$;
