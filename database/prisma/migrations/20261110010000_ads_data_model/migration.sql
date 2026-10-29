-- M-P3-02 广告数据模型。
-- 依据：10 章 10.2 广告行；freeze/models.md M-P3-02；freeze/importers.md A-01、A-02、A-03；14 章 P3-02。
--
-- 内容：
--   一、AdsProfile 加 adsAccountId（统一接口账户编号，可空）、legacyScopeId（旧接口范围编号，回填为 profileId）。
--   二、AdsAccount（广告账户）；把 P3-01 两张表（AdsRecommendation、AdsForecastRun）里的文本账户编号补成指向 AdsAccount 的外键（先补账户行再加外键）。
--   三、AdsCampaign、AdsMetric、AdsTermMetric 增列（全部可空或带默认值，现有读写方不用改）：旧数据回填 entityId、targetId。
--   四、实体表：AdsPortfolio、AdsAdGroup、AdsAd、AdsTarget、AdsKeyword、AdsNegativeTarget、AdsCreative。
--   五、指标表：AdsPlacementMetric（不分区）；AdsAdvertisedProductMetric、AdsConvertedProductDaily（按月分区，reportDate）、AdsPerformanceHourly（按月分区，hourStart）。
--   六、检查约束、行级安全与授权（与其他租户表一致）。
-- 与冻结的出入：
--   1. AdsMetric 的 spend 与 orders 沿用原列名 cost 与 purchases，日期列沿用 reportDate（冻结写 date）；新表的金额与订单数用冻结的 spend 与 orders，日期列也叫 reportDate，
--      这样分区维护、读取方与既有的广告指标表一致；
--   2. 冻结的唯一键没有企业编号，这里全部加上 tenantId（同一个亚马逊广告账户被两个企业连接的代理商场景不会互相覆盖）；
--   3. AdsProfile.adsAccountId 可空：冻结写必填，但旧档案没有办法推出统一接口账户编号，只能等统一接口发现账户后再填；
--   4. AdsPortfolio 多一列 currency；
--   5. AdsEntitySnapshot、AdsChangeLog（P3-14）、AdsBudgetRule（P3-11）、AdsAutomationRule 与 AdsAutomationRun（P3-13）、DaypartingStrategy 与 DaypartingRun（P3-12）、
--      AdsDailySummary（P3-04）按冻结归各自的工作包，本迁移不建。
--
-- 回滚方法：见同目录 rollback.sql（删除新表与新增列；实体与指标表里的数据会丢失，可由统一接口与报告重新同步，回滚前请确认）。

-- ============================================================
-- 一、AdsProfile
-- ============================================================
ALTER TABLE "AdsProfile" ADD COLUMN "adsAccountId" TEXT;
ALTER TABLE "AdsProfile" ADD COLUMN "legacyScopeId" TEXT;
UPDATE "AdsProfile" SET "legacyScopeId" = "profileId";
CREATE UNIQUE INDEX "AdsProfile_account_uq" ON "AdsProfile"("tenantId", "adsAccountId");

-- ============================================================
-- 二、AdsAccount 与 P3-01 两张表的外键
-- ============================================================
CREATE TABLE "AdsAccount" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "entityId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "timezone" TEXT,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsAccount_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsAccount_uq" ON "AdsAccount"("tenantId", "adsAccountId");
CREATE INDEX "AdsAccount_profile_idx" ON "AdsAccount"("adsProfileId");
ALTER TABLE "AdsAccount" ADD CONSTRAINT "AdsAccount_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsAccount" ADD CONSTRAINT "AdsAccount_adsProfileId_fkey" FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- P3-01 的推荐与预测表里已经存着账户编号：为每个（企业，账户编号）补一行账户（挂在最先出现的档案上；真实名称与状态等统一接口发现账户后再更新）。
INSERT INTO "AdsAccount" ("id", "tenantId", "adsProfileId", "adsAccountId", "name", "status", "currency", "timezone", "sourceUpdatedAt", "updatedAt")
SELECT 'adsacct-' || md5(u."tenantId" || ':' || u."adsAccountId"), u."tenantId", u."adsProfileId", u."adsAccountId", u."adsAccountId", 'UNKNOWN', p."currencyCode", p."timezone", now(), now()
FROM (
  SELECT DISTINCT ON ("tenantId", "adsAccountId") "tenantId", "adsProfileId", "adsAccountId"
  FROM (
    SELECT "tenantId", "adsProfileId", "adsAccountId" FROM "AdsRecommendation"
    UNION ALL
    SELECT "tenantId", "adsProfileId", "adsAccountId" FROM "AdsForecastRun"
  ) found
  ORDER BY "tenantId", "adsAccountId", "adsProfileId"
) u
JOIN "AdsProfile" p ON p."id" = u."adsProfileId";

-- 档案恰好只对应一个账户时，把账户编号写回档案。
UPDATE "AdsProfile" p
SET "adsAccountId" = a."adsAccountId"
FROM "AdsAccount" a
WHERE a."adsProfileId" = p."id" AND p."adsAccountId" IS NULL
  AND (SELECT count(*) FROM "AdsAccount" x WHERE x."adsProfileId" = p."id") = 1;

ALTER TABLE "AdsRecommendation" ADD CONSTRAINT "AdsRecommendation_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdsForecastRun" ADD CONSTRAINT "AdsForecastRun_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 三、现有表增列
-- ============================================================
ALTER TABLE "AdsCampaign" ADD COLUMN "adsAccountId" TEXT;
ALTER TABLE "AdsCampaign" ADD COLUMN "portfolioId" TEXT;
ALTER TABLE "AdsCampaign" ADD COLUMN "targetingType" TEXT;
ALTER TABLE "AdsCampaign" ADD COLUMN "bidStrategy" TEXT;
ALTER TABLE "AdsCampaign" ADD COLUMN "servingStatus" TEXT;
ALTER TABLE "AdsCampaign" ADD COLUMN "budgetType" TEXT;
ALTER TABLE "AdsCampaign" ADD CONSTRAINT "AdsCampaign_targeting_check" CHECK ("targetingType" IS NULL OR "targetingType" IN ('AUTO', 'MANUAL'));
CREATE INDEX "AdsCampaign_portfolio_idx" ON "AdsCampaign"("tenantId", "adsAccountId", "portfolioId");
ALTER TABLE "AdsCampaign" ADD CONSTRAINT "AdsCampaign_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- 分区表：ALTER 自动作用于全部分区。
ALTER TABLE "AdsMetric" ADD COLUMN "adsAccountId" TEXT;
ALTER TABLE "AdsMetric" ADD COLUMN "entityType" TEXT NOT NULL DEFAULT 'CAMPAIGN';
ALTER TABLE "AdsMetric" ADD COLUMN "entityId" TEXT;
ALTER TABLE "AdsMetric" ADD COLUMN "units" INTEGER;
ALTER TABLE "AdsMetric" ADD COLUMN "warningSignals" JSONB;
UPDATE "AdsMetric" SET "entityId" = "externalCampaignId" WHERE "externalCampaignId" IS NOT NULL AND "externalCampaignId" <> '';
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_entity_type_check" CHECK ("entityType" IN ('CAMPAIGN', 'AD_GROUP', 'AD', 'TARGET', 'KEYWORD'));
CREATE UNIQUE INDEX "AdsMetric_entity_uq" ON "AdsMetric"("tenantId", "adsAccountId", "entityType", "entityId", "reportDate", "adProduct");
ALTER TABLE "AdsMetric" ADD CONSTRAINT "AdsMetric_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdsTermMetric" ADD COLUMN "adsAccountId" TEXT;
ALTER TABLE "AdsTermMetric" ADD COLUMN "targetId" TEXT;
ALTER TABLE "AdsTermMetric" ADD COLUMN "matchedTargetExpression" TEXT;
ALTER TABLE "AdsTermMetric" ADD COLUMN "otherBucket" BOOLEAN NOT NULL DEFAULT false;
UPDATE "AdsTermMetric" SET "targetId" = "keywordId" WHERE "keywordId" IS NOT NULL;
ALTER TABLE "AdsTermMetric" ADD CONSTRAINT "AdsTermMetric_account_fkey" FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- 四、实体表
-- ============================================================
CREATE TABLE "AdsPortfolio" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "portfolioId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "budgetCap" DECIMAL(20,6),
  "budgetPeriod" TEXT,
  "spent" DECIMAL(20,6) NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "status" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsPortfolio_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsPortfolio_uq" ON "AdsPortfolio"("tenantId", "adsAccountId", "portfolioId");
CREATE INDEX "AdsPortfolio_profile_idx" ON "AdsPortfolio"("adsProfileId");

CREATE TABLE "AdsAdGroup" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "adGroupId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "state" TEXT NOT NULL,
  "defaultBid" DECIMAL(20,6),
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsAdGroup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsAdGroup_uq" ON "AdsAdGroup"("tenantId", "adsAccountId", "adGroupId");
CREATE INDEX "AdsAdGroup_campaign_idx" ON "AdsAdGroup"("tenantId", "adsAccountId", "campaignId");
CREATE INDEX "AdsAdGroup_profile_idx" ON "AdsAdGroup"("adsProfileId");

CREATE TABLE "AdsAd" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "adId" TEXT NOT NULL,
  "adGroupId" TEXT NOT NULL,
  "asin" TEXT,
  "sku" TEXT,
  "state" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsAd_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsAd_uq" ON "AdsAd"("tenantId", "adsAccountId", "adId");
CREATE INDEX "AdsAd_group_idx" ON "AdsAd"("tenantId", "adsAccountId", "adGroupId");
CREATE INDEX "AdsAd_profile_idx" ON "AdsAd"("adsProfileId");

CREATE TABLE "AdsTarget" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "targetId" TEXT NOT NULL,
  "adGroupId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "expression" TEXT NOT NULL,
  "matchType" TEXT,
  "bid" DECIMAL(20,6),
  "state" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsTarget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsTarget_uq" ON "AdsTarget"("tenantId", "adsAccountId", "targetId");
CREATE INDEX "AdsTarget_group_idx" ON "AdsTarget"("tenantId", "adsAccountId", "adGroupId");
CREATE INDEX "AdsTarget_profile_idx" ON "AdsTarget"("adsProfileId");

CREATE TABLE "AdsKeyword" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "keywordId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "adGroupId" TEXT NOT NULL,
  "text" TEXT NOT NULL,
  "matchType" TEXT NOT NULL,
  "bid" DECIMAL(20,6),
  "state" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsKeyword_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsKeyword_uq" ON "AdsKeyword"("tenantId", "adsAccountId", "keywordId");
CREATE INDEX "AdsKeyword_group_idx" ON "AdsKeyword"("tenantId", "adsAccountId", "adGroupId");
CREATE INDEX "AdsKeyword_profile_idx" ON "AdsKeyword"("adsProfileId");

CREATE TABLE "AdsNegativeTarget" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "negativeId" TEXT NOT NULL,
  "level" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "adGroupId" TEXT,
  "expression" TEXT NOT NULL,
  "matchType" TEXT NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsNegativeTarget_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsNegativeTarget_uq" ON "AdsNegativeTarget"("tenantId", "adsAccountId", "negativeId");
CREATE INDEX "AdsNegativeTarget_campaign_idx" ON "AdsNegativeTarget"("tenantId", "adsAccountId", "campaignId");
CREATE INDEX "AdsNegativeTarget_profile_idx" ON "AdsNegativeTarget"("adsProfileId");

CREATE TABLE "AdsCreative" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "creativeId" TEXT NOT NULL,
  "adId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "assetsJson" JSONB NOT NULL,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsCreative_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsCreative_uq" ON "AdsCreative"("tenantId", "adsAccountId", "creativeId");
CREATE INDEX "AdsCreative_ad_idx" ON "AdsCreative"("tenantId", "adsAccountId", "adId");
CREATE INDEX "AdsCreative_profile_idx" ON "AdsCreative"("adsProfileId");

-- ============================================================
-- 五、指标表
-- ============================================================
CREATE TABLE "AdsPlacementMetric" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "placement" TEXT NOT NULL,
  "reportDate" TIMESTAMP(3) NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spend" DECIMAL(20,6),
  "sales" DECIMAL(20,6),
  "orders" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsPlacementMetric_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AdsPlacementMetric_uq" ON "AdsPlacementMetric"("tenantId", "adsAccountId", "campaignId", "placement", "reportDate");
CREATE INDEX "AdsPlacementMetric_date_idx" ON "AdsPlacementMetric"("tenantId", "reportDate");
CREATE INDEX "AdsPlacementMetric_profile_idx" ON "AdsPlacementMetric"("adsProfileId");

CREATE TABLE "AdsAdvertisedProductMetric" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "advertisedAsin" TEXT NOT NULL,
  "reportDate" TIMESTAMP(3) NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spend" DECIMAL(20,6),
  "sales" DECIMAL(20,6),
  "orders" INTEGER NOT NULL DEFAULT 0,
  "units" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsAdvertisedProductMetric_pkey" PRIMARY KEY ("id", "reportDate")
) PARTITION BY RANGE ("reportDate");
CREATE UNIQUE INDEX "AdsAdvertisedProductMetric_uq" ON "AdsAdvertisedProductMetric"("tenantId", "adsAccountId", "campaignId", "advertisedAsin", "reportDate");
CREATE INDEX "AdsAdvertisedProductMetric_date_idx" ON "AdsAdvertisedProductMetric"("tenantId", "reportDate");
CREATE INDEX "AdsAdvertisedProductMetric_profile_idx" ON "AdsAdvertisedProductMetric"("adsProfileId");

CREATE TABLE "AdsConvertedProductDaily" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "advertisedAsin" TEXT NOT NULL,
  "purchasedAsin" TEXT NOT NULL,
  "reportDate" TIMESTAMP(3) NOT NULL,
  "units" INTEGER NOT NULL,
  "sales" DECIMAL(20,6) NOT NULL,
  "isHalo" BOOLEAN NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsConvertedProductDaily_pkey" PRIMARY KEY ("id", "reportDate")
) PARTITION BY RANGE ("reportDate");
CREATE UNIQUE INDEX "AdsConvertedProductDaily_uq" ON "AdsConvertedProductDaily"("tenantId", "adsAccountId", "campaignId", "advertisedAsin", "purchasedAsin", "reportDate");
CREATE INDEX "AdsConvertedProductDaily_date_idx" ON "AdsConvertedProductDaily"("tenantId", "reportDate");
CREATE INDEX "AdsConvertedProductDaily_profile_idx" ON "AdsConvertedProductDaily"("adsProfileId");

CREATE TABLE "AdsPerformanceHourly" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "adsProfileId" TEXT NOT NULL,
  "adsAccountId" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT NOT NULL,
  "hourStart" TIMESTAMP(3) NOT NULL,
  "impressions" INTEGER NOT NULL DEFAULT 0,
  "clicks" INTEGER NOT NULL DEFAULT 0,
  "spend" DECIMAL(20,6),
  "sales" DECIMAL(20,6),
  "orders" INTEGER NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "extraJson" JSONB,
  "sourceUpdatedAt" TIMESTAMP(3) NOT NULL,
  "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sourceReportJobId" TEXT,
  "sourceRecordId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdsPerformanceHourly_pkey" PRIMARY KEY ("id", "hourStart")
) PARTITION BY RANGE ("hourStart");
CREATE UNIQUE INDEX "AdsPerformanceHourly_uq" ON "AdsPerformanceHourly"("tenantId", "adsAccountId", "entityType", "entityId", "hourStart");
CREATE INDEX "AdsPerformanceHourly_hour_idx" ON "AdsPerformanceHourly"("tenantId", "hourStart");
CREATE INDEX "AdsPerformanceHourly_profile_idx" ON "AdsPerformanceHourly"("adsProfileId");

-- 外键：租户、广告档案、广告账户（账户删除级联删除全部子数据）
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'AdsPortfolio', 'AdsAdGroup', 'AdsAd', 'AdsTarget', 'AdsKeyword', 'AdsNegativeTarget', 'AdsCreative',
    'AdsPlacementMetric', 'AdsAdvertisedProductMetric', 'AdsConvertedProductDaily', 'AdsPerformanceHourly'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE', tbl, tbl || '_tenantId_fkey');
    EXECUTE format('ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("adsProfileId") REFERENCES "AdsProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE', tbl, tbl || '_adsProfileId_fkey');
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I FOREIGN KEY ("tenantId", "adsAccountId") REFERENCES "AdsAccount"("tenantId", "adsAccountId") ON DELETE CASCADE ON UPDATE CASCADE',
      tbl, tbl || '_account_fkey'
    );
  END LOOP;
END $$;

-- 分区：日表补建近 26 个月（报告日数据保留期最长 24 个月）到未来 3 个月；小时表补建近 2 个月
DO $$
BEGIN
  PERFORM nova_ensure_partitions_around('"AdsAdvertisedProductMetric"'::regclass, (timezone('UTC', now()) - interval '26 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  PERFORM nova_ensure_partitions_around('"AdsConvertedProductDaily"'::regclass, (timezone('UTC', now()) - interval '26 months')::timestamp, timezone('UTC', now())::timestamp, 3);
  PERFORM nova_ensure_partitions_around('"AdsPerformanceHourly"'::regclass, (timezone('UTC', now()) - interval '2 months')::timestamp, timezone('UTC', now())::timestamp, 3);
END $$;

-- ============================================================
-- 六、检查约束
-- ============================================================
ALTER TABLE "AdsPortfolio" ADD CONSTRAINT "AdsPortfolio_amount_check" CHECK (("budgetCap" IS NULL OR "budgetCap" >= 0) AND "spent" >= 0);
ALTER TABLE "AdsAdGroup" ADD CONSTRAINT "AdsAdGroup_bid_check" CHECK ("defaultBid" IS NULL OR "defaultBid" >= 0);
ALTER TABLE "AdsTarget" ADD CONSTRAINT "AdsTarget_kind_check" CHECK ("kind" IN ('KEYWORD', 'PRODUCT', 'CATEGORY', 'AUDIENCE'));
ALTER TABLE "AdsTarget" ADD CONSTRAINT "AdsTarget_bid_check" CHECK ("bid" IS NULL OR "bid" >= 0);
ALTER TABLE "AdsKeyword" ADD CONSTRAINT "AdsKeyword_bid_check" CHECK ("bid" IS NULL OR "bid" >= 0);
ALTER TABLE "AdsNegativeTarget" ADD CONSTRAINT "AdsNegativeTarget_level_check" CHECK ("level" IN ('CAMPAIGN', 'AD_GROUP') AND ("level" <> 'AD_GROUP' OR "adGroupId" IS NOT NULL));
ALTER TABLE "AdsPlacementMetric" ADD CONSTRAINT "AdsPlacementMetric_value_check" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "orders" >= 0 AND ("spend" IS NULL OR "spend" >= 0) AND ("sales" IS NULL OR "sales" >= 0));
ALTER TABLE "AdsAdvertisedProductMetric" ADD CONSTRAINT "AdsAdvertisedProductMetric_value_check" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "orders" >= 0 AND "units" >= 0 AND ("spend" IS NULL OR "spend" >= 0) AND ("sales" IS NULL OR "sales" >= 0));
ALTER TABLE "AdsConvertedProductDaily" ADD CONSTRAINT "AdsConvertedProductDaily_value_check" CHECK ("units" >= 0 AND "sales" >= 0);
ALTER TABLE "AdsPerformanceHourly" ADD CONSTRAINT "AdsPerformanceHourly_entity_type_check" CHECK ("entityType" IN ('CAMPAIGN', 'AD_GROUP', 'AD', 'TARGET', 'KEYWORD'));
ALTER TABLE "AdsPerformanceHourly" ADD CONSTRAINT "AdsPerformanceHourly_value_check" CHECK ("impressions" >= 0 AND "clicks" >= 0 AND "orders" >= 0 AND ("spend" IS NULL OR "spend" >= 0) AND ("sales" IS NULL OR "sales" >= 0));

-- ============================================================
-- 七、行级安全与授权（同其他租户表）
-- ============================================================
DO $$
DECLARE
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY[
    'AdsAccount', 'AdsPortfolio', 'AdsAdGroup', 'AdsAd', 'AdsTarget', 'AdsKeyword', 'AdsNegativeTarget', 'AdsCreative',
    'AdsPlacementMetric', 'AdsAdvertisedProductMetric', 'AdsConvertedProductDaily', 'AdsPerformanceHourly'
  ] LOOP
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
