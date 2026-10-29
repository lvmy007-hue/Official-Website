-- M-P3-02 回滚：删除广告数据模型的新表与现有表上新增的列、索引、约束。
-- 说明：实体与指标表（广告组合、广告组、广告、投放、关键词、否定投放、创意、广告位、广告商品、转化商品、小时指标）里的数据会丢失，
-- 可由统一接口与报告重新同步；AdsAccount 里的账户记录丢失（档案上的 adsAccountId 也一并删除）。P3-01 的推荐与预测数据保留，只是不再有指向账户的外键。
-- 现有指标表（AdsMetric、AdsTermMetric）与活动表（AdsCampaign）原有的数据与读写方式不受影响。

DROP TABLE IF EXISTS "AdsPerformanceHourly";
DROP TABLE IF EXISTS "AdsConvertedProductDaily";
DROP TABLE IF EXISTS "AdsAdvertisedProductMetric";
DROP TABLE IF EXISTS "AdsPlacementMetric";
DROP TABLE IF EXISTS "AdsCreative";
DROP TABLE IF EXISTS "AdsNegativeTarget";
DROP TABLE IF EXISTS "AdsKeyword";
DROP TABLE IF EXISTS "AdsTarget";
DROP TABLE IF EXISTS "AdsAd";
DROP TABLE IF EXISTS "AdsAdGroup";
DROP TABLE IF EXISTS "AdsPortfolio";

ALTER TABLE "AdsRecommendation" DROP CONSTRAINT IF EXISTS "AdsRecommendation_account_fkey";
ALTER TABLE "AdsForecastRun" DROP CONSTRAINT IF EXISTS "AdsForecastRun_account_fkey";

ALTER TABLE "AdsTermMetric" DROP CONSTRAINT IF EXISTS "AdsTermMetric_account_fkey";
ALTER TABLE "AdsTermMetric" DROP COLUMN IF EXISTS "otherBucket";
ALTER TABLE "AdsTermMetric" DROP COLUMN IF EXISTS "matchedTargetExpression";
ALTER TABLE "AdsTermMetric" DROP COLUMN IF EXISTS "targetId";
ALTER TABLE "AdsTermMetric" DROP COLUMN IF EXISTS "adsAccountId";

ALTER TABLE "AdsMetric" DROP CONSTRAINT IF EXISTS "AdsMetric_account_fkey";
DROP INDEX IF EXISTS "AdsMetric_entity_uq";
ALTER TABLE "AdsMetric" DROP CONSTRAINT IF EXISTS "AdsMetric_entity_type_check";
ALTER TABLE "AdsMetric" DROP COLUMN IF EXISTS "warningSignals";
ALTER TABLE "AdsMetric" DROP COLUMN IF EXISTS "units";
ALTER TABLE "AdsMetric" DROP COLUMN IF EXISTS "entityId";
ALTER TABLE "AdsMetric" DROP COLUMN IF EXISTS "entityType";
ALTER TABLE "AdsMetric" DROP COLUMN IF EXISTS "adsAccountId";

ALTER TABLE "AdsCampaign" DROP CONSTRAINT IF EXISTS "AdsCampaign_account_fkey";
DROP INDEX IF EXISTS "AdsCampaign_portfolio_idx";
ALTER TABLE "AdsCampaign" DROP CONSTRAINT IF EXISTS "AdsCampaign_targeting_check";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "budgetType";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "servingStatus";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "bidStrategy";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "targetingType";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "portfolioId";
ALTER TABLE "AdsCampaign" DROP COLUMN IF EXISTS "adsAccountId";

DROP TABLE IF EXISTS "AdsAccount";

DROP INDEX IF EXISTS "AdsProfile_account_uq";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "legacyScopeId";
ALTER TABLE "AdsProfile" DROP COLUMN IF EXISTS "adsAccountId";
