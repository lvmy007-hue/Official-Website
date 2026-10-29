-- M-P2a-07 回滚：删除补货批次相关 7 张表，并移除补货策略表新增的 9 列与 2 条约束。
-- 说明：批次、建议、动作、结果回看是业务记录，不是派生数据，删除后不可恢复，回滚前请先导出；
-- 订阅省快照与单品经济模拟结果可由同步器重新拉取。回滚后补货策略的 P2a-06 参数（提前期、安全库存天数等）保持不变。
DROP TABLE IF EXISTS "ReplenishmentOutcome";
DROP TABLE IF EXISTS "ReplenishmentAction";
DROP TABLE IF EXISTS "ReplenishmentRecommendation";
DROP TABLE IF EXISTS "ReplenishmentBatch";
DROP TABLE IF EXISTS "SubscribeSaveOffer";
DROP TABLE IF EXISTS "SubscribeSaveMetric";
DROP TABLE IF EXISTS "EconomicsSimulationRun";
ALTER TABLE "ReplenishmentPolicy" DROP CONSTRAINT IF EXISTS "ReplenishmentPolicy_replenish_check";
ALTER TABLE "ReplenishmentPolicy" DROP CONSTRAINT IF EXISTS "ReplenishmentPolicy_ref_check";
ALTER TABLE "ReplenishmentPolicy"
  DROP COLUMN IF EXISTS "productionDays",
  DROP COLUMN IF EXISTS "domesticDays",
  DROP COLUMN IF EXISTS "receivingDays",
  DROP COLUMN IF EXISTS "serviceLevel",
  DROP COLUMN IF EXISTS "transportPreference",
  DROP COLUMN IF EXISTS "transportOptionsJson",
  DROP COLUMN IF EXISTS "casePackQty",
  DROP COLUMN IF EXISTS "moq",
  DROP COLUMN IF EXISTS "minOrderValue";