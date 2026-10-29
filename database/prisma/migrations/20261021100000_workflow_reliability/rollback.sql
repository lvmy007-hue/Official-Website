-- M-P1-20 回滚：移除流程状态机、死信、分布式锁四张表与同步任务新增列。
-- 回滚后任务不再有租约锁、死信与断点，请仅在演练或紧急处置时执行；四张表里的内容会丢失，请先备份。
DROP TABLE IF EXISTS "WorkflowStep";
DROP TABLE IF EXISTS "WorkflowRun";
DROP TABLE IF EXISTS "DeadLetterJob";
DROP TABLE IF EXISTS "DistributedLock";
DROP INDEX IF EXISTS "SyncJob_tenantId_sourceKey_idx";
DROP INDEX IF EXISTS "SyncJob_tenantId_domain_status_idx";
ALTER TABLE "SyncJob" DROP CONSTRAINT IF EXISTS "SyncJob_priority_check";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "deadLettered";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "checkpointJson";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "priority";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "sourceKey";
ALTER TABLE "SyncJob" DROP COLUMN IF EXISTS "domain";
