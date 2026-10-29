-- 回滚 M-P6-16：删除 AlertDigest（含索引、约束与行级安全策略），并去掉 AlertRule 新增的三列。
-- 丢失的数据：汇总批次与升级记录；自定义指标规则（评估器类型 CUSTOM_METRIC）的条件、所有规则的通知频率与升级设置。
-- 自定义指标规则回滚后没有条件，评估器不会评估它们（没有条件的规则不产生预警）；建议回滚前先在规则页停用或删除这些规则。
DROP TABLE IF EXISTS "AlertDigest";
ALTER TABLE "AlertRule" DROP CONSTRAINT IF EXISTS "AlertRule_notifyFrequency_check";
ALTER TABLE "AlertRule" DROP CONSTRAINT IF EXISTS "AlertRule_escalation_check";
ALTER TABLE "AlertRule" DROP CONSTRAINT IF EXISTS "AlertRule_conditionGroups_check";
ALTER TABLE "AlertRule" DROP COLUMN IF EXISTS "conditionGroups";
ALTER TABLE "AlertRule" DROP COLUMN IF EXISTS "notifyFrequency";
ALTER TABLE "AlertRule" DROP COLUMN IF EXISTS "escalation";
