-- M-P3-01 广告连接器。
-- 依据：freeze/models.md M-P3-01（AdsRecommendation、AdsForecastRun）；freeze/importers.md A-01、A-04；14 章 P3-01。
--
-- 内容：
--   一、AdsRecommendation（亚马逊官方推荐）、AdsForecastRun（活动预测）：广告统一接口的两个资源。
--   二、AdsParityState、AdsParityRun、AdsParityDiff：A-04 旧版并行核对的记录（旧通道状态、每次核对、每条差异）。
--   三、检查约束与行级安全授权（与其他租户表一致）。
-- 与冻结的出入：
--   1. 冻结的唯一键是 (adsAccountId, recommendationId)，这里加上 tenantId，并另存 adsProfileId（外键，范围过滤与级联删除用）：
--      广告账户表 AdsAccount 与 AdsProfile.adsAccountId 是 P3-02 才建的，本迁移不提前建，adsAccountId 先存成文本；
--   2. A-04 冻结写“仅写核对记录，键 (compareDate, entityType, metricKey)”，没有给表结构；沿用订单与财务核对的做法（运行 + 差异 + 旧通道状态三张表），
--      但按广告档案而不是店铺记（广告账户在 P3-03 绑定店铺之前也要核对），所以没有复用以 sellerAccountId 为必填的 ConnectorParityRun。
-- 不做数据迁移：全部是新表。
--
-- 回滚方法：见同目录 rollback.sql（删五张表；推荐的人工处理结果与核对记录会丢失，回滚前请先导出）。

-- CreateTable
CREATE TABLE "AdsRecommendation" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "recommendationId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "payloadJson" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsForecastRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "adsAccountId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "requestedBudget" DECIMAL(20,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "forecastJson" JSONB NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL,
    "requestedBy" TEXT,

    CONSTRAINT "AdsForecastRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsParityState" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "legacyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "consecutivePasses" INTEGER NOT NULL DEFAULT 0,
    "requiredPasses" INTEGER NOT NULL DEFAULT 7,
    "lastRunAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdsParityState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsParityRun" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "adsProfileId" TEXT NOT NULL,
    "windowStart" DATE NOT NULL,
    "windowEnd" DATE NOT NULL,
    "legacyCount" INTEGER NOT NULL DEFAULT 0,
    "newCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "unexplainedCount" INTEGER NOT NULL DEFAULT 0,
    "warningCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AdsParityRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdsParityDiff" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "entityKey" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "legacyValue" TEXT,
    "newValue" TEXT,
    "explanation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdsParityDiff_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdsRecommendation_uq" ON "AdsRecommendation"("tenantId", "adsAccountId", "recommendationId");
CREATE INDEX "AdsRecommendation_profile_status_idx" ON "AdsRecommendation"("adsProfileId", "status");
CREATE INDEX "AdsRecommendation_entity_idx" ON "AdsRecommendation"("tenantId", "entityType", "entityId");
CREATE INDEX "AdsForecastRun_campaign_idx" ON "AdsForecastRun"("adsProfileId", "campaignId", "requestedAt");
CREATE INDEX "AdsForecastRun_tenant_idx" ON "AdsForecastRun"("tenantId", "requestedAt");
CREATE UNIQUE INDEX "AdsParityState_adsProfileId_key" ON "AdsParityState"("adsProfileId");
CREATE INDEX "AdsParityState_tenant_idx" ON "AdsParityState"("tenantId");
CREATE INDEX "AdsParityRun_tenant_idx" ON "AdsParityRun"("tenantId", "adsProfileId", "startedAt");
CREATE INDEX "AdsParityRun_profile_idx" ON "AdsParityRun"("adsProfileId", "startedAt");
CREATE INDEX "AdsParityDiff_run_idx" ON "AdsParityDiff"("runId", "category");
CREATE INDEX "AdsParityDiff_tenant_idx" ON "AdsParityDiff"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "AdsRecommendation" ADD CONSTRAINT "AdsRecommendation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsRecommendation" ADD CONSTRAINT "AdsRecommendation_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsForecastRun" ADD CONSTRAINT "AdsForecastRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsForecastRun" ADD CONSTRAINT "AdsForecastRun_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityState" ADD CONSTRAINT "AdsParityState_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityState" ADD CONSTRAINT "AdsParityState_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityRun" ADD CONSTRAINT "AdsParityRun_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityRun" ADD CONSTRAINT "AdsParityRun_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityDiff" ADD CONSTRAINT "AdsParityDiff_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsParityDiff" ADD CONSTRAINT "AdsParityDiff_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AdsParityRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 检查约束
ALTER TABLE "AdsRecommendation" ADD CONSTRAINT "AdsRecommendation_status_check" CHECK ("status" IN ('NEW', 'ADOPTED', 'IGNORED', 'EXPIRED'));
ALTER TABLE "AdsForecastRun" ADD CONSTRAINT "AdsForecastRun_budget_check" CHECK ("requestedBudget" >= 0);
ALTER TABLE "AdsParityState" ADD CONSTRAINT "AdsParityState_passes_check" CHECK ("consecutivePasses" >= 0 AND "requiredPasses" >= 1);
ALTER TABLE "AdsParityRun" ADD CONSTRAINT "AdsParityRun_status_check" CHECK ("status" IN ('PASSED', 'HAS_DIFFS', 'LEGACY_UNAVAILABLE'));
ALTER TABLE "AdsParityRun" ADD CONSTRAINT "AdsParityRun_window_check" CHECK ("windowEnd" >= "windowStart");
ALTER TABLE "AdsParityRun" ADD CONSTRAINT "AdsParityRun_counts_check" CHECK ("legacyCount" >= 0 AND "newCount" >= 0 AND "matchedCount" >= 0 AND "unexplainedCount" >= 0 AND "warningCount" >= 0);
ALTER TABLE "AdsParityDiff" ADD CONSTRAINT "AdsParityDiff_category_check" CHECK ("category" IN ('TIME_BASIS', 'ATTRIBUTION_BASIS', 'SCOPE', 'UNEXPLAINED'));

-- 行级安全与授权（同其他租户表）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['AdsRecommendation', 'AdsForecastRun', 'AdsParityState', 'AdsParityRun', 'AdsParityDiff'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING ("tenantId" = (SELECT nova_current_tenant())) WITH CHECK ("tenantId" = (SELECT nova_current_tenant()))', tbl);
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_app') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_app', tbl);
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nova_system') THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO nova_system', tbl);
    END IF;
  END LOOP;
END $$;
