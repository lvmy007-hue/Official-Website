-- M-P3-04 广告日汇总：AdsDailySummary（广告档案 × 广告产品 × 活动 × 日 × 币种）。
-- 依据：freeze/models.md 第七节（10.1 广告日汇总）、10 章 10.1、14 章 P3-04。
--
-- 内容：
--   一、新增 1 张表；数据由派生任务 ads_daily_summary 从 AdsMetric（entityType = CAMPAIGN）先删后写，可重复执行。
--   二、键用 adsProfileId（档案，永远有值），不存店铺编号：店铺绑定会变化，读取方按 AdsProfile.sellerAccountId 过滤范围。
--   三、spend、sales 可空：来源行都没给就是空，不是 0。
--   四、行级安全与授权（与其他租户表一致）。
--
-- 回滚方法：见同目录 rollback.sql（只删除这张表；汇总可由派生任务重新计算，不丢失原始数据）。
-- 本迁移只新增表，不修改、不删除任何既有对象。

CREATE TABLE "AdsDailySummary" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "adsAccountId" TEXT,
    "adProduct" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL DEFAULT '',
    "summaryDate" DATE NOT NULL,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "spend" DECIMAL(20,6),
    "sales" DECIMAL(20,6),
    "orders" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "metricVersion" TEXT NOT NULL,
    "refreshedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsDailySummary_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AdsDailySummary_counts_check" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "orders" >= 0)
);

CREATE UNIQUE INDEX "AdsDailySummary_uq" ON "AdsDailySummary"("tenantId", "adsProfileId", "adProduct", "campaignId", "summaryDate", "currency");
CREATE INDEX "AdsDailySummary_date_idx" ON "AdsDailySummary"("tenantId", "summaryDate");
CREATE INDEX "AdsDailySummary_profile_idx" ON "AdsDailySummary"("adsProfileId");

ALTER TABLE "AdsDailySummary" ADD CONSTRAINT "AdsDailySummary_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsDailySummary" ADD CONSTRAINT "AdsDailySummary_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 行级安全与授权（同其他租户表）
DO $$
BEGIN
  ALTER TABLE "AdsDailySummary" ENABLE ROW LEVEL SECURITY;
  CREATE POLICY tenant_isolation ON "AdsDailySummary" USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()));
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AdsDailySummary" TO nova_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON "AdsDailySummary" TO nova_system;
  END IF;
END $$;
