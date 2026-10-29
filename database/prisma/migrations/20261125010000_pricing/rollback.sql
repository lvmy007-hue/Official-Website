-- 回滚 M-P4-11：删除八张新表并还原 ListingWriteRun 的检查约束。
-- 价格类快照是亚马逊数据的只读副本，下一次同步会取回；护栏、规则与执行记录会丢失；PRICE_VALIDATE / PRICE_PATCH 类的写入记录要先删除才能还原约束。
DELETE FROM "ListingWriteRun" WHERE "kind" IN ('PRICE_VALIDATE', 'PRICE_PATCH');
ALTER TABLE "ListingWriteRun" DROP CONSTRAINT "ListingWriteRun_check";
ALTER TABLE "ListingWriteRun" ADD CONSTRAINT "ListingWriteRun_check" CHECK (
  "kind" IN ('VALIDATE', 'PATCH', 'BATCH', 'RESTRICTIONS')
  AND "status" IN ('PENDING', 'RUNNING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'PARTIAL', 'FAILED')
  AND ("validation" IS NULL OR "validation" IN ('VALID', 'INVALID'))
  AND "pollCount" >= 0
  AND "itemCount" >= 0
);
DROP TABLE IF EXISTS "PricingRuleRun";
DROP TABLE IF EXISTS "PricingRule";
DROP TABLE IF EXISTS "PriceGuardrail";
DROP TABLE IF EXISTS "BuyBoxSnapshot";
DROP TABLE IF EXISTS "CompetitiveOffer";
DROP TABLE IF EXISTS "CompetitiveSummarySnapshot";
DROP TABLE IF EXISTS "FeaturedOfferExpectedPrice";
DROP TABLE IF EXISTS "PriceSnapshot";