-- M-P1-14 回滚：移除新增表与审计扩展列（扩展列中的内容会丢失，执行前请备份）。
DROP INDEX IF EXISTS "AuditEvent_tenantId_resourceType_resourceId_idx";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "reason";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "stepUpId";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "writeRunId";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "userAgent";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "ip";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "afterJson";
ALTER TABLE "AuditEvent" DROP COLUMN IF EXISTS "beforeJson";
DROP TABLE IF EXISTS "StepUpVerification";
DROP TABLE IF EXISTS "IdempotencyRecord";