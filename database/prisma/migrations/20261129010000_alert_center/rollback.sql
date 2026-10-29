-- M-P5-01 回滚：去掉预警实例补的列（关闭结论、备注、处理人、标题、对象名称、建议、影响金额区间）。
-- 说明：前三列只用于规则质量统计（误报率、处理时长），后六列只用于预警中心的列表显示；回滚后预警状态与待办不受影响，
-- 误报率会变成“尚无记录”，预警列表要靠关联待办显示标题（没有待办的预警只剩规则名称）。
DROP INDEX IF EXISTS "AlertInstance_rule_stats_idx";
ALTER TABLE "AlertInstance" DROP CONSTRAINT IF EXISTS "AlertInstance_closeConclusion_check";
ALTER TABLE "AlertInstance"
  DROP COLUMN IF EXISTS "closeConclusion",
  DROP COLUMN IF EXISTS "closeNote",
  DROP COLUMN IF EXISTS "closedBy",
  DROP COLUMN IF EXISTS "title",
  DROP COLUMN IF EXISTS "entityLabel",
  DROP COLUMN IF EXISTS "suggestedAction",
  DROP COLUMN IF EXISTS "impactMin",
  DROP COLUMN IF EXISTS "impactMax",
  DROP COLUMN IF EXISTS "currency";
