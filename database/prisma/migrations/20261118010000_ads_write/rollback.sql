-- M-P3-17 回滚：删除广告写入记录表。
-- 说明：已经写入亚马逊的修改不会撤销，只是丢失本系统里的写入记录；AdsChangeLog.writeRunId 与 AdsAutomationRun.writeRunId 里存的编号会变成找不到对应记录。

DROP TABLE IF EXISTS "AdsWriteRun";

-- 执行记录：“已提交”改回“已跳过”后恢复原检查，去掉分时策略执行记录的写入记录编号。
DROP INDEX IF EXISTS "AdsAutomationRun_write_idx";
DROP INDEX IF EXISTS "DaypartingRun_write_idx";
UPDATE "AdsAutomationRun" SET "outcome" = 'SKIPPED' WHERE "outcome" = 'QUEUED';
UPDATE "DaypartingRun" SET "outcome" = 'SKIPPED' WHERE "outcome" = 'QUEUED';
ALTER TABLE "AdsAutomationRun" DROP CONSTRAINT IF EXISTS "AdsAutomationRun_outcome_check";
ALTER TABLE "AdsAutomationRun" ADD CONSTRAINT "AdsAutomationRun_outcome_check" CHECK ("outcome" IN ('SUGGESTED', 'APPLIED', 'SKIPPED', 'FAILED'));
ALTER TABLE "DaypartingRun" DROP CONSTRAINT IF EXISTS "DaypartingRun_outcome_check";
ALTER TABLE "DaypartingRun" ADD CONSTRAINT "DaypartingRun_outcome_check" CHECK ("outcome" IN ('APPLIED', 'SKIPPED', 'FAILED'));
ALTER TABLE "DaypartingRun" DROP COLUMN IF EXISTS "writeRunId";

-- 把检查改回原来的取值（新取值的记录先改成原取值，否则无法恢复检查）。
UPDATE "IntegrationSwitchLog" SET "action" = CASE "action" WHEN 'ENABLED' THEN 'ENABLE' WHEN 'DISABLED' THEN 'DISABLE' WHEN 'AUTO_DISABLED' THEN 'AUTO_DISABLE' ELSE "action" END;
ALTER TABLE "IntegrationSwitchLog" DROP CONSTRAINT IF EXISTS "IntegrationSwitchLog_action_check";
ALTER TABLE "IntegrationSwitchLog" ADD CONSTRAINT "IntegrationSwitchLog_action_check" CHECK ("action" IN ('ENABLE', 'DISABLE', 'AUTO_DISABLE', 'READONLY_ALL', 'EMERGENCY_OFF'));
