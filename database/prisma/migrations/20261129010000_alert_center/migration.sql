-- M-P5-01 风险预警中心：
-- 1) 预警实例补“关闭结论、备注、处理人”，用来统计规则的误报率与处理时长。结论取值与待办的关闭结论一致：
--    HANDLED 已处理、NOT_NEEDED 无需处理、FALSE_POSITIVE 误报、IGNORED 忽略；自动恢复的预警结论为空。
--    历史已被处理的预警没有结论（当时只记了状态），统计时 HANDLED 与 IGNORED 状态照常计入“已处理”，只是不能区分误报。
-- 2) 预警实例自己带标题、对象名称、建议与影响金额区间：以前这些只写在待办上，企业没有可分派的负责人时（没有待办）预警列表就没有可显示的内容。
--    旧实例这几列为空，列表回退到关联待办，再回退到规则名称；重新命中时会刷新为最新值。

-- AlterTable
ALTER TABLE "AlertInstance"
ADD COLUMN "closeConclusion" TEXT,
ADD COLUMN "closeNote" TEXT,
ADD COLUMN "closedBy" TEXT,
ADD COLUMN "title" TEXT,
ADD COLUMN "entityLabel" TEXT,
ADD COLUMN "suggestedAction" TEXT,
ADD COLUMN "impactMin" DECIMAL(20,6),
ADD COLUMN "impactMax" DECIMAL(20,6),
ADD COLUMN "currency" TEXT;

ALTER TABLE "AlertInstance" ADD CONSTRAINT "AlertInstance_closeConclusion_check"
  CHECK ("closeConclusion" IS NULL OR "closeConclusion" IN ('HANDLED', 'NOT_NEEDED', 'FALSE_POSITIVE', 'IGNORED'));

-- 规则质量统计按（规则、状态、首次触发时间）取数
CREATE INDEX "AlertInstance_rule_stats_idx" ON "AlertInstance"("tenantId", "ruleId", "firstTriggeredAt");
