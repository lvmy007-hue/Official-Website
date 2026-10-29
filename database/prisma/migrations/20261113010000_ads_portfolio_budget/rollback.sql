-- M-P3-11 回滚：删除广告预算规则表与广告组合上新增的预算起止日。
-- 说明：AdsBudgetRule 里的数据会丢失（目前没有同步器写它，通常是空表）；AdsPortfolio 的 budgetStart、budgetEnd 丢失后，
-- 指定日期范围的预算节奏无法再算，可由统一接口重新同步。

DROP TABLE IF EXISTS "AdsBudgetRule";

ALTER TABLE "AdsPortfolio" DROP CONSTRAINT IF EXISTS "AdsPortfolio_budget_range_check";
ALTER TABLE "AdsPortfolio" DROP COLUMN IF EXISTS "budgetEnd";
ALTER TABLE "AdsPortfolio" DROP COLUMN IF EXISTS "budgetStart";
