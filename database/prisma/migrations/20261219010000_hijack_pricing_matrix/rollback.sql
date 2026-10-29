-- 回滚 M-P6-17：删除 OfferCompetitor、HijackWhitelist（含索引、约束与行级安全策略），并去掉 PricingRule.scenarioMatrix。
-- 丢失的数据：跟卖观察记录（下一次定价同步会重新生成当前仍在的报价方，但“首次出现时间”会重置）、跟卖白名单、定价规则的情形 × 动作矩阵。
-- 已配置矩阵的规则回滚后改回按原策略求价，建议回滚前先在定价页停用这些规则。
DROP TABLE IF EXISTS "OfferCompetitor";
DROP TABLE IF EXISTS "HijackWhitelist";
ALTER TABLE "PricingRule" DROP CONSTRAINT IF EXISTS "PricingRule_scenarioMatrix_check";
ALTER TABLE "PricingRule" DROP COLUMN IF EXISTS "scenarioMatrix";
